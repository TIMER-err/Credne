// Message conversion rules of a Claude subscription (OAuth) request. They reproduce oh-my-pi's conversion so the
// request body matches byte for byte: tool results are block arrays, empty error results and image-only turns get
// fixed placeholder text, images of error results follow the tool results, assistant thinking is replayed signed or
// demoted to text, `tool_use` blocks close their turn, and a turn that would end or repeat an assistant message gets a
// "Continue." user turn.

import type {
	BetaContentBlockParam as ContentBlockParam,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
} from "../../types.ts";
import { applyClaudeToolPrefix } from "./identity.ts";

/** Marks a request whose messages are converted with these rules. */
export interface ClaudeCodeMessageShape {
	/** Whether the model accepts image input; without it, content is sent as one text string. */
	supportsImages: boolean;
}

/** The conversion shape of a request to `model`. */
export function getClaudeCodeMessageShape(model: Model<Api>): ClaudeCodeMessageShape {
	return { supportsImages: model.input.includes("image") };
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type ImageBlock = { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };
type TextBlock = { type: "text"; text: string };
type ToolResultContent = string | Array<TextBlock | ImageBlock>;

const imageOnlyPlaceholder = "(see attached image)";
const nonVisionImagePlaceholder = "[image omitted: model does not support vision]";
const emptyErrorResultText = "Tool failed with no output.";
const hoistedImagesCaption = "Attached image(s) from the tool result(s) above:";
const continueText = "Continue.";

/** The pads this module created, so a user's own `Continue.` is never taken for one. */
const continuePads = new WeakSet<MessageParam>();

/** The user turn that keeps a conversation from ending on, or repeating, an assistant message. */
function createContinuePad(): MessageParam {
	const pad: MessageParam = { role: "user", content: continueText };
	continuePads.add(pad);
	return pad;
}

/** Whether `message` is a pad {@link repairClaudeCodeTurnOrder} inserted, not a turn the user sent. */
export function isContinuePad(message: MessageParam | undefined): boolean {
	return message !== undefined && continuePads.has(message);
}

/** The wire media type of an image, or undefined when Anthropic cannot read the format. */
function normalizeImageMediaType(mimeType: string): ImageMediaType | undefined {
	const normalized = mimeType.trim().toLowerCase();
	if (normalized === "image/jpg") return "image/jpeg";
	if (
		normalized === "image/jpeg" ||
		normalized === "image/png" ||
		normalized === "image/gif" ||
		normalized === "image/webp"
	) {
		return normalized;
	}
	return undefined;
}

/**
 * Converts user or tool result content to text and image blocks. Whitespace-only text is dropped, and an image
 * with no text beside it gets a placeholder text block first. An image Anthropic cannot read becomes a text stub,
 * unless `rejectUnsupportedMedia` is set: the turn being answered then fails instead of being answered as if
 * nothing were attached. Older turns keep the stub, since failing on them would fail every later request.
 */
export function convertClaudeCodeContent(
	content: (TextContent | ImageContent)[],
	options: { supportsImages: boolean; rejectUnsupportedMedia?: boolean },
): ToolResultContent {
	const blocks: Array<TextBlock | ImageBlock> = [];
	let sawText = false;
	let sawImage = false;
	for (const block of content) {
		if (block.type === "text") {
			const text = block.text.toWellFormed();
			if (text.trim().length === 0) continue;
			sawText = true;
			blocks.push({ type: "text", text });
			continue;
		}
		if (!options.supportsImages) {
			blocks.push({ type: "text", text: nonVisionImagePlaceholder });
			continue;
		}
		const imageBlock = convertImage(block, options.rejectUnsupportedMedia === true);
		if (imageBlock.type === "image") sawImage = true;
		blocks.push(imageBlock);
	}
	if (!options.supportsImages) return joinText(blocks);
	if (sawImage && !sawText) blocks.unshift({ type: "text", text: imageOnlyPlaceholder });
	return blocks;
}

function convertImage(image: ImageContent, rejectUnsupportedMedia: boolean): ImageBlock | TextBlock {
	const mediaType = normalizeImageMediaType(image.mimeType);
	if (mediaType) return { type: "image", source: { type: "base64", media_type: mediaType, data: image.data } };
	if (rejectUnsupportedMedia) {
		throw new Error(
			`${image.mimeType} attachments are not supported here; send JPEG, PNG, GIF or WebP images instead`,
		);
	}
	return { type: "text", text: `[unsupported image: ${image.mimeType}]` };
}

function joinText(blocks: Array<TextBlock | ImageBlock>): string {
	return blocks
		.filter((block): block is TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.toWellFormed();
}

/**
 * The `tool_result` block of one tool result. Anthropic rejects images inside error results, so those images are
 * moved to `hoistedImages`, to follow the run of tool results. An empty result is an empty string, and an empty
 * error result says so.
 */
export function buildClaudeCodeToolResultBlock(
	msg: ToolResultMessage,
	shape: ClaudeCodeMessageShape,
	hoistedImages: ContentBlockParam[],
): ContentBlockParam {
	let content = convertClaudeCodeContent(msg.content, { supportsImages: shape.supportsImages });
	if (msg.isError && typeof content !== "string" && content.some((block) => block.type === "image")) {
		for (const block of content) {
			if (block.type === "image") hoistedImages.push(block);
		}
		content = content.filter((block) => block.type === "text");
	}
	if (Array.isArray(content) && content.length === 0) content = "";
	if (msg.isError && typeof content === "string" && content.trim().length === 0) content = emptyErrorResultText;
	return { type: "tool_result", tool_use_id: msg.toolCallId, content, is_error: msg.isError };
}

/** The blocks that follow a run of tool results when error results held images: one caption, then the images. */
export function buildHoistedImageBlocks(hoistedImages: ContentBlockParam[]): ContentBlockParam[] {
	if (hoistedImages.length === 0) return [];
	return [{ type: "text", text: hoistedImagesCaption }, ...hoistedImages];
}

type AssistantBlock = AssistantMessage["content"][number];

function hasText(value: string | undefined): value is string {
	return value !== undefined && value.trim().length > 0;
}

/**
 * Replaces lone surrogates in every string of `value`. The model can emit them in tool arguments, which then stream
 * fine but fail Anthropic's UTF-8 validation on replay. Well-formed values come back as the same object, so replayed
 * history stays byte-identical.
 */
function toWellFormedDeep(value: unknown): unknown {
	if (typeof value === "string") return value.toWellFormed();
	if (Array.isArray(value)) {
		const next = value.map(toWellFormedDeep);
		return next.every((entry, index) => entry === value[index]) ? value : next;
	}
	if (typeof value !== "object" || value === null) return value;
	const entries = Object.entries(value);
	const next = entries.map(([key, entry]) => [key, toWellFormedDeep(entry)] as const);
	return next.every(([, entry], index) => entry === entries[index]?.[1]) ? value : Object.fromEntries(next);
}

/**
 * A thinking block of an assistant turn. Signed thinking replays as it was received. Thinking with no signature, from
 * an aborted stream or another model, replays as plain text, since Anthropic rejects a thinking block it did not sign.
 * Redacted thinking replays its opaque payload. A blank block, or a redacted one with no payload, is left out.
 */
function convertThinkingBlock(block: Extract<AssistantBlock, { type: "thinking" }>): ContentBlockParam | undefined {
	if (block.redacted) {
		return hasText(block.thinkingSignature)
			? { type: "redacted_thinking", data: block.thinkingSignature }
			: undefined;
	}
	if (hasText(block.thinkingSignature)) {
		return { type: "thinking", thinking: block.thinking, signature: block.thinkingSignature };
	}
	return hasText(block.thinking) ? { type: "text", text: block.thinking.toWellFormed() } : undefined;
}

function convertAssistantBlock(block: AssistantBlock): ContentBlockParam | undefined {
	if (block.type === "text") {
		return hasText(block.text) ? { type: "text", text: block.text.toWellFormed() } : undefined;
	}
	if (block.type === "thinking") return convertThinkingBlock(block);
	return {
		type: "tool_use",
		id: block.id,
		name: applyClaudeToolPrefix(block.name),
		input: toWellFormedDeep(block.arguments ?? {}),
	};
}

/**
 * The content blocks of an assistant turn: text, thinking as {@link convertThinkingBlock} replays it, and tool calls
 * with the wire tool-name prefix, `tool_use` blocks last. A turn that converts to nothing has no blocks.
 */
export function convertClaudeCodeAssistantContent(content: AssistantMessage["content"]): ContentBlockParam[] {
	const blocks = content.map(convertAssistantBlock).filter((block): block is ContentBlockParam => block !== undefined);
	return placeToolUseLast(blocks);
}

/**
 * Moves `tool_use` blocks behind the other blocks of an assistant turn when anything but thinking follows one:
 * Anthropic rejects a non-`tool_use` block after a `tool_use`. A turn already in order is returned as it is.
 */
export function placeToolUseLast(blocks: ContentBlockParam[]): ContentBlockParam[] {
	let sawToolUse = false;
	const needsMove = blocks.some((block) => {
		if (block.type === "tool_use") sawToolUse = true;
		else if (sawToolUse && block.type !== "thinking" && block.type !== "redacted_thinking") return true;
		return false;
	});
	if (!needsMove) return blocks;
	return [
		...blocks.filter((block) => block.type !== "tool_use"),
		...blocks.filter((block) => block.type === "tool_use"),
	];
}

/**
 * Index of the message the request answers: the last user message with no assistant reply after it, or -1.
 * Media Claude cannot read fails the request there, and nowhere else.
 */
export function findUnansweredUserIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const role = messages[index]?.role;
		if (role === "assistant") return -1;
		if (role === "user") return index;
	}
	return -1;
}

/** Index of the nearest message before `index` that is not a system message, or -1. */
function previousNonSystemIndex(messages: readonly MessageParam[], index: number): number {
	let previous = index - 1;
	while (previous >= 0 && messages[previous]?.role === "system") previous--;
	return previous;
}

/**
 * Inserts a "Continue." user turn between consecutive assistant messages and after a final assistant message,
 * which Anthropic would otherwise treat as a prefill or reject. System messages in between are looked through: the
 * pad goes directly after the assistant message, ahead of them, since a system message must follow a user turn.
 */
export function repairClaudeCodeTurnOrder(messages: MessageParam[]): void {
	for (let index = messages.length - 1; index > 0; index--) {
		if (messages[index]?.role !== "assistant") continue;
		const previous = previousNonSystemIndex(messages, index);
		if (messages[previous]?.role !== "assistant") continue;
		messages.splice(previous + 1, 0, createContinuePad());
		index = previous + 1;
	}
	const last = previousNonSystemIndex(messages, messages.length);
	if (messages[last]?.role === "assistant") messages.splice(last + 1, 0, createContinuePad());
}
