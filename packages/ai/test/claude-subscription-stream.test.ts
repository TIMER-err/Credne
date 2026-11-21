import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import { DEFAULT_CLAUDE_CODE_VERSION, getClaudeCodeVersion } from "../src/api/claude-subscription/fingerprint.ts";
import type {
	AnthropicSlowModeFailure,
	AnthropicSlowModeHooks,
	AnthropicSlowModeSignal,
} from "../src/api/claude-subscription/slow-mode.ts";
import { isClaudeSubscriptionRequest, streamClaudeSubscription } from "../src/api/claude-subscription/stream.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Message, Model, Tool, ToolCall } from "../src/types.ts";
import { getProviderHttpErrorDetails } from "../src/utils/diagnostics.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { xxHash64 } from "../src/utils/xxhash64.ts";

const oauthKey = "sk-ant-oat-test";
const apiKey = "sk-ant-api03-test";
const uuidSession = "123e4567-e89b-42d3-a456-426614174000";
const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cchSeed = 0x4d659218e32a3268n;
const billingPattern =
	/^x-anthropic-billing-header: cc_version=(\d+\.\d+\.\d+)\.([0-9a-f]{3}); cc_entrypoint=cli; cch=([0-9a-f]{5});$/;
const identityText = "You are Claude Code, Anthropic's official CLI for Claude.";

interface SystemBlock {
	type: string;
	text: string;
	cache_control?: unknown;
}

interface WireBody {
	model: string;
	messages: Array<{ role: string; content: unknown }>;
	system?: SystemBlock[];
	tools?: Array<{ name: string }>;
	metadata?: { user_id?: string };
	thread?: unknown;
}

interface WireRequest {
	url: string;
	headers: Headers;
	rawBody: string;
	body: WireBody;
}

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 100,
};

