/**
 * HTTP/1.1 transport on node:http and node:https that writes request headers in the caller's order and casing, for
 * requests whose wire fingerprint matters. Ported from oh-my-pi's `providers/cowork-fetch.ts`, which does this on
 * Bun; undici (Node's fetch) reorders, lowercases and adds headers, so it cannot.
 *
 * Node's built-ins are loaded through `process.getBuiltinModule`, so browser bundles of pi-ai never resolve them.
 */

import type * as NodeHttp from "node:http";
import type * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import type NodeStream from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type * as NodeTls from "node:tls";
import type * as NodeZlib from "node:zlib";
import { resolveHttpProxyUrlForTarget } from "../../utils/node-http-proxy.ts";

/** TLS settings of one request. Sockets pool per distinct settings, so every request of a profile must share them. */
export interface Http1Tls {
	/** Cipher list in OpenSSL syntax. Default: Node's. */
	ciphers?: string;
	/** Trust roots replacing Node's defaults. */
	ca?: string | string[];
}

/** One request of {@link sendHttp1Request}. */
export interface Http1Request {
	method?: string;
	/** Written to the wire verbatim, in insertion order and casing. `Host` and `Content-Length` are added when absent. */
	headers: Record<string, string>;
	body?: string | Uint8Array;
	signal?: AbortSignal;
	tls?: Http1Tls;
	/** Fails the request when its socket sees no traffic for this long, as undici's body timeout does. */
	idleTimeoutMs?: number;
}

export interface NodeModules {
	http: typeof NodeHttp;
	https: typeof NodeHttps;
	net: typeof NodeNet;
	stream: typeof NodeStream;
	tls: typeof NodeTls;
	zlib: typeof NodeZlib;
}

let nodeModules: NodeModules | undefined;

/** Node's built-in modules this transport and its callers use. */
export function getNodeModules(): NodeModules {
	if (nodeModules) return nodeModules;
	if (typeof process === "undefined" || !process.versions?.node) {
		throw new Error("The HTTP/1.1 transport requires Node.js.");
	}
	nodeModules = {
		http: process.getBuiltinModule("node:http"),
		https: process.getBuiltinModule("node:https"),
		net: process.getBuiltinModule("node:net"),
		stream: process.getBuiltinModule("node:stream"),
		tls: process.getBuiltinModule("node:tls"),
		zlib: process.getBuiltinModule("node:zlib"),
	};
	return nodeModules;
}

// Node pools sockets per host and TLS options inside one agent, so one agent per protocol serves every profile.
let httpAgent: NodeHttp.Agent | undefined;
let httpsAgent: NodeHttps.Agent | undefined;
const tunnelAgents = new Map<string, NodeHttps.Agent>();

/** How far a request got before its connection was lost. */
interface RequestUploadProgress {
	/** Request body size on the wire. */
	bodyBytes: number;
	/** Whether the socket had taken the whole body; the OS may still hold some of it unsent. */
	bodySent: boolean;
	/** Time since the request started. */
	elapsedMs: number;
}

/**
 * An established connection that failed before any response headers arrived, naming how far the request body got.
 * While part of the body is still queued in the process it is "uploading"; once the socket has taken all of it, it
 * was "written to the socket", which does not say the server received it. Failures before the connection is up (DNS,
 * refused, TLS) keep their own error. Ported from oh-my-pi's `ConnectionLostBeforeResponseError`.
 */
export class ConnectionLostBeforeResponseError extends Error {
	constructor(cause: Error, { bodyBytes, bodySent, elapsedMs }: RequestUploadProgress) {
		const after = `connection lost after ${formatDuration(elapsedMs)}`;
		const code = "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
		super(describeUploadProgress(after, code, bodyBytes, bodySent), { cause });
		this.name = "ConnectionLostBeforeResponseError";
	}
}

