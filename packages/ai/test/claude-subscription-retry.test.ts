// Retry, recovery and error classification of Claude subscription requests: which failures are replayed against the
// same account and after what wait, which are account usage limits left to the caller, the stream watchdogs, the
// rewrites that answer a rejected request, slow mode, and the outer retry of an empty completion.

import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEmptyCompletionRetry } from "../src/api/claude-subscription/empty-completion.ts";
import {
	AnthropicStreamEnvelopeError,
	AnthropicStreamTimeoutError,
	isCacheControlRejection,
	isClaudeCodeRetryableError,
	isImmutableLatestThinkingText,
	isInvalidThinkingSignatureError,
	isThinkingPrefixBindingError,
	isTransientStatus,
	isUsageLimitError,
} from "../src/api/claude-subscription/errors.ts";
import {
	type ClaudeCodeFailure,
	createClaudeCodeRecovery,
	recoverFromFailure,
} from "../src/api/claude-subscription/recovery.ts";
import {
	calculateClaudeCodeBackoffMs,
	claudeCodeMaxRetries,
	createStreamWatchdog,
	isEmptyContentDelta,
	planClaudeCodeRetry,
	primeStream,
	resolveStreamTimeouts,
} from "../src/api/claude-subscription/retry.ts";
import {
	type AnthropicSlowModeFailure,
	type AnthropicSlowModeHooks,
	parseAnthropicSlowModeHeaders,
} from "../src/api/claude-subscription/slow-mode.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { getProviderHttpErrorDetails } from "../src/utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { appendProviderHttpErrorDiagnostic } from "../src/utils/provider-http-error.ts";

/** An error shaped like a failed Messages response: `<status> <body>`, with its status and headers. */
function httpError(status: number, body: string, headers: Record<string, string> = {}): Error {
	return Object.assign(new Error(`${status} ${body}`), { status, headers: new Headers(headers) });
}

