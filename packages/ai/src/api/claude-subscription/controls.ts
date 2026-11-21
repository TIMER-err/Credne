/**
 * Mid-conversation controls of an Anthropic subscription (OAuth) request, as Claude Code's clients send them: the
 * declared tool list that stays byte-stable while tools change through `tool_addition` / `tool_removal` references, and
 * the top-level effort that stays fixed while later effort changes ride on `system` messages, and the turn-scoped
 * split of a system message that also carries such a change.
 * Ported from oh-my-pi's `planAnthropicToolControls`, `planAnthropicEffortControls` and the system-message upgrade
 * of `encodeAnthropicMessages`.
 */

import type {
	BetaContentBlockParam as ContentBlockParam,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Message, SystemMessage } from "../../types.ts";
import { getCurrentTools, getDeclaredTools, getInitialSystemMessage } from "../../utils/transcript.ts";
import type { AnthropicEffort } from "../anthropic-messages.ts";
import { isConversationalUser } from "./cache.ts";
import { applyClaudeToolPrefix } from "./identity.ts";
import type { ClaudeModelTraits } from "./model.ts";
import type { ClaudeCodeTool } from "./tools.ts";

export interface ClaudeCodeToolPlan {
	/** The request-level `tools` field: every tool the transcript declares, in first-declaration order. */
	tools: ClaudeCodeTool[];
	/**
	 * Wire blocks for one later system message's tool changes, called once per system message in transcript order.
	 * Undefined when tool changes are not native, so the request-level list is the only place tools live.
	 */
	changeBlocks: ((message: SystemMessage) => ContentBlockParam[]) | undefined;
}

/**
 * Plans the declared tools. With native tool changes the declaration is every tool the transcript ever declared, so the
 * cached prefix survives each change: tools the first system message did not declare are `defer_loading`, and later
 * changes are `tool_addition` / `tool_removal` references to them. Anthropic rejects a declaration whose tools are all
 * deferred, so a transcript that starts without tools declares them all in place; the references then replay when each
 * one became available. Without native tool changes the request carries the current tools.
 */
export function planClaudeCodeTools(messages: readonly Message[], nativeToolChanges: boolean): ClaudeCodeToolPlan {
	if (!nativeToolChanges) {
		return { tools: getCurrentTools(messages).map((tool) => ({ tool, deferred: false })), changeBlocks: undefined };
	}
	const initialNames = new Set((getInitialSystemMessage(messages)?.toolsAdded ?? []).map((tool) => tool.name));
	const declared = getDeclaredTools(messages);
	const hasActiveDeclaration = declared.some((tool) => initialNames.has(tool.name));
	const tools = declared.map((tool) => ({ tool, deferred: hasActiveDeclaration && !initialNames.has(tool.name) }));

	const declaredNames = new Set(declared.map((tool) => tool.name));
	// What the wire has made available so far, and what the transcript has made available.
	let wireActive = tools.filter((entry) => !entry.deferred).map((entry) => entry.tool.name);
	const transcriptActive = new Set(initialNames);
	const changeBlocks = (message: SystemMessage): ContentBlockParam[] => {
		for (const removed of message.toolsRemoved ?? []) transcriptActive.delete(removed.name);
		for (const added of message.toolsAdded ?? []) transcriptActive.add(added.name);
		const next = [...transcriptActive];
		const blocks = diffActiveTools(wireActive, next, declaredNames);
		wireActive = next;
		return blocks;
	};
	return { tools, changeBlocks };
}

function toolReference(name: string): { type: "tool_reference"; name: string } {
	return { type: "tool_reference", name: applyClaudeToolPrefix(name) };
}

/** `tool_removal`s (in `previous` order) then `tool_addition`s (in `next` order), limited to declared tools. */
function diffActiveTools(
	previous: readonly string[],
	next: readonly string[],
	declared: ReadonlySet<string>,
): ContentBlockParam[] {
	const previousSet = new Set(previous);
	const nextSet = new Set(next);
	const blocks: ContentBlockParam[] = [];
	for (const name of previous) {
		if (!nextSet.has(name) && declared.has(name)) blocks.push({ type: "tool_removal", tool: toolReference(name) });
	}
	for (const name of next) {
		if (!previousSet.has(name) && declared.has(name))
			blocks.push({ type: "tool_addition", tool: toolReference(name) });
	}
	return blocks;
}

/** A control to splice in before `messages[index]`. */
interface EffortInsert {
	index: number;
	effort: AnthropicEffort;
}

export interface ClaudeCodeEffortPlan {
	/** `output_config.effort` of the request. It stays the first request's effort for the whole conversation. */
	topLevel: AnthropicEffort | undefined;
	inserts: EffortInsert[];
	/** The effort in force at this request's reply, recorded on it so later requests can replay the changes. */
	tail: AnthropicEffort | undefined;
}

