import { describe, expect, it, vi } from "vitest";
import { AnthropicStreamEnvelopeError } from "../src/api/claude-subscription/errors.ts";
import { iterateLenientAnthropicEvents } from "../src/api/claude-subscription/lenient-events.ts";
import { decodeAnthropicEvents, iterateAnthropicEvents } from "../src/api/claude-subscription/sse.ts";

const messageStart = { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } };
const textStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const messageStop = { type: "message_stop" };

function frame(event: { type: string }): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function responseOf(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
	);
}

async function readAll(response: Response, signal?: AbortSignal, onPing?: () => void) {
	const events: Array<{ type: string }> = [];
	for await (const event of iterateAnthropicEvents(response, signal, onPing)) events.push(event);
	return events;
}

describe("Anthropic SSE decoding", () => {
	it("decodes message events, however the bytes are chunked and whichever the line endings", async () => {
		const text = [messageStart, textStart, messageStop].map(frame).join("").replaceAll("\n", "\r\n");
		const chunks = text.match(/[\s\S]{1,7}/g) ?? [];

		const events = await readAll(responseOf(chunks));

		expect(events.map((event) => event.type)).toEqual(["message_start", "content_block_start", "message_stop"]);
	});

	it("joins the data lines of one event and ignores comments", async () => {
		const dataLines = JSON.stringify(messageStart, null, 1)
			.split("\n")
			.map((line) => `data: ${line}`)
			.join("\n");
		const text = `: keepalive comment\nevent: message_start\n${dataLines}\n\n${frame(messageStop)}`;

		const events = await readAll(responseOf([text]));

		expect(events[0]).toMatchObject({ type: "message_start", message: { id: "msg_1" } });
	});

	it("skips unknown events and reports each ping", async () => {
		const onPing = vi.fn();
		const text = `${frame(messageStart)}event: ping\ndata: {"type":"ping"}\n\nevent: vendor_extension\ndata: {}\n\n${frame(messageStop)}`;

		const events = await readAll(responseOf([text]), undefined, onPing);

		expect(events.map((event) => event.type)).toEqual(["message_start", "message_stop"]);
		expect(onPing).toHaveBeenCalledTimes(1);
	});

	it("throws the data of an error event", async () => {
		const error = `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;

		await expect(readAll(responseOf([frame(messageStart), error]))).rejects.toThrow('"type":"overloaded_error"');
	});

	it("throws for a frame that does not parse, naming the frame", async () => {
		const text = `${frame(messageStart)}event: content_block_delta\ndata: {not json\n\n`;

		await expect(readAll(responseOf([text]))).rejects.toThrow(
			"Could not parse Anthropic SSE event content_block_delta",
		);
	});

	it("throws when the stream ends after message_start without message_stop", async () => {
		await expect(readAll(responseOf([frame(messageStart), frame(textStart)]))).rejects.toThrow(
			"Anthropic stream ended before message_stop",
		);
	});

	it("ends quietly on a stream with no message at all", async () => {
		expect(await readAll(responseOf([""]))).toEqual([]);
	});

	it("throws for a response with no body", async () => {
		await expect(readAll(new Response(null))).rejects.toThrow("no body");
	});

	it("stops reading once the signal aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(readAll(responseOf([frame(messageStart)]), controller.signal)).rejects.toThrow(
			"Request was aborted",
		);
	});
});

describe("the strict and the lenient reader", () => {
	const messageDelta = (stopReason: string | null = "end_turn", outputTokens = 1) => ({
		type: "message_delta",
		delta: { stop_reason: stopReason },
		usage: { output_tokens: outputTokens },
	});
	const blockStart = (index: number) => ({
		type: "content_block_start",
		index,
		content_block: { type: "text", text: "" },
	});
	const blockDelta = (index: number, text: string) => ({
		type: "content_block_delta",
		index,
		delta: { type: "text_delta", text },
	});
	const blockStop = (index: number) => ({ type: "content_block_stop", index });
	const secondStart = {
		type: "message_start",
		message: { id: "msg_2", usage: { input_tokens: 9, output_tokens: 0 } },
	};

	function textOf(...events: Array<{ type: string }>): Response {
		return responseOf(events.map(frame));
	}

	async function lenient(response: Response, onPing?: () => void) {
		const events: Array<{ type: string; index?: number }> = [];
		for await (const event of iterateLenientAnthropicEvents(response, undefined, onPing)) events.push(event);
		return events;
	}

	/** The events as `type` or `type:index`, which is all these cases tell apart. */
	function labels(events: Array<{ type: string; index?: number }>): string[] {
		return events.map((event) => (event.index === undefined ? event.type : `${event.type}:${event.index}`));
	}

	it("decodes the events and leaves the envelope to the reader built on it", async () => {
		const events: Array<{ type: string }> = [];
		for await (const event of decodeAnthropicEvents(responseOf([frame(messageStart), frame(textStart)]))) {
			events.push(event);
		}

		expect(events.map((event) => event.type)).toEqual(["message_start", "content_block_start"]);
	});

	describe("lenient reader", () => {
		it("passes a well-formed turn through unchanged", async () => {
			const events = await lenient(
				textOf(messageStart, blockStart(0), blockDelta(0, "hi"), blockStop(0), messageDelta(), messageStop),
			);

			expect(labels(events)).toEqual([
				"message_start",
				"content_block_start:0",
				"content_block_delta:0",
				"content_block_stop:0",
				"message_delta",
				"message_stop",
			]);
		});

		it("keeps the first envelope and drops a second message_start", async () => {
			const events = await lenient(
				textOf(
					messageStart,
					blockStart(0),
					blockDelta(0, "one"),
					blockStop(0),
					secondStart,
					messageDelta(),
					messageStop,
				),
			);

			expect(labels(events).filter((label) => label === "message_start")).toHaveLength(1);
			expect(events.find((event) => event.type === "message_start")).toMatchObject({ message: { id: "msg_1" } });
		});

		it("drops the replay of a block already completed after a splice, and keeps the blocks that are new", async () => {
			const events = await lenient(
				textOf(
					messageStart,
					blockStart(0),
					blockDelta(0, "one"),
					blockStop(0),
					secondStart,
					blockStart(0),
					blockDelta(0, "one"),
					blockStop(0),
					blockStart(1),
					blockDelta(1, "two"),
					blockStop(1),
					messageDelta(),
					messageStop,
				),
			);

			expect(labels(events)).toEqual([
				"message_start",
				"content_block_start:0",
				"content_block_delta:0",
				"content_block_stop:0",
				"content_block_start:1",
				"content_block_delta:1",
				"content_block_stop:1",
				"message_delta",
				"message_stop",
			]);
		});

		it("lets a block that is still open continue across a splice, and drops a repeated start of its index", async () => {
			const events = await lenient(
				textOf(
					messageStart,
					blockStart(0),
					blockDelta(0, "one"),
					secondStart,
					blockStart(0),
					blockDelta(0, " more"),
					blockStop(0),
					messageDelta(),
					messageStop,
				),
			);

			expect(labels(events)).toEqual([
				"message_start",
				"content_block_start:0",
				"content_block_delta:0",
				"content_block_delta:0",
				"content_block_stop:0",
				"message_delta",
				"message_stop",
			]);
		});

		it("takes the stop reason as the end of the turn when message_stop never arrives", async () => {
			const events = await lenient(
				textOf(messageStart, blockStart(0), blockDelta(0, "hi"), blockStop(0), messageDelta()),
			);

			expect(labels(events).at(-1)).toBe("message_delta");
		});

		it("drops what follows the stop reason, so a second envelope cannot overwrite the finished turn", async () => {
			const events = await lenient(
				textOf(
					messageStart,
					blockStart(0),
					blockDelta(0, "hi"),
					blockStop(0),
					messageDelta("end_turn", 5),
					secondStart,
					messageDelta("max_tokens", 99),
					blockStart(1),
					blockDelta(1, "late"),
					blockStop(1),
					messageStop,
				),
			);

			expect(labels(events)).toEqual([
				"message_start",
				"content_block_start:0",
				"content_block_delta:0",
				"content_block_stop:0",
				"message_delta",
				"message_stop",
			]);
		});

		it("does not take a message_delta without a stop reason for the end of the turn", async () => {
			const withoutStop = textOf(messageStart, blockStart(0), messageDelta(null));

			await expect(lenient(withoutStop)).rejects.toThrow("Anthropic stream ended before message_stop");
		});

		it("closes the blocks left open when the turn ends, before message_stop and at the end of the stream", async () => {
			const atStop = await lenient(
				textOf(messageStart, blockStart(0), blockDelta(0, "hi"), messageDelta(), messageStop),
			);
			const atEnd = await lenient(textOf(messageStart, blockStart(0), blockDelta(0, "hi"), messageDelta()));

			expect(labels(atStop)).toEqual([
				"message_start",
				"content_block_start:0",
				"content_block_delta:0",
				"message_delta",
				"content_block_stop:0",
				"message_stop",
			]);
			expect(labels(atEnd).slice(-2)).toEqual(["message_delta", "content_block_stop:0"]);
		});

		it("closes no block that a splice replayed, and none that was closed", async () => {
			const events = await lenient(
				textOf(messageStart, blockStart(0), blockStop(0), secondStart, blockStart(0), messageDelta(), messageStop),
			);

			expect(labels(events).filter((label) => label === "content_block_stop:0")).toHaveLength(1);
		});

		it("throws for a stream that ends after message_start with no stop reason", async () => {
			await expect(lenient(textOf(messageStart, blockStart(0)))).rejects.toThrow(
				"Anthropic stream ended before message_stop",
			);
		});

		it("throws an envelope error for an event before message_start", async () => {
			const early = lenient(textOf(blockStart(0), messageStart, messageStop));

			await expect(early).rejects.toBeInstanceOf(AnthropicStreamEnvelopeError);
			await expect(lenient(textOf(messageStop))).rejects.toThrow("received message_stop before message_start");
		});

		it("ends quietly on a stream with no message at all", async () => {
			expect(await lenient(responseOf([""]))).toEqual([]);
		});

		it("still throws for an error frame and for a frame that does not parse, and reports each ping", async () => {
			const error = `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;
			const garbled = `event: content_block_delta\ndata: {not json\n\n`;
			const ping = "event: ping\ndata: {}\n\n";
			const onPing = vi.fn();

			await expect(lenient(responseOf([frame(messageStart), error]))).rejects.toThrow("overloaded_error");
			await expect(lenient(responseOf([frame(messageStart), garbled]))).rejects.toThrow(
				"Could not parse Anthropic SSE event content_block_delta",
			);
			await lenient(responseOf([frame(messageStart), ping, frame(messageDelta()), frame(messageStop)]), onPing);
			expect(onPing).toHaveBeenCalledTimes(1);
		});
	});

	describe("strict reader", () => {
		it("passes a second message_start and a replayed block through", async () => {
			const types: string[] = [];
			const spliced = textOf(
				messageStart,
				blockStart(0),
				blockStop(0),
				secondStart,
				blockStart(0),
				messageDelta(),
				messageStop,
			);
			for await (const event of iterateAnthropicEvents(spliced)) types.push(event.type);

			expect(types.filter((type) => type === "message_start")).toHaveLength(2);
			expect(types.filter((type) => type === "content_block_start")).toHaveLength(2);
		});

		it("does not take a stop reason for the end of the turn", async () => {
			const unfinished = textOf(messageStart, blockStart(0), blockStop(0), messageDelta());

			await expect(readAll(unfinished)).rejects.toThrow("Anthropic stream ended before message_stop");
		});
	});
});