const anthropicBody = (type: string, message: string): string =>
	JSON.stringify({ type: "error", error: { type, message } });

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("backoff", () => {
	beforeEach(() => {
		vi.spyOn(Math, "random").mockReturnValue(0);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("doubles from 0.5 seconds and stops at 8", () => {
		expect([0, 1, 2, 3, 4, 5, 9].map(calculateClaudeCodeBackoffMs)).toEqual([
			500, 1000, 2000, 4000, 8000, 8000, 8000,
		]);
	});

	it("subtracts up to a quarter as jitter", () => {
		vi.spyOn(Math, "random").mockReturnValue(1);

		expect(calculateClaudeCodeBackoffMs(2)).toBe(1500);
	});
});

describe("planClaudeCodeRetry", () => {
	beforeEach(() => {
		vi.spyOn(Math, "random").mockReturnValue(0);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retries ten times by default", () => {
		const error = httpError(529, anthropicBody("overloaded_error", "Overloaded"));

		expect(claudeCodeMaxRetries).toBe(10);
		expect(planClaudeCodeRetry(error, 9, {})).toBe(8000);
		expect(planClaudeCodeRetry(error, 10, {})).toBeUndefined();
		expect(planClaudeCodeRetry(error, 1, { maxRetries: 1 })).toBeUndefined();
		expect(planClaudeCodeRetry(error, 0, { maxRetries: 0 })).toBeUndefined();
	});

	it.each([408, 429, 500, 502, 503, 504, 529])("retries status %i", (status) => {
		expect(planClaudeCodeRetry(httpError(status, anthropicBody("api_error", "Internal server error")), 0, {})).toBe(
			500,
		);
	});

	it.each([400, 401, 403, 404, 409, 413, 422])("does not retry status %i", (status) => {
		expect(
			planClaudeCodeRetry(httpError(status, anthropicBody("invalid_request_error", "bad")), 0, {}),
		).toBeUndefined();
	});

	it("waits for the larger of the server's hint and the backoff", () => {
		const hinted = (seconds: string) =>
			httpError(429, anthropicBody("rate_limit_error", "Slow down"), { "retry-after": seconds });

		expect(planClaudeCodeRetry(hinted("20"), 0, {})).toBe(20_000);
		expect(planClaudeCodeRetry(hinted("0.1"), 3, {})).toBe(4000);
		expect(planClaudeCodeRetry(httpError(529, "{}", { "retry-after-ms": "1500", "retry-after": "1" }), 0, {})).toBe(
			1500,
		);
	});

	it("surfaces the response itself when the hint exceeds maxRetryDelayMs, 60 seconds by default", () => {
		const error = httpError(529, anthropicBody("overloaded_error", "Overloaded"), { "retry-after": "3600" });

		expect(planClaudeCodeRetry(error, 0, { maxRetryDelayMs: 60_000 })).toBeUndefined();
		expect(planClaudeCodeRetry(error, 0, {})).toBeUndefined();
		expect(planClaudeCodeRetry(error, 0, { maxRetryDelayMs: 3_600_000 })).toBe(3_600_000);
		expect(planClaudeCodeRetry(error, 0, { maxRetryDelayMs: 0 })).toBe(3_600_000);
	});

	it("honors a hint exactly at the cap", () => {
		const error = httpError(429, anthropicBody("rate_limit_error", "Slow down"), { "retry-after": "60" });

		expect(planClaudeCodeRetry(error, 0, {})).toBe(60_000);
	});

	it("honors x-should-retry over the status", () => {
		expect(planClaudeCodeRetry(httpError(400, "{}", { "x-should-retry": "true" }), 0, {})).toBe(500);
		expect(planClaudeCodeRetry(httpError(529, "{}", { "x-should-retry": "false" }), 0, {})).toBeUndefined();
	});

	it("never replays a local idle timeout, but replays a first-event timeout", () => {
		expect(planClaudeCodeRetry(new AnthropicStreamTimeoutError("idle"), 0, {})).toBeUndefined();
		expect(planClaudeCodeRetry(new AnthropicStreamTimeoutError("first-event"), 0, {})).toBe(500);
	});

	it("replays stream envelope and truncated-JSON failures", () => {
		expect(planClaudeCodeRetry(new AnthropicStreamEnvelopeError("stream ended before message_start"), 0, {})).toBe(
			500,
		);
		expect(
			planClaudeCodeRetry(new Error("Could not parse Anthropic SSE event: Unexpected end of JSON input"), 0, {}),
		).toBe(500);
	});
});

describe("isClaudeCodeRetryableError", () => {
	it.each([
		"The socket connection was closed unexpectedly before the response completed",
		"Connection error.",
		"socket hang up",
		"read ECONNRESET",
		"connect ECONNREFUSED 127.0.0.1:443",
		"getaddrinfo ENOTFOUND api.anthropic.com",
		"fetch failed",
		"Request timed out.",
		"Anthropic stream ended before message_stop",
		"Anthropic stream timed out while waiting for the first event",
		"tls: bad record mac",
		'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		'{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
	])("treats %j as transient", (message) => {
		expect(isClaudeCodeRetryableError(new Error(message))).toBe(true);
	});

	it.each([
		"Invalid API key",
		"messages.0: Input should be a valid list",
		"Anthropic pre-warm response carried no usage",
	])("does not retry %j", (message) => {
		expect(isClaudeCodeRetryableError(new Error(message))).toBe(false);
	});

	it("does not retry a non-error value", () => {
		expect(isClaudeCodeRetryableError("overloaded")).toBe(false);
		expect(isClaudeCodeRetryableError(undefined)).toBe(false);
	});

	it("reads the status of a wrapped error through its causes", () => {
		const wrapped = new Error("request failed", { cause: httpError(400, "bad request body") });

		expect(isClaudeCodeRetryableError(wrapped)).toBe(false);
	});

	it("keeps a 4xx terminal even when its body names a transient phrase", () => {
		expect(isClaudeCodeRetryableError(httpError(400, "unexpected EOF, connection error"))).toBe(false);
	});

	it("tags the envelope error so persisted text still classifies", () => {
		expect(new AnthropicStreamEnvelopeError("stream ended before message_stop").message).toBe(
			"Anthropic stream envelope error: stream ended before message_stop",
		);
	});

	it("keeps 409 out of the transient set", () => {
		expect([408, 409, 429, 500, 599, 400, 404].map((status) => isTransientStatus(status))).toEqual([
			true,
			false,
			true,
			true,
			true,
			false,
			false,
		]);
	});
});

describe("usage limits", () => {
	it.each([
		["a 429 with an opaque body", httpError(429, "status code (no body)")],
		["a 429 with only framing", httpError(429, "error")],
		[
			"an account rate limit",
			httpError(429, anthropicBody("rate_limit_error", "This request would exceed your account's rate limit.")),
		],
		["a usage limit", httpError(429, anthropicBody("rate_limit_error", "You have reached your usage limit."))],
		[
			"usage credits required",
			httpError(
				429,
				'{"error":{"message":"Usage credits are required for this model","details":{"error_code":"credits_required"}}}',
			),
		],
		[
			"a spending limit",
			httpError(400, anthropicBody("invalid_request_error", "You have reached your monthly spend limit")),
		],
		[
			"insufficient credits on a 402",
			httpError(
				402,
				anthropicBody(
					"billing_error",
					"This request would exceed your available credits given your current in-flight requests",
				),
			),
		],
		["a 402 with no body", httpError(402, "status code (no body)")],
		["insufficient_quota by code", Object.assign(httpError(429, "{}"), { code: "insufficient_quota" })],
		["usage_limit_reached by type", Object.assign(httpError(429, "{}"), { type: "usage_limit_reached" })],
		["a cause", new Error("request failed", { cause: httpError(429, "status code (no body)") })],
		[
			"a subscription cap",
			httpError(429, anthropicBody("rate_limit_error", "Your subscription rate limit was reached")),
		],
	])("recognizes %s", (_name, error) => {
		expect(isUsageLimitError(error)).toBe(true);
		expect(isClaudeCodeRetryableError(error)).toBe(false);
	});

	it.each([
		[
			"a per-minute throttle",
			httpError(429, anthropicBody("rate_limit_error", "Rate limit exceeded: 50 requests per minute")),
		],
		["an overload", httpError(529, anthropicBody("overloaded_error", "Overloaded"))],
		["a concurrency cap", httpError(429, anthropicBody("rate_limit_error", "Too many concurrent requests"))],
		[
			"a 429 with a generic rate limit",
			httpError(429, anthropicBody("rate_limit_error", "Rate limited, retry later")),
		],
		["a server error", httpError(500, anthropicBody("api_error", "Internal server error"))],
		["a TPM window", httpError(429, anthropicBody("rate_limit_error", "tpm limit exceeded for this model"))],
	])("does not take %s for one", (_name, error) => {
		expect(isUsageLimitError(error)).toBe(false);
	});

	it("replays a throttle but leaves a usage limit to the caller", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);

		expect(
			planClaudeCodeRetry(httpError(429, anthropicBody("rate_limit_error", "Rate limited, retry later")), 0, {}),
		).toBe(500);
		expect(planClaudeCodeRetry(httpError(429, "status code (no body)"), 0, {})).toBeUndefined();
		vi.restoreAllMocks();
	});
});

describe("cache_control rejection", () => {
	it.each([
		"400 cache_control: Extra inputs are not permitted",
		"400 messages.0.content.0.text.cache_control.ttl: Input should be '5m'; unsupported",
		'400 json: unknown field "cache_control"',
		"400 Invalid parameter: cache_control",
		"400 unsupported_parameter: cache_control",
	])("recognizes %j", (message) => {
		expect(isCacheControlRejection(httpError(400, message.replace(/^400 /, "")))).toBe(true);
	});

	it("reads a 400 named in the message when the error carries no status field", () => {
		expect(isCacheControlRejection(new Error("400 Invalid parameter: cache_control"))).toBe(true);
		expect(isCacheControlRejection(new Error("HTTP 400 cache_control: Extra inputs are not permitted"))).toBe(true);
		expect(isCacheControlRejection(new Error("cache_control: Extra inputs are not permitted"))).toBe(false);
	});

	it.each([
		[
			"an invalid_request_error that names no member",
			"400 invalid_request_error: cache_control breakpoints are mispositioned",
		],
		[
			"an empty text block",
			"400 cache_control cannot be set for empty text blocks; text content blocks must be non-empty",
		],
		["a 429", "429 cache_control: Extra inputs are not permitted"],
		["another field", "400 tools.0.custom.strict: Extra inputs are not permitted"],
	])("does not take %s for one", (_name, message) => {
		expect(isCacheControlRejection(new Error(message))).toBe(false);
	});

	it("reads the status through a cause", () => {
		const wrapped = new Error("request failed", {
			cause: httpError(400, "cache_control: Extra inputs are not permitted"),
		});

		expect(isCacheControlRejection(wrapped)).toBe(true);
	});
});

describe("thinking signature errors", () => {
	const invalid = "messages.1.content.0: Invalid `signature` in `thinking` block";

	it("recognizes an invalid or missing signature", () => {
		expect(isInvalidThinkingSignatureError(invalid)).toBe(true);
		expect(isInvalidThinkingSignatureError("messages.1.content.0.thinking.signature: Field required")).toBe(true);
		expect(isInvalidThinkingSignatureError(`${invalid} compaction_failed`)).toBe(false);
		expect(isInvalidThinkingSignatureError("Overloaded")).toBe(false);
	});

	it("tells a prefix binding apart from a plain bad signature", () => {
		const bound = `${invalid}: bound to a different conversation prefix`;

		expect(isThinkingPrefixBindingError(bound)).toBe(true);
		expect(isThinkingPrefixBindingError(invalid)).toBe(false);
		expect(isThinkingPrefixBindingError(`${bound} compaction_x`)).toBe(false);
	});

	it("recognizes an immutable latest assistant turn", () => {
		expect(
			isImmutableLatestThinkingText(
				"messages.3.content.0: `thinking` blocks in the latest assistant message cannot be modified",
			),
		).toBe(true);
		expect(isImmutableLatestThinkingText("Overloaded")).toBe(false);
	});
});

describe("stream watchdog", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	/** A source that yields `events` and then waits until it is returned. */
	async function* hangingSource<T>(events: T[]): AsyncGenerator<T> {
		yield* events;
		await new Promise<never>(() => {});
	}

	async function drain<T>(source: AsyncGenerator<T>): Promise<{ events: T[]; error: unknown }> {
		const events: T[] = [];
		try {
			for await (const event of source) events.push(event);
		} catch (error) {
			return { events, error };
		}
		return { events, error: undefined };
	}

	it("fails a stream that sends nothing within the first-event limit", async () => {
		const abort = vi.fn();
		const watchdog = createStreamWatchdog({ firstEventTimeoutMs: 1000, idleTimeoutMs: 500 }, abort);

		const drained = drain(watchdog.wrap(hangingSource<number>([])));
		await vi.advanceTimersByTimeAsync(1000);
		const { error } = await drained;

		expect(error).toBeInstanceOf(AnthropicStreamTimeoutError);
		expect((error as AnthropicStreamTimeoutError).kind).toBe("first-event");
		expect(abort).toHaveBeenCalledOnce();
	});

	it("fails a stream that goes quiet for the idle limit after its first event", async () => {
		const abort = vi.fn();
		const watchdog = createStreamWatchdog({ firstEventTimeoutMs: 5000, idleTimeoutMs: 500 }, abort);

		const drained = drain(watchdog.wrap(hangingSource([1])));
		await vi.advanceTimersByTimeAsync(499);
		expect(abort).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		const { events, error } = await drained;

		expect(events).toEqual([1]);
		expect((error as AnthropicStreamTimeoutError).kind).toBe("idle");
		expect(abort).toHaveBeenCalledOnce();
	});

	it("leaves a stream alone when its limits are off", async () => {
		const watchdog = createStreamWatchdog({}, vi.fn());

		const drained = drain(watchdog.wrap(hangingSource([1])));
		await vi.advanceTimersByTimeAsync(3_600_000);

		let settled = false;
		void drained.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
	});

	it("does not let a ping before the first real event end the first-event wait", async () => {
		const watchdog = createStreamWatchdog({ firstEventTimeoutMs: 1000, idleTimeoutMs: 500 }, vi.fn());

		const drained = drain(watchdog.wrap(hangingSource<number>([])));
		await vi.advanceTimersByTimeAsync(900);
		watchdog.ping();
		await vi.advanceTimersByTimeAsync(100);
		const { error } = await drained;

		expect((error as AnthropicStreamTimeoutError).kind).toBe("first-event");
	});

	it("lets pings extend the idle deadline, but only for three idle periods", async () => {
		const watchdog = createStreamWatchdog({ firstEventTimeoutMs: 5000, idleTimeoutMs: 1000 }, vi.fn());

		const drained = drain(watchdog.wrap(hangingSource([1])));
		await vi.advanceTimersByTimeAsync(900);
		watchdog.ping();
		await vi.advanceTimersByTimeAsync(900);
		watchdog.ping();
		await vi.advanceTimersByTimeAsync(900);
		// Three periods have passed without a real event: this ping no longer counts.
		watchdog.ping();
		await vi.advanceTimersByTimeAsync(1000);
		const { error } = await drained;

		expect((error as AnthropicStreamTimeoutError).kind).toBe("idle");
	});

	it("passes on an event that is no progress without extending the deadline", async () => {
		const abort = vi.fn();
		const watchdog = createStreamWatchdog({ firstEventTimeoutMs: 1000, idleTimeoutMs: 500 }, abort);
		let release: (() => void) | undefined;
		async function* source(): AsyncGenerator<string> {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			yield "empty";
			await new Promise<never>(() => {});
		}

		const events: string[] = [];
		const drained = (async () => {
			try {
				for await (const event of watchdog.wrap(source(), (item) => item !== "empty")) events.push(event);
			} catch (error) {
				return error;
			}
			return undefined;
		})();
		await vi.advanceTimersByTimeAsync(800);
		release?.();
		await vi.advanceTimersByTimeAsync(200);
		const error = await drained;

		expect(events).toEqual(["empty"]);
		expect((error as AnthropicStreamTimeoutError).kind).toBe("first-event");
	});

	it("knows an empty content delta", () => {
		const delta = (inner: object) => ({ type: "content_block_delta", index: 0, delta: inner }) as never;

		expect(isEmptyContentDelta(delta({ type: "text_delta", text: "" }))).toBe(true);
		expect(isEmptyContentDelta(delta({ type: "thinking_delta", thinking: "" }))).toBe(true);
		expect(isEmptyContentDelta(delta({ type: "input_json_delta", partial_json: "" }))).toBe(true);
		expect(isEmptyContentDelta(delta({ type: "text_delta", text: "a" }))).toBe(false);
		expect(isEmptyContentDelta(delta({ type: "signature_delta", signature: "" }))).toBe(false);
		expect(isEmptyContentDelta({ type: "message_stop" } as never)).toBe(false);
	});
});

