import type {
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicApiError } from "../src/api/claude-subscription/client.ts";
import {
	claudeCodeThreadsEnabled,
	createThreadTurn,
	messageThreadsBeta,
	type StoredReply,
} from "../src/api/claude-subscription/threads.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model } from "../src/types.ts";

const baseUrl = "https://api.anthropic.com";
const marker = { type: "ephemeral" } as const;

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 100,
};

let sessionCounter = 0;
let sessionId = "";

beforeEach(() => {
	sessionId = `thread-session-${++sessionCounter}`;
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
	cleanupSessionResources();
});

function paramsOf(
	messages: MessageParam[],
	overrides: Partial<MessageCreateParamsStreaming> = {},
): MessageCreateParamsStreaming {
	return {
		model: "claude-sonnet-4-5",
		messages,
		system: [
			{ type: "text", text: "billing" },
			{ type: "text", text: "prompt", cache_control: marker },
		],
		tools: [{ name: "_lookup", description: "Look it up", input_schema: { type: "object", properties: {} } }],
		max_tokens: 100,
		stream: true,
		betas: ["claude-code-20250219"],
		...overrides,
	};
}

const first: MessageParam = { role: "user", content: "first" };
const answer: MessageParam = { role: "assistant", content: [{ type: "text", text: "answer" }] };
const second: MessageParam = { role: "user", content: "second" };

function stored(messageId: string, ...messages: MessageParam[]): StoredReply {
	return { messageId, messages };
}

/** Plans and settles a first turn, so the session has a stored reply to continue. */
function completeFirstTurn(): void {
	const turn = createThreadTurn(sessionId, baseUrl);
	turn.plan(paramsOf([first]));
	turn.settle(stored("msg_1", answer));
}

function threadError(code: string, status = 400): AnthropicApiError {
	const body = JSON.stringify({
		type: "error",
		error: { type: "invalid_request_error", details: { error_code: code } },
	});
	return new AnthropicApiError(status, `${status} ${body}`, new Headers(), { type: "invalid_request_error", code });
}

