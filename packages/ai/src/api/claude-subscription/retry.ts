// Retry policy and stream watchdogs of a Claude subscription (OAuth) request. Ported from oh-my-pi's Anthropic
// provider loop: the HTTP client never retries, the loop below the request replays transient failures up to ten
// times and only until the first content block of the reply starts, and two watchdogs end a stream that stalls.

import type { BetaRawMessageStreamEvent as RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { ProviderEnv } from "../../types.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { DEFAULT_MAX_RETRY_DELAY_MS } from "../../utils/provider-retry.ts";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "../../utils/retry-after.ts";
import {
	AnthropicStreamEnvelopeError,
	AnthropicStreamTimeoutError,
	isClaudeCodeRetryableError,
	isTransientStreamFailure,
} from "./errors.ts";

/** Retry budget when the caller sets none: oh-my-pi's provider loop retries up to ten times. */
export const claudeCodeMaxRetries = 10;

const initialRetryDelaySeconds = 0.5;
const maxRetryDelaySeconds = 8;
const defaultStreamTimeoutMs = 300_000;
// Pings keep a quiet stream alive, but only for this many idle periods without a real event, so a wedged upstream
// that pings forever still trips the watchdog.
const pingProgressMaxIdleMultiplier = 3;

export interface ClaudeCodeRetryLimits {
	/** Retries after the first attempt; defaults to {@link claudeCodeMaxRetries}. */
	maxRetries?: number;
	/** Longest server-requested wait honoured, in milliseconds; 0 disables the limit. Defaults to 60 seconds. */
	maxRetryDelayMs?: number;
}

/** Exponential backoff `0.5s * 2^retryIndex`, capped at 8s, with up to 25% downward jitter. */
export function calculateClaudeCodeBackoffMs(retryIndex: number): number {
	const sleepSeconds = Math.min(initialRetryDelaySeconds * 2 ** retryIndex, maxRetryDelaySeconds);
	return sleepSeconds * (1 - Math.random() * 0.25) * 1000;
}

/**
 * Delay before replaying `error`, or undefined when it should surface instead: it is not transient, the retry
 * budget is used up, a local idle timeout ended the stream, or the server's retry hint exceeds `maxRetryDelayMs`
 * (60 seconds by default; 0 disables the limit), so a multi-hour wait does not park the request. The error then
 * surfaces as it is, with its status and headers, as oh-my-pi's loop rethrows it. The delay is the larger of the
 * server's retry hint and the backoff.
 */
export function planClaudeCodeRetry(
	error: unknown,
	retriesDone: number,
	limits: ClaudeCodeRetryLimits,
): number | undefined {
	if (retriesDone >= (limits.maxRetries ?? claudeCodeMaxRetries)) return undefined;
	if (error instanceof AnthropicStreamTimeoutError && error.kind === "idle") return undefined;
	if (!isTransientStreamFailure(error) && !isClaudeCodeRetryableError(error)) return undefined;
	const backoffMs = calculateClaudeCodeBackoffMs(retriesDone);
	const hintMs = getRetryAfterMsFromHeaders(getHeadersFromError(error));
	if (hintMs === undefined) return backoffMs;
	const maxDelayMs = limits.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && hintMs > maxDelayMs) return undefined;
	return Math.max(hintMs, backoffMs);
}

export interface StreamTimeouts {
	/** Longest wait for the first real event of a response; undefined disables it. */
	firstEventTimeoutMs?: number;
	/** Longest gap between real events; undefined disables it. */
	idleTimeoutMs?: number;
}

/**
 * Watchdog limits: `PI_STREAM_IDLE_TIMEOUT_MS` (or its older alias `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`) and
 * `PI_STREAM_FIRST_EVENT_TIMEOUT_MS`, five minutes by default, 0 to disable. The first-event limit never undershoots
 * the idle limit, because the first token may legitimately take longer than later gaps.
 */
export function resolveStreamTimeouts(env: ProviderEnv | undefined): StreamTimeouts {
	const idleTimeoutMs = readTimeout(
		getProviderEnvValue("PI_STREAM_IDLE_TIMEOUT_MS", env) ??
			getProviderEnvValue("PI_OPENAI_STREAM_IDLE_TIMEOUT_MS", env),
		defaultStreamTimeoutMs,
	);
	const firstEventFallbackMs = Math.max(defaultStreamTimeoutMs, idleTimeoutMs ?? 0);
	return {
		idleTimeoutMs,
		firstEventTimeoutMs: readTimeout(
			getProviderEnvValue("PI_STREAM_FIRST_EVENT_TIMEOUT_MS", env),
			firstEventFallbackMs,
		),
	};
}

function readTimeout(raw: string | undefined, fallbackMs: number): number | undefined {
	if (raw === undefined) return fallbackMs;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return fallbackMs;
	return parsed <= 0 ? undefined : Math.trunc(parsed);
}