function sse(events: Array<{ type: string } & Record<string, unknown>>): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function textReply(modelId = model.id): Response {
	return sse([
		{
			type: "message_start",
			message: { id: "msg_text", model: modelId, usage: { input_tokens: 10, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function toolUseReply(name: string, input: Record<string, unknown> = { value: "x" }): Response {
	return sse([
		{
			type: "message_start",
			message: { id: "msg_tool", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function errorResponse(message: string, errorCode?: string): Response {
	return Response.json(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message,
				...(errorCode ? { details: { error_code: errorCode } } : {}),
			},
		},
		{ status: 400 },
	);
}

type WireEvent = { type: string } & Record<string, unknown>;

const messageStartEvent = (id = "msg_1"): WireEvent => ({
	type: "message_start",
	message: { id, model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
});

const textBlockEvents = (index: number, text: string): WireEvent[] => [
	{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index, delta: { type: "text_delta", text } },
	{ type: "content_block_stop", index },
];

const messageDeltaEvent = (stopReason: string | null = "end_turn", outputTokens = 1): WireEvent => ({
	type: "message_delta",
	delta: { stop_reason: stopReason },
	usage: { output_tokens: outputTokens },
});

const messageStopEvent: WireEvent = { type: "message_stop" };

function overloadedResponse(headers: Record<string, string> = {}): Response {
	return Response.json(
		{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
		{ status: 529, headers },
	);
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
	const merged = new Headers(response.headers);
	for (const [name, value] of Object.entries(headers)) merged.set(name, value);
	return new Response(response.body, { status: response.status, headers: merged });
}

type Responder = (request: WireRequest, attempt: number) => Response;

/** Fake Anthropic endpoint that records every request exactly as it reaches the network layer. */
function harness(respond: Responder = () => textReply()) {
	const requests: WireRequest[] = [];
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (input, init) => {
		const rawBody = init?.body as string;
		const request: WireRequest = {
			url: String(input),
			headers: new Headers(init?.headers),
			rawBody,
			body: JSON.parse(rawBody) as WireBody,
		};
		requests.push(request);
		return respond(request, requests.length);
	};
	return { requests, fetch };
}

function tool(name: string): Tool {
	return { name, description: `Tool ${name}`, parameters: Type.Object({ value: Type.String() }) };
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

interface TurnInput {
	/** The stream function under test: the subscription stream itself, or the API's entry that dispatches to it. */
	entry?: typeof stream;
	messages?: Message[];
	systemPrompt?: string | null;
	tools?: Tool[];
	model?: Model<"anthropic-messages">;
	options?: AnthropicOptions;
}

function run(h: ReturnType<typeof harness>, input: TurnInput = {}): Promise<AssistantMessage> {
	const context = normalizeContext({
		...(input.systemPrompt === null ? {} : { systemPrompt: input.systemPrompt ?? "You are a test assistant." }),
		tools: input.tools ?? [tool("lookup")],
		messages: input.messages ?? [user("Hello world, this is a test")],
	});
	return (input.entry ?? streamClaudeSubscription)(input.model ?? model, context, {
		apiKey: oauthKey,
		fetch: h.fetch,
		maxRetries: 0,
		...input.options,
	}).result();
}

/** Runs fake time forward until `work` settles: each step lets the async work between timers finish before the next. */
async function settleWithFakeTime<T>(work: Promise<T>, stepMs = 10): Promise<T> {
	let settled = false;
	const tracked = work.finally(() => {
		settled = true;
	});
	while (!settled) await vi.advanceTimersByTimeAsync(stepMs);
	return tracked;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function billingOf(request: WireRequest) {
	const match = billingPattern.exec(request.body.system?.[0]?.text ?? "");
	if (!match) throw new Error(`system[0] is not a billing block: ${request.body.system?.[0]?.text}`);
	return { ccVersion: match[1], fingerprint: match[2], cch: match[3] };
}

/** Recomputes the cch the way Claude Code does: hash of the body with the placeholder, low 20 bits. */
function expectedCch(request: WireRequest): string {
	const placeholderBody = request.rawBody.replace(/cch=[0-9a-f]{5};/, "cch=00000;");
	return (xxHash64(new TextEncoder().encode(placeholderBody), cchSeed) & 0xfffffn).toString(16).padStart(5, "0");
}

function userIdOf(request: WireRequest): Record<string, string> {
	return JSON.parse(request.body.metadata?.user_id ?? "null") as Record<string, string>;
}

function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

beforeEach(() => {
	vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", undefined);
	vi.stubEnv("ANTHROPIC_OAUTH_ACCOUNT_UUID", undefined);
	vi.stubEnv("ANTHROPIC_OAUTH_DEVICE_ID", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
	cleanupSessionResources();
});

describe("Anthropic subscription (OAuth) wire format", () => {
	it("sends Claude Code's client headers with Bearer auth", async () => {
		const h = harness();

		const result = await run(h, { options: { sessionId: uuidSession } });

		expect(result.stopReason).toBe("stop");
		const [request] = h.requests;
		expect(request.url).toContain("https://api.anthropic.com/v1/messages");
		expect(request.headers.get("user-agent")).toBe(`claude-cli/${getClaudeCodeVersion()} (external, cli)`);
		expect(request.headers.get("user-agent")).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
		expect(request.headers.get("x-app")).toBe("cli");
		expect(request.headers.get("x-stainless-package-version")).toBe("0.128.0");
		expect(request.headers.get("x-stainless-lang")).toBe("js");
		expect(request.headers.get("x-stainless-runtime")).toBe("node");
		expect(request.headers.get("x-stainless-retry-count")).toBe("0");
		expect(request.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
		expect(request.headers.get("authorization")).toBe(`Bearer ${oauthKey}`);
		expect(request.headers.get("x-api-key")).toBeNull();
	});

	it("sends the caller's session id verbatim, and none when the request has no session", async () => {
		const h = harness();

		await run(h, { options: { sessionId: uuidSession } });
		await run(h, { options: { sessionId: "not-a-uuid-session" } });
		await run(h, { options: { metadata: { user_id: JSON.stringify({ session_id: uuidSession }) } } });
		await run(h);
		await run(h);

		const [uuid, verbatim, fromMetadata, noneA, noneB] = h.requests;
		expect(uuid.headers.get("x-claude-code-session-id")).toBe(uuidSession);
		expect(userIdOf(uuid).session_id).toBe(uuidSession);
		expect(verbatim.headers.get("x-claude-code-session-id")).toBe("not-a-uuid-session");
		expect(userIdOf(verbatim).session_id).toBe("not-a-uuid-session");
		expect(fromMetadata.headers.get("x-claude-code-session-id")).toBe(uuidSession);
		expect(noneA.headers.get("x-claude-code-session-id")).toBeNull();
		expect(userIdOf(noneA).session_id).toMatch(uuidShape);
		expect(userIdOf(noneA).session_id).not.toBe(userIdOf(noneB).session_id);
	});

	it("advertises the Claude Code and OAuth betas and never the 1m context beta", async () => {
		const h = harness();

		await run(h);
		await run(h, {
			model: { ...model, reasoning: true },
			options: { thinkingEnabled: true, thinkingBudgetTokens: 1024 },
		});

		const [plain, thinking] = h.requests.map((request) => (request.headers.get("anthropic-beta") ?? "").split(","));
		for (const betas of [plain, thinking]) {
			expect(betas).toContain("claude-code-20250219");
			expect(betas).toContain("oauth-2025-04-20");
			expect(betas.some((beta) => beta.includes("context-1m"))).toBe(false);
			expect(new Set(betas).size).toBe(betas.length);
		}
		expect(plain).not.toContain("effort-2025-11-24");
		expect(thinking).toContain("effort-2025-11-24");
	});

	it("keeps the Claude Code headers over caller headers of the same name", async () => {
		const h = harness();

		await run(h, {
			options: { headers: { "user-agent": "custom-agent", "x-app": "custom-app", "x-custom": "kept" } },
		});

		const [request] = h.requests;
		expect(request.headers.get("user-agent")).toMatch(/^claude-cli\//);
		expect(request.headers.get("x-app")).toBe("cli");
		expect(request.headers.get("x-custom")).toBe("kept");
	});

	it("sends the billing block first with a cch that verifies against the body", async () => {
		const h = harness();

		await run(h);

		const [request] = h.requests;
		const billing = billingOf(request);
		const version = getClaudeCodeVersion();
		// Characters 4, 7 and 20 of "Hello world, this is a test" are "o", "o" and a space.
		expect(billing.ccVersion).toBe(version);
		expect(billing.fingerprint).toBe(sha256Hex(`59cf53e54c78oo ${version}`).slice(0, 3));
		expect(billing.cch).not.toBe("00000");
		expect(billing.cch).toBe(expectedCch(request));
		expect(request.rawBody.match(/cch=/g)).toHaveLength(1);
		expect(request.body.system?.[0]).toEqual({
			type: "text",
			text: `x-anthropic-billing-header: cc_version=${version}.${billing.fingerprint}; cc_entrypoint=cli; cch=${billing.cch};`,
		});
	});

	it("follows the billing block with the identity block and the system prompt", async () => {
		const h = harness();

		await run(h, { systemPrompt: "You are a test assistant." });
		await run(h, { systemPrompt: null });

		const [withPrompt, withoutPrompt] = h.requests;
		expect(withPrompt.body.system).toHaveLength(3);
		expect(withPrompt.body.system?.[0]).not.toHaveProperty("cache_control");
		expect(withPrompt.body.system?.[1]).toMatchObject({ type: "text", text: identityText });
		expect(withPrompt.body.system?.[2]).toMatchObject({ type: "text", text: "You are a test assistant." });
		expect(withoutPrompt.body.system).toHaveLength(2);
		expect(withoutPrompt.body.system?.[1]).toMatchObject({ text: identityText });
	});

	it("derives the billing fingerprint from the first user turn", async () => {
		const h = harness();

		await run(h, { messages: [user("   "), user("abcdefghijklmnopqrstuvwxyz")] });
		await run(h, {
			messages: [{ role: "user", content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }], timestamp: 1 }],
		});
		await run(h, { messages: [user("abcdefghijklmnopqrstuvwxyz"), user("ignored later turn")] });

		const fingerprints = h.requests.map((request) => billingOf(request).fingerprint);
		expect(fingerprints).toEqual(Array(3).fill(sha256Hex(`59cf53e54c78ehu${getClaudeCodeVersion()}`).slice(0, 3)));
	});

	it("prefixes tool names on the wire and decodes them in tool calls", async () => {
		const h = harness((_request, attempt) => (attempt === 1 ? toolUseReply("_lookup") : textReply()));
		const events: string[] = [];

		const first = streamClaudeSubscription(
			model,
			normalizeContext({ systemPrompt: "s", tools: [tool("lookup"), tool("read")], messages: [user("go")] }),
			{ apiKey: oauthKey, fetch: h.fetch, maxRetries: 0 },
		);
		for await (const event of first) {
			if (event.type === "toolcall_start" || event.type === "toolcall_end") {
				const block = event.partial.content[event.contentIndex];
				if (block?.type === "toolCall") events.push(`${event.type}:${block.name}`);
			}
		}
		const result = await first.result();

		expect(h.requests[0].body.tools?.map((definition) => definition.name)).toEqual(["_lookup", "_read"]);
		expect(toolCallsOf(result).map((call) => call.name)).toEqual(["lookup"]);
		expect(events).toEqual(["toolcall_start:lookup", "toolcall_end:lookup"]);
		expect(result.stopReason).toBe("toolUse");
	});

	it("keeps Anthropic's built-in tool names unprefixed", async () => {
		const h = harness();

		await run(h, {
			tools: [tool("web_search"), tool("code_execution"), tool("text_editor"), tool("computer"), tool("bash")],
		});

		expect(h.requests[0].body.tools?.map((definition) => definition.name)).toEqual([
			"web_search",
			"code_execution",
			"text_editor",
			"computer",
			"_bash",
		]);
	});

	it("sends earlier tool calls in the history with the wire prefix", async () => {
		const h = harness();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_1", name: "lookup", arguments: { value: "x" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};

		await run(h, {
			messages: [
				user("look it up"),
				assistant,
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "lookup",
					content: [{ type: "text", text: "found" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		const toolUses = h.requests[0].body.messages.flatMap((message) =>
			Array.isArray(message.content)
				? (message.content as Array<{ type: string; name?: string }>).filter((block) => block.type === "tool_use")
				: [],
		);
		expect(toolUses.map((block) => block.name)).toEqual(["_lookup"]);
	});

	it("decodes a tool call the server returns without the prefix", async () => {
		const h = harness(() => toolUseReply("lookup"));

		const result = await run(h);

		expect(toolCallsOf(result).map((call) => call.name)).toEqual(["lookup"]);
	});

	it("sends metadata.user_id as Claude Code's JSON, with an account and device only when the account is known", async () => {
		const h = harness();

		await run(h, { options: { sessionId: uuidSession, metadata: { user_id: "caller-user" } } });

		expect(userIdOf(h.requests[0])).toEqual({ session_id: uuidSession });
	});

	it("adds the account uuid and stored device id from options.env", async () => {
		const h = harness();

		await run(h, {
			options: {
				sessionId: uuidSession,
				env: { ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-uuid", ANTHROPIC_OAUTH_DEVICE_ID: "stored-device" },
			},
		});
		await run(h, { options: { sessionId: uuidSession, env: { ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-uuid" } } });

		expect(userIdOf(h.requests[0])).toEqual({
			device_id: "stored-device",
			session_id: uuidSession,
			account_uuid: "account-uuid",
		});
		expect(userIdOf(h.requests[1])).toEqual({
			device_id: sha256Hex("omp-claude-device-id-v2\0credne\0account-uuid"),
			session_id: uuidSession,
			account_uuid: "account-uuid",
		});
	});

	it.each(["account_uuid", "accountId", "account_id"])(
		"builds the user id for the account the caller's metadata names as %s",
		async (key) => {
			const h = harness();

			await run(h, { options: { sessionId: uuidSession, metadata: { [key]: "metadata-account" } } });

			expect(userIdOf(h.requests[0])).toEqual({
				session_id: uuidSession,
				account_uuid: "metadata-account",
				device_id: sha256Hex("omp-claude-device-id-v2\0credne\0metadata-account"),
			});
		},
	);

	it("hands the transport the header record in Claude Code's order, and the body without its betas", async () => {
		const sent: Array<{ headerNames: string[]; bodyKeys: string[] }> = [];
		const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
			sent.push({
				headerNames: Object.keys(init?.headers as Record<string, string>),
				bodyKeys: Object.keys(JSON.parse(init?.body as string) as Record<string, unknown>),
			});
			return textReply();
		};
		const context = normalizeContext({ systemPrompt: "s", tools: [tool("lookup")], messages: [user("hello there")] });

		await streamClaudeSubscription(model, context, { apiKey: oauthKey, fetch, sessionId: uuidSession }).result();

		expect(sent).toHaveLength(1);
		expect(sent[0].headerNames).toEqual([
			"Accept",
			"Content-Type",
			"User-Agent",
			"X-Claude-Code-Session-Id",
			"X-Stainless-Arch",
			"X-Stainless-Lang",
			"X-Stainless-OS",
			"X-Stainless-Package-Version",
			"X-Stainless-Retry-Count",
			"X-Stainless-Runtime",
			"X-Stainless-Runtime-Version",
			"X-Stainless-Timeout",
			"anthropic-beta",
			"anthropic-dangerous-direct-browser-access",
			"anthropic-version",
			"Authorization",
			"x-app",
			"Connection",
			"Accept-Encoding",
		]);
		expect(sent[0].bodyKeys).toEqual(["model", "messages", "system", "tools", "metadata", "max_tokens", "stream"]);
	});

	it("hands the network layer the signed body as a JSON string", async () => {
		const h = harness();

		await run(h);

		expect(typeof h.requests[0].rawBody).toBe("string");
		expect(JSON.parse(h.requests[0].rawBody)).toMatchObject({ model: "claude-test", stream: true });
		expect(h.requests[0].rawBody).not.toContain("cch=00000");
	});

	it("pins the Claude Code version from PI_AI_CLAUDE_CODE_VERSION and does not retry a version rejection", async () => {
		vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", "2.1.100");
		const h = harness(() =>
			errorResponse("claude_code_version_too_old: Claude Code version 9.9.9 or newer is required"),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("claude_code_version_too_old");
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0].headers.get("user-agent")).toBe("claude-cli/2.1.100 (external, cli)");
		expect(billingOf(h.requests[0]).ccVersion).toBe("2.1.100");
	});
});

describe("Dispatch from the Anthropic API entry", () => {
	it("sends a subscription token to the subscription stream and nothing else", () => {
		expect(isClaudeSubscriptionRequest(model, { apiKey: oauthKey })).toBe(true);
		expect(isClaudeSubscriptionRequest(model, { apiKey: apiKey })).toBe(false);
		expect(isClaudeSubscriptionRequest(model, {})).toBe(false);
		expect(isClaudeSubscriptionRequest({ ...model, provider: "github-copilot" }, { apiKey: oauthKey })).toBe(false);
	});

	it("serves the API entry's subscription requests with the same wire format as the subscription stream", async () => {
		const direct = harness();
		const dispatched = harness();

		await run(direct, { options: { sessionId: uuidSession } });
		await run(dispatched, { entry: stream, options: { sessionId: uuidSession } });

		expect(dispatched.requests[0].headers.get("user-agent")).toBe(direct.requests[0].headers.get("user-agent"));
		expect(dispatched.requests[0].headers.get("anthropic-beta")).toBe(
			direct.requests[0].headers.get("anthropic-beta"),
		);
		expect(Object.keys(dispatched.requests[0].body)).toEqual(Object.keys(direct.requests[0].body));
	});
});

describe("Anthropic requests without a subscription token", () => {
	it.each([
		["an Anthropic API key", apiKey],
		["a key that is not a subscription token", "test-key"],
	])("sends no Claude Code wire format with %s", async (_name, key) => {
		const h = harness((_request, attempt) => (attempt === 1 ? toolUseReply("_internal") : textReply()));

		const result = await run(h, {
			entry: stream,
			tools: [tool("_internal"), tool("read")],
			options: {
				apiKey: key,
				sessionId: uuidSession,
				env: { ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-uuid" },
				metadata: { user_id: "caller-user" },
			},
		});

		const [request] = h.requests;
		expect(request.headers.get("x-api-key")).toBe(key);
		expect(request.headers.get("authorization")).toBeNull();
		expect(request.headers.get("user-agent")).not.toMatch(/^claude-cli\//);
		expect(request.headers.get("x-app")).toBeNull();
		expect(request.headers.get("x-claude-code-session-id")).toBeNull();
		expect(request.headers.get("x-stainless-package-version")).not.toBe("0.128.0");
		const betas = request.headers.get("anthropic-beta") ?? "";
		expect(betas).not.toContain("claude-code-20250219");
		expect(betas).not.toContain("oauth-2025-04-20");
		expect(request.rawBody).not.toContain("x-anthropic-billing-header");
		expect(request.rawBody).not.toContain(identityText);
		expect(request.body.system).toEqual([
			{ type: "text", text: "You are a test assistant.", cache_control: { type: "ephemeral" } },
		]);
		expect(request.body.tools?.map((definition) => definition.name)).toEqual(["_internal", "read"]);
		expect(request.body.metadata).toEqual({ user_id: "caller-user" });
		// Without a subscription token, a leading underscore is the tool's own name and is not stripped.
		expect(toolCallsOf(result).map((call) => call.name)).toEqual(["_internal"]);
	});

	it("does not retry a Claude Code version rejection", async () => {
		const h = harness(() =>
			errorResponse("claude_code_version_too_old: Claude Code version 9.9.9 or newer is required"),
		);

		const result = await run(h, { entry: stream, options: { apiKey } });

		expect(result.stopReason).toBe("error");
		expect(h.requests).toHaveLength(1);
		expect(getClaudeCodeVersion()).toBe(DEFAULT_CLAUDE_CODE_VERSION);
	});
});

describe("Claude subscription empty completions", () => {
	const emptyReply = (): Response => sse([messageStartEvent(), messageDeltaEvent("end_turn", 1), messageStopEvent]);

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function runToEnd(h: ReturnType<typeof harness>, input: TurnInput = {}): Promise<AssistantMessage> {
		return settleWithFakeTime(run(h, input));
	}

	it("replays an empty reply twice, after 500 and 1000 milliseconds, then lets it stand", async () => {
		const times: number[] = [];
		const h = harness(() => {
			times.push(Date.now());
			return emptyReply();
		});

		const result = await runToEnd(h);

		expect(h.requests).toHaveLength(3);
		// The wait doubles; fake time moves in steps, so each gap lands a little past its wait.
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(500);
		expect(times[1] - times[0]).toBeLessThan(700);
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(1000);
		expect(times[2] - times[1]).toBeLessThan(1200);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
	});

	it("answers with the first reply that is not empty", async () => {
		const h = harness((_request, attempt) => (attempt === 1 ? emptyReply() : textReply()));

		const result = await runToEnd(h);

		expect(h.requests).toHaveLength(2);
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("shows the consumer one start and one done, whatever was replayed", async () => {
		const h = harness((_request, attempt) => (attempt < 3 ? emptyReply() : textReply()));
		const context = normalizeContext({ systemPrompt: "s", messages: [user("Hello world, this is a test")] });

		const events = streamClaudeSubscription(model, context, { apiKey: oauthKey, fetch: h.fetch, maxRetries: 0 });
		const types: string[] = [];
		const reading = (async () => {
			for await (const event of events) types.push(event.type);
		})();
		await settleWithFakeTime(reading);

		expect(h.requests).toHaveLength(3);
		expect(types.filter((type) => type === "start")).toHaveLength(1);
		expect(types.at(-1)).toBe("done");
		expect(types.filter((type) => type === "done")).toHaveLength(1);
	});

	it.each([
		["text", () => textReply()],
		["a tool call", () => toolUseReply("lookup")],
		[
			"a reply that ends at its token cap",
			() => sse([messageStartEvent(), messageDeltaEvent("max_tokens", 1), messageStopEvent]),
		],
	])("does not replay a reply with %s", async (_name, reply) => {
		const h = harness(reply);

		await runToEnd(h);

		expect(h.requests).toHaveLength(1);
	});

	it("does not replay an error", async () => {
		const h = harness(() => errorResponse("Invalid tool schema"));

		const result = await runToEnd(h);

		expect(result.stopReason).toBe("error");
		expect(h.requests).toHaveLength(1);
	});

	it("does not replay once the caller aborted", async () => {
		const controller = new AbortController();
		const h = harness(() => {
			controller.abort();
			return emptyReply();
		});

		await runToEnd(h, { options: { signal: controller.signal } });

		expect(h.requests).toHaveLength(1);
	});
});

describe("Claude subscription slow mode", () => {
	const slowHeader = "anthropic-usage-limit";

	function hooksOf(overrides: Partial<AnthropicSlowModeHooks> = {}) {
		const observed: Array<{ signal: AnthropicSlowModeSignal; lane: string }> = [];
		const failures: AnthropicSlowModeFailure[] = [];
		const lanes: string[] = [];
		const hooks: AnthropicSlowModeHooks = {
			isActive: (lane) => {
				lanes.push(lane);
				return false;
			},
			observe: (signal, lane) => {
				observed.push({ signal, lane });
			},
			onFailure: (failure) => {
				failures.push(failure);
				return undefined;
			},
			...overrides,
		};
		return { hooks, observed, failures, lanes };
	}

	it("is off unless the caller opts in: no header, and an overload is not waited through", async () => {
		const h = harness(() => overloadedResponse());

		const result = await run(h);

		expect(result.stopReason).toBe("error");
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0].headers.get(slowHeader)).toBeNull();
	});

	it("sends the slow header while the hooks say the lane is active, and only then", async () => {
		const active = hooksOf({ isActive: () => true });
		const inactive = hooksOf();
		const h = harness();

		await run(h, { options: { anthropicSlowMode: active.hooks } });
		await run(h, { options: { anthropicSlowMode: inactive.hooks } });

		expect(h.requests[0].headers.get(slowHeader)).toBe("slow");
		expect(h.requests[1].headers.get(slowHeader)).toBeNull();
	});

	it("names the lane after the serving account, else after a stable hash of the bearer", async () => {
		const withAccount = hooksOf();
		const withoutAccount = hooksOf();
		const otherBearer = hooksOf();
		const h = harness();

		await run(h, {
			options: { anthropicSlowMode: withAccount.hooks, env: { ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-1" } },
		});
		await run(h, { options: { anthropicSlowMode: withoutAccount.hooks } });
		await run(h, { options: { anthropicSlowMode: withoutAccount.hooks } });
		await run(h, { options: { anthropicSlowMode: otherBearer.hooks, apiKey: "sk-ant-oat-other" } });

		expect(withAccount.lanes).toEqual(["cred:account-1"]);
		expect(withoutAccount.lanes[0]).toMatch(/^key:[0-9a-z]+$/);
		expect(withoutAccount.lanes[1]).toBe(withoutAccount.lanes[0]);
		expect(withoutAccount.lanes[0]).not.toContain(oauthKey);
		expect(otherBearer.lanes[0]).not.toBe(withoutAccount.lanes[0]);
	});

	it("lets the hooks read the slow-lane headers of a response that opened", async () => {
		const { hooks, observed } = hooksOf({ isActive: () => true });
		const h = harness(() =>
			withHeaders(textReply(), {
				"anthropic-ratelimit-unified-slow-status": "active",
				"anthropic-ratelimit-unified-slow-retry-after": "20",
			}),
		);

		await run(h, { options: { anthropicSlowMode: hooks, env: { ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-1" } } });

		expect(observed).toHaveLength(1);
		expect(observed[0].lane).toBe("cred:account-1");
		expect(observed[0].signal).toMatchObject({ status: "active", retryAfterMs: 20_000 });
	});

	it("does not call observe for a response without limit headers", async () => {
		const { hooks, observed } = hooksOf();

		await run(harness(), { options: { anthropicSlowMode: hooks } });

		expect(observed).toEqual([]);
	});

	it("waits through an overload the hooks answer with a capacity wait, and sends the request again", async () => {
		let answers = 0;
		const { hooks, failures } = hooksOf({
			isActive: () => true,
			onFailure: (failure) => {
				failures.push(failure);
				return answers++ === 0 ? { delayMs: 1, capacityWait: true } : undefined;
			},
		});
		const h = harness((_request, attempt) =>
			attempt === 1 ? overloadedResponse({ "anthropic-ratelimit-unified-slow-status": "slot_busy" }) : textReply(),
		);

		const result = await run(h, { options: { anthropicSlowMode: hooks } });

		expect(result.stopReason).toBe("stop");
		expect(h.requests).toHaveLength(2);
		expect(h.requests.map((request) => request.headers.get(slowHeader))).toEqual(["slow", "slow"]);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			httpStatus: 529,
			overloaded: true,
			sentSlow: true,
			attempts: 0,
			signal: { status: "slot_busy" },
		});
	});

	it("counts the capacity waits it has taken, and the time spent waiting, for the next failure", async () => {
		const seen: Array<{ attempts: number; waitedMs: number }> = [];
		const { hooks } = hooksOf({
			onFailure: (failure) => {
				seen.push({ attempts: failure.attempts, waitedMs: failure.waitedMs });
				return seen.length < 3 ? { delayMs: 5, capacityWait: true } : undefined;
			},
		});
		const h = harness((_request, attempt) => (attempt < 3 ? overloadedResponse() : textReply()));

		await run(h, { options: { anthropicSlowMode: hooks } });

		expect(seen.map((entry) => entry.attempts)).toEqual([0, 1]);
		expect(seen[0].waitedMs).toBe(0);
		expect(seen[1].waitedMs).toBeGreaterThanOrEqual(0);
	});

	it("surfaces the failure when the hooks decline and no retry is left", async () => {
		const { hooks, failures } = hooksOf();
		const h = harness(() => overloadedResponse());

		const result = await run(h, { options: { anthropicSlowMode: hooks } });

		expect(result.stopReason).toBe("error");
		expect(h.requests).toHaveLength(1);
		expect(failures).toHaveLength(1);
	});

	it("does not consult the hooks for a host that is not Anthropic's API", async () => {
		const { hooks, failures, lanes, observed } = hooksOf({ isActive: () => true });
		const h = harness((_request, attempt) => (attempt === 1 ? overloadedResponse() : textReply()));

		await run(h, {
			model: { ...model, baseUrl: "https://gateway.example.com" },
			options: { anthropicSlowMode: hooks },
		});

		expect(lanes).toEqual([]);
		expect(failures).toEqual([]);
		expect(observed).toEqual([]);
		expect(h.requests[0].headers.get(slowHeader)).toBeNull();
	});

	it("is consulted for Anthropic's API under a path", async () => {
		const { hooks, lanes } = hooksOf();

		await run(harness(), {
			model: { ...model, baseUrl: "https://API.anthropic.com/proxy" },
			options: { anthropicSlowMode: hooks },
		});

		expect(lanes).toHaveLength(1);
	});

	it("is ignored by the API-key stream", async () => {
		const { hooks, lanes } = hooksOf({ isActive: () => true });
		const h = harness();

		await run(h, { entry: stream, options: { apiKey, anthropicSlowMode: hooks } });

		expect(lanes).toEqual([]);
		expect(h.requests[0].headers.get(slowHeader)).toBeNull();
	});
});

describe("Claude subscription retry hints beyond the cap", () => {
	const unifiedHeaders = {
		"retry-after": "3600",
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-reset": "1800000000",
	};

	it("ends the request with the response itself, not a wrapper, and keeps its diagnostics", async () => {
		const h = harness(() => overloadedResponse(unifiedHeaders));

		const result = await run(h, { options: { maxRetries: 3 } });

		expect(h.requests).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("overloaded_error");
		expect(result.errorMessage).not.toContain("Server requested");
		expect(getProviderHttpErrorDetails(result)).toMatchObject({
			status: 529,
			retryAfterMs: 3_600_000,
			headers: {
				"retry-after": "3600",
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": "1800000000",
			},
		});
	});

	it("takes the cap from maxRetryDelayMs", async () => {
		const h = harness(() => overloadedResponse({ "retry-after": "2" }));

		const result = await run(h, { options: { maxRetries: 3, maxRetryDelayMs: 1000 } });

		expect(h.requests).toHaveLength(1);
		expect(result.errorMessage).toContain("overloaded_error");
		expect(result.errorMessage).not.toContain("Server requested");
	});
});

describe("Claude subscription lenient events", () => {
	function eventTypes(h: ReturnType<typeof harness>, input: TurnInput = {}): Promise<string[]> {
		const context = normalizeContext({ systemPrompt: "s", messages: [user("Hello world, this is a test")] });
		const events = streamClaudeSubscription(input.model ?? model, context, {
			apiKey: oauthKey,
			fetch: h.fetch,
			maxRetries: 0,
		});
		return (async () => {
			const types: string[] = [];
			for await (const event of events) types.push(event.type);
			return types;
		})();
	}

	it("keeps the first envelope of a spliced stream, and shows each block once", async () => {
		const h = harness(() =>
			sse([
				messageStartEvent("msg_first"),
				...textBlockEvents(0, "one"),
				messageStartEvent("msg_second"),
				...textBlockEvents(0, "one"),
				...textBlockEvents(1, "two"),
				messageDeltaEvent("end_turn", 3),
				messageStopEvent,
			]),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("msg_first");
		expect(result.content).toEqual([
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		]);
		expect(result.usage.output).toBe(3);
		expect(h.requests).toHaveLength(1);
	});

	it("completes a turn that ends with its stop reason and no message_stop", async () => {
		const h = harness(() =>
			sse([messageStartEvent(), ...textBlockEvents(0, "answer"), messageDeltaEvent("end_turn", 4)]),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(result.usage.output).toBe(4);
	});

	it("keeps the stop reason and usage of the finished turn when a second envelope follows", async () => {
		const h = harness(() =>
			sse([
				messageStartEvent(),
				...textBlockEvents(0, "answer"),
				messageDeltaEvent("end_turn", 5),
				messageStartEvent("msg_second"),
				...textBlockEvents(1, "late"),
				messageDeltaEvent("max_tokens", 99),
				messageStopEvent,
			]),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("stop");
		expect(result.usage.output).toBe(5);
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("finishes a block that is still open when the turn ends", async () => {
		const h = harness(() =>
			sse([
				messageStartEvent(),
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
				messageDeltaEvent("end_turn", 2),
				messageStopEvent,
			]),
		);

		const types = await eventTypes(h);

		expect(types).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("finishes the arguments of a tool call that is still open when the turn ends", async () => {
		const h = harness(() =>
			sse([
				messageStartEvent(),
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"value":"x"}' },
				},
				messageDeltaEvent("tool_use", 2),
				messageStopEvent,
			]),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("toolUse");
		expect(toolCallsOf(result)).toMatchObject([{ id: "toolu_1", name: "lookup", arguments: { value: "x" } }]);
	});

	it("fails a stream that ends with no stop reason", async () => {
		const h = harness(() => sse([messageStartEvent(), ...textBlockEvents(0, "cut")]));

		const result = await run(h);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ended before message_stop");
	});

	it("fails a stream whose events arrive before message_start", async () => {
		const h = harness(() => sse([...textBlockEvents(0, "early"), messageStartEvent(), messageStopEvent]));

		const result = await run(h);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("received content_block_start before message_start");
	});

	it("leaves the API-key stream strict: a stop reason without message_stop still fails", async () => {
		const h = harness(() =>
			sse([messageStartEvent(), ...textBlockEvents(0, "answer"), messageDeltaEvent("end_turn")]),
		);

		const result = await run(h, { entry: stream, options: { apiKey } });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ended before message_stop");
	});
});

describe("Claude subscription terminal grace", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const replyText = [messageStartEvent(), ...textBlockEvents(0, "answer"), messageDeltaEvent(), messageStopEvent]
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");

	/** A transport whose response body stays open after the reply, as a relay that never ends the body does. */
	function heldOpenTransport(): { signals: AbortSignal[]; h: ReturnType<typeof harness> } {
		const signals: AbortSignal[] = [];
		const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
			const signal = init?.signal ?? undefined;
			if (signal) signals.push(signal);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(replyText));
						signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		return { signals, h: { requests: [], fetch } };
	}

	it("completes the turn at message_stop, and aborts a body that stays open once the grace window closes", async () => {
		const { signals, h } = heldOpenTransport();

		const result = await run(h);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(signals).toHaveLength(1);
		expect(signals[0].aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(2499);
		expect(signals[0].aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(signals[0].aborted).toBe(true);
	});

	it("does not abort a body that ends with the reply", async () => {
		const signals: AbortSignal[] = [];
		const h = harness();
		const fetch: NonNullable<AnthropicOptions["fetch"]> = (input, init) => {
			if (init?.signal) signals.push(init.signal);
			return h.fetch(input, init);
		};

		const result = await run({ ...h, fetch });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(result.stopReason).toBe("stop");
		expect(signals[0].aborted).toBe(false);
	});
});

// Adopting a required version is process-global with no reset, so these cases run last and in order, each
// requiring a newer version than the one before.
describe("Claude Code version adoption after a rejected request", () => {
	it("retries once with the version the server requires", async () => {
		const h = harness((_request, attempt) =>
			attempt === 1
				? errorResponse(
						"claude_code_version_too_old: Claude Code version 9.9.9 or newer is required to use this client",
					)
				: textReply(),
		);

		const result = await run(h, { options: { sessionId: uuidSession } });

		expect(result.stopReason).toBe("stop");
		expect(h.requests).toHaveLength(2);
		const [rejected, retried] = h.requests;
		expect(rejected.headers.get("user-agent")).toBe(`claude-cli/${DEFAULT_CLAUDE_CODE_VERSION} (external, cli)`);
		expect(retried.headers.get("user-agent")).toBe("claude-cli/9.9.9 (external, cli)");
		expect(billingOf(retried).ccVersion).toBe("9.9.9");
		expect(billingOf(retried).fingerprint).toBe(sha256Hex("59cf53e54c78oo 9.9.9").slice(0, 3));
		expect(billingOf(retried).cch).toBe(expectedCch(retried));
		expect(retried.headers.get("authorization")).toBe(`Bearer ${oauthKey}`);
		expect(retried.headers.get("x-claude-code-session-id")).toBe(uuidSession);
		expect(userIdOf(retried).session_id).toBe(uuidSession);
		expect(getClaudeCodeVersion()).toBe("9.9.9");
	});

	it("reads the rejection from the structured error code as well as the message", async () => {
		const h = harness((_request, attempt) =>
			attempt === 1
				? errorResponse("Claude Code version 9.9.10 or newer is required", "claude_code_version_too_old")
				: textReply(),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("stop");
		expect(h.requests).toHaveLength(2);
		expect(h.requests[0].headers.get("user-agent")).toBe("claude-cli/9.9.9 (external, cli)");
		expect(h.requests[1].headers.get("user-agent")).toBe("claude-cli/9.9.10 (external, cli)");
	});

	it("uses the adopted version for later requests without another rejection", async () => {
		const h = harness();

		await run(h);

		expect(h.requests).toHaveLength(1);
		expect(h.requests[0].headers.get("user-agent")).toBe("claude-cli/9.9.10 (external, cli)");
		expect(billingOf(h.requests[0]).ccVersion).toBe("9.9.10");
	});

	it("surfaces a repeated rejection after one retry per newer version", async () => {
		const h = harness(() =>
			errorResponse("claude_code_version_too_old: Claude Code version 9.9.11 or newer is required"),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("9.9.11");
		expect(h.requests.map((request) => request.headers.get("user-agent"))).toEqual([
			"claude-cli/9.9.10 (external, cli)",
			"claude-cli/9.9.11 (external, cli)",
		]);
	});

	it("does not retry a rejection for a version the request already sent", async () => {
		const h = harness(() =>
			errorResponse("claude_code_version_too_old: Claude Code version 9.9.11 or newer is required"),
		);

		const result = await run(h);

		expect(result.stopReason).toBe("error");
		expect(h.requests).toHaveLength(1);
	});

	it("does not retry unrelated bad requests", async () => {
		const h = harness(() => errorResponse("Invalid tool schema"));

		const result = await run(h);

		expect(result.stopReason).toBe("error");
		expect(h.requests).toHaveLength(1);
	});

	it("starts the retry budget over once the required version is adopted", async () => {
		vi.useFakeTimers();
		try {
			// One retry in all: a transient failure uses it, and only the adoption gives the next one back.
			const h = harness((_request, attempt) => {
				if (attempt === 1 || attempt === 3) return overloadedResponse();
				if (attempt === 2) {
					return errorResponse("claude_code_version_too_old: Claude Code version 9.9.12 or newer is required");
				}
				return textReply();
			});

			const result = await settleWithFakeTime(run(h, { options: { maxRetries: 1 } }));

			expect(result.stopReason).toBe("stop");
			expect(h.requests).toHaveLength(4);
			expect(h.requests.map((request) => request.headers.get("user-agent"))).toEqual([
				"claude-cli/9.9.11 (external, cli)",
				"claude-cli/9.9.11 (external, cli)",
				"claude-cli/9.9.12 (external, cli)",
				"claude-cli/9.9.12 (external, cli)",
			]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Claude subscription message threads", () => {
	const threaded: Model<"anthropic-messages"> = { ...model, id: "claude-sonnet-4-5" };
	const answerTurn: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: threaded.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
	const threadsBeta = "message-threads-2026-08-12";
	let sessionCounter = 0;

	function threadSession(): string {
		return `stream-thread-${++sessionCounter}`;
	}

	function betasOf(request: WireRequest): string[] {
		return (request.headers.get("anthropic-beta") ?? "").split(",");
	}

	it("continues the stored reply, resends system and tools, and sends the threads beta only with a thread", async () => {
		const h = harness(() => textReply(threaded.id));
		const options = { sessionId: threadSession() };

		await run(h, { model: threaded, messages: [user("first")], options });
		await run(h, { model: threaded, messages: [user("first"), answerTurn, user("second")], options });

		const [create, next] = h.requests;
		expect(create.body.thread).toEqual({ type: "create" });
		expect(betasOf(create)).toContain(threadsBeta);
		expect(next.body.thread).toEqual({ type: "continue", previous_message_id: "msg_text" });
		expect(betasOf(next).at(-1)).toBe(threadsBeta);
		expect(next.body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "second", cache_control: expect.anything() }] },
		]);
		// The billing block carries the hash of each body; the rest of the system is the thread's own.
		expect(next.body.system?.slice(1)).toEqual(create.body.system?.slice(1));
		expect(billingOf(next).cch).toBe(expectedCch(next));
		expect(next.body.tools).toEqual(create.body.tools);
		expect(Object.keys(next.body).at(-1)).toBe("thread");
	});

	it("sends no thread, and no threads beta, for a request without a session or an older model", async () => {
		const h = harness();

		await run(h, { model: threaded });
		await run(h, { model: { ...model, id: "claude-sonnet-4" }, options: { sessionId: threadSession() } });
		await run(h, { model: threaded, options: { sessionId: threadSession(), disableContinuation: true } });
		await run(h, { model: threaded, options: { sessionId: threadSession(), cacheRetention: "none" } });

		for (const request of h.requests) {
			expect(request.body).not.toHaveProperty("thread");
			expect(betasOf(request)).not.toContain(threadsBeta);
		}
	});

	it("replays a continue the server refused as a new thread and records why", async () => {
		const h = harness((_request, attempt) =>
			attempt === 2 ? errorResponse("The thread was not found.", "thread_not_found") : textReply(threaded.id),
		);
		const options = { sessionId: threadSession() };
		const conversation = [user("first"), answerTurn, user("second")];

		await run(h, { model: threaded, messages: [user("first")], options });
		const result = await run(h, { model: threaded, messages: conversation, options });

		expect(result.stopReason).toBe("stop");
		expect(h.requests.map((request) => (request.body.thread as { type: string }).type)).toEqual([
			"create",
			"continue",
			"create",
		]);
		expect(h.requests[2].body.messages).toHaveLength(conversation.length);
		expect(result.diagnostics?.[0]).toMatchObject({
			type: "anthropic_thread_fallback",
			details: { reason: "thread_not_found" },
		});
	});

	describe("a 400 nothing explained", () => {
		const unexplained = "messages.0.content: Input should be a valid list";

		it("sends the request again without the thread, and stops threading the session once that carries the turn", async () => {
			const h = harness((request) => (request.body.thread ? errorResponse(unexplained) : textReply(threaded.id)));
			const options = { sessionId: threadSession() };

			const first = await run(h, { model: threaded, messages: [user("first")], options });
			const second = await run(h, {
				model: threaded,
				messages: [user("first"), answerTurn, user("second")],
				options,
			});

			expect(first.stopReason).toBe("stop");
			expect(second.stopReason).toBe("stop");
			expect(h.requests).toHaveLength(3);
			expect(h.requests[0].body.thread).toEqual({ type: "create" });
			expect(h.requests[1].body).not.toHaveProperty("thread");
			expect(betasOf(h.requests[1])).not.toContain(threadsBeta);
			expect(h.requests[2].body).not.toHaveProperty("thread");
			expect(first.diagnostics?.[0]).toMatchObject({ type: "anthropic_thread_fallback" });
		});

		it("surfaces the 400 when the request fails without the thread too, and keeps threading the session", async () => {
			let failing = true;
			const h = harness(() => (failing ? errorResponse(unexplained) : textReply(threaded.id)));
			const options = { sessionId: threadSession() };

			const first = await run(h, { model: threaded, messages: [user("first")], options });
			failing = false;
			const second = await run(h, { model: threaded, messages: [user("first")], options });

			expect(first.stopReason).toBe("error");
			expect(first.errorMessage).toContain(unexplained);
			expect(h.requests.map((request) => request.body.thread)).toEqual([
				{ type: "create" },
				undefined,
				{ type: "create" },
			]);
			expect(second.stopReason).toBe("stop");
		});

		it("does not take a context overflow for a thread problem", async () => {
			const h = harness(() => errorResponse("prompt is too long: 213462 tokens > 200000 maximum"));

			const result = await run(h, {
				model: threaded,
				messages: [user("first")],
				options: { sessionId: threadSession() },
			});

			expect(result.stopReason).toBe("error");
			expect(h.requests).toHaveLength(1);
		});

		it("does not resend a request that carried no thread", async () => {
			const h = harness(() => errorResponse(unexplained));

			const result = await run(h, { model: threaded, messages: [user("first")] });

			expect(result.stopReason).toBe("error");
			expect(h.requests).toHaveLength(1);
		});
	});

	it("sends the request without a thread when the endpoint cannot thread, and stops asking", async () => {
		const h = harness((request) =>
			request.body.thread
				? errorResponse("Threads are not available.", "thread_unsupported_request")
				: textReply(threaded.id),
		);
		const options = { sessionId: threadSession() };

		const first = await run(h, { model: threaded, messages: [user("first")], options });
		const second = await run(h, { model: threaded, messages: [user("first"), answerTurn, user("second")], options });

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		expect(h.requests).toHaveLength(3);
		expect(h.requests[0].body.thread).toEqual({ type: "create" });
		expect(h.requests[1].body).not.toHaveProperty("thread");
		expect(h.requests[2].body).not.toHaveProperty("thread");
		expect(betasOf(h.requests[1])).not.toContain(threadsBeta);
	});
});

describe("Claude subscription request over the real transport", () => {
	it("puts Claude Code's headers on the wire in order and casing, with Host and Content-Length placed", async () => {
		const received: Array<{ rawHeaders: string[]; url: string; body: string }> = [];
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				received.push({
					rawHeaders: request.rawHeaders,
					url: request.url ?? "",
					body: Buffer.concat(chunks).toString(),
				});
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					[
						{ type: "message_start", message: { id: "msg_wire", model: model.id, usage: { input_tokens: 1 } } },
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
						{ type: "message_stop" },
					]
						.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
						.join(""),
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as AddressInfo;
			const context = normalizeContext({ systemPrompt: "s", messages: [user("hello there")] });

			const result = await streamClaudeSubscription({ ...model, baseUrl: `http://127.0.0.1:${port}` }, context, {
				apiKey: oauthKey,
				sessionId: uuidSession,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(received).toHaveLength(1);
			expect(received[0].url).toBe("/v1/messages?beta=true");
			const names = received[0].rawHeaders.filter((_value, index) => index % 2 === 0);
			expect(names).toEqual([
				"Accept",
				"Content-Type",
				"User-Agent",
				"X-Claude-Code-Session-Id",
				"X-Stainless-Arch",
				"X-Stainless-Lang",
				"X-Stainless-OS",
				"X-Stainless-Package-Version",
				"X-Stainless-Retry-Count",
				"X-Stainless-Runtime",
				"X-Stainless-Runtime-Version",
				"X-Stainless-Timeout",
				"anthropic-beta",
				"anthropic-dangerous-direct-browser-access",
				"anthropic-version",
				"Authorization",
				"x-app",
				"Connection",
				"Host",
				"Accept-Encoding",
				"Content-Length",
			]);
			expect(received[0].body).toMatch(/cch=[0-9a-f]{5};/);
			expect(received[0].body).not.toContain("cch=00000");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("Claude subscription prompt-cache pre-warm", () => {
	function warmResponse(): Response {
		return Response.json({
			id: "msg_warm",
			type: "message",
			role: "assistant",
			model: model.id,
			content: [],
			stop_reason: "max_tokens",
			usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 100, cache_read_input_tokens: 40 },
		});
	}

	it("sends the real body without streaming and with no output, and reports its usage as an empty reply", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
			sent.push(JSON.parse(init?.body as string) as Record<string, unknown>);
			return warmResponse();
		};
		const context = normalizeContext({ systemPrompt: "s", tools: [tool("lookup")], messages: [user("warm me")] });

		const events = streamClaudeSubscription(model, context, { apiKey: oauthKey, fetch, prewarm: true });
		const seen: string[] = [];
		for await (const event of events) seen.push(event.type);
		const result = await events.result();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ max_tokens: 0, stream: false });
		expect(Object.keys(sent[0]).slice(0, 5)).toEqual(["model", "messages", "system", "tools", "metadata"]);
		expect(seen).toEqual(["start", "done"]);
		expect(result.content).toEqual([]);
		expect(result.stopReason).toBe("length");
		expect(result.responseId).toBe("msg_warm");
		expect(result.usage).toMatchObject({ input: 5, output: 0, cacheRead: 40, cacheWrite: 100 });
	});

	it("sends a request the endpoint would reject with no output as a normal request", async () => {
		const h = harness();

		const result = await run(h, {
			model: { ...model, reasoning: true },
			options: { prewarm: true, thinkingEnabled: true, thinkingBudgetTokens: 2048 },
		});

		expect(result.stopReason).toBe("stop");
		expect(h.requests[0].body).toMatchObject({ max_tokens: 100, stream: true });
	});
});
