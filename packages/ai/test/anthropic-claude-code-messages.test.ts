import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const oauthKey = "sk-ant-oat-test";
const apiKey = "sk-ant-api03-test";

interface WireMessage {
	role: string;
	content: string | Array<Record<string, unknown>>;
}

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 100,
};

function textReply(): Response {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_text", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

/** Sends `messages` and returns the wire messages of the request that carried them. */
async function wireMessages(
	messages: Message[],
	credential: string,
	options?: AnthropicOptions,
	requestModel: Model<"anthropic-messages"> = model,
): Promise<{ wire: WireMessage[]; result: AssistantMessage }> {
	const bodies: Array<{ messages: WireMessage[] }> = [];
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
		bodies.push(JSON.parse(init?.body as string) as { messages: WireMessage[] });
		return textReply();
	};
	const tool: Tool = { name: "lookup", description: "Look up", parameters: Type.Object({ value: Type.String() }) };
	const context = normalizeContext({ systemPrompt: "You are a test assistant.", tools: [tool], messages });
	const result = await stream(requestModel, context, {
		apiKey: credential,
		fetch,
		maxRetries: 0,
		cacheRetention: "none",
		...options,
	}).result();
	return { wire: bodies[0]?.messages ?? [], result };
}

function user(content: string | (TextContent | ImageContent)[]): Message {
	return { role: "user", content, timestamp: 1 };
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: 2,
	};
}

function toolCall(id: string): ToolCall {
	return { type: "toolCall", id, name: "lookup", arguments: { value: id } };
}

function toolResult(id: string, content: (TextContent | ImageContent)[], isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "lookup", content, isError, timestamp: 3 };
}

