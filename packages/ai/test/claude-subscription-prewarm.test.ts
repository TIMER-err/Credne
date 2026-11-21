// Warm-ups of Claude subscription requests: the connection warm-up (a credential-less HEAD through the transport's own
// socket pool, throttled, never throwing) and the prompt-cache pre-warm (the real body with `max_tokens: 0`).

import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildPromptCachePrewarmBody,
	getPromptCachePrewarmRejection,
	promptCachePrewarmEventStream,
} from "../src/api/claude-subscription/cache-prewarm.ts";
import { prewarmModelConnection } from "../src/api/claude-subscription/prewarm.ts";
import type { ProfiledRequest } from "../src/api/claude-subscription/transport.ts";
import type { Model } from "../src/types.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("prewarmModelConnection", () => {
	const anthropicModel: Model<"anthropic-messages"> = {
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

	interface Probe {
		url: string;
		request: ProfiledRequest;
	}

	// The throttle is keyed by origin for the whole process, so each case starts an hour after the previous one.
	let clock = Date.parse("2030-01-01T00:00:00Z");

	function startClock(): void {
		vi.useFakeTimers({ toFake: ["Date"] });
		clock += 3_600_000;
		vi.setSystemTime(clock);
	}

	function recordingSend(respond: () => Promise<Response> = async () => new Response(null, { status: 405 })) {
		const probes: Probe[] = [];
		const send = async (url: URL, request: ProfiledRequest): Promise<Response> => {
			probes.push({ url: url.href, request });
			return respond();
		};
		return { probes, send };
	}

	it("sends a credential-less HEAD to the origin with only the app's User-Agent", async () => {
		startClock();
		const { probes, send } = recordingSend();

		await prewarmModelConnection(anthropicModel, { send, identity: { userAgent: { custom: "credne/9.9.9" } } });

		expect(probes).toHaveLength(1);
		expect(probes[0].url).toBe("https://api.anthropic.com/");
		expect(probes[0].request.method).toBe("HEAD");
		expect(probes[0].request.headers).toEqual({ "User-Agent": "credne/9.9.9" });
		expect(probes[0].request.body).toBeUndefined();
		expect(probes[0].request.signal).toBeInstanceOf(AbortSignal);
	});

	it("uses pi-ai's detailed User-Agent without an identity", async () => {
		startClock();
		const { probes, send } = recordingSend();

		await prewarmModelConnection(anthropicModel, { send });

		expect(probes[0].request.headers["User-Agent"]).toMatch(/^pi\/\d+\.\d+\.\d+ \(/);
	});

	it("probes an origin once per 30 seconds", async () => {
		startClock();
		const { probes, send } = recordingSend();

		await prewarmModelConnection(anthropicModel, { send });
		vi.setSystemTime(clock + 29_999);
		await prewarmModelConnection(anthropicModel, { send });
		expect(probes).toHaveLength(1);

		vi.setSystemTime(clock + 30_000);
		await prewarmModelConnection(anthropicModel, { send });
		expect(probes).toHaveLength(2);
		await prewarmModelConnection(anthropicModel, { send });
		expect(probes).toHaveLength(2);
	});

	it("gives each probe a 10 second timeout", async () => {
		startClock();
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const { probes, send } = recordingSend();

		await prewarmModelConnection(anthropicModel, { send });

		expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
		expect(probes[0].request.signal).toBe(timeout.mock.results[0].value);
		timeout.mockRestore();
	});

	it("never throws, and a failed probe still counts toward the throttle", async () => {
		startClock();
		const { probes, send } = recordingSend(async () => {
			throw new Error("connect ECONNREFUSED");
		});

		await expect(prewarmModelConnection(anthropicModel, { send })).resolves.toBeUndefined();
		await prewarmModelConnection(anthropicModel, { send });

		expect(probes).toHaveLength(1);
	});

	it("drains the probe response so the socket returns to the pool", async () => {
		startClock();
		const cancel = vi.fn(async () => {});
		const response = new Response("body");
		vi.spyOn(response.body as ReadableStream, "cancel").mockImplementation(cancel);
		const { send } = recordingSend(async () => response);

		await prewarmModelConnection(anthropicModel, { send });

		expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([
		["a custom base URL", { ...anthropicModel, baseUrl: "https://gateway.example.com" }],
		["a plain http base URL", { ...anthropicModel, baseUrl: "http://api.anthropic.com" }],
		["an unparseable base URL", { ...anthropicModel, baseUrl: "not a url" }],
		[
			"another API",
			{
				...anthropicModel,
				api: "openai-completions",
				baseUrl: "https://api.anthropic.com",
			} as unknown as Model<"anthropic-messages">,
		],
	])("does nothing for %s", async (_name, model) => {
		startClock();
		const { probes, send } = recordingSend();

		await prewarmModelConnection(model, { send });

		expect(probes).toHaveLength(0);
	});

	it("warms a local subscription provider on Anthropic's API like the anthropic provider", async () => {
		startClock();
		const { probes, send } = recordingSend();

		await prewarmModelConnection({ ...anthropicModel, provider: "claude-sub:work" }, { send });

		expect(probes).toHaveLength(1);
	});
});

describe("prompt-cache pre-warm", () => {
	const params: MessageCreateParamsStreaming = {
		model: "claude-test",
		max_tokens: 4096,
		stream: true,
		system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
		tools: [{ name: "read", description: "Reads", input_schema: { type: "object" } }],
	};

	it("sends the real body with no output cap and no streaming, and keeps every other field", () => {
		const body = buildPromptCachePrewarmBody(params);

		expect(body).toEqual({ ...params, max_tokens: 0, stream: false });
		expect(Object.keys(body)).toEqual(Object.keys(params));
		expect(params.max_tokens).toBe(4096);
		expect(params.stream).toBe(true);
	});

	it("accepts a body with adaptive thinking, auto tool choice and no structured output", () => {
		expect(
			getPromptCachePrewarmRejection({
				...params,
				thinking: { type: "adaptive" },
				tool_choice: { type: "auto" },
			}),
		).toBeUndefined();
	});

	it.each([
		["budget thinking", { thinking: { type: "enabled", budget_tokens: 1024 } }],
		["a forced tool_choice", { tool_choice: { type: "any" } }],
		["a forced tool_choice", { tool_choice: { type: "tool", name: "read" } }],
		["structured output", { output_config: { format: { type: "json_schema", schema: { type: "object" } } } }],
	] as const)("refuses %s", (reason, extra) => {
		expect(getPromptCachePrewarmRejection({ ...params, ...extra } as MessageCreateParamsStreaming)).toBe(reason);
	});

	it("re-expresses the JSON reply as the event stream of an empty reply that stopped at its cap", async () => {
		const usage = {
			input_tokens: 12,
			output_tokens: 0,
			cache_read_input_tokens: 9000,
			cache_creation_input_tokens: 0,
		};
		const reply = new Response(
			JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], usage }),
			{
				status: 200,
				headers: { "content-type": "application/json", "content-encoding": "gzip", "request-id": "req_1" },
			},
		);

		const converted = await promptCachePrewarmEventStream(reply);

		expect(converted.status).toBe(200);
		expect(converted.headers.get("content-type")).toBe("text/event-stream");
		expect(converted.headers.get("content-encoding")).toBeNull();
		expect(converted.headers.get("request-id")).toBe("req_1");
		const events = (await converted.text())
			.trim()
			.split("\n\n")
			.map((frame) => JSON.parse(frame.split("\n")[1].slice("data: ".length)) as Record<string, unknown>);
		expect(events.map((event) => event.type)).toEqual(["message_start", "message_delta", "message_stop"]);
		expect(events[0]).toMatchObject({
			message: { id: "msg_1", content: [], stop_reason: null, usage },
		});
		expect(events[1]).toMatchObject({ delta: { stop_reason: "max_tokens" }, usage });
	});

	it("rejects a reply that carries no usage", async () => {
		await expect(promptCachePrewarmEventStream(new Response(JSON.stringify({ id: "msg_1" })))).rejects.toThrow(
			"carried no usage",
		);
	});
});
