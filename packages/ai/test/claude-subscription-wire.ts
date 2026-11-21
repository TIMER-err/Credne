// Shared fixtures of the Claude subscription wire tests: raw TCP and TLS servers that parse requests by hand (so a test
// sees the exact bytes, not Node's view of them), a CONNECT proxy, a self-signed certificate, and header and body
// builders for the subscription request shape.

import { createServer as createHttpServer } from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import { vi } from "vitest";
import { buildClaudeSubscriptionHeaders } from "../src/api/claude-subscription/headers.ts";
import { buildClaudeBillingBlockText } from "../src/api/claude-subscription/identity.ts";
import { createClaudeCodeFetch } from "../src/api/claude-subscription/transport.ts";
import { xxHash64 } from "../src/utils/xxhash64.ts";

// Self-signed test certificate (EC P-256, valid for localhost and api.anthropic.com until 2126). It is trusted only
// through the `ca` option of these tests.
export const testKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJQJpa5n87dXhJ68N
8yR1GsVdQEE5wQgOxi4qpWm2KbehRANCAAQ3eg3EmDY+GysYcfht9UISL/L27MeT
Qo578K1REazjWMbhO1xJFer4uEkOd2yz/BeP2OHtnUawPKjMrqgAQ6vh
-----END PRIVATE KEY-----
`;
export const testCert = `-----BEGIN CERTIFICATE-----
MIIBpzCCAU6gAwIBAgIUMcyavHaZe4mY7ewJof1z/UZAuDswCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEyMDE5MTcxMloYDzIxMjYxMDI3
MTkxNzEyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQ3eg3EmDY+GysYcfht9UISL/L27MeTQo578K1REazjWMbhO1xJFer4
uEkOd2yz/BeP2OHtnUawPKjMrqgAQ6vho3wwejAdBgNVHQ4EFgQUL3IwgN8L+hWf
2d1AL3pnHfXipQcwHwYDVR0jBBgwFoAUL3IwgN8L+hWf2d1AL3pnHfXipQcwDwYD
VR0TAQH/BAUwAwEB/zAnBgNVHREEIDAegglsb2NhbGhvc3SCEWFwaS5hbnRocm9w
aWMuY29tMAoGCCqGSM49BAMCA0cAMEQCIDAbLC1/RUxFUbNFnX+MQ9mELqKSLfJ2
xzn3OVpCYnHEAiBRy1Sil0is/sN0kMNtfRQ2eelNYJh8jrlkqGq6Ar7S6Q==
-----END CERTIFICATE-----
`;

// Bun's default TLS cipher list, which the transport must offer verbatim and in this order.
export const bunCipherList =
	"TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";

export const oauthKey = "sk-ant-oat-test";
export const sessionId = "123e4567-e89b-42d3-a456-426614174000";
export const cchSeed = 0x4d659218e32a3268n;

// ---------------------------------------------------------------------------------------------------------------
// Raw wire servers: they parse requests by hand so the tests see the exact bytes, not Node's view of them.
// ---------------------------------------------------------------------------------------------------------------

export interface CapturedRequest {
	/** Request line and header lines, exactly as received, joined by CRLF. */
	head: string;
	/** Header lines without the request line. */
	headerLines: string[];
	body: Buffer;
	connection: number;
	tls?: { alpn: string | false | null; protocol: string | null };
}

export type Respond = (request: CapturedRequest, socket: net.Socket) => void;

export interface RawServer {
	port: number;
	requests: CapturedRequest[];
	connections: number;
	/** Connections the client side has closed. */
	closedConnections: number;
	close(): Promise<void>;
}

export function parseRequests(
	socket: net.Socket,
	connection: number,
	onRequest: (request: CapturedRequest) => void,
): void {
	let buffer = Buffer.alloc(0);
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const headEnd = buffer.indexOf("\r\n\r\n");
			if (headEnd === -1) return;
			const head = buffer.subarray(0, headEnd).toString("latin1");
			const length = Number(/^content-length: (\d+)$/im.exec(head)?.[1] ?? 0);
			if (buffer.length < headEnd + 4 + length) return;
			const body = buffer.subarray(headEnd + 4, headEnd + 4 + length);
			buffer = buffer.subarray(headEnd + 4 + length);
			const tlsSocket = socket instanceof tls.TLSSocket ? socket : undefined;
			onRequest({
				head,
				headerLines: head.split("\r\n").slice(1),
				body,
				connection,
				tls: tlsSocket && { alpn: tlsSocket.alpnProtocol, protocol: tlsSocket.getProtocol() },
			});
		}
	});
}

export async function startServer(
	kind: "http" | "tls",
	respond: Respond,
	tlsOptions: tls.TlsOptions = {},
): Promise<RawServer> {
	const requests: CapturedRequest[] = [];
	const sockets = new Set<net.Socket>();
	let connections = 0;
	let closedConnections = 0;
	const onSocket = (socket: net.Socket): void => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
			closedConnections++;
		});
		const connection = ++connections;
		parseRequests(socket, connection, (request) => {
			requests.push(request);
			respond(request, socket);
		});
	};
	const server =
		kind === "http"
			? net.createServer(onSocket)
			: tls.createServer({ key: testKey, cert: testCert, ALPNProtocols: ["http/1.1"], ...tlsOptions }, onSocket);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	return {
		port,
		requests,
		get connections() {
			return connections;
		},
		get closedConnections() {
			return closedConnections;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

export function reply(
	socket: net.Socket,
	status: number,
	headers: Record<string, string>,
	body: Buffer | string = "",
): void {
	const payload = typeof body === "string" ? Buffer.from(body) : body;
	const lines = Object.entries({ "content-length": String(payload.length), ...headers }).map(
		([name, value]) => `${name}: ${value}\r\n`,
	);
	socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 ${status} Status\r\n${lines.join("")}\r\n`), payload]));
}

