/**
 * Fetch for Anthropic subscription (OAuth) requests that puts Claude Code's request bytes on the wire: the header
 * record in the order and casing it arrives in (`headers.ts` builds it), `Host`, a signed and gzipped body, HTTP/1.1
 * over Bun's TLS cipher list. Ported from oh-my-pi's `cowork-fetch.ts` and `request-compression.ts`.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { getNodeModules, type Http1Request, sendHttp1Request } from "./http1.ts";
import { signClaudeCodeBody } from "./identity.ts";

/** Origin of Anthropic's API, the only host that receives gzipped bodies and connection warm-ups. */
export const OFFICIAL_ANTHROPIC_ORIGIN = "https://api.anthropic.com";

/** Cipher list of Bun's TLS defaults, which Claude Code's runtime offers; Node's default list differs. */
const claudeCodeCiphers =
	"TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";

/** Options of {@link createClaudeCodeFetch}. */
export interface ClaudeCodeFetchOptions {
	/** Sends the shaped request instead of this module's own transport. The body is signed but never gzipped. */
	fetch?: typeof globalThis.fetch;
	/** Fails a request whose socket sees no traffic for this long. */
	idleTimeoutMs?: number;
	/** Trust roots replacing Node's defaults. */
	ca?: string | string[];
}

/** A request whose TLS settings are the Claude Code profile's. */
export type ProfiledRequest = Omit<Http1Request, "tls">;

/** Sends a request over the socket pool and TLS profile of Claude Code requests, whatever its headers. */
export function sendWithClaudeCodeProfile(url: URL, request: ProfiledRequest): Promise<Response> {
	return sendHttp1Request(url, { ...request, tls: { ciphers: claudeCodeCiphers } });
}

/**
 * A fetch that sends each request the way Claude Code does: the request's headers as the record gives them, in order
 * and casing (`Host` just before `Accept-Encoding`, `Content-Length` last), the `cch` hash written into the body, and
 * a gzipped body at or above {@link minGzipChars} when the host is Anthropic's API.
 */
export function createClaudeCodeFetch(options: ClaudeCodeFetchOptions = {}): typeof globalThis.fetch {
	return async (input, init) => {
		const url = new URL(requestUrl(input));
		const headers = toHeaderRecord(init?.headers);
		// Signing runs first: the hash covers the plain body, and gzip would hide the billing block.
		const signed = typeof init?.body === "string" ? signClaudeCodeBody(init.body) : init?.body;
		if (options.fetch) return options.fetch(input, { ...init, headers, body: signed });
		const signedBody = toWireBody(signed);
		const request: ProfiledRequest = {
			method: init?.method ?? "GET",
			headers,
			body: signedBody,
			signal: init?.signal ?? undefined,
			idleTimeoutMs: options.idleTimeoutMs,
		};
		const send: Send = (sent) =>
			sendHttp1Request(url, { ...sent, tls: { ciphers: claudeCodeCiphers, ca: options.ca } });
		if (typeof signedBody !== "string" || !shouldGzip(url, headers, signedBody)) return send(request);
		return sendGzipped(url.origin, request, signedBody, send);
	};
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

function toWireBody(body: RequestInit["body"]): string | Uint8Array | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string" || body instanceof Uint8Array) return body;
	throw new TypeError("The Claude Code transport sends string and byte request bodies only.");
}

/** The request's headers as a record, which keeps the order and casing the client built. */
function toHeaderRecord(headers: RequestInit["headers"]): Record<string, string> {
	if (headers === undefined) return {};
	if (headers instanceof Headers) return Object.fromEntries(headers.entries());
	const entries = Array.isArray(headers) ? headers : Object.entries(headers);
	return Object.fromEntries(entries.map(([name, value]) => [name, String(value)]));
}

/** Bodies below one TCP segment gain nothing from compression. UTF-16 length undercounts bytes, fine for a floor. */
export const minGzipChars = 1024;

// zlib's default level: on multi-MB transcripts about 35% smaller than level 1 for twice the CPU, a few ms per MB.
const gzipLevel = 6;

