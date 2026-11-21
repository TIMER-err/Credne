// Recovery from requests a Claude subscription (OAuth) endpoint rejected for a detail of the body: `cache_control`
// it does not accept, or replayed thinking blocks it can no longer verify. Each rejection is answered by one
// rewrite of the same request. Ported from oh-my-pi's Anthropic provider catch ladder.

import type {
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { registerSessionResourceCleanup } from "../../session-resources.ts";
import type { AssistantMessage } from "../../types.ts";
import { appendAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { abortableSleep } from "../../utils/provider-retry.ts";
import { getHeadersFromError, getHttpStatusFromError } from "../../utils/retry-after.ts";
import {
	isCacheControlRejection,
	isImmutableLatestThinkingText,
	isInvalidThinkingSignatureError,
	isThinkingPrefixBindingError,
} from "./errors.ts";
import { repairClaudeCodeTurnOrder } from "./messages.ts";
import { type ClaudeCodeRetryLimits, planClaudeCodeRetry } from "./retry.ts";
import {
	type AnthropicSlowModeFailure,
	type AnthropicSlowModeRetry,
	type AnthropicSlowModeSession,
	parseAnthropicSlowModeHeaders,
} from "./slow-mode.ts";

/** What a recovery changed about the request, for the diagnostic recorded on the reply. */
export type ClaudeCodeRecoveryRung =
	| "cache_control_options_rejected"
	| "cache_control_rejected"
	| "thinking_prefix_binding_rejected"
	| "thinking_latest_turn_rejected"
	| "thinking_signature_rejected";

/** What the endpoint refused in one session, so later requests do not repeat a request it will reject. */
interface SessionRefusals {
	cacheControlUnsupported: boolean;
	cacheControlOptionsUnsupported: boolean;
	thinkingReplayDisabled: boolean;
	droppedThinking: Set<string>;
}

const sessionRefusals = new Map<string, SessionRefusals>();
const maxSessionRefusals = 10_000;

registerSessionResourceCleanup((sessionId) => {
	if (sessionId) sessionRefusals.delete(sessionId);
	else sessionRefusals.clear();
});

/** The rewrites in force for one logical request, seeded from what its session already learned. */
export interface ClaudeCodeRecovery {
	readonly sessionId: string | undefined;
	dropCacheControl: boolean;
	dropCacheControlOptions: boolean;
	dropAllThinking: boolean;
	/** Replay keys (`thinking:<signature>`, `redacted:<data>`) of thinking blocks not to replay. */
	readonly droppedThinking: Set<string>;
	prefixBindingTried: boolean;
	latestTurnTried: boolean;
	/** A cache_control refusal to remember once the rewritten request has carried a turn to completion. */
	pendingCacheControlRefusal: "field" | "options" | undefined;
	/** Plain retries since the request was last rewritten; a rewrite starts the budget over. */
	retriesDone: number;
	/** When this request first waited for slow-lane capacity; the server's max-wait budget counts from there. */
	slowWaitSinceMs: number | undefined;
	/** Capacity waits this request has taken. */
	slowWaitAttempts: number;
}

/** Starts the recovery state of a request, carrying over what the session's earlier requests learned. */
export function createClaudeCodeRecovery(sessionId: string | undefined): ClaudeCodeRecovery {
	const learned = sessionId === undefined ? undefined : sessionRefusals.get(sessionId);
	return {
		sessionId,
		dropCacheControl: learned?.cacheControlUnsupported ?? false,
		dropCacheControlOptions: learned?.cacheControlOptionsUnsupported ?? false,
		dropAllThinking: learned?.thinkingReplayDisabled ?? false,
		droppedThinking: new Set(learned?.droppedThinking),
		prefixBindingTried: false,
		latestTurnTried: false,
		pendingCacheControlRefusal: undefined,
		retriesDone: 0,
		slowWaitSinceMs: undefined,
		slowWaitAttempts: 0,
	};
}

/** Remembers a cache_control refusal for the session; call once the rewritten request completed a turn. */
export function commitClaudeCodeRecovery(recovery: ClaudeCodeRecovery): void {
	const refusal = recovery.pendingCacheControlRefusal;
	if (refusal === undefined) return;
	// Both rungs replayed: the field refusal is what carried the turn, so it is what the next turn starts from.
	const refusals = getSessionRefusals(recovery.sessionId);
	if (refusals === undefined) return;
	if (refusal === "field") refusals.cacheControlUnsupported = true;
	else refusals.cacheControlOptionsUnsupported = true;
	recovery.pendingCacheControlRefusal = undefined;
}

/** Applies the rewrites in force to a built request; returns it unchanged when there are none. */
export function applyClaudeCodeRecovery(
	params: MessageCreateParamsStreaming,
	recovery: ClaudeCodeRecovery,
): MessageCreateParamsStreaming {
	let rewritten = params;
	if (recovery.dropAllThinking || recovery.droppedThinking.size > 0) rewritten = withoutThinking(rewritten, recovery);
	if (recovery.dropCacheControl) return rewriteCacheControl(rewritten, () => undefined);
	if (recovery.dropCacheControlOptions) return rewriteCacheControl(rewritten, dropCacheControlOptions);
	return rewritten;
}

/** The slow-mode wiring of a failed attempt: only a first-party OAuth request has one. */
export interface ClaudeCodeSlowModeFailure extends AnthropicSlowModeSession {
	/** Whether the failed request carried `anthropic-usage-limit: slow`. */
	sentSlow: boolean;
}

/** A failed attempt of a request, with what the answer to it needs. */
export interface ClaudeCodeFailure {
	/** The request that failed, as sent. */
	params: MessageCreateParamsStreaming;
	recovery: ClaudeCodeRecovery;
	/** The reply being built; receives a diagnostic for each rewrite. */
	output: AssistantMessage;
	signal: AbortSignal | undefined;
	/** Present when the caller plugged in a slow-mode state machine for this request. */
	slowMode?: ClaudeCodeSlowModeFailure;
}

/**
 * Answers a failed attempt of a Claude subscription request: rewrites the request when the endpoint rejected a
 * detail of it, waits for slow-lane capacity when the slow-mode hooks ask for it, or waits out the backoff when the
 * failure is transient. Returns true when the request should be sent again, false when `error` should surface, which
 * includes a transient failure whose server-requested wait exceeds `limits.maxRetryDelayMs`. Throws when
 * `failure.signal` aborts during the wait.
 */
export async function recoverFromFailure(
	error: unknown,
	failure: ClaudeCodeFailure,
	limits: ClaudeCodeRetryLimits,
): Promise<boolean> {
	if (failure.signal?.aborted) return false;
	const rung = recoverFromRejection(error, failure.params, failure.recovery);
	if (rung) {
		failure.recovery.retriesDone = 0;
		appendAssistantMessageDiagnostic(failure.output, {
			type: "anthropic_request_recovery",
			timestamp: Date.now(),
			error: { message: error instanceof Error ? error.message : String(error) },
			details: { reason: rung },
		});
		return true;
	}
	if (await waitForSlowLane(error, failure)) return true;
	const delayMs = planClaudeCodeRetry(error, failure.recovery.retriesDone, limits);
	if (delayMs === undefined) return false;
	failure.recovery.retriesDone++;
	await abortableSleep(delayMs, failure.signal);
	return true;
}

/**
 * Asks the slow-mode hooks what to do with a failure before any content. A retry they grant resends the request,
 * after the server-paced wait of a capacity retry, and starts the plain retry budget over.
 */
async function waitForSlowLane(error: unknown, failure: ClaudeCodeFailure): Promise<boolean> {
	const { slowMode, recovery } = failure;
	if (!slowMode) return false;
	const httpStatus = getHttpStatusFromError(error);
	const message = error instanceof Error ? error.message : String(error);
	const slowFailure: AnthropicSlowModeFailure = {
		lane: slowMode.lane,
		...(httpStatus === undefined ? {} : { httpStatus }),
		overloaded: httpStatus === 529 || message.includes("overloaded_error"),
		signal: parseAnthropicSlowModeHeaders(getHeadersFromError(error)),
		sentSlow: slowMode.sentSlow,
		waitedMs: recovery.slowWaitSinceMs === undefined ? 0 : Date.now() - recovery.slowWaitSinceMs,
		attempts: recovery.slowWaitAttempts,
	};
	const retry: AnthropicSlowModeRetry | undefined = await slowMode.hooks.onFailure(slowFailure);
	if (!retry) return false;
	if (retry.capacityWait) {
		recovery.slowWaitSinceMs ??= Date.now();
		recovery.slowWaitAttempts++;
	}
	if (retry.delayMs > 0) await abortableSleep(retry.delayMs, failure.signal);
	recovery.retriesDone = 0;
	return true;
}

/**
 * Chooses the rewrite that answers a rejected request and records it in `recovery`, or returns undefined when the
 * rejection is about something else or its rewrite was already tried. `params` is the request that was rejected.
 */
export function recoverFromRejection(
	error: unknown,
	params: MessageCreateParamsStreaming,
	recovery: ClaudeCodeRecovery,
): ClaudeCodeRecoveryRung | undefined {
	if (!(error instanceof Error)) return undefined;
	const message = error.message;
	if (!recovery.prefixBindingTried && isThinkingPrefixBindingError(message)) {
		recovery.prefixBindingTried = true;
		dropThinkingFromPrefixBinding(params, message, recovery);
		return "thinking_prefix_binding_rejected";
	}
	if (!recovery.latestTurnTried && isImmutableLatestThinkingText(message)) {
		const keys = latestAssistantTurnThinkingKeys(params);
		if (keys.length > 0) {
			recovery.latestTurnTried = true;
			rememberDroppedThinking(recovery, keys);
			return "thinking_latest_turn_rejected";
		}
	}
	if (
		!recovery.dropAllThinking &&
		!isThinkingPrefixBindingError(message) &&
		isInvalidThinkingSignatureError(message)
	) {
		// Every replayed block carries a signature the signer no longer accepts, and unsigned thinking is already
		// replayed as text, so prior-turn reasoning is dropped: it is optional context.
		recovery.dropAllThinking = true;
		const refusals = getSessionRefusals(recovery.sessionId);
		if (refusals) refusals.thinkingReplayDisabled = true;
		return "thinking_signature_rejected";
	}
	if (recovery.dropCacheControl || !isCacheControlRejection(error)) return undefined;
	// A nested option may be what was refused: ask without ttl and scope before giving up every breakpoint.
	if (!recovery.dropCacheControlOptions && carriesCacheControlOptions(params)) {
		recovery.dropCacheControlOptions = true;
		recovery.pendingCacheControlRefusal = "options";
		return "cache_control_options_rejected";
	}
	recovery.dropCacheControl = true;
	recovery.pendingCacheControlRefusal = "field";
	return "cache_control_rejected";
}

function getSessionRefusals(sessionId: string | undefined): SessionRefusals | undefined {
	if (sessionId === undefined) return undefined;
	const existing = sessionRefusals.get(sessionId);
	if (existing) return existing;
	const created: SessionRefusals = {
		cacheControlUnsupported: false,
		cacheControlOptionsUnsupported: false,
		thinkingReplayDisabled: false,
		droppedThinking: new Set(),
	};
	sessionRefusals.set(sessionId, created);
	if (sessionRefusals.size > maxSessionRefusals) {
		const oldest = sessionRefusals.keys().next().value;
		if (oldest !== undefined) sessionRefusals.delete(oldest);
	}
	return created;
}

/** Drops these blocks for the rest of the session, or for this request alone when it has no session. */
function rememberDroppedThinking(recovery: ClaudeCodeRecovery, keys: readonly string[]): void {
	const refusals = getSessionRefusals(recovery.sessionId);
	if (!refusals) {
		recovery.dropAllThinking = true;
		return;
	}
	for (const key of keys) {
		recovery.droppedThinking.add(key);
		refusals.droppedThinking.add(key);
	}
}

const errorPathPattern = /messages\.(\d+)\.content\.(\d+)/;

/**
 * A signed thinking block is bound to the conversation prefix it was produced after. When the prefix changed, the
 * named block and every thinking block after it are invalid, so they are dropped from here on. The error names the
 * first one as `messages.N.content.M`; without a path the first thinking block of the request stands in.
 */
function dropThinkingFromPrefixBinding(
	params: MessageCreateParamsStreaming,
	message: string,
	recovery: ClaudeCodeRecovery,
): void {
	const match = errorPathPattern.exec(message);
	const start = match ? { message: Number(match[1]), block: Number(match[2]) } : findFirstThinkingBlock(params);
	if (!start) {
		recovery.dropAllThinking = true;
		return;
	}
	const keys: string[] = [];
	for (let messageIndex = start.message; messageIndex < params.messages.length; messageIndex++) {
		const content = params.messages[messageIndex]?.content;
		if (!Array.isArray(content)) continue;
		const firstBlock = messageIndex === start.message ? start.block : 0;
		for (const block of content.slice(firstBlock)) {
			const key = thinkingReplayKey(block);
			if (key) keys.push(key);
		}
	}
	rememberDroppedThinking(recovery, keys);
}

function findFirstThinkingBlock(params: MessageCreateParamsStreaming): { message: number; block: number } | undefined {
	for (let messageIndex = 0; messageIndex < params.messages.length; messageIndex++) {
		const content = params.messages[messageIndex]?.content;
		if (!Array.isArray(content)) continue;
		const block = content.findIndex((candidate) => thinkingReplayKey(candidate) !== undefined);
		if (block >= 0) return { message: messageIndex, block };
	}
	return undefined;
}

/**
 * Replay keys of the thinking blocks in the request's latest assistant turn. Anthropic validates the last run of
 * assistant messages, joined only by tool results, as one "latest assistant message", even when user messages
 * follow it.
 */
function latestAssistantTurnThinkingKeys(params: MessageCreateParamsStreaming): string[] {
	const keys: string[] = [];
	let index = params.messages.length - 1;
	while (index >= 0 && params.messages[index]?.role !== "assistant") index--;
	for (; index >= 0; index--) {
		const message = params.messages[index]!;
		if (message.role !== "assistant" && !isToolResultsOnly(message)) break;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const key = thinkingReplayKey(block);
			if (key) keys.push(key);
		}
	}
	return keys;
}

function isToolResultsOnly(message: MessageParam): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.length > 0 &&
		message.content.every((block) => block.type === "tool_result")
	);
}

