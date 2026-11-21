// The body of a Claude subscription (OAuth) request, built the way Claude Code's clients build it: the fields in
// their key order, the system blocks with the billing attestation, the declared tools, the thinking and effort plan,
// the cache breakpoints, and the betas. Messages are converted with oh-my-pi's rules. Ported from oh-my-pi's
// `buildParams` and `convertAnthropicMessages`.

import type {
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { AssistantMessage, Message, Model, SystemMessage, ToolResultMessage, UserMessage } from "../../types.ts";
import { renderSystemMessageUpdate } from "../../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage, type TranscriptContext } from "../../utils/transcript.ts";
import type { AnthropicEffort, AnthropicOptions } from "../anthropic-messages.ts";
import { getAnthropicCompat, isAnthropicEffort, normalizeToolCallId } from "../anthropic-shared.ts";
import { transformMessages } from "../transform-messages.ts";
import {
	applyHeadCaching,
	applyPromptCaching,
	buildClaudeCodeSystemBlocks,
	getSystemPromptSegments,
	resolveClaudeCodeCacheControl,
} from "./cache.ts";
import {
	effortControlsBlockDisabledThinking,
	insertEffortControls,
	planClaudeCodeTools,
	planClaudeEffortControls,
} from "./controls.ts";
import { buildClaudeCodeBetas, CLAUDE_CODE_CONTEXT_MANAGEMENT_BETA, CLAUDE_CODE_EFFORT_BETA } from "./fingerprint.ts";
import { buildClaudeBillingBlockText, type ClaudeCodeRequestIdentity } from "./identity.ts";
import {
	buildClaudeCodeToolResultBlock,
	buildHoistedImageBlocks,
	type ClaudeCodeMessageShape,
	convertClaudeCodeAssistantContent,
	convertClaudeCodeContent,
	findUnansweredUserIndex,
	getClaudeCodeMessageShape,
	repairClaudeCodeTurnOrder,
} from "./messages.ts";
import { getClaudeModelTraits } from "./model.ts";
import { planClaudeCodeContextManagement, planClaudeCodeThinking, planClaudeCodeToolChoice } from "./thinking.ts";
import { convertClaudeCodeTools } from "./tools.ts";

const midConversationSystemClearAtBeta = "mid-conversation-system-clear-at-2026-08-21";
const midConversationToolChangesBeta = "mid-conversation-tool-changes-2026-07-01";
const midConversationOutputConfigBeta = "mid-conversation-output-config-2026-07-01";
const serverSideFallbackBeta = "server-side-fallback-2026-07-01";
const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
const thinkingBindingControlsBeta = "thinking-binding-controls-2026-08-01";

/** What the rungs of the retry ladder change about the body of one attempt. */
export interface ClaudeCodeBuildFlags {
	/** Send no `strict: true` tool: Anthropic rejected strict tools for this request or session. */
	disableStrictTools: boolean;
	/** Withhold the prompt-cache betas: the endpoint rejected `cache_control`. */
	dropPromptCacheBetas: boolean;
}

/** A built request body and the facts the stream loop needs about it. */
export interface BuiltClaudeCodeParams {
	params: MessageCreateParamsStreaming;
	/** The body carries a `strict: true` tool, which the strict-tool downgrade ladder keys on. */
	hasStrictTools: boolean;
	/** Effort in force at the reply, recorded on it so later requests can replay effort changes. */
	providerThinkingLevel: AnthropicEffort | undefined;
}

/**
 * Builds the body of a subscription request in Claude Code's key order: `model, messages, system, tools, metadata,
 * max_tokens, thinking, context_management, output_config, fallbacks, stream`, then sampling and `tool_choice`, then
 * `betas` (which the client moves into the `anthropic-beta` header). `thread` is appended last by the thread planner.
 * Cache breakpoints are placed on the finished body, so message conversion adds none.
 */
export function buildClaudeCodeParams(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions | undefined,
	claudeCode: ClaudeCodeRequestIdentity,
	flags: ClaudeCodeBuildFlags,
): BuiltClaudeCodeParams {
	const compat = getAnthropicCompat(model);
	const cacheControl = resolveClaudeCodeCacheControl(
		compat.supportsLongCacheRetention,
		options?.cacheRetention,
		options?.env,
	);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;

	const toolPlan = planClaudeCodeTools(
		context.messages,
		compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges,
	);
	const perMessageEffort = model.compat?.supportsMidConvoEffort === true;
	const converted = convertClaudeCodeMessages(conversationMessages, getClaudeCodeMessageShape(model), {
		managedProvider: perMessageEffort ? model.provider : undefined,
		toolChangeBlocks: toolPlan.changeBlocks,
	});

	const traits = getClaudeModelTraits(model.id);
	const adaptive = model.compat?.forceAdaptiveThinking === true;
	const thinkingPlan = planClaudeCodeThinking({
		traits,
		reasoning: model.reasoning,
		adaptive,
		thinkingEnabled: options?.thinkingEnabled,
		effort: options?.effort,
		budgetTokens: options?.thinkingBudgetTokens,
		display: options?.thinkingDisplay,
		effortBlocksDisabledThinking:
			perMessageEffort && effortControlsBlockDisabledThinking(converted.messages, converted.assistantLevels),
	});
	const effortPlan = planClaudeEffortControls(
		thinkingPlan.effort,
		converted.messages,
		converted.assistantLevels,
		perMessageEffort,
	);
	// `between_tools` is a 400 at xhigh and max effort, and the effort in force outlives a thinking toggle: fall
	// back to the default adaptive request, which accepts every effort.
	const plannedThinking =
		thinkingPlan.thinking?.type === "between_tools" &&
		(effortPlan.topLevel === "xhigh" || effortPlan.topLevel === "max")
			? undefined
			: thinkingPlan.thinking;
	// A forced tool choice cannot be combined with thinking, and some models reject it outright.
	const { toolChoice, thinking, effort } = planClaudeCodeToolChoice({
		toolChoice: options?.toolChoice,
		traits,
		adaptive,
		thinking: plannedThinking,
		effort: effortPlan.topLevel,
	});
	const messages = insertEffortControls(converted.messages, effortPlan.inserts);

	const wireTools = convertClaudeCodeTools(toolPlan.tools, {
		disableStrictTools: flags.disableStrictTools,
		supportsEagerToolInputStreaming: compat.supportsEagerToolInputStreaming,
	});
	const system = buildClaudeCodeSystemBlocks(
		buildClaudeBillingBlockText(claudeCode.ccVersion),
		getSystemPromptSegments(initialSystemMessage),
		cacheControl,
	);
	const cacheableTools = compat.supportsCacheControlOnTools ? wireTools.tools : [];
	applyHeadCaching(system, cacheableTools, cacheControl);
	applyPromptCaching(messages, system, cacheableTools, cacheControl);

	// Every request with adaptive or budget thinking keeps the earlier thinking blocks.
	const contextManagement = planClaudeCodeContextManagement(thinking);
	const betas = getClaudeCodeBetaFeatures(model, options, {
		hasTools: getCurrentTools(context.messages).length > 0,
		disableStrictTools: flags.disableStrictTools,
		dropPromptCacheBetas: flags.dropPromptCacheBetas,
		carriesThinkingBinding: thinking !== undefined && "block_binding" in thinking && thinking.block_binding != null,
		carriesContextManagement: contextManagement !== undefined,
	});
	const fallbackModels = model.compat?.allowedFallbackModels ?? [];

	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages,
		system,
		tools: wireTools.tools,
		metadata: { user_id: claudeCode.userId },
		max_tokens: Math.min(model.maxTokens, options?.maxTokens ?? model.maxTokens),
		...(thinking ? { thinking } : {}),
		...(contextManagement ? { context_management: contextManagement } : {}),
		...(effort ? { output_config: { effort } } : {}),
		...(fallbackModels.length > 0
			? { fallbacks: fallbackModels.map((fallback) => ({ model: fallback.model })) }
			: {}),
		stream: true,
	};
	// Sampling parameters cannot ride with thinking and are a 400 on adaptive Claude.
	if (
		options?.temperature !== undefined &&
		traits.supportsSamplingParams &&
		compat.supportsTemperature &&
		(thinking === undefined || thinking.type === "disabled")
	) {
		params.temperature = options.temperature;
	}
	if (toolChoice) params.tool_choice = toolChoice;
	if (betas.length > 0) params.betas = betas;

	return { params, hasStrictTools: wireTools.hasStrictTools, providerThinkingLevel: effortPlan.tail };
}

