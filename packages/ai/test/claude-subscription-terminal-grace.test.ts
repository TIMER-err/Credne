// Reading on after the last item of a stream: the grace window that lets a body finish draining in the background, and
// ends the stream cleanly, never with an error, when a host holds the body open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { iterateWithTerminalGrace, postStopGraceMs } from "../src/api/claude-subscription/terminal-grace.ts";

/**
 * A source that yields `items` and then waits to be told how to end. Settling the wait is what a transport abort does
 * to a read in flight.
 */
function heldSource(items: string[]) {
	let end: { resolve(): void; reject(error: Error): void } | undefined;
	const released = vi.fn();
	async function* source(): AsyncGenerator<string> {
		try {
			for (const item of items) yield item;
			await new Promise<void>((resolve, reject) => {
				end = { resolve, reject };
			});
		} finally {
			released();
		}
	}
	return {
		source: source(),
		released,
		finish: () => end?.resolve(),
		abort: () => end?.reject(new Error("aborted")),
	};
}

const isStop = (item: string): boolean => item === "stop";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("iterateWithTerminalGrace", () => {
	it("yields every item and ends when the source ends within the window", async () => {
		const released = vi.fn();
		async function* finite(): AsyncGenerator<string> {
			try {
				yield* ["a", "stop", "usage"];
			} finally {
				released();
			}
		}
		const onGraceEnd = vi.fn();

		const items: string[] = [];
		for await (const item of iterateWithTerminalGrace(finite(), { isTerminal: isStop, graceMs: 100, onGraceEnd })) {
			items.push(item);
		}

		expect(items).toEqual(["a", "stop", "usage"]);
		expect(onGraceEnd).not.toHaveBeenCalled();
		expect(released).toHaveBeenCalledOnce();
	});

	it("does not bound the wait before the terminal item", async () => {
		const held = heldSource(["a"]);
		const iterator = iterateWithTerminalGrace(held.source, {
			isTerminal: isStop,
			graceMs: 100,
			onGraceEnd: vi.fn(),
		});

		expect((await iterator.next()).value).toBe("a");
		let settled = false;
		const pending = iterator.next().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(60_000);

		expect(settled).toBe(false);
		held.finish();
		await pending;
		expect(settled).toBe(true);
	});

	it("ends cleanly when the window closes after the terminal item, and tells the caller to abort", async () => {
		const held = heldSource(["a", "stop"]);
		const onGraceEnd = vi.fn(() => held.abort());
		const iterator = iterateWithTerminalGrace(held.source, {
			isTerminal: isStop,
			graceMs: postStopGraceMs,
			onGraceEnd,
		});

		expect((await iterator.next()).value).toBe("a");
		expect((await iterator.next()).value).toBe("stop");
		const next = iterator.next();
		await vi.advanceTimersByTimeAsync(postStopGraceMs - 1);
		expect(onGraceEnd).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(await next).toEqual({ done: true, value: undefined });
		expect(onGraceEnd).toHaveBeenCalledOnce();
	});

	it("does not let trailing items extend the window", async () => {
		const gate: Array<() => void> = [];
		async function* source(): AsyncGenerator<string> {
			yield "stop";
			await new Promise<void>((resolve) => gate.push(resolve));
			yield "trailing";
			await new Promise<void>(() => {});
		}
		const onGraceEnd = vi.fn();
		const iterator = iterateWithTerminalGrace(source(), { isTerminal: isStop, graceMs: 1000, onGraceEnd });

		expect((await iterator.next()).value).toBe("stop");
		const trailing = iterator.next();
		await vi.advanceTimersByTimeAsync(900);
		gate[0]();
		expect((await trailing).value).toBe("trailing");
		const last = iterator.next();
		await vi.advanceTimersByTimeAsync(99);
		expect(onGraceEnd).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect((await last).done).toBe(true);
		expect(onGraceEnd).toHaveBeenCalledOnce();
	});

	it("leaves a consumer that stops at the terminal item free, and drains the rest in the background", async () => {
		const held = heldSource(["a", "stop", "usage"]);
		const onGraceEnd = vi.fn();

		for await (const item of iterateWithTerminalGrace(held.source, {
			isTerminal: isStop,
			graceMs: postStopGraceMs,
			onGraceEnd,
		})) {
			if (item === "stop") break;
		}
		await vi.advanceTimersByTimeAsync(10);
		expect(held.released).not.toHaveBeenCalled();
		held.finish();
		await vi.advanceTimersByTimeAsync(0);

		expect(held.released).toHaveBeenCalledOnce();
		expect(onGraceEnd).not.toHaveBeenCalled();
	});

	it("aborts a body that stays open after the consumer stopped, once the window closes, and swallows the failure", async () => {
		const held = heldSource(["stop"]);
		const onGraceEnd = vi.fn(() => held.abort());

		for await (const item of iterateWithTerminalGrace(held.source, {
			isTerminal: isStop,
			graceMs: postStopGraceMs,
			onGraceEnd,
		})) {
			if (item === "stop") break;
		}
		await vi.advanceTimersByTimeAsync(postStopGraceMs);

		expect(onGraceEnd).toHaveBeenCalledOnce();
		expect(held.released).toHaveBeenCalledOnce();
	});

	it("releases the source without draining when the consumer stops before the terminal item", async () => {
		const held = heldSource(["a", "b", "stop"]);
		const onGraceEnd = vi.fn();

		for await (const item of iterateWithTerminalGrace(held.source, {
			isTerminal: isStop,
			graceMs: postStopGraceMs,
			onGraceEnd,
		})) {
			if (item === "a") break;
		}
		await vi.advanceTimersByTimeAsync(postStopGraceMs * 2);

		expect(held.released).toHaveBeenCalledOnce();
		expect(onGraceEnd).not.toHaveBeenCalled();
	});

	it("lets a failure before the terminal item reach the consumer", async () => {
		const held = heldSource(["a"]);
		const iterator = iterateWithTerminalGrace(held.source, {
			isTerminal: isStop,
			graceMs: 100,
			onGraceEnd: vi.fn(),
		});

		await iterator.next();
		const failing = iterator.next();
		held.abort();

		await expect(failing).rejects.toThrow("aborted");
	});
});