describe("stream timeouts from the environment", () => {
	it("defaults to five minutes, with the first-event limit never below the idle limit", () => {
		expect(resolveStreamTimeouts({})).toEqual({ idleTimeoutMs: 300_000, firstEventTimeoutMs: 300_000 });
		expect(resolveStreamTimeouts({ PI_STREAM_IDLE_TIMEOUT_MS: "600000" })).toEqual({
			idleTimeoutMs: 600_000,
			firstEventTimeoutMs: 600_000,
		});
		expect(resolveStreamTimeouts({ PI_STREAM_IDLE_TIMEOUT_MS: "1000" })).toEqual({
			idleTimeoutMs: 1000,
			firstEventTimeoutMs: 300_000,
		});
	});

	it("reads each limit, the older idle alias, and 0 as off", () => {
		expect(resolveStreamTimeouts({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: "45000" }).firstEventTimeoutMs).toBe(45_000);
		expect(resolveStreamTimeouts({ PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: "90000" }).idleTimeoutMs).toBe(90_000);
		expect(
			resolveStreamTimeouts({ PI_STREAM_IDLE_TIMEOUT_MS: "1000", PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: "90000" })
				.idleTimeoutMs,
		).toBe(1000);
		expect(resolveStreamTimeouts({ PI_STREAM_IDLE_TIMEOUT_MS: "0" }).idleTimeoutMs).toBeUndefined();
		expect(resolveStreamTimeouts({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: "0" }).firstEventTimeoutMs).toBeUndefined();
		expect(resolveStreamTimeouts({ PI_STREAM_IDLE_TIMEOUT_MS: "soon" }).idleTimeoutMs).toBe(300_000);
	});
});

