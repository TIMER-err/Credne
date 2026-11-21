/**
 * The `thinking` object, effort, `context_management` and `tool_choice` of an Anthropic subscription (OAuth) request,
 * as Claude Code's clients derive them from the model's capabilities. Ported from the thinking section of oh-my-pi's
 * `buildParams` and its `disableThinkingIfToolChoiceForced`.
 */

import type {
	BetaContextManagementConfig,
	BetaThinkingConfigParam,
	BetaThinkingPrefixMismatchBehavior,
	BetaToolChoice,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "../anthropic-messages.ts";
import { applyClaudeToolPrefix } from "./identity.ts";
import type { ClaudeModelTraits } from "./model.ts";

export interface ClaudeCodeThinkingInput {
	traits: ClaudeModelTraits;
	/** The model reasons (`Model.reasoning`). */
	reasoning: boolean;
	/** The model uses adaptive thinking (`compat.forceAdaptiveThinking`); otherwise it takes a token budget. */
	adaptive: boolean;
	/** The caller's thinking request: on, off, or unspecified. */
	thinkingEnabled: boolean | undefined;
	effort: AnthropicEffort | undefined;
	budgetTokens: number | undefined;
	display: AnthropicThinkingDisplay | undefined;
	/** Effort controls already in the conversation rule out `thinking: {type: "disabled"}`. */
	effortBlocksDisabledThinking: boolean;
	/** What Anthropic does with a thinking block whose preceding conversation changed; `drop_block` when omitted. */
	prefixMismatchBehavior?: BetaThinkingPrefixMismatchBehavior;
}

export interface ClaudeCodeThinking {
	thinking: BetaThinkingConfigParam | undefined;
	/** Effort this request sets; undefined keeps the effort in force. */
	effort: AnthropicEffort | undefined;
}

const defaultThinkingBudgetTokens = 1024;
const defaultPrefixMismatchBehavior: BetaThinkingPrefixMismatchBehavior = "drop_block";

/**
 * Thinking off needs a model-specific form because adaptive-only Claude models reject `disabled`: Sonnet 5.5 takes
 * `between_tools`, its lowest setting; other adaptive models omit `thinking` (which means adaptive) and pin the lowest
 * effort, so a "thinking off" call stays cheap instead of failing the request with a 400.
 */
function planThinkingOff(input: ClaudeCodeThinkingInput): ClaudeCodeThinking {
	if (input.traits.supportsBetweenToolsThinking) return { thinking: { type: "between_tools" }, effort: undefined };
	if (input.adaptive) return { thinking: undefined, effort: "low" };
	return { thinking: { type: "disabled" }, effort: undefined };
}

/**
 * Thinking on. `display` is sent only where the model accepts it, since Opus 4.6 and Sonnet 4.6 reject it with a 400;
 * budget thinking always carries it. Opus 4.7 and newer default to omitted thinking, so it is requested summarized.
 * Opus 4.5 takes an effort beside its token budget.
 */
function planThinkingOn(input: ClaudeCodeThinkingInput): ClaudeCodeThinking {
	const display = input.display ?? "summarized";
	if (!input.adaptive) {
		const thinking: BetaThinkingConfigParam = {
			type: "enabled",
			budget_tokens: input.budgetTokens || defaultThinkingBudgetTokens,
			display,
		};
		return { thinking, effort: input.traits.thinkingMode === "budget-effort" ? input.effort : undefined };
	}
	const thinking: BetaThinkingConfigParam = {
		type: "adaptive",
		...(input.traits.supportsThinkingDisplay ? { display } : {}),
	};
	return { thinking, effort: input.effort };
}

function planRequestedThinking(input: ClaudeCodeThinkingInput): ClaudeCodeThinking {
	if (!input.reasoning) return { thinking: undefined, effort: undefined };
	if (input.thinkingEnabled === false && input.traits.acceptsDisabledThinking && !input.effortBlocksDisabledThinking) {
		return { thinking: { type: "disabled" }, effort: undefined };
	}
	if (input.thinkingEnabled) return planThinkingOn(input);
	if (input.thinkingEnabled === false) return planThinkingOff(input);
	return { thinking: undefined, effort: undefined };
}

/**
 * The thinking config and effort of a request. Models that bind signed thinking to the preceding conversation use
 * adaptive thinking with `block_binding`, so a prefix mismatch drops the block instead of surfacing as a persistent
 * 400. That also re-adds adaptive thinking where the request omitted it. The binding rides only on adaptive and
 * budget thinking, never on `disabled` or `between_tools`.
 */
export function planClaudeCodeThinking(input: ClaudeCodeThinkingInput): ClaudeCodeThinking {
	const planned = planRequestedThinking(input);
	const bindsThinking =
		input.reasoning && input.traits.hasThinkingPrefixBinding && input.traits.supportsThinkingBindingControls;
	if (!bindsThinking) return planned;
	const thinking = planned.thinking ?? (input.adaptive ? ({ type: "adaptive" } as const) : undefined);
	if (thinking?.type !== "adaptive" && thinking?.type !== "enabled") return planned;
	const prefixMismatchBehavior = input.prefixMismatchBehavior ?? defaultPrefixMismatchBehavior;
	return {
		thinking: { ...thinking, block_binding: { prefix_mismatch_behavior: prefixMismatchBehavior } },
		effort: planned.effort,
	};
}

/** `context_management` of a request: every earlier thinking block is kept while thinking is adaptive or enabled. */
export function planClaudeCodeContextManagement(
	thinking: BetaThinkingConfigParam | undefined,
): BetaContextManagementConfig | undefined {
	if (thinking?.type !== "adaptive" && thinking?.type !== "enabled") return undefined;
	return { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
}

export interface ClaudeCodeToolChoiceInput {
	toolChoice: AnthropicOptions["toolChoice"];
	traits: ClaudeModelTraits;
	/** The model uses adaptive thinking, which cannot be switched off by omitting `thinking`. */
	adaptive: boolean;
	thinking: BetaThinkingConfigParam | undefined;
	/** The top-level effort the request carries. */
	effort: AnthropicEffort | undefined;
}

export interface ClaudeCodeToolChoice {
	toolChoice: BetaToolChoice | undefined;
	thinking: BetaThinkingConfigParam | undefined;
	effort: AnthropicEffort | undefined;
}

function toWireToolChoice(toolChoice: AnthropicOptions["toolChoice"]): BetaToolChoice | undefined {
	if (toolChoice === undefined) return undefined;
	if (typeof toolChoice === "string") return { type: toolChoice };
	return { type: "tool", name: applyClaudeToolPrefix(toolChoice.name) };
}

/**
 * The `tool_choice` of a request and what it does to thinking. A forced choice (`any` or `tool`) is a 400 on models
 * that reject it, so it is downgraded to `auto`. Elsewhere it cannot be combined with thinking: `thinking` is dropped,
 * and so is the effort, except on adaptive models, where omitting `thinking` means adaptive thinking and the lowest
 * effort is pinned instead.
 */
export function planClaudeCodeToolChoice(input: ClaudeCodeToolChoiceInput): ClaudeCodeToolChoice {
	const toolChoice = toWireToolChoice(input.toolChoice);
	const { thinking, effort } = input;
	if (toolChoice?.type !== "any" && toolChoice?.type !== "tool") return { toolChoice, thinking, effort };
	if (!input.traits.supportsForcedToolChoice) return { toolChoice: { type: "auto" }, thinking, effort };
	return { toolChoice, thinking: undefined, effort: input.adaptive ? "low" : undefined };
}