/** Origins that rejected a gzipped body; each is sent plain from then on. */
const gzipRejectedOrigins = new Set<string>();

/** `<origin> <status>` pairs where a non-JSON refusal recurred on the plain resend: a proxy refuses everything. */
const unrelatedRefusals = new Set<string>();

const gzipRejectionPattern =
	/request_body_encoding_invalid|Unsupported Content-Encoding|request body is not valid JSON/;

/** Values of a boolean environment flag that read as on, exactly as oh-my-pi's `parseFlag` accepts them. */
const truthyFlagValues = new Set(["1", "Y", "y", "TRUE", "true", "YES", "yes", "ON", "on"]);

/** `PI_REQUEST_COMPRESSION`: on when unset or empty, else on only for a truthy value (`0` turns it off). */
function isCompressionEnabled(): boolean {
	const value = getProviderEnvValue("PI_REQUEST_COMPRESSION");
	return !value || truthyFlagValues.has(value);
}

function hasContentEncoding(headers: Record<string, string>): boolean {
	return Object.keys(headers).some((name) => name.toLowerCase() === "content-encoding");
}

function shouldGzip(url: URL, headers: Record<string, string>, body: string): boolean {
	return (
		body.length >= minGzipChars &&
		url.origin === OFFICIAL_ANTHROPIC_ORIGIN &&
		!gzipRejectedOrigins.has(url.origin) &&
		!hasContentEncoding(headers) &&
		isCompressionEnabled()
	);
}

type Send = (request: ProfiledRequest) => Promise<Response>;

/**
 * Sends `body` gzipped. A possible rejection of the encoding (the host's decode error, or a non-JSON 400/403/415
 * from a proxy in front of it) is resent plain once; only when that resend succeeds is gzip latched off for the
 * origin, so a genuine 400 never disables compression.
 */
async function sendGzipped(origin: string, request: ProfiledRequest, body: string, send: Send): Promise<Response> {
	let compressed: Uint8Array;
	try {
		compressed = await gzip(body);
	} catch {
		// Compression is an optimization: a codec failure sends the plain body.
		return send(request);
	}
	const response = await send({
		...request,
		headers: { ...request.headers, "Content-Encoding": "gzip" },
		body: compressed,
	});
	const suspect = await suspectEncodingRejection(response);
	if (!suspect) return response;
	const refusal = `${origin} ${response.status}`;
	if (suspect === "proxy" && unrelatedRefusals.has(refusal)) return response;
	await response.body?.cancel().catch(() => {});
	const plain = await send(request);
	if (plain.ok) {
		gzipRejectedOrigins.add(origin);
	} else if (suspect === "proxy" && plain.status === response.status) {
		// A JSON body means the resend reached the provider, whose own error says nothing about the proxy.
		const plainBody = await readBodyText(plain);
		if (plainBody !== undefined && !isJson(plainBody)) unrelatedRefusals.add(refusal);
	}
	return plain;
}

// Off the event loop: a synchronous codec stalls the TUI on a multi-MB transcript.
function gzip(body: string): Promise<Uint8Array> {
	const { zlib } = getNodeModules();
	return new Promise((resolve, reject) => {
		zlib.gzip(body, { level: gzipLevel }, (error, compressed) => (error ? reject(error) : resolve(compressed)));
	});
}

/**
 * "host": a JSON 400/415 naming the encoding. "proxy": a 400/403/415 whose body is not JSON, empty included; the
 * provider answers errors in JSON, so that body is presumed to come from a proxy that refuses a gzipped upload.
 */
async function suspectEncodingRejection(response: Response): Promise<"host" | "proxy" | undefined> {
	if (response.status !== 400 && response.status !== 403 && response.status !== 415) return undefined;
	const text = await readBodyText(response);
	if (text === undefined) return undefined;
	if (!isJson(text)) return "proxy";
	if (response.status === 403) return undefined;
	return gzipRejectionPattern.test(text) ? "host" : undefined;
}

/** Reads a clone of the response body; undefined when it cannot be read. */
async function readBodyText(response: Response): Promise<string | undefined> {
	try {
		return await response.clone().text();
	} catch {
		return undefined;
	}
}

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}