describe("Claude subscription thread planning", () => {
	it("creates a thread for the first request and adds the threads beta to that body only", () => {
		const params = paramsOf([first]);

		const plan = createThreadTurn(sessionId, baseUrl).plan(params);

		expect(plan?.kind).toBe("create");
		expect(plan?.body.thread).toEqual({ type: "create" });
		expect(plan?.body.betas).toEqual(["claude-code-20250219", messageThreadsBeta]);
		expect(Object.keys(plan?.body ?? {}).at(-1)).toBe("thread");
		expect(params.betas).toEqual(["claude-code-20250219"]);
		expect(params).not.toHaveProperty("thread");
	});

	it("continues the stored reply with only the appended messages, and keeps system and tools", () => {
		completeFirstTurn();
		const params = paramsOf([first, answer, second]);

		const plan = createThreadTurn(sessionId, baseUrl).plan(params);

		expect(plan?.kind).toBe("continue");
		expect(plan?.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
		expect(plan?.body.messages).toEqual([second]);
		expect(plan?.body.system).toBe(params.system);
		expect(plan?.body.tools).toBe(params.tools);
		expect(plan?.body.betas).toEqual(["claude-code-20250219", messageThreadsBeta]);
		expect(Object.keys(plan?.body ?? {}).at(-1)).toBe("thread");
	});

	it("marks the first appended block and the newest, and drops the other breakpoints", () => {
		completeFirstTurn();
		const results: MessageParam = {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "a", content: "1" },
				{ type: "tool_result", tool_use_id: "b", content: "2", cache_control: marker },
				{ type: "tool_result", tool_use_id: "c", content: "3", cache_control: marker },
			],
		};

		const plan = createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, results]));

		const blocks = (plan?.body.messages[0].content ?? []) as Array<{ cache_control?: unknown }>;
		expect(blocks.map((block) => block.cache_control)).toEqual([marker, undefined, marker]);
	});

	it("continues a reply once: the next request creates a new thread", () => {
		completeFirstTurn();
		const params = paramsOf([first, answer, second]);

		expect(createThreadTurn(sessionId, baseUrl).plan(params)?.kind).toBe("continue");
		expect(createThreadTurn(sessionId, baseUrl).plan(params)?.kind).toBe("create");
	});

	it("returns the same plan for the same params, so a retry resends the same continue", () => {
		completeFirstTurn();
		const turn = createThreadTurn(sessionId, baseUrl);
		const params = paramsOf([first, answer, second]);

		const plan = turn.plan(params);

		expect(turn.plan(params)).toBe(plan);
		// A rebuilt body is planned again from the reply this turn claimed, so it is still a continue.
		expect(turn.plan(paramsOf([first, answer, second]))?.kind).toBe("continue");
	});

	it("continues within 270 seconds of the stored reply and not after", () => {
		completeFirstTurn();
		vi.setSystemTime(Date.now() + 269_000);
		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second]))?.kind).toBe("continue");

		completeFirstTurn();
		vi.setSystemTime(Date.now() + 271_000);
		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second]))?.kind).toBe("create");
	});

	it.each<[string, Partial<MessageCreateParamsStreaming>]>([
		["system", { system: [{ type: "text", text: "another prompt" }] }],
		["tools", { tools: [] }],
		["thinking", { thinking: { type: "adaptive" } }],
		["effort", { output_config: { effort: "low" } }],
		["tool choice", { tool_choice: { type: "any" } }],
		["model", { model: "claude-sonnet-4-6" }],
		["betas", { betas: ["claude-code-20250219", "other-beta"] }],
	])("creates a new thread when the %s changed", (_name, change) => {
		completeFirstTurn();

		const plan = createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second], change));

		expect(plan?.kind).toBe("create");
	});

	it("creates a new thread when an earlier message changed or nothing was appended", () => {
		completeFirstTurn();

		expect(
			createThreadTurn(sessionId, baseUrl).plan(paramsOf([{ role: "user", content: "other" }, answer, second]))
				?.kind,
		).toBe("create");
		completeFirstTurn();
		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer]))?.kind).toBe("create");
	});

	it("treats a string message and its single text block as the same message", () => {
		completeFirstTurn();
		const asBlock: MessageParam = { role: "user", content: [{ type: "text", text: "first", cache_control: marker }] };

		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([asBlock, answer, second]))?.kind).toBe("continue");
	});

	it("sends no thread for a body a thread cannot hold", () => {
		const withEdit = paramsOf([first], {
			context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
		});
		const turnScoped = paramsOf([
			first,
			{ role: "system", content: [{ type: "text", text: "note" }], clear_at: "next_user_message" } as MessageParam,
		]);

		expect(createThreadTurn(sessionId, baseUrl).plan(withEdit)).toBeUndefined();
		expect(createThreadTurn(sessionId, baseUrl).plan(turnScoped)).toBeUndefined();
		expect(
			createThreadTurn(sessionId, baseUrl).plan(
				paramsOf([first], { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }),
			)?.kind,
		).toBe("create");
	});

	it("starts over when a fallback model answered, which the server does not store", () => {
		const turn = createThreadTurn(sessionId, baseUrl);
		turn.plan(paramsOf([first]));
		turn.settle(undefined);

		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second]))?.kind).toBe("create");
	});

	it("keeps the sessions apart, and forgets a session when its resources are cleaned up", () => {
		completeFirstTurn();
		const other = createThreadTurn(`${sessionId}-other`, baseUrl);

		expect(other.plan(paramsOf([first, answer, second]))?.kind).toBe("create");

		cleanupSessionResources(sessionId);
		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second]))?.kind).toBe("create");
	});
});

