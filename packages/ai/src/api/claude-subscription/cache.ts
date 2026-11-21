/**
 * Prompt-cache breakpoint placement of an Anthropic subscription (OAuth) request, as Claude Code's clients place it:
 * a long default lifetime, one breakpoint on the last stable system block, one on the last non-deferred tool, and the
 * rest of the four-breakpoint budget on the message tail and every 15th user turn.
 * Ported from oh-my-pi's `providers/anthropic.ts` and `providers/anthropic-threads.ts`.
 */

import type {
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	BetaMessageParam as MessageParam,
	BetaTextBlockParam as TextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { CacheRetention, ProviderEnv, SystemMessage } from "../../types.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { contentText } from "../../utils/text.ts";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "./fingerprint.ts";
import { isContinuePad } from "./messages.ts";

/** The request may carry at most this many `cache_control` breakpoints. */
const maxBreakpoints = 4;
/** A decimation checkpoint marks every Nth conversational user turn, keeping long-context anchors stable. */
const decimationInterval = 15;

/**
 * System segments whose bytes differ between sessions or turns of the same agent: per-turn memory recall and the
 * working-directory context. The system breakpoint anchors on the block right before the first of them, so the static
 * head is shared byte for byte across sessions in different directories. Only a leading tag counts.
 */
const volatileSystemSegmentMarkers = ["<memories>", "<project-context>"];

/**
 * Cache lifetime of a subscription request. Claude Code's native policy is the one-hour lifetime where the model
 * supports it, which avoids cold cache writes after 15 idle minutes; an explicit retention, then `PI_CACHE_RETENTION`,
 * takes precedence. Undefined when caching is off.
 */
export function resolveClaudeCodeCacheControl(
	supportsLongCacheRetention: boolean,
	cacheRetention: CacheRetention | undefined,
	env: ProviderEnv | undefined,
): CacheControlEphemeral | undefined {
	const envRetention = getProviderEnvValue("PI_CACHE_RETENTION", env);
	const configured =
		envRetention === "long" || envRetention === "short" || envRetention === "none" ? envRetention : undefined;
	const retention = cacheRetention ?? configured ?? (supportsLongCacheRetention ? "long" : "short");
	if (retention === "none") return undefined;
	const ttl = retention === "long" && supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl && { ttl }) };
}

/** The prompt segments of a system message: its base prompt, then each named section, one segment per system block. */
export function getSystemPromptSegments(message: SystemMessage | undefined): string[] {
	if (!message) return [];
	const sections = Object.values(message.sections ?? {}).filter((section): section is string => section !== null);
	return [contentText(message.content), ...sections];
}

/**
 * System blocks of a subscription request: the billing block (never cached, its position anchors the `cch` hash),
 * Claude Code's identity block, then one block per prompt segment. The identity block carries the breakpoint until
 * {@link applyHeadCaching} moves it to the last stable block. It carries a default breakpoint even when caching is off,
 * as Claude Code's own requests do.
 */
export function buildClaudeCodeSystemBlocks(
	billingText: string,
	segments: readonly string[],
	cacheControl: CacheControlEphemeral | undefined,
): TextBlockParam[] {
	const prompts = segments.map((segment) => segment.toWellFormed()).filter((prompt) => prompt.trim().length > 0);
	return [
		{ type: "text", text: billingText },
		{
			type: "text",
			text: CLAUDE_CODE_SYSTEM_INSTRUCTION,
			cache_control: { ...(cacheControl ?? { type: "ephemeral" }) },
		},
		...prompts.map((text): TextBlockParam => ({ type: "text", text })),
	];
}

function volatileSuffixStart(systemBlocks: readonly TextBlockParam[]): number {
	const start = systemBlocks.findIndex((block) =>
		volatileSystemSegmentMarkers.some((marker) => block.text.startsWith(marker)),
	);
	return start === -1 ? systemBlocks.length : start;
}

/**
 * Anchors the stable request head: the last non-deferred tool (deferred tools are not part of the checked prefix until
 * referenced) and the last system block before the volatile suffix. The identity block's breakpoint moves to that
 * anchor instead of a second one being added, which keeps the budget at tool, system and two message breakpoints.
 */
