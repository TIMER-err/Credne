/**
 * Prompt-cache pre-warm of an Anthropic subscription (OAuth) request, as oh-my-pi sends it: the body the real request
 * would send, non-streaming with `max_tokens: 0`. The endpoint reads the prompt, refreshes the cache at its
 * breakpoints and returns usage with no output billed, so the refresh lands on the real request's cache key.
 */

import type {
	BetaMessage,
	MessageCreateParamsNonStreaming,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

/**
 * What in `params` the endpoint rejects on a `max_tokens: 0` pre-warm, or undefined when it can be sent: budget
 * thinking, a forced `tool_choice` and structured output are refused.
 */
export function getPromptCachePrewarmRejection(params: MessageCreateParamsStreaming): string | undefined {
	if (params.thinking?.type === "enabled") return "budget thinking";
	const toolChoice = params.tool_choice?.type;
	if (toolChoice === "any" || toolChoice === "tool") return "a forced tool_choice";
	if (params.output_config?.format != null) return "structured output";
	return undefined;
}

/** The request body of a pre-warm: the real body with no output cap and no streaming; every other field is kept. */
export function buildPromptCachePrewarmBody(params: MessageCreateParamsStreaming): MessageCreateParamsNonStreaming {
	return { ...params, max_tokens: 0, stream: false };
}

function toEventStreamText(events: ReadonlyArray<{ type: string } & Record<string, unknown>>): string {
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/**
 * Re-expresses a pre-warm's JSON response as the event stream of an empty reply that ended at its token cap, so the
 * provider's one streaming path reports its usage and cost. Zero output tokens always stop at the cap.
 */
export async function promptCachePrewarmEventStream(response: Response): Promise<Response> {
	const message = (await response.json()) as BetaMessage;
	if (!message.usage) throw new Error("Anthropic pre-warm response carried no usage");
	const headers = new Headers(response.headers);
	headers.set("content-type", "text/event-stream");
	headers.delete("content-length");
	headers.delete("content-encoding");
	const body = toEventStreamText([
		{ type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null } },
		{ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: message.usage },
		{ type: "message_stop" },
	]);
	return new Response(body, { status: response.status, headers });
}