describe("primeStream", () => {
	async function* events(items: Array<{ type: string } | Error>): AsyncGenerator<{ type: string }> {
		for (const item of items) {
			if (item instanceof Error) throw item;
			yield item;
		}
	}

	async function collect(stream: AsyncGenerator<{ type: string }>): Promise<string[]> {
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		return types;
	}

	it("replays everything read until the first content block started, then continues", async () => {
		const primed = await primeStream(
			events([
				{ type: "message_start" },
				{ type: "ping" },
				{ type: "content_block_start" },
				{ type: "content_block_delta" },
			]),
		);

		expect(await collect(primed)).toEqual(["message_start", "ping", "content_block_start", "content_block_delta"]);
	});

	it("throws a failure before the first content block, with nothing replayed", async () => {
		await expect(primeStream(events([{ type: "message_start" }, new Error("overloaded_error")]))).rejects.toThrow(
			"overloaded_error",
		);
	});

	it("reports a stream that ends before message_start as an envelope error", async () => {
		await expect(primeStream(events([]))).rejects.toThrow(
			"Anthropic stream envelope error: stream ended before message_start",
		);
	});

	it("lets a failure after the first content block reach the consumer", async () => {
		const primed = await primeStream(
			events([{ type: "message_start" }, { type: "content_block_start" }, new Error("cut")]),
		);

		await expect(collect(primed)).rejects.toThrow("cut");
	});
});