export function applyHeadCaching(
	systemBlocks: TextBlockParam[],
	tools: BetaTool[],
	cacheControl: CacheControlEphemeral | undefined,
): void {
	if (!cacheControl) return;
	if (tools.length > 0 && !tools.some((tool) => tool.cache_control != null)) {
		const anchorTool = tools.findLast((tool) => !tool.defer_loading);
		if (anchorTool) anchorTool.cache_control = { ...cacheControl };
	}
	if (systemBlocks.length === 0) return;
	const suffixStart = volatileSuffixStart(systemBlocks);
	const anchor = systemBlocks[suffixStart === 0 ? systemBlocks.length - 1 : suffixStart - 1];
	if (anchor.cache_control != null) return;
	for (const block of systemBlocks) delete block.cache_control;
	anchor.cache_control = { ...cacheControl };
}

function countHeadBreakpoints(systemBlocks: readonly TextBlockParam[], tools: readonly BetaTool[]): number {
	return (
		systemBlocks.filter((block) => block.cache_control != null).length +
		tools.filter((tool) => tool.cache_control != null).length
	);
}

type CacheableBlock = Extract<ContentBlockParam, { type: "text" | "image" | "tool_use" | "tool_result" }>;

/**
 * Whether the block can carry a breakpoint: ordinary content, including tool use and tool results. Anthropic rejects
 * `cache_control` on generated reasoning, fallback boundaries and the blocks of mid-conversation tool changes.
 */
function isCacheable(block: ContentBlockParam): block is CacheableBlock {
	return block.type === "text" || block.type === "image" || block.type === "tool_use" || block.type === "tool_result";
}

/** Puts the breakpoint on the last block that accepts one. False when the block already has one or none accepts it. */
function applyCacheControlToLastBlock(blocks: ContentBlockParam[], cacheControl: CacheControlEphemeral): boolean {
	for (let index = blocks.length - 1; index >= 0; index--) {
		const block = blocks[index];
		if (!isCacheable(block)) continue;
		if (block.cache_control != null) return false;
		blocks[index] = { ...block, cache_control: { ...cacheControl } };
		return true;
	}
	return false;
}

function applyCacheControlToMessage(message: MessageParam, cacheControl: CacheControlEphemeral): boolean {
	if (typeof message.content === "string") {
		message.content = [{ type: "text", text: message.content, cache_control: { ...cacheControl } }];
		return true;
	}
	return applyCacheControlToLastBlock(message.content, cacheControl);
}

/** A mid-conversation tool-control message: a `system` message that only adds or removes tools. */
function isToolControlMessage(message: MessageParam): boolean {
	return (
		message.role === "system" &&
		typeof message.content !== "string" &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "tool_addition" || block.type === "tool_removal")
	);
}

/** A turn-scoped system message is absent from the next request, so it cannot anchor a prefix the next request reuses. */
function isTurnScoped(message: MessageParam): boolean {
	return message.clear_at === "next_user_message";
}

/**
 * A real user turn: a user message that is neither a tool-result run nor the `Continue.` pad. The pad is told apart by
 * identity, since a user who types `Continue.` still sends a turn.
 */
export function isConversationalUser(message: MessageParam): boolean {
	if (message.role !== "user" || isContinuePad(message)) return false;
	return typeof message.content === "string" || !message.content.some((block) => block.type === "tool_result");
}

interface TailWalk {
	/** Up to two newest messages that can carry a breakpoint. */
	trailingCandidates: number[];
	/** Conversational user turns in the stable range, which ends before the first turn-scoped message. */
	stableUserTurns: number;
	/** Last message of the stable range: the walk's end, or the message before the first turn-scoped one. */
	stableMessageEnd: number;
}

/**
 * One backward walk over the tail resolves everything the anchors need. Turn-scoped messages are skipped as candidates,
 * and the first one from the start is the last this walk sees: it ends the stable range and resets the turn count, so
 * the count covers exactly the turns before it. Oh-my-pi also skips per-call context messages; the transcript here has
 * no such marker.
 */
function walkMessageTail(messages: readonly MessageParam[], messageEnd: number): TailWalk {
	const trailingCandidates: number[] = [];
	let stableUserTurns = 0;
	let markIndex = -1;
	for (let index = messageEnd; index >= 0; index--) {
		const message = messages[index];
		if (isTurnScoped(message)) {
			markIndex = index;
			stableUserTurns = 0;
			continue;
		}
		if (trailingCandidates.length < 2 && !isToolControlMessage(message)) trailingCandidates.push(index);
		if (isConversationalUser(message)) stableUserTurns++;
	}
	return { trailingCandidates, stableUserTurns, stableMessageEnd: markIndex === -1 ? messageEnd : markIndex - 1 };
}

