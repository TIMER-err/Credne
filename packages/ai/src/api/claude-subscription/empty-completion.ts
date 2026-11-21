// Outer retry of a Claude subscription reply that completed with nothing in it. The endpoint sometimes ends a turn
// with a normal stop, at most one output token and no visible content; the same request usually answers on replay.
// A reply can be discarded only until meaningful output has been streamed, so the events before that are held back and
// a replayed attempt never repeats content to the consumer. Ported from oh-my-pi's `utils/empty-completion-retry.ts`,
// which wraps `streamAnthropic` with `retryEmptyCompletion: true` and no provider-error retries (the stream loop owns
// those).

import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { abortableSleep } from "../../utils/provider-retry.ts";
import { lazyStream } from "../lazy.ts";

/** Replays of an empty completion, after the first attempt. */
export const maxEmptyCompletionRetries = 2;
/** Wait before the first replay; it doubles for each further one. */
export const emptyCompletionBaseDelayMs = 500;

const nonWhitespacePattern = /\S/;

/**
 * Whether a completed reply carries content worth delivering: a tool call, or any non-whitespace text. A message that
 * is empty, whitespace only, or holds nothing but thinking is the "empty completion" failure.
 */
export function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	return message.content.some(
		(block) => block.type === "toolCall" || (block.type === "text" && nonWhitespacePattern.test(block.text)),
	);
}

/**
 * Whether an event delivers content that commits the attempt. `toolcall_start` and `toolcall_end` markers do not: a
 * stream that dies before any argument arrives is retried, because the held-back markers never reached the consumer
 * and no tool ran.
 */
function isMeaningfulCompletionEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		default:
			return false;
	}
}

/** Whether `message` is a benign empty stop: nothing visible, at most one token, no error, not a paused turn. */
function isEmptyCompletion(message: AssistantMessage): boolean {
	return (
		message.stopReason === "stop" &&
		message.rawStopReason !== "pause_turn" &&
		message.rawStopReason !== "compaction" &&
		!message.errorMessage &&
		message.usage.output <= 1 &&
		!hasVisibleAssistantContent(message)
	);
}

export interface EmptyCompletionRetryOptions {
	signal?: AbortSignal;
	/** The caller takes an empty reply as the answer, so it is never replayed. */
	acceptEmptyResponse?: boolean;
}

/**
 * Runs `attempt` and replays it, up to {@link maxEmptyCompletionRetries} times with a doubling wait, while it
 * completes empty before streaming any content. Any other result is passed through unchanged. An attempt that throws
 * ends the returned stream with an error event, as a setup failure does.
 */
export function withEmptyCompletionRetry(
	model: Model<Api>,
	attempt: () => AssistantMessageEventStream,
	options: EmptyCompletionRetryOptions = {},
): AssistantMessageEventStream {
	return lazyStream(model, async () => emptyCompletionRetryEvents(attempt, options), undefined, options.signal);
}

/** The events of `attempt` and its replays, in order, ending with the terminal event of the last attempt. */
export async function* emptyCompletionRetryEvents(
	attempt: () => AssistantMessageEventStream,
	options: EmptyCompletionRetryOptions = {},
): AsyncGenerator<AssistantMessageEvent> {
	const { signal } = options;
	for (let replays = 0; ; replays++) {
		const held: AssistantMessageEvent[] = [];
		let committed = options.acceptEmptyResponse === true;
		let terminal: AssistantMessageEvent | undefined;
		for await (const event of attempt()) {
			if (event.type === "done" || event.type === "error") {
				terminal = event;
				break;
			}
			if (!committed && !isMeaningfulCompletionEvent(event)) {
				held.push(event);
				continue;
			}
			committed = true;
			yield* held.splice(0);
			yield event;
		}
		if (!terminal) throw new Error("The Claude subscription stream ended without a final message");
		const replay =
			!committed &&
			terminal.type === "done" &&
			replays < maxEmptyCompletionRetries &&
			signal?.aborted !== true &&
			isEmptyCompletion(terminal.message);
		if (replay) {
			try {
				await abortableSleep(emptyCompletionBaseDelayMs * 2 ** replays, signal);
				continue;
			} catch {
				// Aborted while waiting: the empty reply stands as it was.
			}
		}
		yield* held;
		yield terminal;
		return;
	}
}