describe("recoverFromFailure", () => {
	function params(overrides: Partial<MessageCreateParamsStreaming> = {}): MessageCreateParamsStreaming {
		return {
			model: "claude-test",
			max_tokens: 100,
			stream: true,
			system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
			messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
			...overrides,
		};
	}

	function failureOf(overrides: Partial<ClaudeCodeFailure> = {}): ClaudeCodeFailure {
		return {
			params: params(),
			recovery: createClaudeCodeRecovery(undefined),
			output: { diagnostics: undefined } as unknown as AssistantMessage,
			signal: undefined,
			...overrides,
		};
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("waits out the backoff of a transient failure and counts the retry", async () => {
		const failure = failureOf();

		const outcome = recoverFromFailure(httpError(529, anthropicBody("overloaded_error", "Overloaded")), failure, {});
		await vi.advanceTimersByTimeAsync(499);
		let settled = false;
		void outcome.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(await outcome).toBe(true);
		expect(failure.recovery.retriesDone).toBe(1);
	});

	it("surfaces a transient failure whose server-requested wait exceeds the cap, without waiting", async () => {
		const failure = failureOf();
		const error = httpError(429, anthropicBody("rate_limit_error", "Rate limited, retry later"), {
			"retry-after": "3600",
		});

		expect(await recoverFromFailure(error, failure, {})).toBe(false);
		expect(failure.recovery.retriesDone).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("surfaces a failure that is not transient, and one after the signal aborted", async () => {
		expect(await recoverFromFailure(httpError(401, "{}"), failureOf(), {})).toBe(false);
		const controller = new AbortController();
		controller.abort();
		expect(await recoverFromFailure(httpError(529, "{}"), failureOf({ signal: controller.signal }), {})).toBe(false);
	});

	it("answers a rejected cache_control by dropping its options first, then the field", async () => {
		const failure = failureOf();
		const rejection = httpError(400, "cache_control: Extra inputs are not permitted");

		expect(await recoverFromFailure(rejection, failure, {})).toBe(true);
		expect(failure.recovery.dropCacheControlOptions).toBe(true);
		expect(failure.recovery.dropCacheControl).toBe(false);
		expect(await recoverFromFailure(rejection, failure, {})).toBe(true);
		expect(failure.recovery.dropCacheControl).toBe(true);
		expect(failure.output.diagnostics?.map((entry) => entry.details?.reason)).toEqual([
			"cache_control_options_rejected",
			"cache_control_rejected",
		]);
		// With every breakpoint gone there is nothing left to drop.
		expect(await recoverFromFailure(rejection, failure, {})).toBe(false);
	});

	it("drops every breakpoint at once when the request carried no options", async () => {
		const failure = failureOf({
			params: params({ system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }] }),
		});

		await recoverFromFailure(httpError(400, "cache_control: Extra inputs are not permitted"), failure, {});

		expect(failure.recovery.dropCacheControl).toBe(true);
	});

	it("drops replayed thinking once, when a signature is rejected, and starts the retry budget over", async () => {
		const failure = failureOf();
		failure.recovery.retriesDone = 4;

		const rejected = httpError(400, "messages.1.content.0: Invalid `signature` in `thinking` block");
		expect(await recoverFromFailure(rejected, failure, {})).toBe(true);
		expect(failure.recovery.dropAllThinking).toBe(true);
		expect(failure.recovery.retriesDone).toBe(0);
		expect(await recoverFromFailure(rejected, failure, {})).toBe(false);
	});

	describe("slow mode", () => {
		function hooks(onFailure: AnthropicSlowModeHooks["onFailure"]): AnthropicSlowModeHooks {
			return { isActive: () => false, observe: () => {}, onFailure };
		}

		it("hands the failure, its slow headers and the wait so far to the hooks", async () => {
			const seen: AnthropicSlowModeFailure[] = [];
			const failure = failureOf({
				slowMode: {
					lane: "cred:1",
					sentSlow: true,
					hooks: hooks((slow) => {
						seen.push(slow);
						return undefined;
					}),
				},
			});
			const error = httpError(429, anthropicBody("rate_limit_error", "Slot busy"), {
				"anthropic-ratelimit-unified-slow-status": "slot_busy",
				"anthropic-ratelimit-unified-slow-retry-after": "20",
			});

			await recoverFromFailure(error, failure, { maxRetries: 0 });

			expect(seen).toEqual([
				{
					lane: "cred:1",
					httpStatus: 429,
					overloaded: false,
					signal: expect.objectContaining({ status: "slot_busy", retryAfterMs: 20_000 }),
					sentSlow: true,
					waitedMs: 0,
					attempts: 0,
				},
			]);
		});

		it("takes a capacity wait, counts it, and starts the retry budget over", async () => {
			const failure = failureOf({
				slowMode: { lane: "cred:1", sentSlow: true, hooks: hooks(() => ({ delayMs: 20_000, capacityWait: true })) },
			});
			failure.recovery.retriesDone = 7;
			const error = httpError(529, anthropicBody("overloaded_error", "Overloaded"));

			const outcome = recoverFromFailure(error, failure, {});
			await vi.advanceTimersByTimeAsync(20_000);

			expect(await outcome).toBe(true);
			expect(failure.recovery.slowWaitAttempts).toBe(1);
			expect(failure.recovery.slowWaitSinceMs).toBeDefined();
			expect(failure.recovery.retriesDone).toBe(0);
		});

		it("resends at once for a retry without a delay and counts no capacity wait", async () => {
			const failure = failureOf({
				slowMode: { lane: "cred:1", sentSlow: false, hooks: hooks(() => ({ delayMs: 0, capacityWait: false })) },
			});

			expect(await recoverFromFailure(httpError(429, "{}"), failure, {})).toBe(true);
			expect(failure.recovery.slowWaitAttempts).toBe(0);
			expect(failure.recovery.slowWaitSinceMs).toBeUndefined();
		});

		it("flags an overloaded_error envelope as an overload even without a 529", async () => {
			const seen: boolean[] = [];
			const failure = failureOf({
				slowMode: {
					lane: "cred:1",
					sentSlow: true,
					hooks: hooks((slow) => {
						seen.push(slow.overloaded);
						return undefined;
					}),
				},
			});

			await recoverFromFailure(new Error('{"error":{"type":"overloaded_error"}}'), failure, { maxRetries: 0 });
			await recoverFromFailure(httpError(529, "{}"), failure, { maxRetries: 0 });
			await recoverFromFailure(httpError(500, "{}"), failure, { maxRetries: 0 });

			expect(seen).toEqual([true, true, false]);
		});

		it("falls through to the normal retry when the hooks decline", async () => {
			const failure = failureOf({ slowMode: { lane: "cred:1", sentSlow: false, hooks: hooks(() => undefined) } });

			const outcome = recoverFromFailure(httpError(529, "{}"), failure, {});
			await vi.advanceTimersByTimeAsync(500);

			expect(await outcome).toBe(true);
			expect(failure.recovery.retriesDone).toBe(1);
		});
	});
});

describe("slow mode headers", () => {
	it("returns nothing for a response without slow-lane or unified-limit headers", () => {
		expect(parseAnthropicSlowModeHeaders(undefined)).toBeUndefined();
		expect(parseAnthropicSlowModeHeaders(new Headers({ "retry-after": "5" }))).toBeUndefined();
	});

	it("parses the slow-lane facts", () => {
		const signal = parseAnthropicSlowModeHeaders(
			new Headers({
				"anthropic-ratelimit-unified-slow-offer": "treatment",
				"anthropic-ratelimit-unified-slow-status": "slot_busy",
				"anthropic-ratelimit-unified-slow-retry-after": "12.5",
				"anthropic-ratelimit-unified-slow-max-wait": "600",
				"anthropic-ratelimit-unified-slow-budget-utilization": "1.7",
				"anthropic-ratelimit-unified-slow-budget-reset": "1900000000",
				"anthropic-ratelimit-unified-reset": "1800000000",
				"anthropic-ratelimit-unified-5h-reset": "1800000100",
				"anthropic-ratelimit-unified-7d-reset": "1800900000",
				"anthropic-ratelimit-unified-representative-claim": "five_hour",
				"anthropic-ratelimit-unified-overage-in-use": "true",
				"anthropic-ratelimit-unified-overage-status": "allowed_warning",
			}),
		);

		expect(signal).toEqual({
			offer: "treatment",
			status: "slot_busy",
			retryAfterMs: 12_500,
			maxWaitMs: 600_000,
			budgetUtilization: 1,
			budgetResetAtSec: 1_900_000_000,
			unifiedResetAtSec: 1_800_000_000,
			fiveHourResetAtSec: 1_800_000_100,
			weeklyResetAtSec: 1_800_900_000,
			unifiedLimitClaim: true,
			overageInUse: true,
			overageAllowed: true,
		});
	});

	it("maps an unknown slow status to unrecognized and reads the wrap-up allowance", () => {
		const signal = parseAnthropicSlowModeHeaders({
			"Anthropic-RateLimit-Unified-Slow-Status": "brand_new",
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-grace-5h-utilization": "0.25",
			"anthropic-ratelimit-unified-grace-7d-utilization": "bogus",
		});

		expect(signal).toMatchObject({
			status: "unrecognized",
			graceUtilization: { fiveHour: 0.25, sevenDay: 0 },
			unifiedLimitClaim: false,
			overageInUse: false,
		});
	});

	it("reports a unified status response even when both allowances read zero", () => {
		expect(parseAnthropicSlowModeHeaders(new Headers({ "anthropic-ratelimit-unified-status": "allowed" }))).toEqual({
			unifiedLimitClaim: false,
			overageInUse: false,
			graceUtilization: { fiveHour: 0, sevenDay: 0 },
		});
	});
});

describe("empty completion retry", () => {
	const model = { provider: "anthropic", id: "claude-test", api: "anthropic-messages" } as unknown as Model<Api>;

	function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 10,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
			...overrides,
		};
	}

	/** A stream of `events` that ends with `done` (or the given terminal) of `final`. */
	function attemptOf(final: AssistantMessage, events: AssistantMessageEvent[] = []): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: final });
			for (const event of events) stream.push(event);
			if (final.stopReason === "error") stream.push({ type: "error", reason: "error", error: final });
			else stream.push({ type: "done", reason: "stop", message: final });
		});
		return stream;
	}

	async function run(
		attempts: AssistantMessage[],
		options: Parameters<typeof withEmptyCompletionRetry>[2] = {},
		eventsOf: (index: number) => AssistantMessageEvent[] = () => [],
	): Promise<{ result: AssistantMessage; attemptsMade: number; seen: string[] }> {
		let attemptsMade = 0;
		const stream = withEmptyCompletionRetry(
			model,
			() => {
				const index = attemptsMade++;
				return attemptOf(attempts[Math.min(index, attempts.length - 1)], eventsOf(index));
			},
			options,
		);
		const seen: string[] = [];
		const consumed = (async () => {
			for await (const event of stream) seen.push(event.type);
		})();
		await vi.advanceTimersByTimeAsync(10_000);
		await consumed;
		return { result: await stream.result(), attemptsMade, seen };
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("replays an empty completion twice, after 500 and 1000 milliseconds, then lets it stand", async () => {
		const startTimes: number[] = [];
		let attempts = 0;
		const stream = withEmptyCompletionRetry(model, () => {
			startTimes.push(Date.now());
			attempts++;
			return attemptOf(message());
		});
		const done = stream.result();
		await vi.advanceTimersByTimeAsync(5000);
		const result = await done;

		expect(attempts).toBe(3);
		expect(startTimes[1] - startTimes[0]).toBe(500);
		expect(startTimes[2] - startTimes[1]).toBe(1000);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
	});

	it("shows the consumer one start and one done, whatever was replayed", async () => {
		const { seen, attemptsMade } = await run([message(), message()]);

		expect(attemptsMade).toBe(3);
		expect(seen).toEqual(["start", "done"]);
	});

	it("stops replaying once an attempt answers", async () => {
		const answered = message({
			content: [{ type: "text", text: "hello" }],
			usage: { ...message().usage, output: 5 },
		});

		const { result, attemptsMade } = await run([message(), answered]);

		expect(attemptsMade).toBe(2);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it.each([
		["a tool call", message({ content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] })],
		["more than one output token", message({ usage: { ...message().usage, output: 2 } })],
		["an error", message({ stopReason: "error", errorMessage: "boom" })],
		["a paused turn", message({ rawStopReason: "pause_turn" })],
		["a length stop", message({ stopReason: "length" })],
		[
			"whitespace only is still empty, but thinking with text is not",
			message({ content: [{ type: "text", text: "ok" }] }),
		],
	])("does not replay %s", async (_name, final) => {
		const { attemptsMade } = await run([final]);

		expect(attemptsMade).toBe(1);
	});

	it("replays a reply that holds only whitespace or thinking", async () => {
		const only = message({
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "  \n" },
			],
		});

		const { attemptsMade } = await run([only]);

		expect(attemptsMade).toBe(3);
	});

	it("does not replay once content has streamed to the consumer", async () => {
		const { attemptsMade, seen } = await run([message()], {}, () => [
			{ type: "text_delta", contentIndex: 0, delta: "partial", partial: message() },
		]);

		expect(attemptsMade).toBe(1);
		expect(seen).toEqual(["start", "text_delta", "done"]);
	});

	it("does not commit on a tool call marker alone", async () => {
		const { attemptsMade } = await run([message()], {}, () => [
			{ type: "toolcall_start", contentIndex: 0, partial: message() },
		]);

		expect(attemptsMade).toBe(3);
	});

	it("never replays an empty reply the caller accepts", async () => {
		const { attemptsMade } = await run([message()], { acceptEmptyResponse: true });

		expect(attemptsMade).toBe(1);
	});

	it("never replays after the signal aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const { attemptsMade } = await run([message()], { signal: controller.signal });

		expect(attemptsMade).toBe(1);
	});

	it("turns an attempt that throws into an error reply", async () => {
		const stream = withEmptyCompletionRetry(model, () => {
			throw new Error("setup failed");
		});

		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("setup failed");
	});
});