function image(mimeType = "image/png", data = "aGVsbG8="): ImageContent {
	return { type: "image", mimeType, data };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function toolResultBlocks(message: WireMessage | undefined): Array<Record<string, unknown>> {
	return (message?.content as Array<Record<string, unknown>>).filter((block) => block.type === "tool_result");
}

afterEach(() => {
	cleanupSessionResources();
});

describe("Claude subscription message conversion", () => {
	describe("tool results", () => {
		const history = (results: ToolResultMessage[], calls = ["toolu_1"]): Message[] => [
			user("look it up"),
			assistant(calls.map(toolCall), "toolUse"),
			...results,
		];

		it("sends text-only results as arrays of text blocks, dropping blank text", async () => {
			const { wire } = await wireMessages(
				history([toolResult("toolu_1", [text("first"), text("   "), text("second")])]),
				oauthKey,
			);

			const [block] = toolResultBlocks(wire[2]);
			expect(block.content).toEqual([
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			]);
			expect(block.is_error).toBe(false);
		});

		it("sends an empty result as an empty string and an empty error as a fixed sentence", async () => {
			const { wire } = await wireMessages(
				history([toolResult("toolu_1", []), toolResult("toolu_2", [text("  ")], true)], ["toolu_1", "toolu_2"]),
				oauthKey,
			);

			const [empty, failed] = toolResultBlocks(wire[2]);
			expect(empty.content).toBe("");
			expect(failed.content).toBe("Tool failed with no output.");
			expect(failed.is_error).toBe(true);
		});

		it("hoists the images of error results behind all tool results under one OMP caption", async () => {
			const { wire } = await wireMessages(
				history(
					[
						toolResult("toolu_1", [text("boom"), image("image/png", "QQ==")], true),
						toolResult("toolu_2", [image("image/jpeg", "Qg==")], true),
						toolResult("toolu_3", [text("fine")]),
					],
					["toolu_1", "toolu_2", "toolu_3"],
				),
				oauthKey,
			);

			const content = wire[2].content as Array<Record<string, unknown>>;
			expect(content.map((block) => block.type)).toEqual([
				"tool_result",
				"tool_result",
				"tool_result",
				"text",
				"image",
				"image",
			]);
			expect(content[0].content).toEqual([{ type: "text", text: "boom" }]);
			// An image-only error result keeps the placeholder text, since errors may only hold text.
			expect(content[1].content).toEqual([{ type: "text", text: "(see attached image)" }]);
			expect(content[2].content).toEqual([{ type: "text", text: "fine" }]);
			expect(content[3]).toEqual({ type: "text", text: "Attached image(s) from the tool result(s) above:" });
			expect(content[4]).toMatchObject({ source: { type: "base64", media_type: "image/png", data: "QQ==" } });
			expect(content[5]).toMatchObject({ source: { type: "base64", media_type: "image/jpeg", data: "Qg==" } });
		});

		it("keeps the images of successful results inside the result, after a placeholder when no text is there", async () => {
			const { wire } = await wireMessages(history([toolResult("toolu_1", [image()])]), oauthKey);

			const [block] = toolResultBlocks(wire[2]);
			expect(block.content).toEqual([
				{ type: "text", text: "(see attached image)" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
			]);
		});

		it("keeps joined strings and the pi caption for API key requests", async () => {
			const { wire } = await wireMessages(
				history(
					[toolResult("toolu_1", [text("first"), text("second")]), toolResult("toolu_2", [], true)],
					["toolu_1", "toolu_2"],
				),
				apiKey,
			);

			const [joined, empty] = toolResultBlocks(wire[2]);
			expect(joined.content).toBe("first\nsecond");
			expect(empty.content).toBe("");
		});
	});

	describe("user turns", () => {
		it("puts a text placeholder before an image-only turn", async () => {
			const { wire } = await wireMessages([user([image()])], oauthKey);

			expect(wire[0].content).toEqual([
				{ type: "text", text: "(see attached image)" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
			]);
		});

		it("adds no placeholder when text comes with the image, and drops blank text", async () => {
			const { wire } = await wireMessages([user([text("look"), text("  "), image()])], oauthKey);

			expect((wire[0].content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
				"text",
				"image",
			]);
		});

		it("sends the plain image turn unchanged for API key requests", async () => {
			const { wire } = await wireMessages([user([image()])], apiKey);

			expect((wire[0].content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual(["image"]);
		});
	});

	describe("image media types", () => {
		it("normalizes image/jpg and case to a media type Anthropic accepts", async () => {
			const { wire } = await wireMessages(
				[user([text("a"), image("image/jpg", "QQ=="), image(" IMAGE/WebP ", "Qg==")])],
				oauthKey,
			);

			const blocks = wire[0].content as Array<{ source?: { media_type: string } }>;
			expect(blocks[1].source?.media_type).toBe("image/jpeg");
			expect(blocks[2].source?.media_type).toBe("image/webp");
		});

		it("fails the turn being answered when an attachment cannot be sent", async () => {
			const { result, wire } = await wireMessages([user([text("look"), image("image/heic")])], oauthKey);

			expect(wire).toEqual([]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe(
				"image/heic attachments are not supported here; send JPEG, PNG, GIF or WebP images instead",
			);
		});

		it("keeps a stub for an unsupported attachment in an earlier turn", async () => {
			const { result, wire } = await wireMessages(
				[user([text("look"), image("image/heic")]), assistant([text("seen")], "stop"), user("and now?")],
				oauthKey,
			);

			expect(result.stopReason).toBe("stop");
			expect(wire[0].content).toEqual([
				{ type: "text", text: "look" },
				{ type: "text", text: "[unsupported image: image/heic]" },
			]);
		});
	});

	describe("assistant turns", () => {
		it("moves tool_use blocks behind text, and leaves thinking in front", async () => {
			const { wire } = await wireMessages(
				[
					user("look it up"),
					assistant(
						[
							toolCall("toolu_1"),
							{ type: "text", text: "after the call" },
							{ type: "thinking", thinking: "hm", thinkingSignature: "sig" },
							toolCall("toolu_2"),
						],
						"toolUse",
					),
					toolResult("toolu_1", [text("a")]),
					toolResult("toolu_2", [text("b")]),
				],
				oauthKey,
			);

			expect((wire[1].content as Array<{ type: string }>).map((block) => block.type)).toEqual([
				"text",
				"thinking",
				"tool_use",
				"tool_use",
			]);
		});

		it("keeps the order of a turn whose tool_use blocks already come last", async () => {
			const { wire } = await wireMessages(
				[
					user("look it up"),
					assistant(
						[
							{ type: "text", text: "calling" },
							toolCall("toolu_1"),
							{ type: "thinking", thinking: "x", thinkingSignature: "s" },
						],
						"toolUse",
					),
					toolResult("toolu_1", [text("a")]),
				],
				oauthKey,
			);

			// Only thinking follows the tool_use, which Anthropic accepts: the turn is replayed as it was.
			expect((wire[1].content as Array<{ type: string }>).map((block) => block.type)).toEqual([
				"text",
				"tool_use",
				"thinking",
			]);
		});

		it("keeps the order of turns for API key requests", async () => {
			const { wire } = await wireMessages(
				[
					user("look it up"),
					assistant([toolCall("toolu_1"), { type: "text", text: "after the call" }], "toolUse"),
					toolResult("toolu_1", [text("a")]),
				],
				apiKey,
			);

			expect((wire[1].content as Array<{ type: string }>).map((block) => block.type)).toEqual(["tool_use", "text"]);
		});

		it("ends a conversation that ends on an assistant turn with a Continue. user turn", async () => {
			const { wire } = await wireMessages([user("hi"), assistant([text("hello")], "stop")], oauthKey);

			expect(wire.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
			expect(wire[2].content).toBe("Continue.");
		});

		it("separates consecutive assistant turns with a Continue. user turn", async () => {
			const { wire } = await wireMessages(
				[
					user("hi"),
					assistant([text("one")], "stop"),
					assistant([text("two")], "stop"),
					assistant([text("three")], "stop"),
					user("go on"),
				],
				oauthKey,
			);

			expect(wire.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
				"user",
				"assistant",
				"user",
			]);
			expect(wire[2].content).toBe("Continue.");
			expect(wire[4].content).toBe("Continue.");
			expect(wire[6].content).toBe("go on");
		});

		it("sends a trailing assistant turn as it is for API key requests", async () => {
			const { wire } = await wireMessages([user("hi"), assistant([text("hello")], "stop")], apiKey);

			expect(wire.map((message) => message.role)).toEqual(["user", "assistant"]);
		});
	});
});