function isForcedToolChoice(toolChoice: AnthropicOptions["toolChoice"]): boolean {
	return toolChoice === "any" || (typeof toolChoice === "object" && toolChoice.type === "tool");
}

/** What a subscription request's betas depend on besides the model: its tools, its finished body and its strict-tool state. */
interface ClaudeCodeBetaFacts {
	hasTools: boolean;
	disableStrictTools: boolean;
	dropPromptCacheBetas: boolean;
	/** The body carries `thinking.block_binding`. */
	carriesThinkingBinding: boolean;
	/** The body carries a `clear_thinking` context edit. */
	carriesContextManagement: boolean;
}

/**
 * Betas of a subscription request, in Claude Code's order. Claude Code's own defaults come first: the agent profile
 * for a request with tools or thinking, the utility profile otherwise. Then the betas of the model's controls:
 * effort, turn-scoped system messages, tool changes and per-message effort. Then the betas that ride exactly with
 * what the finished body carries: thinking binding and context management. The threads beta is added to a body that
 * carries `thread`, never here. A caller's `anthropic-beta` header does not count: the betas are part of the
 * fingerprint, as oh-my-pi enforces them.
 */
export function getClaudeCodeBetaFeatures(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions | undefined,
	facts: ClaudeCodeBetaFacts,
): string[] {
	const compat = getAnthropicCompat(model);
	const thinkingRequested = options?.thinkingEnabled === true;
	// `output_config.effort` ships on thinking requests and on the lowest-effort pin of an adaptive model with thinking
	// off or a forced tool choice.
	const pinsAdaptiveEffort =
		model.compat?.forceAdaptiveThinking === true &&
		(options?.thinkingEnabled === false ||
			(isForcedToolChoice(options?.toolChoice) && getClaudeModelTraits(model.id).supportsForcedToolChoice));
	const emitsEffortBeta = model.reasoning && (thinkingRequested || pinsAdaptiveEffort);
	const features = buildClaudeCodeBetas({
		agentRequest: facts.hasTools || thinkingRequested,
		thinkingRequest: thinkingRequested,
		disableStrictTools: facts.disableStrictTools,
		dropPromptCacheBetas: facts.dropPromptCacheBetas,
	});
	if (emitsEffortBeta) features.push(CLAUDE_CODE_EFFORT_BETA);
	if (compat.supportsMidConvoSystemMessages) features.push(midConversationSystemClearAtBeta);
	if (compat.supportsMidConvoToolChanges) features.push(midConversationToolChangesBeta);
	if (model.compat?.supportsMidConvoEffort === true) features.push(midConversationOutputConfigBeta);
	if ((model.compat?.allowedFallbackModels?.length ?? 0) > 0) features.push(serverSideFallbackBeta);
	if (facts.hasTools && !compat.supportsEagerToolInputStreaming) features.push(fineGrainedToolStreamingBeta);
	if (facts.carriesThinkingBinding) features.push(thinkingBindingControlsBeta);
	if (facts.carriesContextManagement) features.push(CLAUDE_CODE_CONTEXT_MANAGEMENT_BETA);
	return [...new Set(features)];
}

