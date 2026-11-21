// The lenient reader of a Claude subscription response's events. Anthropic's endpoint can splice a fresh envelope onto
// a stream after a transparent reconnect, can end a turn with a `stop_reason` and no `message_stop`, and can leave a
// block open; a strict reader fails such a turn, which is complete. This reader keeps the turn's first envelope and
// drops what a spliced one replays, accepts a stop reason as the end of the turn, and closes the blocks left open, as
// oh-my-pi's provider loop does. Only a stream that never starts or ends with no stop at all is an error, so the stream
// loop can replay the request. The API-key stream stays on the strict reader (`iterateAnthropicEvents`).

import type { BetaRawMessageStreamEvent as RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { AnthropicStreamEnvelopeError } from "./errors.ts";
import { decodeAnthropicEvents } from "./sse.ts";

/** What the reader knows of the stream's first envelope so far. */
interface Envelope {
	started: boolean;
	/** A `stop_reason` or `message_stop` has arrived: the turn is complete, and nothing after it counts. */
	terminal: boolean;
	/** A second `message_start` arrived: the stream carries a replay of blocks it already completed. */
	spliced: boolean;
	/** The blocks that are open, by Anthropic block index. An ignored block is a replay whose events are dropped. */
	openBlocks: Map<number, "live" | "ignored">;
	closedBlocks: Set<number>;
}

/**
 * The message events of a response, leniently. Events the first envelope does not account for are dropped: a second
 * `message_start`, the replay of a block already completed after a splice, and anything after the stop reason. Blocks
 * still open when the turn ends are closed with a synthesized `content_block_stop`. An event before `message_start`
 * and a stream that ends after it with no stop reason throw, so the caller can classify the failure.
 */
export async function* iterateLenientAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onPing?: () => void,
): AsyncGenerator<RawMessageStreamEvent> {
	const envelope: Envelope = {
		started: false,
		terminal: false,
		spliced: false,
		openBlocks: new Map(),
		closedBlocks: new Set(),
	};

	for await (const event of decodeAnthropicEvents(response, signal, onPing)) {
		// Blocks still open at the end of the turn are closed before it ends.
		if (event.type === "message_stop") yield* closeOpenBlocks(envelope);
		if (admitEvent(envelope, event)) yield event;
	}

	if (envelope.started && !envelope.terminal) throw new Error("Anthropic stream ended before message_stop");
	yield* closeOpenBlocks(envelope);
}

/** Whether the first envelope accounts for `event`; records what it tells about the envelope. */
function admitEvent(envelope: Envelope, event: RawMessageStreamEvent): boolean {
	if (event.type === "message_start") return admitMessageStart(envelope);
	if (!envelope.started) throw new AnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
	switch (event.type) {
		case "content_block_start":
			return admitBlockStart(envelope, event.index);
		case "content_block_delta":
			return !envelope.terminal && envelope.openBlocks.get(event.index) === "live";
		case "content_block_stop":
			return admitBlockStop(envelope, event.index);
		case "message_delta":
			return admitMessageDelta(envelope, event.delta.stop_reason);
		case "message_stop":
			envelope.terminal = true;
			return true;
	}
}

function admitMessageStart(envelope: Envelope): boolean {
	if (envelope.started) {
		envelope.spliced = true;
		return false;
	}
	envelope.started = true;
	return true;
}

function admitBlockStart(envelope: Envelope, index: number): boolean {
	if (envelope.terminal || envelope.openBlocks.has(index)) return false;
	if (envelope.spliced && envelope.closedBlocks.has(index)) {
		// A replay of a completed block: its deltas and stop are consumed without effect.
		envelope.openBlocks.set(index, "ignored");
		return false;
	}
	envelope.openBlocks.set(index, "live");
	return true;
}

function admitBlockStop(envelope: Envelope, index: number): boolean {
	const kind = envelope.openBlocks.get(index);
	if (envelope.terminal || kind === undefined) return false;
	envelope.openBlocks.delete(index);
	if (kind === "ignored") return false;
	envelope.closedBlocks.add(index);
	return true;
}

/** A second envelope's `message_delta` must not overwrite the stop reason and usage of the completed turn. */
function admitMessageDelta(envelope: Envelope, stopReason: string | null | undefined): boolean {
	if (envelope.terminal) return false;
	if (stopReason) envelope.terminal = true;
	return true;
}

function* closeOpenBlocks(envelope: Envelope): Generator<RawMessageStreamEvent> {
	for (const [index, kind] of envelope.openBlocks) {
		if (kind === "live") yield { type: "content_block_stop", index };
	}
	envelope.openBlocks.clear();
}