function thinkingReplayKey(block: ContentBlockParam): string | undefined {
	if (block.type === "thinking") return block.signature ? `thinking:${block.signature}` : undefined;
	if (block.type === "redacted_thinking") return block.data ? `redacted:${block.data}` : undefined;
	return undefined;
}

function isDroppedThinking(block: ContentBlockParam, recovery: ClaudeCodeRecovery): boolean {
	if (block.type !== "thinking" && block.type !== "redacted_thinking") return false;
	if (recovery.dropAllThinking) return true;
	const key = thinkingReplayKey(block);
	return key !== undefined && recovery.droppedThinking.has(key);
}

/** The request without the thinking blocks `recovery` drops; a message left empty is dropped with them. */
function withoutThinking(
	params: MessageCreateParamsStreaming,
	recovery: ClaudeCodeRecovery,
): MessageCreateParamsStreaming {
	const messages: MessageParam[] = [];
	for (const message of params.messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			messages.push(message);
			continue;
		}
		const content = message.content.filter((block) => !isDroppedThinking(block, recovery));
		if (content.length > 0) messages.push({ ...message, content });
	}
	repairClaudeCodeTurnOrder(messages);
	return { ...params, messages };
}

type CacheControl = Record<string, unknown>;

/** Dropping `ttl` and `scope` keeps the breakpoint itself. */
function dropCacheControlOptions(cacheControl: CacheControl): CacheControl {
	const { ttl: _ttl, scope: _scope, ...breakpoint } = cacheControl;
	return breakpoint;
}