describe("Claude subscription thread refusals", () => {
	it("replays a continue the server refused as a new thread", () => {
		completeFirstTurn();
		const turn = createThreadTurn(sessionId, baseUrl);
		const params = paramsOf([first, answer, second]);
		turn.plan(params);

		expect(turn.recover(threadError("thread_not_found"))).toBe("replay");

		expect(turn.plan(params)?.kind).toBe("create");
		turn.settle(stored("msg_2", answer));
		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second, answer, second]))?.kind).toBe(
			"continue",
		);
	});

	/** A turn whose continue is refused and replayed as a new thread that succeeds, leaving the next reply stored. */
	function refuseAndReplay(messages: MessageParam[], nextReplyId: string): void {
		const turn = createThreadTurn(sessionId, baseUrl);
		turn.plan(paramsOf(messages));
		expect(turn.recover(threadError("thread_not_found"))).toBe("replay");
		turn.plan(paramsOf(messages));
		turn.settle(stored(nextReplyId, answer));
	}

	it("stops threading the session after two refused continues in a row", () => {
		completeFirstTurn();
		refuseAndReplay([first, answer, second], "msg_2");

		const next = createThreadTurn(sessionId, baseUrl);
		next.plan(paramsOf([first, answer, second, answer, second]));

		expect(next.recover(threadError("thread_not_found"))).toBe("unthreaded");
		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second]))).toBeUndefined();
	});

	it("counts refused continues from the last continue that succeeded", () => {
		completeFirstTurn();
		refuseAndReplay([first, answer, second], "msg_2");
		const conversation = [first, answer, second, answer, second];
		const succeeding = createThreadTurn(sessionId, baseUrl);
		expect(succeeding.plan(paramsOf(conversation))?.kind).toBe("continue");
		succeeding.settle(stored("msg_3", answer));

		const refused = createThreadTurn(sessionId, baseUrl);
		refused.plan(paramsOf([...conversation, answer, second]));

		expect(refused.recover(threadError("thread_not_found"))).toBe("replay");
	});

	it("sends the request without a thread, and every later request of the session too, when threads are unsupported", () => {
		completeFirstTurn();
		const turn = createThreadTurn(sessionId, baseUrl);
		const params = paramsOf([first, answer, second]);
		turn.plan(params);

		expect(turn.recover(threadError("thread_unsupported_request"))).toBe("unthreaded");

		expect(turn.plan(params)).toBeUndefined();
		expect(
			createThreadTurn(sessionId, baseUrl).plan(paramsOf([first, answer, second, answer, second])),
		).toBeUndefined();
	});

	it("gives up on threads when even a new thread was refused", () => {
		const turn = createThreadTurn(sessionId, baseUrl);
		turn.plan(paramsOf([first]));

		expect(turn.recover(threadError("thread_invalid_request"))).toBe("unthreaded");
		expect(createThreadTurn(sessionId, baseUrl).plan(paramsOf([first]))).toBeUndefined();
	});

	it("recognizes a thread 400 that carries no code by its text", () => {
		const turn = createThreadTurn(sessionId, baseUrl);
		turn.plan(paramsOf([first]));
		const error = new AnthropicApiError(400, "400 thread: Extra inputs are not permitted", new Headers());

		expect(turn.recover(error)).toBe("unthreaded");
	});

	it.each([
		[
			"another 400",
			new AnthropicApiError(400, "400 prompt is too long", new Headers(), { type: "invalid_request_error" }),
		],
		[
			"a 404 for an unknown model",
			new AnthropicApiError(404, "404 model: claude-x", new Headers(), { type: "not_found_error" }),
		],
		["a 529", new AnthropicApiError(529, "529 overloaded", new Headers(), { type: "overloaded_error" })],
		["a plain error", new Error("socket hang up")],
	])("leaves %s to the rest of the retry ladder", (_name, error) => {
		const turn = createThreadTurn(sessionId, baseUrl);
		turn.plan(paramsOf([first]));

		expect(turn.recover(error)).toBeUndefined();
	});
});

describe("claudeCodeThreadsEnabled", () => {
	it("is on for Claude 4.5 and newer on Anthropic's own endpoint", () => {
		expect(claudeCodeThreadsEnabled(model)).toBe(true);
		expect(claudeCodeThreadsEnabled({ ...model, id: "claude-opus-5-1" })).toBe(true);
		expect(claudeCodeThreadsEnabled({ ...model, id: "claude-sonnet-4-5-20250929" })).toBe(true);
	});

	it("is off for older Claude models and for other endpoints", () => {
		expect(claudeCodeThreadsEnabled({ ...model, id: "claude-sonnet-4" })).toBe(false);
		expect(claudeCodeThreadsEnabled({ ...model, id: "claude-3-5-haiku-20241022" })).toBe(false);
		expect(claudeCodeThreadsEnabled({ ...model, baseUrl: "https://gateway.example.com" })).toBe(false);
	});

	it("follows the model's own flag over both rules", () => {
		expect(
			claudeCodeThreadsEnabled({ ...model, id: "claude-sonnet-4", compat: { supportsMessageThreads: true } }),
		).toBe(true);
		expect(claudeCodeThreadsEnabled({ ...model, compat: { supportsMessageThreads: false } })).toBe(false);
	});
});