describe("the final error", () => {
	const unifiedHeaders = {
		"retry-after": "30",
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-5h-utilization": "1.0",
		"anthropic-ratelimit-unified-reset": "1800000000",
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"request-id": "req_1",
		"x-should-retry": "false",
		"content-type": "application/json",
		"set-cookie": "secret",
	};

	it("carries its status, retry hint and the unified rate-limit headers in a diagnostic", () => {
		const message = { diagnostics: undefined } as { diagnostics?: AssistantMessage["diagnostics"] };

		appendProviderHttpErrorDiagnostic(
			message,
			httpError(429, anthropicBody("rate_limit_error", "Limit"), unifiedHeaders),
		);

		expect(getProviderHttpErrorDetails(message)).toEqual({
			status: 429,
			retryAfterMs: 30_000,
			headers: {
				"retry-after": "30",
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-5h-utilization": "1.0",
				"anthropic-ratelimit-unified-reset": "1800000000",
				"anthropic-ratelimit-unified-representative-claim": "five_hour",
				"request-id": "req_1",
				"x-should-retry": "false",
			},
		});
	});

	it("keeps them when a retry hint beyond the cap ends the request with the response itself", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const message = { diagnostics: undefined } as { diagnostics?: AssistantMessage["diagnostics"] };
		const error = httpError(529, anthropicBody("overloaded_error", "Overloaded"), {
			...unifiedHeaders,
			"retry-after": "3600",
			"x-should-retry": "true",
		});
		const failure = {
			params: {} as MessageCreateParamsStreaming,
			recovery: createClaudeCodeRecovery(undefined),
			output: message as AssistantMessage,
			signal: undefined,
		};

		// The loop finds nothing to retry, so the error it rethrows is the response's own.
		expect(await recoverFromFailure(error, failure, { maxRetryDelayMs: 60_000 })).toBe(false);
		appendProviderHttpErrorDiagnostic(message, error);

		expect(getProviderHttpErrorDetails(message)).toMatchObject({
			status: 529,
			retryAfterMs: 3_600_000,
			headers: { "anthropic-ratelimit-unified-reset": "1800000000" },
		});
		vi.restoreAllMocks();
	});

	it("records nothing for a failure with no HTTP status", () => {
		const message = { diagnostics: undefined } as { diagnostics?: AssistantMessage["diagnostics"] };

		appendProviderHttpErrorDiagnostic(message, new Error("socket hang up"));

		expect(message.diagnostics).toBeUndefined();
	});
});
