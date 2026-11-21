// Message threads of Claude subscription requests (`message-threads-2026-08-12`). The server keeps a conversation for
// 5 minutes after its last stored reply, so a long agent loop uploads its history once and then sends only what each
// turn appends. Every request is planned from the full body that would go without a thread, so the client stays the
// source of truth: it continues the last stored reply when the fixed fields and the earlier messages are unchanged,
// and creates a new thread otherwise. Any doubt costs a full upload, never a conversation that diverges from the
// client's. Ported from oh-my-pi's `anthropic-threads.ts`.

import type {
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { registerSessionResourceCleanup } from "../../session-resources.ts";
import type { Model } from "../../types.ts";
import { shortHash } from "../../utils/hash.ts";
import { isContextOverflowText } from "../../utils/overflow.ts";
import { continueBreakpoints } from "./cache.ts";
import { AnthropicApiError } from "./client.ts";
import { getClaudeModelTraits } from "./model.ts";

/** The `thread` field of a request: a new thread, or the continuation of a stored reply. */
export type ThreadParam = { type: "create" } | { type: "continue"; previous_message_id: string };

/** A request body with its `thread`; the SDK's types do not know the field. */
export type ThreadedParams = MessageCreateParamsStreaming & { thread?: ThreadParam };

/** Gates the `thread` field; it rides only on requests that carry one. */
export const messageThreadsBeta = "message-threads-2026-08-12";

/**
 * How long after a stored reply a continue may name it. The server keeps a thread 5 minutes after its last stored
 * reply; the margin covers the delay between the server storing it and the client seeing `message_stop`.
 */
const threadReuseWindowMs = 270_000;

/**
 * Refused continues in a row (each followed by a replay) that stop threading the session: a conversation the server
 * keeps failing to continue right after a replay is one it cannot store.
 */
const maxRefusedContinues = 2;

/** Sessions kept; the least recently used goes first. Library users that never end a session are bounded by it. */
const maxChains = 10_000;

/** Error text of thread 400s that carry no `error_code` (a continue without `previous_message_id`, one that sends `system`). */
const threadErrorText = /(?<!diagnostics\.)previous_message_id|\bthread\b.{0,3}(?:param|field|request|type|:)/i;

/** The reply a continue names, and what the server holds for it. */
interface ThreadAnchor {
	/** Id of the stored reply, the `previous_message_id` of the continue. */
	messageId: string;
	/** Number of messages the server holds: the request's messages plus the reply. */
	messageCount: number;
	/** `hashThread()` of the fixed fields and those messages. */
	hash: string;
	/** When the reply was stored (`Date.now()`). */
	storedAt: number;
}

/** One session's thread bookkeeping. */
interface ThreadChain {
	/** The stored reply the next request may continue. A continue that names it removes it: each reply continues once. */
	anchor: ThreadAnchor | undefined;
	/** Continues the server refused since the last success; {@link maxRefusedContinues} disables the chain. */
	refusedContinues: number;
	/** The server cannot thread this session's requests; later requests go without `thread`. */
	disabled: boolean;
}

const chains = new Map<string, ThreadChain>();

registerSessionResourceCleanup((sessionId) => {
	if (sessionId) chains.delete(sessionId);
	else chains.clear();
});

function getChain(sessionId: string): ThreadChain {
	let chain = chains.get(sessionId);
	if (chain) {
		// Re-insert so Map order stays least recently used first.
		chains.delete(sessionId);
	} else {
		chain = { anchor: undefined, refusedContinues: 0, disabled: false };
		const oldest = chains.size >= maxChains ? chains.keys().next().value : undefined;
		if (oldest !== undefined) chains.delete(oldest);
	}
	chains.set(sessionId, chain);
	return chain;
}

/**
 * Whether a subscription request may use threads: the model's own flag, else Claude 4.5 and newer on Anthropic's own
 * endpoint. A gateway that drops unknown request fields would silently turn a `continue` into a request without the
 * earlier conversation.
 */
export function claudeCodeThreadsEnabled(model: Model<"anthropic-messages">): boolean {
	const explicit = model.compat?.supportsMessageThreads;
	if (explicit !== undefined) return explicit;
	return model.baseUrl.includes("api.anthropic.com") && getClaudeModelTraits(model.id).supportsMessageThreads;
}

/** The request with the threads beta, which rides exactly on requests that carry `thread`. */
function withMessageThreadsBeta(params: MessageCreateParamsStreaming): MessageCreateParamsStreaming {
	const betas = params.betas ?? [];
	return betas.includes(messageThreadsBeta) ? params : { ...params, betas: [...betas, messageThreadsBeta] };
}

/** A thread request: the body to send, and whether it creates a thread or continues one. */
export interface ThreadPlan {
	kind: "create" | "continue";
	body: ThreadedParams;
}

/** What to do with a request the server refused for a thread reason: send it as a new thread, or without `thread`. */
export type ThreadRecovery = "replay" | "unthreaded";

/** A reply the server stored and the next request may continue. */
export interface StoredReply {
	messageId: string;
	/** The reply as the next request's history serializes it. */
	messages: readonly MessageParam[];
}

/** One request's use of its session's thread. */
export interface ThreadTurn {
	/**
	 * The thread request for `params`, or undefined to send the request without a thread. The same params return the
	 * same plan, so a transient retry resends the same continue.
	 */
	plan(params: MessageCreateParamsStreaming): ThreadPlan | undefined;
	/** The answer to a failure the server gave for a thread reason, or undefined for any other failure. */
	recover(error: unknown): ThreadRecovery | undefined;
	/**
	 * Whether to send the planned request again without `thread`, after a 400 nothing else explained (undocumented
	 * thread rejections arrive as plain 400s; a context overflow is not one). When that resend carries the turn, the
	 * thread was the problem, and {@link settle} stops threading the session.
	 */
	dropAfterUnexplained400(error: unknown): boolean;
	/** Records the completed turn; `stored` is the reply when the server keeps it continuable. */
	settle(stored: StoredReply | undefined): void;
}

interface PlannedRequest {
	params: MessageCreateParamsStreaming;
	plan: ThreadPlan;
	/** Hash of the fixed fields of this request and the given messages. */
	hashOf(messages: readonly MessageParam[]): string;
}

/** Starts the thread bookkeeping of one request of `sessionId` to `baseUrl`. */
export function createThreadTurn(sessionId: string, baseUrl: string): ThreadTurn {
	const chain = getChain(sessionId);
	// The anchor this request continues, taken off the chain when first planned.
	let claimed: ThreadAnchor | undefined;
	let forceCreate = false;
	let unthreaded = false;
	// The unthreaded resend after an unexplained 400 is on trial: if it carries the turn, the session stops threading.
	let disableOnSuccess = false;
	let planned: PlannedRequest | undefined;

	const disable = (): void => {
		chain.disabled = true;
		chain.anchor = undefined;
		claimed = undefined;
		unthreaded = true;
	};

	return {
		plan(params) {
			if (unthreaded || chain.disabled || !isThreadable(params)) {
				planned = undefined;
				return undefined;
			}
			if (planned?.params === params) return planned.plan;
			const hashOf = (messages: readonly MessageParam[]): string => hashThread(baseUrl, params, messages);
			const anchor = forceCreate ? undefined : (claimed ?? chain.anchor);
			const continued = anchor && canContinue(anchor, params, hashOf) ? anchor : undefined;
			if (continued) {
				claimed = continued;
				if (chain.anchor === continued) chain.anchor = undefined;
			}
			const plan = continued ? continueRequest(params, continued) : createRequest(params);
			planned = { params, plan, hashOf };
			return plan;
		},

		recover(error) {
			const threadRequest = planned?.plan;
			if (!threadRequest) return undefined;
			const code = threadErrorCode(error);
			if (code === undefined) return undefined;
			planned = undefined;
			if (code === "thread_unsupported_request" || threadRequest.kind === "create") {
				// An organization setting or a feature threads lack; a create refused for a thread reason says the same.
				disable();
				return "unthreaded";
			}
			// Expired, unstored, already continued, in flight, or the fixed fields drifted: the conversation itself is
			// fine, so replay it in full.
			claimed = undefined;
			chain.refusedContinues++;
			if (chain.refusedContinues >= maxRefusedContinues) {
				disable();
				return "unthreaded";
			}
			forceCreate = true;
			return "replay";
		},

		dropAfterUnexplained400(error) {
			if (!planned || !(error instanceof AnthropicApiError) || error.status !== 400) return false;
			if (isContextOverflowText(error.message)) return false;
			planned = undefined;
			unthreaded = true;
			disableOnSuccess = true;
			return true;
		},

		settle(stored) {
			if (disableOnSuccess) {
				disable();
				return;
			}
			// An unthreaded request leaves the server's thread as it was.
			if (!planned) return;
			if (planned.plan.kind === "continue" || !forceCreate) chain.refusedContinues = 0;
			if (!stored) {
				chain.anchor = undefined;
				return;
			}
			const messages = [...planned.params.messages, ...stored.messages];
			chain.anchor = {
				messageId: stored.messageId,
				messageCount: messages.length,
				hash: planned.hashOf(messages),
				storedAt: Date.now(),
			};
		},
	};
}

function canContinue(
	anchor: ThreadAnchor,
	params: MessageCreateParamsStreaming,
	hashOf: (messages: readonly MessageParam[]) => string,
): boolean {
	return (
		Date.now() - anchor.storedAt < threadReuseWindowMs &&
		params.messages.length > anchor.messageCount &&
		hashOf(params.messages.slice(0, anchor.messageCount)) === anchor.hash
	);
}

/**
 * A continue. It keeps `system` and `tools`, which Claude Code's subscription traffic resends (the billing block that
 * attests the request lives in `system`, and the endpoint fingerprints it); the documented API contract omits them.
 * Its breakpoints are the first appended block and the newest.
 */
function continueRequest(params: MessageCreateParamsStreaming, anchor: ThreadAnchor): ThreadPlan {
	const thread: ThreadParam = { type: "continue", previous_message_id: anchor.messageId };
	const messages = continueBreakpoints(params.messages.slice(anchor.messageCount));
	return { kind: "continue", body: { ...withMessageThreadsBeta(params), messages, thread } };
}

function createRequest(params: MessageCreateParamsStreaming): ThreadPlan {
	return { kind: "create", body: { ...withMessageThreadsBeta(params), thread: { type: "create" } } };
}

/** Whether a thread can hold this body: it keeps only `clear_thinking` context edits, and no turn-scoped messages. */
function isThreadable(params: MessageCreateParamsStreaming): boolean {
	if (params.context_management?.edits?.some((edit) => edit.type !== "clear_thinking_20251015")) return false;
	return !params.messages.some((message) => "clear_at" in message);
}

/**
 * Hash of everything a continue builds on: the endpoint, the fixed fields as sent (the server rejects changes to them
 * with `thread_fingerprint_mismatch`, and a change to `system` or `tools` can only be noticed here, cache markers
 * included) and the messages the server already holds, normalized so that messages that mean the same hash the same.
 */
function hashThread(baseUrl: string, params: MessageCreateParamsStreaming, messages: readonly MessageParam[]): string {
	const { model, system, tools, tool_choice, thinking, output_config, context_management, fallbacks, betas } = params;
	const settings = JSON.stringify([
		baseUrl,
		model,
		system,
		tools,
		tool_choice,
		thinking,
		output_config,
		context_management,
		(fallbacks?.length ?? 0) > 0,
		[...new Set(betas)].sort(),
	]);
	const conversation = JSON.stringify(messages, (key, value: unknown) => {
		// Cache markers move: the newest message has one in the request that sent it and none in the next request.
		if (key === "cache_control") return undefined;
		// To attach a marker, a string content is sent as one text block: "hi" and [{ type: "text", text: "hi" }]
		// are the same message.
		if (key === "content" && typeof value === "string") return [{ type: "text", text: value }];
		return value;
	});
	return shortHash(settings + conversation);
}

/** The thread error code of a failed request: `error.details.error_code`, or a codeless thread 400. */
function threadErrorCode(error: unknown): string | undefined {
	if (!(error instanceof AnthropicApiError)) return undefined;
	if (error.status !== 400 && error.status !== 404) return undefined;
	if (error.code?.startsWith("thread_")) return error.code;
	// A 404 for an unknown model is not a thread error.
	if (error.status === 404) return error.message.includes("thread_not_found") ? "thread_not_found" : undefined;
	return threadErrorText.test(error.message) ? "thread_invalid_request" : undefined;
}
