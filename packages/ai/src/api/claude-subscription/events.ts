// Maps the message events of a Claude subscription response to pi's: the reply's content blocks (text, thinking with
// its signature, redacted thinking, tool calls with their partial arguments), its usage and cost, its stop reason, and
// the stream events a consumer sees. Server tool blocks have no pi representation and are skipped. The emitted events
// are the ones the API-key stream emits for the same response. Based on pi-sub-anthropic's `stream.ts`.

import type {
	BetaInputTransformation as InputTransformation,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { calculateCost } from "../../models.ts";
import type { AssistantMessage, AssistantMessageEvent, JsonObject, Model } from "../../types.ts";
import { ToolCallArgumentsStream } from "../../utils/streaming-json.ts";
import { mapStopReason } from "../anthropic-shared.ts";
import { stripClaudeToolPrefix } from "./identity.ts";

/** Reads the message events of one response into `output`, pushing the stream events they cause. */
export interface EventMapper {
	apply(event: RawMessageStreamEvent): void;
	/** The input transformations the server reported for the request, if any. */
	getInputTransformations(): InputTransformation[] | undefined;
}

/** A block being streamed: where it sits in the reply, and the argument text of a tool call. */
interface OpenBlock {
	contentIndex: number;
	arguments?: ToolCallArgumentsStream;
}

/** Creates the mapper of one response. `output` is the reply being built; `push` hands events to the stream. */
export function createEventMapper(
	model: Model<"anthropic-messages">,
	output: AssistantMessage,
	push: (event: AssistantMessageEvent) => void,
): EventMapper {
	// Stream state per Anthropic block index, kept off the content blocks so it never reaches partials.
	const openBlocks = new Map<number, OpenBlock>();
	let usageModel = model;
	let inputTransformations: InputTransformation[] | undefined;

	const openBlock = (index: number) => {
		const open = openBlocks.get(index);
		return open === undefined ? undefined : { ...open, block: output.content[open.contentIndex]! };
	};

	const apply = (event: RawMessageStreamEvent): void => {
		switch (event.type) {
			case "message_start":
				applyMessageStart(event);
				return;
			case "content_block_start":
				applyBlockStart(event);
				return;
			case "content_block_delta":
				applyBlockDelta(event);
				return;
			case "content_block_stop":
				applyBlockStop(event);
				return;
			case "message_delta":
				applyMessageDelta(event);
				return;
			default:
				return;
		}
	};

	function applyMessageStart(event: Extract<RawMessageStreamEvent, { type: "message_start" }>): void {
		const { message } = event;
		output.responseId = message.id;
		if (message.input_transformations) inputTransformations = message.input_transformations;
		if (message.model !== model.id) output.responseModel = message.model;
		usageModel = servedModel(model, message.model);
		// The input counts are recorded now, so they survive a stream that is cut early.
		output.usage.input = message.usage.input_tokens || 0;
		output.usage.output = message.usage.output_tokens || 0;
		output.usage.cacheRead = message.usage.cache_read_input_tokens || 0;
		output.usage.cacheWrite = message.usage.cache_creation_input_tokens || 0;
		output.usage.cacheWrite1h = message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
		updateTotalAndCost();
	}

	function applyBlockStart(event: Extract<RawMessageStreamEvent, { type: "content_block_start" }>): void {
		const block = event.content_block;
		if (block.type === "fallback") {
			if (output.content.length > 0) throw new Error("Anthropic performed an unsupported mid-output model fallback");
			return;
		}
		if (block.type === "text") {
			startBlock(event.index, { type: "text", text: block.text ?? "" }, "text_start");
		} else if (block.type === "thinking") {
			const thinking = {
				type: "thinking" as const,
				thinking: block.thinking ?? "",
				thinkingSignature: block.signature ?? "",
			};
			startBlock(event.index, thinking, "thinking_start");
		} else if (block.type === "redacted_thinking") {
			const redacted = {
				type: "thinking" as const,
				thinking: "[Reasoning redacted]",
				thinkingSignature: block.data,
				redacted: true,
			};
			startBlock(event.index, redacted, "thinking_start");
		} else if (block.type === "tool_use") {
			const toolCall = {
				type: "toolCall" as const,
				id: block.id,
				name: stripClaudeToolPrefix(block.name),
				arguments: (block.input as JsonObject) ?? {},
			};
			startBlock(event.index, toolCall, "toolcall_start", new ToolCallArgumentsStream());
		}
	}

	function startBlock(
		index: number,
		content: AssistantMessage["content"][number],
		type: "text_start" | "thinking_start" | "toolcall_start",
		argumentsStream?: ToolCallArgumentsStream,
	): void {
		output.content.push(content);
		const contentIndex = output.content.length - 1;
		openBlocks.set(index, { contentIndex, arguments: argumentsStream });
		push({ type, contentIndex, partial: output });
	}

	function applyBlockDelta(event: Extract<RawMessageStreamEvent, { type: "content_block_delta" }>): void {
		const open = openBlock(event.index);
		const { delta } = event;
		if (delta.type === "text_delta") {
			if (open?.block.type !== "text") return;
			open.block.text += delta.text;
			push({ type: "text_delta", contentIndex: open.contentIndex, delta: delta.text, partial: output });
		} else if (delta.type === "thinking_delta") {
			if (open?.block.type !== "thinking") return;
			open.block.thinking += delta.thinking;
			push({ type: "thinking_delta", contentIndex: open.contentIndex, delta: delta.thinking, partial: output });
		} else if (delta.type === "input_json_delta") {
			if (open?.block.type !== "toolCall" || open.arguments === undefined) return;
			open.block.arguments = open.arguments.append(delta.partial_json);
			push({ type: "toolcall_delta", contentIndex: open.contentIndex, delta: delta.partial_json, partial: output });
		} else if (delta.type === "signature_delta") {
			if (open?.block.type !== "thinking") return;
			open.block.thinkingSignature = (open.block.thinkingSignature || "") + delta.signature;
		}
	}

	function applyBlockStop(event: Extract<RawMessageStreamEvent, { type: "content_block_stop" }>): void {
		const open = openBlock(event.index);
		openBlocks.delete(event.index);
		if (!open) return;
		const { block, contentIndex } = open;
		if (block.type === "text") {
			push({ type: "text_end", contentIndex, content: block.text, partial: output });
		} else if (block.type === "thinking") {
			push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
		} else if (block.type === "toolCall" && open.arguments !== undefined) {
			Object.assign(block, open.arguments.finish());
			push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
		}
	}

	function applyMessageDelta(event: Extract<RawMessageStreamEvent, { type: "message_delta" }>): void {
		if (event.input_transformations) inputTransformations = event.input_transformations;
		if (event.delta.stop_reason) {
			output.rawStopReason = event.delta.stop_reason;
			const stopReason = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
			output.stopReason = stopReason.stopReason;
			if (stopReason.errorMessage) output.errorMessage = stopReason.errorMessage;
		}
		if (event.usage) applyUsageDelta(event.usage);
		updateTotalAndCost();
	}

	// Only fields that are present count, which keeps the input tokens of `message_start` when a proxy omits them here.
	function applyUsageDelta(usage: Extract<RawMessageStreamEvent, { type: "message_delta" }>["usage"]): void {
		if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
		if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
		if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
		if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
		// Anthropic reports reasoning tokens as a subset of output tokens.
		const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
		if (thinkingTokens != null) output.usage.reasoning = thinkingTokens;
	}

	// Anthropic does not provide total_tokens, so it is computed from the components.
	function updateTotalAndCost(): void {
		output.usage.totalTokens =
			output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		calculateCost(usageModel, output.usage);
	}

	return { apply, getInputTransformations: () => inputTransformations };
}

/** The model that is priced: the requested model, or the fallback that answered, at the fallback's own rates. */
function servedModel(model: Model<"anthropic-messages">, responseModel: string): Model<"anthropic-messages"> {
	if (responseModel === model.id) return model;
	const fallbackCost = model.compat?.allowedFallbackModels?.find(
		(fallback) => fallback.provider === model.provider && fallback.model === responseModel,
	)?.cost;
	return fallbackCost ? { ...model, id: responseModel, cost: fallbackCost } : model;
}