function carriesCacheControlOptions(params: MessageCreateParamsStreaming): boolean {
	let found = false;
	rewriteCacheControl(params, (cacheControl) => {
		if ("ttl" in cacheControl || "scope" in cacheControl) found = true;
		return cacheControl;
	});
	return found;
}

/**
 * Rewrites every `cache_control` of a request: `rewrite` returns the replacement, or undefined to remove it. Only
 * the places a request can carry one are visited: the request itself, system blocks, tools, and message blocks
 * including the content of tool results. Tool schemas are left alone, since a parameter may be named `cache_control`.
 */
function rewriteCacheControl(
	params: MessageCreateParamsStreaming,
	rewrite: (cacheControl: CacheControl) => CacheControl | undefined,
): MessageCreateParamsStreaming {
	const rewriteBlocks = (blocks: readonly unknown[]): unknown[] => blocks.map((block) => rewriteBlock(block, rewrite));
	const rewritten: Record<string, unknown> = rewriteBlock(params, rewrite);
	if (Array.isArray(params.system)) rewritten.system = rewriteBlocks(params.system);
	if (params.tools) rewritten.tools = rewriteBlocks(params.tools);
	rewritten.messages = params.messages.map((message) =>
		Array.isArray(message.content) ? { ...message, content: rewriteBlocks(message.content) } : message,
	);
	// Only cache_control keys changed, so the result still has the request's shape.
	return rewritten as unknown as MessageCreateParamsStreaming;
}

function rewriteBlock(
	block: unknown,
	rewrite: (cacheControl: CacheControl) => CacheControl | undefined,
): Record<string, unknown> {
	const record = block as Record<string, unknown>;
	const { cache_control: cacheControl, ...rest } = record;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key !== "cache_control") {
			result[key] = value;
			continue;
		}
		const replacement = rewrite(cacheControl as CacheControl);
		if (replacement !== undefined) result[key] = replacement;
	}
	if (Array.isArray(rest.content)) {
		result.content = (rest.content as unknown[]).map((nested) =>
			nested !== null && typeof nested === "object" ? rewriteBlock(nested, rewrite) : nested,
		);
	}
	return result;
}