/** A CONNECT proxy that tunnels every request to a local server, whatever host the client asked for. */
export async function startProxy(targetPort: number) {
	const connects: Array<{ target: string | undefined; authorization: string | undefined }> = [];
	const sockets = new Set<{ destroy(): unknown }>();
	const server = createHttpServer();
	server.on("connect", (request, clientSocket, head) => {
		connects.push({ target: request.url, authorization: request.headers["proxy-authorization"] });
		sockets.add(clientSocket);
		const upstream = net.connect(targetPort, "127.0.0.1", () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		sockets.add(upstream);
		const close = (): void => {
			upstream.destroy();
			clientSocket.destroy();
		};
		upstream.on("error", close);
		clientSocket.on("error", close);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	return {
		port,
		connects,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

export const servers: Array<{ close(): Promise<void> }> = [];

export async function track<T extends { close(): Promise<void> }>(started: Promise<T>): Promise<T> {
	const server = await started;
	servers.push(server);
	return server;
}

export function clearProxyEnv(): void {
	for (const name of [
		"HTTPS_PROXY",
		"https_proxy",
		"HTTP_PROXY",
		"http_proxy",
		"ALL_PROXY",
		"all_proxy",
		"NO_PROXY",
		"no_proxy",
	]) {
		vi.stubEnv(name, "");
	}
}

export function setHttpsProxy(url: string): void {
	vi.stubEnv("HTTPS_PROXY", url);
	vi.stubEnv("https_proxy", url);
}

export const billingText = buildClaudeBillingBlockText("2.1.326.abc");

/** A request body that carries the billing placeholder and is exactly `chars` characters long. */
export function billingBody(chars?: number): string {
	const build = (filler: string): string =>
		JSON.stringify({
			model: "claude-test",
			messages: [{ role: "user", content: filler }],
			system: [{ type: "text", text: billingText }],
			max_tokens: 10,
			stream: true,
		});
	if (chars === undefined) return build("hello");
	const padding = chars - build("").length;
	if (padding < 0) throw new Error(`Body cannot be ${chars} characters long`);
	return build("x".repeat(padding));
}

export function expectedCch(placeholderBody: string): string {
	return (xxHash64(new TextEncoder().encode(placeholderBody), cchSeed) & 0xfffffn).toString(16).padStart(5, "0");
}

export function headerNames(request: CapturedRequest): string[] {
	return request.headerLines.map((line) => line.slice(0, line.indexOf(":")));
}

export function headerValue(request: CapturedRequest, name: string): string | undefined {
	const line = request.headerLines.find((candidate) => candidate.startsWith(`${name}: `));
	return line?.slice(name.length + 2);
}

export const claudeCodeHeaderNames = [
	"Accept",
	"Content-Type",
	"User-Agent",
	"X-Claude-Code-Session-Id",
	"X-Stainless-Arch",
	"X-Stainless-Lang",
	"X-Stainless-OS",
	"X-Stainless-Package-Version",
	"X-Stainless-Retry-Count",
	"X-Stainless-Runtime",
	"X-Stainless-Runtime-Version",
	"X-Stainless-Timeout",
	"anthropic-beta",
	"anthropic-dangerous-direct-browser-access",
	"anthropic-version",
	"Authorization",
	"x-app",
	"Connection",
];

/** The headers of a subscription request, as `headers.ts` builds them: Claude Code's order and casing. */
export function claudeCodeHeaders(callerHeaders?: Record<string, string>): Record<string, string> {
	return buildClaudeSubscriptionHeaders({
		token: oauthKey,
		betas: ["claude-code-20250219", "oauth-2025-04-20"],
		sessionId,
		callerHeaders,
	});
}

/** Posts through the subscription transport; the header record keeps the order it is given. */
export async function post(
	url: string,
	options: { headers?: Record<string, string>; body?: string; ca?: string } = {},
): Promise<Response> {
	const send = createClaudeCodeFetch({ ca: options.ca });
	return send(url, {
		method: "POST",
		headers: options.headers ?? claudeCodeHeaders(),
		body: options.body ?? billingBody(),
	});
}

/** Restores the proxy environment of a test that set one. Call from `afterEach`. */
export function restoreWireEnv(): void {
	vi.unstubAllEnvs();
}

export { createHttpServer, net, tls };
