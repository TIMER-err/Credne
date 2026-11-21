// HTTP client of Claude subscription Messages requests. It assembles the URL, builds the headers, serializes the body,
// bounds the wait for the response headers, and turns a failed response into an error that carries its status, its
// body and its headers, which is what retry and recovery classify. It replaces the Anthropic SDK, which this component
// never loads. It never retries: the stream loop owns retries. Ported from oh-my-pi's `anthropic-client.ts`.

import type {
	MessageCreateParamsNonStreaming,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { FetchFunction } from "../../types.ts";
import { buildClaudeSubscriptionHeaders } from "./headers.ts";
import type { ThreadParam } from "./threads.ts";

/** Endpoint of Anthropic's API; a model that names no other base URL talks to it. */
export const anthropicBaseUrl = "https://api.anthropic.com";

const messagesPath = "/v1/messages?beta=true";
// The SDK's default: how long a request may wait for its response headers.
const defaultTimeoutMs = 600_000;
const errorBodyReadTimeoutMs = 5_000;
const maxErrorBodyBytes = 64 * 1024;
const errorBodyTruncationMarker = "\n[Response body truncated after 64 KiB]";

/** A Messages request body. `betas` rides in the `anthropic-beta` header, never in the body. */
export type MessagesRequestBody = (MessageCreateParamsStreaming | MessageCreateParamsNonStreaming) & {
	thread?: ThreadParam;
};

/** A non-2xx response of the Messages API. `message` is `<status> <body>`, which is what error classification reads. */
export class AnthropicApiError extends Error {
	readonly status: number;
	readonly headers: Headers;
	/** `error.type` of the response body, for example `invalid_request_error`. */
	readonly type: string | undefined;
	/** `error.details.error_code` of the response body, for example `thread_not_found`, else its `error.type`. */
	readonly code: string | undefined;

	constructor(status: number, message: string, headers: Headers, body: { type?: string; code?: string } = {}) {
		super(message);
		this.name = "AnthropicApiError";
		this.status = status;
		this.headers = headers;
		this.type = body.type;
		this.code = body.code;
	}

	/** Reads the error response, within a bounded wait and size, and builds the error. */
	static async fromResponse(response: Response, signal: AbortSignal | undefined): Promise<AnthropicApiError> {
		const detail = (await readErrorBody(response, signal)) || "status code (no body)";
		return new AnthropicApiError(
			response.status,
			`${response.status} ${detail}`,
			response.headers,
			parseErrorBody(detail),
		);
	}
}

/** No response headers arrived within the request timeout. */
export class AnthropicConnectionTimeoutError extends Error {
	constructor() {
		super("Request timed out.");
		this.name = "AnthropicConnectionTimeoutError";
	}
}

/** The request failed before any response: DNS, TLS, a reset socket. The failure is the `cause`. */
export class AnthropicConnectionError extends Error {
	constructor(cause: unknown) {
		super("Connection error.", { cause });
		this.name = "AnthropicConnectionError";
	}
}

/** The caller aborted the request. */
function createAbortError(): Error {
	const error = new Error("Request was aborted.");
	error.name = "AbortError";
	return error;
}

/** What a request of a client needs besides its body. */
export interface MessagesRequestOptions {
	signal: AbortSignal | undefined;
	/** Longest wait for the response headers; the SDK's ten minutes when unset. */
	timeoutMs: number | undefined;
	/** Headers of this request alone, after the caller's own (for example `anthropic-usage-limit`). */
	headers?: Record<string, string>;
}

export interface ClaudeSubscriptionClientOptions {
	/** The OAuth access token. */
	token: string;
	baseUrl: string;
	/** The session id sent as `X-Claude-Code-Session-Id`. */
	sessionId: string | undefined;
	/** Headers the caller configured, in their casing. */
	callerHeaders: Record<string, string> | undefined;
	/** The transport; `createClaudeCodeFetch` for a real request. */
	fetch: FetchFunction;
}

export interface ClaudeSubscriptionClient {
	/**
	 * Sends one Messages request and resolves at its response headers; the body streams. A non-2xx response throws an
	 * {@link AnthropicApiError}, a caller abort throws "Request was aborted.", a wait past the timeout throws an
	 * {@link AnthropicConnectionTimeoutError}.
	 */
	createMessage(params: MessagesRequestBody, options: MessagesRequestOptions): Promise<Response>;
}

/** Creates the client of one account's requests. */
export function createClaudeSubscriptionClient(
	clientOptions: ClaudeSubscriptionClientOptions,
): ClaudeSubscriptionClient {
	const url = `${clientOptions.baseUrl.replace(/\/+$/, "")}${messagesPath}`;
	return {
		async createMessage({ betas, ...body }, options) {
			if (options.signal?.aborted) throw createAbortError();
			const headers = buildClaudeSubscriptionHeaders({
				token: clientOptions.token,
				betas: betas ?? [],
				sessionId: clientOptions.sessionId,
				callerHeaders: options.headers
					? { ...clientOptions.callerHeaders, ...options.headers }
					: clientOptions.callerHeaders,
			});
			const response = await fetchOnce(clientOptions.fetch, url, headers, JSON.stringify(body), options);
			if (response.ok) return response;
			throw await AnthropicApiError.fromResponse(response, options.signal);
		},
	};
}

async function fetchOnce(
	fetch: FetchFunction,
	url: string,
	headers: Record<string, string>,
	body: string,
	options: MessagesRequestOptions,
): Promise<Response> {
	const timeout = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		timeout.abort();
	}, options.timeoutMs ?? defaultTimeoutMs);
	// The caller's signal stays linked past the headers, so aborting it also ends the transfer of the body.
	const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
	try {
		return await fetch(url, { method: "POST", headers, body, signal });
	} catch (error) {
		if (options.signal?.aborted) throw createAbortError();
		if (timedOut) throw new AnthropicConnectionTimeoutError();
		throw new AnthropicConnectionError(error);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The text of an error response. A body that stalls or exceeds {@link maxErrorBodyBytes} ends the read, so a failing
 * endpoint cannot hold the request; what arrived until then is the detail.
 */
async function readErrorBody(response: Response, signal: AbortSignal | undefined): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const cancel = (): void => void reader.cancel().catch(() => {});
	const timer = setTimeout(cancel, errorBodyReadTimeoutMs);
	signal?.addEventListener("abort", cancel, { once: true });
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let truncated = false;
	try {
		while (!truncated) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const kept = chunk.value.subarray(0, maxErrorBodyBytes - bytes);
			text += decoder.decode(kept, { stream: true });
			bytes += kept.byteLength;
			truncated = kept.byteLength < chunk.value.byteLength;
		}
		text += decoder.decode();
	} catch {
		// A cancelled or broken body: the text read so far is the detail.
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		cancel();
	}
	if (signal?.aborted) throw createAbortError();
	return `${text}${truncated ? errorBodyTruncationMarker : ""}`.trim();
}

/** The type and code of an Anthropic error body (wire input): `error.type`, and `error.details.error_code` else the type. */
function parseErrorBody(text: string): { type?: string; code?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	const error = (parsed as { error?: { type?: unknown; details?: { error_code?: unknown } } } | null)?.error;
	const type = typeof error?.type === "string" ? error.type : undefined;
	const errorCode = typeof error?.details?.error_code === "string" ? error.details.error_code : undefined;
	return { type, code: errorCode ?? type };
}
