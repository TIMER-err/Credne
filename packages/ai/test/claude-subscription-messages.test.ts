import type { BetaMessageParam as MessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, it } from "vitest";
import {
	buildClaudeCodeToolResultBlock,
	buildHoistedImageBlocks,
	convertClaudeCodeAssistantContent,
	convertClaudeCodeContent,
	findUnansweredUserIndex,
	isContinuePad,
	placeToolUseLast,
	repairClaudeCodeTurnOrder,
} from "../src/api/claude-subscription/messages.ts";
import type { AssistantMessage, ImageContent, Message, ToolResultMessage } from "../src/types.ts";

const png: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
const vision = { supportsImages: true };

function toolResult(overrides: Partial<ToolResultMessage>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "toolu_1",
		toolName: "read",
		content: [],
		isError: false,
		timestamp: 0,
		...overrides,
	};
}

describe("tool result blocks", () => {
	it("sends text-only content as an array of text blocks", () => {
		const block = buildClaudeCodeToolResultBlock(
			toolResult({
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			}),
			vision,
			[],
		);
		expect(JSON.stringify(block)).toBe(
			'{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}],"is_error":false}',
		);
	});

	it("sends a model without vision one text string, with a stub for each image", () => {
		const block = buildClaudeCodeToolResultBlock(
			toolResult({ content: [{ type: "text", text: "one" }, png] }),
			{ supportsImages: false },
			[],
		);
		expect(block).toEqual({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content: "one\n[image omitted: model does not support vision]",
			is_error: false,
		});
	});

	it("sends an empty result as an empty string", () => {
		expect(buildClaudeCodeToolResultBlock(toolResult({ content: [] }), vision, [])).toEqual({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content: "",
			is_error: false,
		});
	});

	it("tells the model an empty error result failed with no output", () => {
		for (const content of [[], [{ type: "text" as const, text: "  \n" }]]) {
			expect(buildClaudeCodeToolResultBlock(toolResult({ content, isError: true }), vision, [])).toEqual({
				type: "tool_result",
				tool_use_id: "toolu_1",
				content: "Tool failed with no output.",
				is_error: true,
			});
		}
	});

	it("hoists the images of an error result behind a caption, keeping its text in the block", () => {
		const hoisted: Parameters<typeof buildClaudeCodeToolResultBlock>[2] = [];
		const block = buildClaudeCodeToolResultBlock(
			toolResult({ content: [{ type: "text", text: "boom" }, png], isError: true }),
			vision,
			hoisted,
		);
		expect(block).toEqual({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content: [{ type: "text", text: "boom" }],
			is_error: true,
		});
		expect(buildHoistedImageBlocks(hoisted)).toEqual([
			{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("hoists an image-only error result, whose placeholder text stays in the block", () => {
		const hoisted: Parameters<typeof buildClaudeCodeToolResultBlock>[2] = [];
		const block = buildClaudeCodeToolResultBlock(toolResult({ content: [png], isError: true }), vision, hoisted);
		expect(block).toEqual({
			type: "tool_result",
			tool_use_id: "toolu_1",
			content: [{ type: "text", text: "(see attached image)" }],
			is_error: true,
		});
		expect(hoisted).toHaveLength(1);
		expect(buildHoistedImageBlocks([])).toEqual([]);
	});
});

describe("user content", () => {
	it("adds a placeholder text block in front of an image with no text beside it", () => {
		expect(convertClaudeCodeContent([png], vision)).toEqual([
			{ type: "text", text: "(see attached image)" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("keeps an image after its text and drops whitespace-only text", () => {
		expect(
			convertClaudeCodeContent([{ type: "text", text: " " }, { type: "text", text: "look" }, png], vision),
		).toEqual([
			{ type: "text", text: "look" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		]);
	});

	it("normalizes the image media type", () => {
		const blocks = convertClaudeCodeContent(
			[
				{ type: "text", text: "x" },
				{ ...png, mimeType: " Image/JPG " },
				{ ...png, mimeType: "IMAGE/WEBP" },
			],
			vision,
		);
		expect(blocks).toEqual([
			{ type: "text", text: "x" },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
			{ type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
		]);
	});

	it("stubs an unreadable image, or fails the turn being answered", () => {
		const heic: ImageContent = { ...png, mimeType: "image/heic" };
		expect(convertClaudeCodeContent([{ type: "text", text: "x" }, heic], vision)).toEqual([
			{ type: "text", text: "x" },
			{ type: "text", text: "[unsupported image: image/heic]" },
		]);
		expect(() => convertClaudeCodeContent([heic], { ...vision, rejectUnsupportedMedia: true })).toThrow(
			"image/heic attachments are not supported here",
		);
	});

	it("replaces lone surrogates instead of removing them", () => {
		expect(convertClaudeCodeContent([{ type: "text", text: "a\uD800b" }], vision)).toEqual([
			{ type: "text", text: "a�b" },
		]);
	});
});

function assistantContent(content: AssistantMessage["content"]) {
	return convertClaudeCodeAssistantContent(content);
}

describe("assistant content", () => {
	it("replays signed thinking as received and skips blank text", () => {
		expect(
			assistantContent([
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
				{ type: "text", text: "  " },
				{ type: "text", text: "hello" },
			]),
		).toEqual([
			{ type: "thinking", thinking: "plan", signature: "sig" },
			{ type: "text", text: "hello" },
		]);
	});

	it("keeps signed thinking with empty text, which a stream can produce", () => {
		expect(assistantContent([{ type: "thinking", thinking: "", thinkingSignature: "sig" }])).toEqual([
			{ type: "thinking", thinking: "", signature: "sig" },
		]);
	});

	it("demotes unsigned thinking to text, beside signed thinking as well", () => {
		expect(
			assistantContent([
				{ type: "thinking", thinking: "signed", thinkingSignature: "sig" },
				{ type: "thinking", thinking: "from another model" },
				{ type: "thinking", thinking: "   ", thinkingSignature: "  " },
			]),
		).toEqual([
			{ type: "thinking", thinking: "signed", signature: "sig" },
			{ type: "text", text: "from another model" },
		]);
		expect(assistantContent([{ type: "thinking", thinking: "aborted", thinkingSignature: "" }])).toEqual([
			{ type: "text", text: "aborted" },
		]);
	});

	it("replays redacted thinking as its opaque payload and skips one with none", () => {
		expect(
			assistantContent([
				{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
				{ type: "thinking", thinking: "", redacted: true },
				{ type: "thinking", thinking: "", thinkingSignature: " ", redacted: true },
			]),
		).toEqual([{ type: "redacted_thinking", data: "opaque" }]);
	});

	it("sends tool calls with the wire prefix, built-in names unprefixed, and moves them to the end", () => {
		const blocks = assistantContent([
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
			{ type: "text", text: "after" },
			{ type: "toolCall", id: "t2", name: "web_search", arguments: {} },
		]);
		expect(JSON.stringify(blocks)).toBe(
			'[{"type":"text","text":"after"},{"type":"tool_use","id":"t1","name":"_read","input":{"path":"a"}},{"type":"tool_use","id":"t2","name":"web_search","input":{}}]',
		);
	});

	it("leaves a turn already in order, thinking before a tool call included", () => {
		const blocks = [
			{ type: "thinking" as const, thinking: "t", signature: "s" },
			{ type: "tool_use" as const, id: "t1", name: "_a", input: {} },
			{ type: "redacted_thinking" as const, data: "d" },
		];
		expect(placeToolUseLast(blocks)).toBe(blocks);
	});

	it("replaces lone surrogates in tool arguments and keeps well-formed arguments as they are", () => {
		const wellFormed = { path: "a", nested: { list: ["x"] } };
		const [clean, dirty] = assistantContent([
			{ type: "toolCall", id: "t1", name: "read", arguments: wellFormed },
			{ type: "toolCall", id: "t2", name: "read", arguments: { text: ["a\uD83D"] } },
		]);
		expect(clean).toMatchObject({ input: wellFormed });
		expect((clean as { input: unknown }).input).toBe(wellFormed);
		expect(dirty).toMatchObject({ input: { text: ["a�"] } });
	});

	it("converts a turn with nothing to send to no blocks", () => {
		expect(assistantContent([{ type: "text", text: " " }])).toEqual([]);
	});
});

describe("turn order", () => {
	const user = (text: string): MessageParam => ({ role: "user", content: text });
	const assistant = (text: string): MessageParam => ({ role: "assistant", content: [{ type: "text", text }] });
	const system: MessageParam = { role: "system", content: [{ type: "text", text: "note" }] };

	it("pads a conversation that ends in an assistant message with a Continue. user turn", () => {
		const messages = [user("a"), assistant("1")];
		repairClaudeCodeTurnOrder(messages);
		expect(messages).toEqual([user("a"), assistant("1"), { role: "user", content: "Continue." }]);
		expect(isContinuePad(messages[2])).toBe(true);
	});

	it("pads between consecutive assistant messages", () => {
		const messages = [user("a"), assistant("1"), assistant("2"), assistant("3"), user("b")];
		repairClaudeCodeTurnOrder(messages);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		]);
		expect(messages.filter(isContinuePad)).toHaveLength(2);
	});

	it("looks through system messages: the pad follows the assistant message, ahead of them", () => {
		const messages = [user("a"), assistant("1"), system, assistant("2"), user("b"), assistant("3"), system];
		repairClaudeCodeTurnOrder(messages);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
			"assistant",
			"user",
			"assistant",
			"user",
			"system",
		]);
	});

	it("leaves a conversation that ends in a user turn alone, and never mistakes a user's Continue. for a pad", () => {
		const messages = [user("a"), assistant("1"), user("Continue.")];
		repairClaudeCodeTurnOrder(messages);
		expect(messages).toHaveLength(3);
		expect(isContinuePad(messages[2])).toBe(false);
	});

	it("finds the user message the request answers", () => {
		const messages: Message[] = [
			{ role: "user", content: "a", timestamp: 0 },
			{ role: "user", content: "b", timestamp: 0 },
			toolResult({}),
		];
		expect(findUnansweredUserIndex(messages)).toBe(1);
		expect(findUnansweredUserIndex([...messages, { role: "user", content: "c", timestamp: 0 }])).toBe(3);
	});

	it("finds no unanswered user message once an assistant reply follows it", () => {
		const reply = { role: "assistant", content: [] } as unknown as Message;
		expect(findUnansweredUserIndex([{ role: "user", content: "a", timestamp: 0 }, reply])).toBe(-1);
	});
});