/**
 * Slot of an effort control for the reply at `end`: before the turn's user message, where Anthropic applies it to
 * that response, or at `end` when the request continues a tool loop. It never lands between a `tool_use` and its
 * `tool_result`.
 */
function effortInsertIndex(messages: readonly MessageParam[], end: number): number {
	for (let index = end - 1; index >= 0; index--) {
		if (messages[index].role === "assistant") return end;
		if (isConversationalUser(messages[index])) return index;
	}
	return end;
}

/**
 * Plans the effort of the request. The first recorded reply's effort is the top-level effort and stays that for the
 * conversation, so the cached prefix survives effort changes. Each later change is replayed as a `system` message
 * where it happened, and `current` is appended only when it differs from the effort in force. An omitted `current`
 * keeps the effort in force. `levels` maps the index of each assistant message to the effort recorded on it.
 * Without per-message effort the top-level effort is `current`.
 */
export function planClaudeEffortControls(
	current: AnthropicEffort | undefined,
	messages: readonly MessageParam[],
	levels: ReadonlyMap<number, AnthropicEffort>,
	perMessageEffort: boolean,
): ClaudeCodeEffortPlan {
	if (!perMessageEffort) return { topLevel: current, inserts: [], tail: undefined };
	const first = levels.values().next();
	if (first.done) return { topLevel: current, inserts: [], tail: current };
	const topLevel = first.value;
	const inserts: EffortInsert[] = [];
	let tail = topLevel;
	for (const [index, effort] of levels) {
		if (effort !== tail) inserts.push({ index: effortInsertIndex(messages, index), effort });
		tail = effort;
	}
	if (current !== undefined && current !== tail) {
		inserts.push({ index: effortInsertIndex(messages, messages.length), effort: current });
		tail = current;
	}
	return { topLevel, inserts, tail };
}

/** Splices the effort controls into `messages`; controls at one index merge into one, the later effort winning. */
export function insertEffortControls(messages: MessageParam[], inserts: readonly EffortInsert[]): MessageParam[] {
	if (inserts.length === 0) return messages;
	const merged = new Map<number, AnthropicEffort>();
	for (const { index, effort } of inserts) merged.set(index, effort);
	const result = messages.slice();
	for (const [index, effort] of [...merged].sort((left, right) => right[0] - left[0])) {
		result.splice(index, 0, { role: "system", content: [], output_config: { effort } });
	}
	return result;
}

/**
 * Whether the controls rule out `thinking: {type: "disabled"}`: Anthropic rejects a per-message effort control with
 * thinking off, and `disabled` above `high` effort. Both stay in force across a thinking toggle.
 */
export function effortControlsBlockDisabledThinking(
	messages: readonly MessageParam[],
	levels: ReadonlyMap<number, AnthropicEffort>,
): boolean {
	const plan = planClaudeEffortControls(undefined, messages, levels, true);
	return plan.inserts.length > 0 || plan.topLevel === "xhigh" || plan.topLevel === "max";
}

export interface ClaudeSystemControlInput {
	/** The blocks of the system message: its text and its tool changes. */
	content: ContentBlockParam[];
	/** `next_user_message` makes the message's text visible only for the user turn it follows. */
	clearAt: "next_user_message" | undefined;
	/** A per-message effort the message carries. */
	effort: AnthropicEffort | undefined;
	traits: Pick<ClaudeModelTraits, "supportsTurnScopedSystem" | "supportsPerMessageEffort">;
}

/**
 * The wire system message of one mid-conversation control. A turn-scoped message that also changes tools or effort
 * splits in two: its text, scoped to the next user turn, and a bare control carrying the changes, because a scoped
 * message would drop them with its text. Without a scope, or with nothing but text, it stays one message.
 */
export function renderClaudeSystemControl(input: ClaudeSystemControlInput): MessageParam[] {
	const { content, traits } = input;
	const turnScoped = input.clearAt === "next_user_message" && traits.supportsTurnScopedSystem;
	const effort = traits.supportsPerMessageEffort ? input.effort : undefined;
	const hasToolChanges = content.some((block) => block.type === "tool_addition" || block.type === "tool_removal");
	const outputConfig = effort === undefined ? {} : { output_config: { effort } };
	const text = content.filter((block) => block.type === "text");
	if (turnScoped && (effort !== undefined || hasToolChanges) && text.length > 0) {
		const changes = content.filter((block) => block.type !== "text");
		return [
			{ role: "system", content: text, clear_at: "next_user_message" },
			{ role: "system", content: changes, ...outputConfig },
		];
	}
	const clearAt =
		turnScoped && effort === undefined && !hasToolChanges ? { clear_at: "next_user_message" as const } : {};
	return [{ role: "system", content, ...clearAt, ...outputConfig }];
}