/** Text of the first user turn, the seed of Claude Code's billing fingerprint; empty for an image-only turn. */
export function getFirstUserText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") {
			if (message.content.trim()) return message.content;
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) return block.text;
		}
		if (message.content.some((block) => block.type === "image")) return "";
	}
	return "";
}

/**
 * The reply of a completed turn as the next request's history serializes it: its assistant message. Placeholder
 * results for trailing tool calls, which `transformMessages` adds, are left out.
 */
export function convertClaudeCodeReply(model: Model<"anthropic-messages">, reply: AssistantMessage): MessageParam[] {
	return convertClaudeCodeMessages(
		transformMessages([reply], model, normalizeToolCallId),
		getClaudeCodeMessageShape(model),
		{ managedProvider: undefined, toolChangeBlocks: undefined },
	).messages.filter((message) => message.role === "assistant");
}

interface ConvertedClaudeCodeMessages {
	messages: MessageParam[];
	/** The effort recorded on each assistant message that carries one, by its index in `messages`. */
	assistantLevels: Map<number, AnthropicEffort>;
}

interface ConversionOptions {
	/** The provider whose recorded effort levels are replayed; undefined when effort is not per message. */
	managedProvider: string | undefined;
	/** Wire blocks for a later system message's native tool changes; undefined when tool changes are not native. */
	toolChangeBlocks: ((message: SystemMessage) => ContentBlockParam[]) | undefined;
}