function describeUploadProgress(after: string, code: string, bodyBytes: number, bodySent: boolean): string {
	if (bodyBytes === 0) return `${after}, before any response${code}`;
	if (bodySent) {
		return `${after}, after the ${formatBytes(bodyBytes)} request body was written to the socket, before any response${code}`;
	}
	return `${after} while uploading the ${formatBytes(bodyBytes)} request body; no response received${code}`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < 1000) return `${Math.floor(ms)}ms`;
	if (ms < 60_000) {
		// Round to tenths first: `toFixed(1)` alone turns 59.95s and more into an impossible `60.0s`.
		const tenths = Math.round(ms / 100);
		return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : "1m";
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Sends one request and resolves at the response headers; the body streams. Aborting rejects with the signal's reason. */
export async function sendHttp1Request(url: URL, request: Http1Request): Promise<Response> {
	const node = getNodeModules();
	const { signal } = request;
	signal?.throwIfAborted();
	const method = request.method ?? "GET";
	const payload = typeof request.body === "string" ? new TextEncoder().encode(request.body) : request.body;
	const headers = withHostAndLength(url, request.headers, payload?.byteLength);
	const result = Promise.withResolvers<Response>();
	const startedAt = performance.now();
	let isConnected = false;
	let isBodySent = false;
	// The error this module destroys the request with (an abort, the idle timeout), which keeps its own wording.
	let localFailure: Error | undefined;
	const release = (): void => signal?.removeEventListener("abort", abort);
	// Once the response has started, the failure must reach the body reader; the request itself no longer reports.
	let activeResponse: NodeHttp.IncomingMessage | undefined;
	const fail = (error: Error): void => {
		localFailure = error;
		(activeResponse ?? clientRequest).destroy(error);
	};
	const abort = (): void => {
		const reason: unknown = signal?.reason;
		fail(reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError"));
	};
	const onResponse = (message: NodeHttp.IncomingMessage): void => {
		activeResponse = message;
		message.once("close", release);
		try {
			result.resolve(createResponse(message, method, signal, node));
		} catch (error) {
			message.destroy();
			release();
			result.reject(error);
		}
	};
	const clientRequest = openClientRequest(url, method, headers, request, node, onResponse);
	signal?.addEventListener("abort", abort, { once: true });
	clientRequest.once("socket", (socket) => {
		const markConnected = (): void => {
			isConnected = true;
		};
		// A pooled keep-alive socket is already connected; a fresh one counts once its handshake is done.
		if (socket.connecting) socket.once(url.protocol === "https:" ? "secureConnect" : "connect", markConnected);
		else markConnected();
	});
	clientRequest.once("finish", () => {
		isBodySent = true;
	});
	// A persistent listener: destroying a request after its response arrived still emits "error".
	clientRequest.on("error", (error) => {
		release();
		// Failures before the connection is up keep their own error, as does an abort; after a response arrived the
		// promise is already settled.
		const isConnectionLost = isConnected && error !== localFailure && !signal?.aborted;
		result.reject(
			isConnectionLost
				? new ConnectionLostBeforeResponseError(error, {
						bodyBytes: payload?.byteLength ?? 0,
						bodySent: isBodySent,
						elapsedMs: performance.now() - startedAt,
					})
				: error,
		);
	});
	if (request.idleTimeoutMs !== undefined && request.idleTimeoutMs > 0) {
		clientRequest.setTimeout(request.idleTimeoutMs, () => {
			fail(new Error(`Request timed out after ${request.idleTimeoutMs}ms without traffic`));
		});
	}
	clientRequest.end(payload);
	return result.promise;
}

/** Adds `Host` just before `Accept-Encoding`, as oh-my-pi does, else last; adds `Content-Length` for a body. */
function withHostAndLength(
	url: URL,
	source: Record<string, string>,
	bodyBytes: number | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {};
	let hasHost = false;
	let hasContentLength = false;
	for (const name in source) {
		const lowerName = name.toLowerCase();
		if (lowerName === "host") hasHost = true;
		if (lowerName === "content-length") hasContentLength = true;
		if (lowerName === "accept-encoding" && !hasHost) {
			headers.Host = url.host;
			hasHost = true;
		}
		headers[name] = source[name];
	}
	if (!hasHost) headers.Host = url.host;
	if (!hasContentLength && bodyBytes !== undefined) headers["Content-Length"] = String(bodyBytes);
	return headers;
}

function openClientRequest(
	url: URL,
	method: string,
	headers: Record<string, string>,
	request: Http1Request,
	node: NodeModules,
	onResponse: (message: NodeHttp.IncomingMessage) => void,
): NodeHttp.ClientRequest {
	const hostname = stripBrackets(url.hostname);
	const path = `${url.pathname}${url.search}`;
	if (url.protocol === "http:") {
		const options = { hostname, port: Number(url.port) || 80, path, method, headers, agent: getAgent(url, node) };
		return node.http.request(options, onResponse);
	}
	const options: NodeHttps.RequestOptions & NodeTls.ConnectionOptions = {
		hostname,
		port: Number(url.port) || 443,
		path,
		method,
		headers,
		agent: getAgent(url, node),
		ALPNProtocols: ["http/1.1"],
		rejectUnauthorized: true,
		// SNI must be a host name; an address literal is ignored by Node with a deprecation warning.
		...(node.net.isIP(hostname) === 0 ? { servername: hostname } : {}),
		...(request.tls?.ciphers ? { ciphers: request.tls.ciphers } : {}),
		...(request.tls?.ca ? { ca: request.tls.ca } : {}),
	};
	return node.https.request(options, onResponse);
}

function stripBrackets(host: string): string {
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function getAgent(url: URL, node: NodeModules): NodeHttp.Agent {
	if (url.protocol === "http:") {
		httpAgent ??= new node.http.Agent({ keepAlive: true });
		return httpAgent;
	}
	const proxy = resolveHttpProxyUrlForTarget(url);
	if (!proxy) {
		httpsAgent ??= new node.https.Agent({ keepAlive: true });
		return httpsAgent;
	}
	let agent = tunnelAgents.get(proxy.href);
	if (!agent) {
		agent = createTunnelAgent(proxy, node);
		tunnelAgents.set(proxy.href, agent);
	}
	return agent;
}

/** An https agent whose sockets are TLS sessions inside a CONNECT tunnel through `proxy`. */
function createTunnelAgent(proxy: URL, node: NodeModules): NodeHttps.Agent {
	const agent = new node.https.Agent({ keepAlive: true });
	const createTunnelConnection = (
		options: NodeHttps.RequestOptions,
		callback: (error: Error | null, socket?: NodeStream.Duplex) => void,
	): void => {
		openTunnel(proxy, options, node).then(
			(socket) => callback(null, socket),
			(error: Error) => callback(error),
		);
	};
	// Node's Agent calls createConnection with a callback and uses the socket handed to it; the declared type
	// (a synchronous socket result, a required callback socket) cannot express that.
	agent.createConnection = createTunnelConnection as NodeHttps.Agent["createConnection"];
	return agent;
}

function openTunnel(proxy: URL, options: NodeHttps.RequestOptions, node: NodeModules): Promise<NodeTls.TLSSocket> {
	const host = options.host ?? "";
	const authority = `${host}:${options.port}`;
	const headers: Record<string, string> = { Host: authority };
	if (proxy.username) {
		const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
		headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
	}
	const isHttpsProxy = proxy.protocol === "https:";
	const connect = {
		hostname: stripBrackets(proxy.hostname),
		port: proxy.port || (isHttpsProxy ? 443 : 80),
		method: "CONNECT",
		path: authority,
		headers,
		agent: false,
	};
	return new Promise((resolve, reject) => {
		const tunnelRequest = isHttpsProxy ? node.https.request(connect) : node.http.request(connect);
		tunnelRequest.once("error", reject);
		tunnelRequest.once("connect", (response, socket) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`Proxy refused CONNECT to ${authority} with HTTP ${response.statusCode}`));
				return;
			}
			resolve(
				node.tls.connect({
					socket,
					ALPNProtocols: ["http/1.1"],
					rejectUnauthorized: true,
					...(options.servername ? { servername: options.servername } : {}),
					...(options.ciphers ? { ciphers: options.ciphers } : {}),
					...(options.ca ? { ca: options.ca } : {}),
				}),
			);
		});
		tunnelRequest.end();
	});
}

