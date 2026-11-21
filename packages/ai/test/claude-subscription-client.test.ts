import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AnthropicApiError,
	AnthropicConnectionError,
	AnthropicConnectionTimeoutError,
	createClaudeSubscriptionClient,
	type MessagesRequestBody,
} from "../src/api/claude-subscription/client.ts";
import { getHeadersFromError, getHttpStatusFromError } from "../src/utils/retry-after.ts";

const token = "sk-ant-oat-test";

interface Sent {
	url: string;
	init: RequestInit;
}

const body: MessagesRequestBody = {
	model: "claude-test",
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 10,
	stream: true,
	betas: ["beta-one", "beta-two"],
};

function createClient(fetch: typeof globalThis.fetch, baseUrl = "https://api.anthropic.com") {
	return createClaudeSubscriptionClient({ token, baseUrl, sessionId: "session-1", callerHeaders: undefined, fetch });
}

function recordingFetch(respond: () => Response = () => new Response("ok")) {
	const sent: Sent[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		sent.push({ url: String(input), init: init ?? {} });
		return respond();
	};
	return { sent, fetch };
}

const noRequestOptions = { signal: undefined, timeoutMs: undefined };

describe("Claude subscription client request", () => {
	it("posts to the beta Messages endpoint with the header record and the body JSON", async () => {
		const { sent, fetch } = recordingFetch();

		await createClient(fetch).createMessage(body, noRequestOptions);

		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
		expect(sent[0].init.method).toBe("POST");
		const headers = sent[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${token}`);
		expect(headers["X-Claude-Code-Session-Id"]).toBe("session-1");
		expect(Object.keys(headers).indexOf("Authorization")).toBeLessThan(Object.keys(headers).indexOf("x-app"));
	});

	it("moves the betas into the anthropic-beta header and leaves them out of the body", async () => {
		const { sent, fetch } = recordingFetch();

		await createClient(fetch).createMessage(body, noRequestOptions);

		const headers = sent[0].init.headers as Record<string, string>;
		expect(headers["anthropic-beta"]).toBe("beta-one,beta-two");
		// The body keeps the key order it was built in.
		expect(sent[0].init.body).toBe(
			'{"model":"claude-test","messages":[{"role":"user","content":"hi"}],"max_tokens":10,"stream":true}',
		);
	});

	it("serializes a thread after the other fields", async () => {
		const { sent, fetch } = recordingFetch();

		await createClient(fetch).createMessage(
			{ ...body, thread: { type: "continue", previous_message_id: "msg_1" } },
			noRequestOptions,
		);

		expect(String(sent[0].init.body).endsWith('"thread":{"type":"continue","previous_message_id":"msg_1"}}')).toBe(
			true,
		);
	});

	it("joins the path to a base URL with or without a trailing slash", async () => {
		const { sent, fetch } = recordingFetch();

		await createClient(fetch, "https://gateway.example.com/anthropic/").createMessage(body, noRequestOptions);

		expect(sent[0].url).toBe("https://gateway.example.com/anthropic/v1/messages?beta=true");
	});

	it("sends once: it never retries", async () => {
		const { sent, fetch } = recordingFetch(() => new Response("overloaded", { status: 529 }));

		await expect(createClient(fetch).createMessage(body, noRequestOptions)).rejects.toBeInstanceOf(AnthropicApiError);

		expect(sent).toHaveLength(1);
	});
});

describe("Claude subscription client errors", () => {
	function errorResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
		return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers });
	}

	async function failure(response: Response): Promise<AnthropicApiError> {
		const { fetch } = recordingFetch(() => response);
		const error = await createClient(fetch)
			.createMessage(body, noRequestOptions)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AnthropicApiError);
		return error as AnthropicApiError;
	}

	it("carries the status, the body text, the headers, the error type and its code", async () => {
		const payload = {
			type: "error",
			error: { type: "invalid_request_error", message: "thread gone", details: { error_code: "thread_not_found" } },
		};

		const error = await failure(errorResponse(400, payload, { "request-id": "req_1", "retry-after": "7" }));

		expect(error.status).toBe(400);
		expect(error.message).toBe(`400 ${JSON.stringify(payload)}`);
		expect(error.type).toBe("invalid_request_error");
		expect(error.code).toBe("thread_not_found");
		expect(error.headers.get("request-id")).toBe("req_1");
		// What retry and recovery read from an error.
		expect(getHttpStatusFromError(error)).toBe(400);
		expect(getHeadersFromError(error)).toBe(error.headers);
	});

	it("uses the error type as the code when the body has no error code", async () => {
		const error = await failure(
			errorResponse(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
		);

		expect(error.code).toBe("overloaded_error");
		expect(error.type).toBe("overloaded_error");
	});

	it("reports a body that is not JSON as it is, and an empty body by its status", async () => {
		const text = await failure(errorResponse(502, "Bad Gateway"));
		const empty = await failure(errorResponse(503, ""));

		expect(text.message).toBe("502 Bad Gateway");
		expect(text.type).toBeUndefined();
		expect(text.code).toBeUndefined();
		expect(empty.message).toBe("503 status code (no body)");
	});

	it("reads at most 64 KiB of an error body", async () => {
		const error = await failure(errorResponse(500, "x".repeat(200 * 1024)));

		expect(error.message.length).toBeLessThan(65 * 1024);
		expect(error.message).toContain("[Response body truncated after 64 KiB]");
	});
});

describe("Claude subscription client aborts and timeouts", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("throws the abort error without sending when the signal is already aborted", async () => {
		const { sent, fetch } = recordingFetch();

		const error = await createClient(fetch)
			.createMessage(body, { signal: AbortSignal.abort(), timeoutMs: undefined })
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ name: "AbortError", message: "Request was aborted." });
		expect(sent).toHaveLength(0);
	});

	it("throws the abort error when the caller aborts while the request is in flight", async () => {
		const controller = new AbortController();
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

		const pending = createClient(fetch)
			.createMessage(body, { signal: controller.signal, timeoutMs: 10_000 })
			.catch((caught: unknown) => caught);
		controller.abort();

		expect(await pending).toMatchObject({ name: "AbortError", message: "Request was aborted." });
	});

	it("keeps the caller's signal linked after the response headers, so aborting ends the body too", async () => {
		const controller = new AbortController();
		let requestSignal: AbortSignal | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response("ok");
		};

		await createClient(fetch).createMessage(body, { signal: controller.signal, timeoutMs: 10_000 });
		expect(requestSignal?.aborted).toBe(false);
		controller.abort();

		expect(requestSignal?.aborted).toBe(true);
	});

	it("fails with a timeout error when no response headers arrive in time", async () => {
		const fetch: typeof globalThis.fetch = (_input, init) =>
			new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

		const pending = createClient(fetch)
			.createMessage(body, { signal: undefined, timeoutMs: 5000 })
			.catch((caught: unknown) => caught);
		await vi.advanceTimersByTimeAsync(5000);

		const error = await pending;
		expect(error).toBeInstanceOf(AnthropicConnectionTimeoutError);
		expect((error as Error).message).toBe("Request timed out.");
	});

	it("stops the timeout once the headers arrived", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response("ok");
		};

		await createClient(fetch).createMessage(body, { signal: undefined, timeoutMs: 5000 });
		await vi.advanceTimersByTimeAsync(60_000);

		expect(requestSignal?.aborted).toBe(false);
	});

	it("wraps a failed transport in a connection error that keeps the cause", async () => {
		const cause = new Error("socket hang up");
		const fetch: typeof globalThis.fetch = async () => {
			throw cause;
		};

		const error = await createClient(fetch)
			.createMessage(body, noRequestOptions)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AnthropicConnectionError);
		expect((error as Error).message).toBe("Connection error.");
		expect((error as Error).cause).toBe(cause);
	});
});