/**
 * Converts pi messages to Anthropic's, as oh-my-pi does. Later system messages are held back and emitted directly
 * before the next assistant message that is sent, or at the end: Anthropic requires `tool_result` blocks to follow
 * their `tool_use` immediately, and assistant messages that convert to nothing are dropped, so holding past them keeps
 * an update from landing before a user message.
 */
function convertClaudeCodeMessages(
	messages: Message[],
	shape: ClaudeCodeMessageShape,
	options: ConversionOptions,
): ConvertedClaudeCodeMessages {
	const params: MessageParam[] = [];
	const assistantLevels = new Map<number, AnthropicEffort>();
	const unansweredUserIndex = findUnansweredUserIndex(messages);
	const pendingSystemMessages: MessageParam[] = [];
	const flushPendingSystemMessages = (): void => {
		params.push(...pendingSystemMessages);
		pendingSystemMessages.length = 0;
	};

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "system") {
			const update = convertSystemUpdate(message, options.toolChangeBlocks);
			if (update) pendingSystemMessages.push(update);
		} else if (message.role === "user") {
			const user = convertUserMessage(message, shape, index === unansweredUserIndex);
			if (user) params.push(user);
		} else if (message.role === "assistant") {
			const content = convertClaudeCodeAssistantContent(message.content);
			if (content.length === 0) continue;
			flushPendingSystemMessages();
			const level = recordedEffort(message, options.managedProvider);
			if (level !== undefined) assistantLevels.set(params.length, level);
			params.push({ role: "assistant", content });
		} else if (message.role === "toolResult") {
			// A run of tool results is one user turn; the images of error results follow all of them.
			const run = collectToolResults(messages, index, shape);
			index = run.lastIndex;
			params.push({ role: "user", content: run.content });
		}
	}
	flushPendingSystemMessages();

	// The turns the repair inserts shift message indexes, which `assistantLevels` is keyed by.
	const levelMessages = [...assistantLevels].map(([position, level]) => ({ message: params[position], level }));
	repairClaudeCodeTurnOrder(params);
	assistantLevels.clear();
	for (const { message, level } of levelMessages) assistantLevels.set(params.indexOf(message), level);

	return { messages: params, assistantLevels };
}

function convertSystemUpdate(
	message: SystemMessage,
	toolChangeBlocks: ConversionOptions["toolChangeBlocks"],
): MessageParam | undefined {
	// Later system messages only reach this point when the model accepts them natively; otherwise the transcript was
	// collapsed into the leading message before conversion.
	const text = renderSystemMessageUpdate(message);
	const blocks: ContentBlockParam[] = [];
	if (text.length > 0) blocks.push({ type: "text", text: text.toWellFormed() });
	if (toolChangeBlocks) blocks.push(...toolChangeBlocks(message));
	return blocks.length > 0 ? { role: "system", content: blocks } : undefined;
}

function convertUserMessage(
	message: UserMessage,
	shape: ClaudeCodeMessageShape,
	isUnanswered: boolean,
): MessageParam | undefined {
	if (typeof message.content === "string") {
		return message.content.trim().length > 0 ? { role: "user", content: message.content.toWellFormed() } : undefined;
	}
	const content = convertClaudeCodeContent(message.content, {
		supportsImages: shape.supportsImages,
		rejectUnsupportedMedia: isUnanswered,
	});
	return content.length > 0 ? { role: "user", content } : undefined;
}

/** The effort recorded on an assistant message of the managed provider, which later requests replay. */
function recordedEffort(message: AssistantMessage, managedProvider: string | undefined): AnthropicEffort | undefined {
	if (managedProvider === undefined || message.api !== "anthropic-messages") return undefined;
	if (message.provider !== managedProvider) return undefined;
	return isAnthropicEffort(message.providerThinkingLevel) ? message.providerThinkingLevel : undefined;
}

function collectToolResults(
	messages: Message[],
	start: number,
	shape: ClaudeCodeMessageShape,
): { content: ContentBlockParam[]; lastIndex: number } {
	const toolResults: ContentBlockParam[] = [];
	const hoistedImages: ContentBlockParam[] = [];
	let lastIndex = start;
	while (lastIndex < messages.length && messages[lastIndex].role === "toolResult") {
		const result = messages[lastIndex] as ToolResultMessage;
		toolResults.push(buildClaudeCodeToolResultBlock(result, shape, hoistedImages));
		lastIndex++;
	}
	return { content: [...toolResults, ...buildHoistedImageBlocks(hoistedImages)], lastIndex: lastIndex - 1 };
}
