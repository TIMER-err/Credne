import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import { streamClaudeSubscription } from "../src/api/claude-subscription/stream.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 1000,
};

/** A recorded reply: pings, thinking with its signature, redacted thinking, a server tool block, text, a tool call. */
const recordedReply = [
	`event: message_start`,
	`data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"usage":{"input_tokens":25,"cache_creation_input_tokens":100,"cache_read_input_tokens":40,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":100},"output_tokens":1}}}`,
	``,
	`event: ping`,
	`data: {"type":"ping"}`,
	``,
	`event: content_block_start`,
	`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" about it."}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQB"}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"Cg=="}}`,
	``,
	`event: content_block_stop`,
	`data: {"type":"content_block_stop","index":0}`,
	``,
	`event: content_block_start`,
	`data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-payload"}}`,
	``,
	`event: content_block_stop`,
	`data: {"type":"content_block_stop","index":1}`,
	``,
	`event: content_block_start`,
	`data: {"type":"content_block_start","index":2,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}`,
	``,
	`event: content_block_stop`,
	`data: {"type":"content_block_stop","index":2}`,
	``,
	`event: content_block_start`,
	`data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"Looking "}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"it up."}}`,
	``,
	`event: content_block_stop`,
	`data: {"type":"content_block_stop","index":3}`,
	``,
	`event: content_block_start`,
	`data: {"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"toolu_01","name":"lookup","input":{}}}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{\\"val"}}`,
	``,
	`event: ping`,
	`data: {"type":"ping"}`,
	``,
	`event: content_block_delta`,
	`data: {"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"ue\\":\\"abc\\"}"}}`,
	``,
	`event: content_block_stop`,
	`data: {"type":"content_block_stop","index":4}`,
	``,
	`event: message_delta`,
	`data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":57,"output_tokens_details":{"thinking_tokens":12}}}`,
	``,
	`event: message_stop`,
	`data: {"type":"message_stop"}`,
	``,
	``,
].join("\n");

function recordedResponse(): Response {
	return new Response(recordedReply, { headers: { "content-type": "text/event-stream" } });
}

/** One line per stream event: its type, the block it concerns, and what it carries. */
function describeEvent(event: AssistantMessageEvent): string {
	switch (event.type) {
		case "start":
			return "start";
		case "done":
			return `done:${event.reason}`;
		case "error":
			return `error:${event.reason}`;
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return `${event.type}[${event.contentIndex}]`;
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return `${event.type}[${event.contentIndex}] ${JSON.stringify(event.delta)}`;
		case "text_end":
		case "thinking_end":
			return `${event.type}[${event.contentIndex}] ${JSON.stringify(event.content)}`;
		case "toolcall_end":
			return `toolcall_end[${event.contentIndex}] ${event.toolCall.name} ${JSON.stringify(event.toolCall.arguments)}`;
	}
}

async function collect(
	entry: typeof stream,
	options: AnthropicOptions,
): Promise<{ events: string[]; message: AssistantMessage }> {
	const context = normalizeContext({ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
	const events = entry(model, context, { fetch: async () => recordedResponse(), ...options });
	const seen: string[] = [];
	for await (const event of events) seen.push(describeEvent(event));
	return { events: seen, message: await events.result() };
}

describe("Claude subscription event mapping", () => {
	it("decodes a recorded reply into the pi event sequence", async () => {
		const { events, message } = await collect(streamClaudeSubscription, { apiKey: "sk-ant-oat-test" });

		expect(events).toEqual([
			"start",
			"thinking_start[0]",
			'thinking_delta[0] "Let me think"',
			'thinking_delta[0] " about it."',
			'thinking_end[0] "Let me think about it."',
			"thinking_start[1]",
			'thinking_end[1] "[Reasoning redacted]"',
			"text_start[2]",
			'text_delta[2] "Looking "',
			'text_delta[2] "it up."',
			'text_end[2] "Looking it up."',
			"toolcall_start[3]",
			'toolcall_delta[3] "{\\"val"',
			'toolcall_delta[3] "ue\\":\\"abc\\"}"',
			'toolcall_end[3] lookup {"value":"abc"}',
			"done:toolUse",
		]);
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "Let me think about it.", thinkingSignature: "EqQBCg==" },
			{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque-payload", redacted: true },
			{ type: "text", text: "Looking it up." },
			{ type: "toolCall", id: "toolu_01", name: "lookup", arguments: { value: "abc" } },
		]);
	});

	it("reads usage, cost, the response id and the stop reason", async () => {
		const { message } = await collect(streamClaudeSubscription, { apiKey: "sk-ant-oat-test" });

		expect(message.responseId).toBe("msg_01");
		expect(message.rawStopReason).toBe("tool_use");
		expect(message.stopReason).toBe("toolUse");
		expect(message.usage).toMatchObject({
			input: 25,
			output: 57,
			cacheRead: 40,
			cacheWrite: 100,
			cacheWrite1h: 100,
			reasoning: 12,
			totalTokens: 222,
		});
		// 25 input at $3, 100 one-hour cache writes at twice the input rate, 40 cache reads at $0.30, 57 output at $15.
		expect(message.usage.cost.cacheWrite).toBeCloseTo((100 * 3 * 2) / 1_000_000, 9);
		expect(message.usage.cost.total).toBeCloseTo((25 * 3 + 100 * 3 * 2 + 40 * 0.3 + 57 * 15) / 1_000_000, 9);
	});

	it("emits the events the API key stream emits for the same reply", async () => {
		const subscription = await collect(streamClaudeSubscription, { apiKey: "sk-ant-oat-test" });
		const apiKey = await collect(stream, { apiKey: "sk-ant-api03-test" });

		expect(subscription.events).toEqual(apiKey.events);
		expect(subscription.message.content).toEqual(apiKey.message.content);
		expect(subscription.message.usage).toEqual(apiKey.message.usage);
		expect(subscription.message.stopReason).toBe(apiKey.message.stopReason);
	});

	it("decodes the wire tool prefix and leaves a name without it as it is", async () => {
		const prefixed = recordedReply.replace('"name":"lookup"', '"name":"_lookup"');
		const { message } = await collect(streamClaudeSubscription, {
			apiKey: "sk-ant-oat-test",
			fetch: async () => new Response(prefixed, { headers: { "content-type": "text/event-stream" } }),
		});

		expect(message.content.at(-1)).toMatchObject({ type: "toolCall", name: "lookup" });
	});

	it("hands each provider event to onProviderStreamEvent, pings excepted", async () => {
		const seen: string[] = [];

		await collect(streamClaudeSubscription, {
			apiKey: "sk-ant-oat-test",
			onProviderStreamEvent: (event) => {
				seen.push((event as { type: string }).type);
			},
		});

		expect(seen[0]).toBe("message_start");
		expect(seen.at(-1)).toBe("message_stop");
		expect(seen).not.toContain("ping");
	});
});