/**
 * Places the message breakpoints, in priority order: the newest message, decimation checkpoints (every 15th user turn,
 * newest first), the newest message of the stable range when a turn-scoped message ends it, then the second newest
 * message. The budget is four minus the head breakpoints, and only successful decorations count against it, so a
 * thinking-only assistant message does not silently spend one. A trailing `Continue.` pad is absent from the next
 * normal turn, so the rolling window anchors on the assistant before it.
 */
export function applyPromptCaching(
	messages: MessageParam[],
	systemBlocks: readonly TextBlockParam[],
	tools: readonly BetaTool[],
	cacheControl: CacheControlEphemeral | undefined,
): void {
	if (!cacheControl || messages.length === 0) return;
	const budget = Math.max(0, maxBreakpoints - countHeadBreakpoints(systemBlocks, tools));
	if (budget <= 0) return;

	const trailingIndex = messages.length - 1;
	const hasTrailingPad = isContinuePad(messages[trailingIndex]) && messages[trailingIndex - 1]?.role === "assistant";
	const messageEnd = hasTrailingPad ? trailingIndex - 1 : trailingIndex;
	const { trailingCandidates, stableUserTurns, stableMessageEnd } = walkMessageTail(messages, messageEnd);

	let applied = 0;
	const mark = (index: number): void => {
		if (applied < budget && applyCacheControlToMessage(messages[index], cacheControl)) applied++;
	};
	if (trailingCandidates.length > 0) mark(trailingCandidates[0]);
	if (stableUserTurns >= decimationInterval) {
		let turnsSinceCheckpoint = stableUserTurns % decimationInterval;
		for (let index = stableMessageEnd; index >= 0 && applied < budget; index--) {
			if (!isConversationalUser(messages[index])) continue;
			if (turnsSinceCheckpoint > 0) {
				turnsSinceCheckpoint--;
				continue;
			}
			turnsSinceCheckpoint = decimationInterval - 1;
			mark(index);
		}
	}
	if (stableMessageEnd < messageEnd && stableMessageEnd >= 0) mark(stableMessageEnd);
	for (const index of trailingCandidates) mark(index);
}

function withoutCacheControl(block: ContentBlockParam): ContentBlockParam {
	if (!("cache_control" in block) || block.cache_control == null) return block;
	const copy = { ...block };
	delete copy.cache_control;
	return copy;
}

interface BlockPosition {
	message: number;
	block: number;
}

interface AppendedBreakpoints {
	template: CacheControlEphemeral | undefined;
	first: BlockPosition | undefined;
	newest: BlockPosition | undefined;
}

function findAppendedBreakpoints(appended: readonly MessageParam[]): AppendedBreakpoints {
	let template: CacheControlEphemeral | undefined;
	let newest: BlockPosition | undefined;
	let first: BlockPosition | undefined;
	for (const [message, { content }] of appended.entries()) {
		if (typeof content === "string") {
			first ??= { message, block: 0 };
			continue;
		}
		for (const [block, entry] of content.entries()) {
			if (!first && isCacheable(entry)) first = { message, block };
			if ("cache_control" in entry && entry.cache_control) newest = { message, block };
			if (isCacheable(entry) && entry.cache_control) template = entry.cache_control;
		}
	}
	return { template, first, newest };
}

/**
 * Breakpoints for the messages a thread `continue` appends. The create request's system, tools and earlier message
 * breakpoints keep working on every continue, but a continue's own breakpoints act on that request only, each looking
 * back about 20 blocks. The trailing breakpoint reaches the previous request's cache entry only when the stored
 * response plus the appended blocks fit that lookback, and a turn of parallel tool calls does not. This keeps the
 * newest breakpoint, which writes the turn, adds one on the first appended block, which reads up to the previous
 * request, and drops the rest. Messages without a breakpoint (caching off) pass through.
 */
export function continueBreakpoints(appended: MessageParam[]): MessageParam[] {
	const { template, first, newest } = findAppendedBreakpoints(appended);
	if (!template || !first) return appended;
	const isMarked = (message: number, block: number): boolean =>
		(message === first.message && block === first.block) || (message === newest?.message && block === newest.block);
	return appended.map((message, messageIndex) => {
		if (messageIndex !== first.message && typeof message.content === "string") return message;
		const content: ContentBlockParam[] =
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		let changed = typeof message.content === "string";
		const next = content.map((block, blockIndex) => {
			if (!isMarked(messageIndex, blockIndex)) {
				const stripped = withoutCacheControl(block);
				changed ||= stripped !== block;
				return stripped;
			}
			if (!isCacheable(block) || block.cache_control) return block;
			changed = true;
			return { ...block, cache_control: { ...template } };
		});
		return changed ? { ...message, content: next } : message;
	});
}
