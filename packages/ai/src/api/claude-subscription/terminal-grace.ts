// Reading on after the last item of a stream, for a short while. A reply is complete at its terminal item, but a relay
// can flush `message_stop` ahead of the end of the HTTP body, and cancelling a body whose last chunk has not arrived
// makes the transport close the socket instead of returning it to its pool, so every turn behind such a relay would
// pay a fresh connection. The consumer is not held up: the rest of the body drains in the background, within a grace
// window that trailing items cannot extend, so a host that never ends the body does not hold the socket either.
// Ported from oh-my-pi's `iterateWithTerminalGrace`.

/** How long to keep reading the response body after `message_stop`. */
export const postStopGraceMs = 2_500;

export interface TerminalGraceOptions<T> {
	/** Whether `item` ends the reply; the grace window starts when it is yielded. */
	isTerminal(item: T): boolean;
	graceMs: number;
	/**
	 * Called when the window closes with the source still open. The source is typically parked in a read, which a
	 * queued `return()` cannot interrupt, so this is where the transport is aborted.
	 */
	onGraceEnd(): void;
}

/**
 * Yields the items of `source`. Once the terminal item has been yielded, pulls are bounded by the grace window and
 * the stream ends cleanly when it closes, never with an error. A consumer that stops at the terminal item leaves the
 * source draining in the background until it ends or the window closes.
 */
export async function* iterateWithTerminalGrace<T>(
	source: AsyncGenerator<T>,
	options: TerminalGraceOptions<T>,
): AsyncGenerator<T> {
	let finishedAtMs: number | undefined;
	// True only while suspended at `yield`: `finally` then runs because the consumer stopped, not because the source
	// ended or failed.
	let consumerStopped = false;
	try {
		for (;;) {
			const next = await nextWithinGrace(source, finishedAtMs, options);
			if (next.done) return;
			if (options.isTerminal(next.value)) finishedAtMs = Date.now();
			consumerStopped = true;
			yield next.value;
			consumerStopped = false;
		}
	} finally {
		if (consumerStopped && finishedAtMs !== undefined) void drainWithinGrace(source, finishedAtMs, options);
		else releaseSource(source);
	}
}

const graceEnded: IteratorReturnResult<undefined> = { done: true, value: undefined };

/** The next item, or the end of the stream once the grace window of `finishedAtMs` has closed. */
async function nextWithinGrace<T>(
	source: AsyncGenerator<T>,
	finishedAtMs: number | undefined,
	options: TerminalGraceOptions<T>,
): Promise<IteratorResult<T, undefined>> {
	if (finishedAtMs === undefined) return source.next();
	const remainingMs = finishedAtMs + options.graceMs - Date.now();
	if (remainingMs > 0) {
		const pending = source.next();
		const outcome = await raceWithTimer(pending, remainingMs);
		if (outcome !== "timeout") return outcome;
		// The abandoned read settles, likely with an error, once the transport is aborted; nothing awaits it.
		pending.catch(() => {});
	}
	options.onGraceEnd();
	return graceEnded;
}

async function raceWithTimer<T>(pending: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	try {
		return await Promise.race([pending, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Discards the source's trailing items until it ends or the window closes, then releases it. Errors are moot: the reply was accepted. */
async function drainWithinGrace<T>(
	source: AsyncGenerator<T>,
	finishedAtMs: number,
	options: TerminalGraceOptions<T>,
): Promise<void> {
	try {
		for (;;) {
			const next = await nextWithinGrace(source, finishedAtMs, options);
			if (next.done) return;
		}
	} catch {
		// A transport error after the consumer finished cannot change its result.
	} finally {
		releaseSource(source);
	}
}

function releaseSource<T>(source: AsyncGenerator<T>): void {
	void source.return(undefined).catch(() => {});
}