function createResponse(
	message: NodeHttp.IncomingMessage,
	method: string,
	signal: AbortSignal | undefined,
	node: NodeModules,
): Response {
	const status = message.statusCode;
	if (status === undefined) throw new Error("The HTTP/1.1 transport received a response without a status.");
	const hasBody = method !== "HEAD" && status !== 204 && status !== 304;
	if (!hasBody) {
		// An unread response keeps its socket out of the keep-alive pool.
		message.resume();
		return new Response(null, {
			status,
			statusText: message.statusMessage,
			headers: responseHeaders(message, false),
		});
	}
	const encoding = readContentEncoding(message);
	const decoder = createDecoder(encoding, node);
	const source = decoder ? node.stream.pipeline(message, decoder, () => {}) : message;
	const body = withFetchParityErrors(node.stream.Readable.toWeb(source), signal);
	return new Response(body, {
		status,
		statusText: message.statusMessage,
		headers: responseHeaders(message, decoder !== undefined),
	});
}

function readContentEncoding(message: NodeHttp.IncomingMessage): string | undefined {
	return message.headers["content-encoding"]?.trim().toLowerCase();
}

function createDecoder(encoding: string | undefined, node: NodeModules): NodeStream.Transform | undefined {
	switch (encoding) {
		case "gzip":
			return node.zlib.createGunzip();
		case "deflate":
			return node.zlib.createInflate();
		case "br":
			return node.zlib.createBrotliDecompress();
		case "zstd":
			return node.zlib.createZstdDecompress();
		default:
			return undefined;
	}
}

/** Response headers as received. A decoded body no longer matches its `Content-Encoding` or `Content-Length`. */
function responseHeaders(message: NodeHttp.IncomingMessage, decoded: boolean): Headers {
	const headers = new Headers();
	for (let index = 0; index < message.rawHeaders.length; index += 2) {
		const name = message.rawHeaders[index];
		const lowerName = name.toLowerCase();
		if (decoded && (lowerName === "content-encoding" || lowerName === "content-length")) continue;
		headers.append(name, message.rawHeaders[index + 1]);
	}
	return headers;
}

/**
 * Node reports a body cut off mid-stream (peer reset, dead connection) as a bare `Error("aborted")` with code
 * `ECONNRESET`, wording that retry classification cannot tell from a cancellation. Re-raise it as a lost socket,
 * keeping the original as `cause`; a caller abort keeps its own error.
 */
function withFetchParityErrors(
	body: NodeWebReadableStream,
	signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await reader.read();
				if (chunk.done) controller.close();
				else controller.enqueue(chunk.value);
			} catch (error) {
				const isPrematureClose =
					!signal?.aborted &&
					error instanceof Error &&
					error.message === "aborted" &&
					"code" in error &&
					error.code === "ECONNRESET";
				controller.error(
					isPrematureClose
						? Object.assign(
								new Error("The socket connection was closed unexpectedly before the response completed", {
									cause: error,
								}),
								{ code: "ECONNRESET" },
							)
						: error,
				);
			}
		},
		cancel: (reason) => reader.cancel(reason),
	});
}