/** Guards one response stream against stalls; `ping()` records a keepalive the event parser swallowed. */
export interface StreamWatchdog {
	ping(): void;
	/**
	 * Watches `source`. `isProgress` says whether an event shows the model working; an event that does not is still
	 * passed on, but neither ends the first-event wait nor extends the idle deadline. Every event counts by default.
	 */
	wrap<T>(source: AsyncGenerator<T>, isProgress?: (event: T) => boolean): AsyncGenerator<T>;
}

/**
 * Whether a stream event is an empty content delta (`text_delta`, `thinking_delta` or `input_json_delta` with no
 * content), which a wedged upstream can emit forever without producing anything: it is no progress.
 */
export function isEmptyContentDelta(event: RawMessageStreamEvent): boolean {
	if (event.type !== "content_block_delta") return false;
	switch (event.delta.type) {
		case "text_delta":
			return event.delta.text === "";
		case "thinking_delta":
			return event.delta.thinking === "";
		case "input_json_delta":
			return event.delta.partial_json === "";
		default:
			return false;
	}
}

const timedOut = Symbol("timedOut");

/**
 * Creates a watchdog for one response stream. `wrap()` ends the stream with an {@link AnthropicStreamTimeoutError}
 * when no real event arrives within `firstEventTimeoutMs` of the stream starting, or within `idleTimeoutMs` of the
 * last one, and calls `abort` so the transport gives up too. Pings extend the idle deadline only once real events
 * flow, and only for {@link pingProgressMaxIdleMultiplier} idle periods.
 */
export function createStreamWatchdog(timeouts: StreamTimeouts, abort: () => void): StreamWatchdog {
	let sawEvent = false;
	let lastEventAt = Date.now();
	let lastLivenessAt = lastEventAt;

	const deadlineMs = (): number | undefined => {
		if (!sawEvent)
			return timeouts.firstEventTimeoutMs === undefined ? undefined : lastEventAt + timeouts.firstEventTimeoutMs;
		return timeouts.idleTimeoutMs === undefined ? undefined : lastLivenessAt + timeouts.idleTimeoutMs;
	};

	const ping = (): void => {
		if (!sawEvent || timeouts.idleTimeoutMs === undefined) return;
		const now = Date.now();
		if (now - lastEventAt < timeouts.idleTimeoutMs * pingProgressMaxIdleMultiplier) lastLivenessAt = now;
	};

	// Waits for `pending`, re-reading the deadline after every timer because a ping can move it.
	const awaitNext = async <T>(pending: Promise<IteratorResult<T>>): Promise<IteratorResult<T> | typeof timedOut> => {
		for (;;) {
			const deadline = deadlineMs();
			if (deadline === undefined) return pending;
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return timedOut;
			const timer = createTimer(remainingMs);
			try {
				const result = await Promise.race([pending, timer.promise]);
				if (result !== timedOut) return result;
			} finally {
				timer.clear();
			}
		}
	};

	async function* wrap<T>(source: AsyncGenerator<T>, isProgress?: (event: T) => boolean): AsyncGenerator<T> {
		lastEventAt = lastLivenessAt = Date.now();
		try {
			for (;;) {
				const pending = source.next();
				const next = await awaitNext(pending);
				if (next === timedOut) {
					const kind = sawEvent ? "idle" : "first-event";
					// The pending read settles once the transport is aborted; nobody awaits it any more.
					pending.catch(() => {});
					abort();
					throw new AnthropicStreamTimeoutError(kind);
				}
				if (next.done) return;
				if (isProgress?.(next.value) !== false) {
					sawEvent = true;
					lastEventAt = lastLivenessAt = Date.now();
				}
				yield next.value;
			}
		} finally {
			void source.return(undefined).catch(() => {});
		}
	}

	return { ping, wrap };
}

function createTimer(ms: number): { promise: Promise<typeof timedOut>; clear: () => void } {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<typeof timedOut>((resolve) => {
		handle = setTimeout(() => resolve(timedOut), ms);
	});
	return { promise, clear: () => clearTimeout(handle) };
}

/**
 * Reads `events` until the first content block starts and returns a stream that replays everything read so far.
 * A failure before that point is thrown here, with nothing of the reply processed yet, so the request can be
 * replayed. A stream that ends before `message_start` is an envelope error.
 */
export async function primeStream<T extends { type: string }>(events: AsyncGenerator<T>): Promise<AsyncGenerator<T>> {
	const head: T[] = [];
	let sawMessageStart = false;
	for (;;) {
		const next = await events.next();
		if (next.done) {
			if (!sawMessageStart) throw new AnthropicStreamEnvelopeError("stream ended before message_start");
			break;
		}
		head.push(next.value);
		if (next.value.type === "message_start") sawMessageStart = true;
		if (next.value.type === "content_block_start") break;
	}
	return replayThenContinue(head, events);
}

async function* replayThenContinue<T>(head: T[], events: AsyncGenerator<T>): AsyncGenerator<T> {
	try {
		yield* head;
		for (;;) {
			const next = await events.next();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		void events.return(undefined).catch(() => {});
	}
}
