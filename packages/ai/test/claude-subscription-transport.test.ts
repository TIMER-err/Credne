// The Claude subscription transport on the wire: request bytes (header order and casing, Host, Content-Length, the cch
// body hash), the TLS profile (Bun's cipher list, ALPN http/1.1, SNI), the CONNECT proxy, request compression, response
// decoding, abort handling, connection reuse. Every case runs against raw TCP or TLS servers that record the exact bytes.

import { brotliCompressSync, deflateSync, gunzipSync, gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createClaudeCodeFetch,
	minGzipChars,
	sendWithClaudeCodeProfile,
} from "../src/api/claude-subscription/transport.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import {
	billingBody,
	bunCipherList,
	claudeCodeHeaderNames,
	claudeCodeHeaders,
	clearProxyEnv,
	createHttpServer,
	expectedCch,
	headerNames,
	headerValue,
	net,
	oauthKey,
	post,
	type RawServer,
	type Respond,
	reply,
	servers,
	sessionId,
	setHttpsProxy,
	startProxy,
	startServer,
	testCert,
	tls,
	track,
} from "./claude-subscription-wire.ts";

beforeEach(() => {
	clearProxyEnv();
	vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", undefined);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	cleanupSessionResources();
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

// ---------------------------------------------------------------------------------------------------------------
// TLS profile, proxy, compression
// ---------------------------------------------------------------------------------------------------------------

describe("Claude Code request bytes", () => {
	it("writes the header record in its order and casing, then Host, Accept-Encoding and Content-Length", async () => {
		const server = await track(startServer("http", (_request, socket) => reply(socket, 200, {}, "ok")));

		await post(`http://127.0.0.1:${server.port}/v1/messages?beta=true`);

		const [request] = server.requests;
		expect(request.head.split("\r\n")[0]).toBe("POST /v1/messages?beta=true HTTP/1.1");
		expect(headerNames(request)).toEqual([...claudeCodeHeaderNames, "Host", "Accept-Encoding", "Content-Length"]);
		expect(headerValue(request, "Accept")).toBe("application/json");
		expect(headerValue(request, "Content-Type")).toBe("application/json");
		expect(headerValue(request, "User-Agent")).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
		expect(headerValue(request, "X-Claude-Code-Session-Id")).toBe(sessionId);
		expect(headerValue(request, "X-Stainless-Retry-Count")).toBe("0");
		expect(headerValue(request, "X-Stainless-Timeout")).toBe("600");
		expect(headerValue(request, "X-Stainless-Runtime-Version")).toBe("v26.12.1");
		expect(headerValue(request, "anthropic-dangerous-direct-browser-access")).toBe("true");
		expect(headerValue(request, "anthropic-version")).toBe("2023-06-01");
		expect(headerValue(request, "Authorization")).toBe(`Bearer ${oauthKey}`);
		expect(headerValue(request, "x-app")).toBe("cli");
		expect(headerValue(request, "Connection")).toBe("keep-alive");
		expect(headerValue(request, "Host")).toBe(`127.0.0.1:${server.port}`);
		expect(headerValue(request, "Accept-Encoding")).toBe("gzip, deflate, br, zstd");
		expect(headerValue(request, "Content-Length")).toBe(String(request.body.length));
	});

	it("puts the headers the caller configured before Claude Code's own", async () => {
		const server = await track(startServer("http", (_request, socket) => reply(socket, 200, {}, "ok")));

		await post(`http://127.0.0.1:${server.port}/v1/messages`, {
			headers: claudeCodeHeaders({ "X-Zeta-Trace": "z", "x-alpha": "a" }),
		});

		const [request] = server.requests;
		expect(headerNames(request).slice(0, 3)).toEqual(["X-Zeta-Trace", "x-alpha", "Accept"]);
	});

	it("signs the plain body before it leaves and sends exactly the signed bytes", async () => {
		const server = await track(startServer("http", (_request, socket) => reply(socket, 200, {}, "ok")));
		const placeholderBody = billingBody();

		await post(`http://127.0.0.1:${server.port}/v1/messages`, { body: placeholderBody });

		const body = server.requests[0].body.toString("utf8");
		const cch = /cch=([0-9a-f]{5});/.exec(body)?.[1];
		expect(cch).toBe(expectedCch(placeholderBody));
		expect(cch).not.toBe("00000");
		expect(body).toBe(placeholderBody.replace("cch=00000", `cch=${cch}`));
	});

	it("hands a caller's fetch the signed body and the header record untouched, never gzipped", async () => {
		const calls: Array<{ headers: Record<string, string>; body: string }> = [];
		const stub = createClaudeCodeFetch({
			fetch: async (_input, init) => {
				calls.push({ headers: init?.headers as Record<string, string>, body: init?.body as string });
				return new Response("ok");
			},
		});
		const headers = claudeCodeHeaders({ "X-Zeta": "z" });

		await stub("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: billingBody(4000) });

		const [call] = calls;
		expect(Object.keys(call.headers)).toEqual(Object.keys(headers));
		expect(call.body.length).toBeGreaterThan(minGzipChars);
		expect(call.body).toContain(`cch=${expectedCch(billingBody(4000))};`);
	});
});

describe("Claude Code connection failures", () => {
	it("names how far the body got when an established connection is lost before any response", async () => {
		const server = await track(startServer("http", (_request, socket) => socket.destroy()));

		const error = await post(`http://127.0.0.1:${server.port}/v1/messages`).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		const failure = error as Error & { cause?: { code?: string } };
		expect(failure.name).toBe("ConnectionLostBeforeResponseError");
		expect(failure.message).toMatch(
			/^connection lost after \d+ms, after the \d+B request body was written to the socket, before any response \(ECONNRESET\)$/,
		);
		expect(failure.cause?.code).toBe("ECONNRESET");
	});

	it("keeps a connect failure's own error", async () => {
		const closed = await startServer("http", () => {});
		const { port } = closed;
		await closed.close();

		const error = await post(`http://127.0.0.1:${port}/v1/messages`).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error & { code?: string }).code).toBe("ECONNREFUSED");
		expect((error as Error).name).not.toBe("ConnectionLostBeforeResponseError");
	});
});

describe("Claude Code TLS transport through a CONNECT proxy", () => {
	async function startTlsStack(respond: Respond = (_request, socket) => reply(socket, 200, {}, "ok")) {
		const server = await track(startServer("tls", respond));
		const proxy = await track(startProxy(server.port));
		setHttpsProxy(`http://127.0.0.1:${proxy.port}`);
		return { server, proxy };
	}

	it("tunnels https requests to the proxy and talks HTTP/1.1 with SNI and trusted certificates", async () => {
		const { server, proxy } = await startTlsStack();

		const response = await post("https://api.anthropic.com/v1/messages?beta=true", { ca: testCert });

		expect(await response.text()).toBe("ok");
		expect(proxy.connects).toEqual([{ target: "api.anthropic.com:443", authorization: undefined }]);
		const [request] = server.requests;
		expect(request.tls).toEqual({ alpn: "http/1.1", protocol: "TLSv1.3" });
		expect(headerValue(request, "Host")).toBe("api.anthropic.com");
	});

	it("sends proxy credentials from the proxy URL", async () => {
		const server = await track(startServer("tls", (_request, socket) => reply(socket, 200, {}, "ok")));
		const proxy = await track(startProxy(server.port));
		setHttpsProxy(`http://user%40corp:p%3Ass@127.0.0.1:${proxy.port}`);

		await post("https://api.anthropic.com/v1/messages", { ca: testCert });

		expect(proxy.connects[0].authorization).toBe(`Basic ${Buffer.from("user@corp:p:ss").toString("base64")}`);
	});

	it("rejects when the proxy refuses the tunnel", async () => {
		const refusing = createHttpServer();
		refusing.on("connect", (_request, socket) => {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		});
		await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
		servers.push({ close: () => new Promise<void>((resolve) => refusing.close(() => resolve())) });
		setHttpsProxy(`http://127.0.0.1:${(refusing.address() as net.AddressInfo).port}`);

		await expect(post("https://api.anthropic.com/v1/messages", { ca: testCert })).rejects.toThrow(
			/Proxy refused CONNECT to api\.anthropic\.com:443 with HTTP 403/,
		);
	});

	it("does not trust a certificate the caller did not provide", async () => {
		await startTlsStack();

		await expect(post("https://api.anthropic.com/v1/messages")).rejects.toThrow();
	});

	it("honors NO_PROXY", async () => {
		const server = await track(startServer("tls", (_request, socket) => reply(socket, 200, {}, "ok")));
		setHttpsProxy("http://127.0.0.1:1");
		vi.stubEnv("NO_PROXY", "localhost");
		vi.stubEnv("no_proxy", "localhost");

		const response = await post(`https://localhost:${server.port}/v1/messages`, { ca: testCert });

		expect(await response.text()).toBe("ok");
		expect(server.requests).toHaveLength(1);
	});

	describe("request body compression", () => {
		it("gzips a body of exactly 1024 characters and leaves one of 1023 plain", async () => {
			const { server } = await startTlsStack();

			await post("https://api.anthropic.com/v1/messages", { ca: testCert, body: billingBody(minGzipChars - 1) });
			await post("https://api.anthropic.com/v1/messages", { ca: testCert, body: billingBody(minGzipChars) });

			const [plain, compressed] = server.requests;
			expect(minGzipChars).toBe(1024);
			expect(headerNames(plain)).not.toContain("Content-Encoding");
			expect(plain.body.length).toBe(minGzipChars - 1);
			expect(headerNames(compressed)).toContain("Content-Encoding");
			expect(headerValue(compressed, "Content-Encoding")).toBe("gzip");
			expect(gunzipSync(compressed.body).length).toBe(minGzipChars);
		});

		it("signs the plain body before gzip and sends the compressed length", async () => {
			const { server } = await startTlsStack();
			const placeholderBody = billingBody(5000);

			await post("https://api.anthropic.com/v1/messages", { ca: testCert, body: placeholderBody });

			const [request] = server.requests;
			const decompressed = gunzipSync(request.body).toString("utf8");
			const cch = expectedCch(placeholderBody);
			expect(cch).not.toBe("00000");
			expect(decompressed).toBe(placeholderBody.replace("cch=00000", `cch=${cch}`));
			expect(request.body.length).toBeLessThan(placeholderBody.length);
			expect(headerValue(request, "Content-Length")).toBe(String(request.body.length));
			expect(request.body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
		});

		it("places Content-Encoding after Accept-Encoding and Content-Length last, with Host before Accept-Encoding", async () => {
			const { server } = await startTlsStack();

			await post("https://api.anthropic.com/v1/messages?beta=true", { ca: testCert, body: billingBody(3000) });

			const [request] = server.requests;
			expect(headerNames(request)).toEqual([
				...claudeCodeHeaderNames,
				"Host",
				"Accept-Encoding",
				"Content-Encoding",
				"Content-Length",
			]);
		});

		it("compresses at gzip level 6", async () => {
			const { server } = await startTlsStack();
			const body = billingBody(20_000);

			await post("https://api.anthropic.com/v1/messages", { ca: testCert, body });

			const [request] = server.requests;
			const plain = gunzipSync(request.body);
			// The same bytes at level 6 compress to exactly the length on the wire; another level would differ.
			expect(request.body.length).toBe(gzipSync(plain, { level: 6 }).length);
			expect(request.body.length).not.toBe(gzipSync(plain, { level: 1 }).length);
		});

		it("sends a body plain when PI_REQUEST_COMPRESSION turns compression off", async () => {
			const { server } = await startTlsStack();
			vi.stubEnv("PI_REQUEST_COMPRESSION", "0");

			await post("https://api.anthropic.com/v1/messages", { ca: testCert, body: billingBody(5000) });

			const [request] = server.requests;
			expect(headerNames(request)).not.toContain("Content-Encoding");
			expect(request.body.length).toBe(5000);
		});

		it("keeps compression on for the truthy spellings of PI_REQUEST_COMPRESSION", async () => {
			const { server } = await startTlsStack();
			vi.stubEnv("PI_REQUEST_COMPRESSION", "yes");

			await post("https://api.anthropic.com/v1/messages", { ca: testCert, body: billingBody(5000) });

			expect(headerValue(server.requests[0], "Content-Encoding")).toBe("gzip");
		});

		it("does not compress a request that already carries a Content-Encoding", async () => {
			const { server } = await startTlsStack();
			const body = gzipSync(billingBody(5000));

			const send = createClaudeCodeFetch({ ca: testCert });
			await send("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { ...claudeCodeHeaders(), "Content-Encoding": "identity" },
				body,
			});

			const [request] = server.requests;
			expect(headerValue(request, "Content-Encoding")).toBe("identity");
			expect(request.body.equals(body)).toBe(true);
		});

		it("never gzips bodies for hosts other than Anthropic's API", async () => {
			const server = await track(startServer("tls", (_request, socket) => reply(socket, 200, {}, "ok")));

			await post(`https://localhost:${server.port}/v1/messages`, { ca: testCert, body: billingBody(3000) });

			const [request] = server.requests;
			expect(headerNames(request)).not.toContain("Content-Encoding");
			expect(request.body.length).toBe(3000);
		});
	});
});

describe("Claude Code TLS profile", () => {
	interface ClientHello {
		cipherSuites: number[];
		alpn: string[];
		serverName: string | undefined;
	}

	function parseClientHello(data: Buffer): ClientHello {
		// TLS record header (5), handshake header (4), client version (2), random (32).
		let offset = 5 + 4 + 2 + 32;
		offset += 1 + data[offset];
		const suitesLength = data.readUInt16BE(offset);
		offset += 2;
		const cipherSuites: number[] = [];
		for (let index = 0; index < suitesLength; index += 2) cipherSuites.push(data.readUInt16BE(offset + index));
		offset += suitesLength;
		offset += 1 + data[offset];
		const extensionsEnd = offset + 2 + data.readUInt16BE(offset);
		offset += 2;
		const alpn: string[] = [];
		let serverName: string | undefined;
		while (offset < extensionsEnd) {
			const type = data.readUInt16BE(offset);
			const length = data.readUInt16BE(offset + 2);
			const body = data.subarray(offset + 4, offset + 4 + length);
			offset += 4 + length;
			if (type === 0) serverName = body.subarray(5).toString("ascii");
			if (type !== 16) continue;
			for (let cursor = 2; cursor < body.length; cursor += 1 + body[cursor]) {
				alpn.push(body.subarray(cursor + 1, cursor + 1 + body[cursor]).toString("ascii"));
			}
		}
		return { cipherSuites, alpn, serverName };
	}

	/** Runs `connect` against a server that records the ClientHello and drops the connection. */
	async function captureClientHello(connect: (port: number) => Promise<unknown>): Promise<ClientHello> {
		const captured = Promise.withResolvers<ClientHello>();
		const server = net.createServer((socket) => {
			socket.on("error", () => {});
			socket.once("data", (data) => {
				captured.resolve(parseClientHello(data));
				socket.destroy();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
		await connect((server.address() as net.AddressInfo).port).catch(() => {});
		return captured.promise;
	}

	function directClientHello(ciphers: string): Promise<ClientHello> {
		return captureClientHello(
			(port) =>
				new Promise((resolve) => {
					const socket = tls.connect({
						host: "127.0.0.1",
						port,
						servername: "localhost",
						ciphers,
						ALPNProtocols: ["http/1.1"],
					});
					socket.on("error", resolve);
				}),
		);
	}

	it("offers Bun's cipher list in order, ALPN http/1.1 only, and the host name as SNI", async () => {
		const profile = await captureClientHello((port) =>
			sendWithClaudeCodeProfile(new URL(`https://localhost:${port}/`), { method: "HEAD", headers: {} }),
		);

		const bun = await directClientHello(bunCipherList);
		const nodeDefault = await directClientHello(tls.DEFAULT_CIPHERS);
		expect(profile.cipherSuites).toEqual(bun.cipherSuites);
		expect(profile.cipherSuites).not.toEqual(nodeDefault.cipherSuites);
		expect(profile.alpn).toEqual(["http/1.1"]);
		expect(profile.serverName).toBe("localhost");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

describe("Claude Code response handling", () => {
	const plaintext = JSON.stringify({ message: "héllo ✓", repeated: "abc".repeat(500) });

	async function fetchFromHttp(server: RawServer, init: RequestInit = {}): Promise<Response> {
		const send = createClaudeCodeFetch();
		return send(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: "POST",
			headers: claudeCodeHeaders(),
			body: billingBody(),
			...init,
		});
	}

	it.each([
		["gzip", gzipSync],
		["deflate", deflateSync],
		["br", brotliCompressSync],
		["zstd", zstdCompressSync],
	] as const)("decodes a %s response body and drops the encoding headers", async (encoding, encode) => {
		const encoded = encode(Buffer.from(plaintext));
		const server = await track(
			startServer("http", (_request, socket) =>
				reply(
					socket,
					201,
					{ "content-encoding": encoding, "request-id": "req_123", "content-type": "application/json" },
					encoded,
				),
			),
		);

		const response = await fetchFromHttp(server);

		expect(response.status).toBe(201);
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(response.headers.get("content-length")).toBeNull();
		expect(response.headers.get("request-id")).toBe("req_123");
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.text()).toBe(plaintext);
	});

	it("returns an unencoded body as is, keeping its headers", async () => {
		const server = await track(
			startServer("http", (_request, socket) => reply(socket, 200, { "content-type": "text/plain" }, plaintext)),
		);

		const response = await fetchFromHttp(server);

		expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(plaintext)));
		expect(await response.text()).toBe(plaintext);
	});

	it("passes error statuses and bodies to the caller", async () => {
		const server = await track(
			startServer("http", (_request, socket) =>
				reply(socket, 429, { "retry-after": "7", "content-type": "application/json" }, '{"type":"error"}'),
			),
		);

		const response = await fetchFromHttp(server);

		expect(response.status).toBe(429);
		expect(response.ok).toBe(false);
		expect(response.headers.get("retry-after")).toBe("7");
		expect(await response.json()).toEqual({ type: "error" });
	});

	it("streams the body as it arrives instead of buffering it", async () => {
		const release = Promise.withResolvers<void>();
		const server = await track(
			startServer("http", (_request, socket) => {
				socket.write("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n");
				socket.write("5\r\nfirst\r\n");
				release.promise.then(() => socket.write("6\r\nsecond\r\n0\r\n\r\n"));
			}),
		);

		const response = await fetchFromHttp(server);
		const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
		const first = await reader.read();

		expect(new TextDecoder().decode(first.value)).toBe("first");
		release.resolve();
		const second = await reader.read();
		expect(new TextDecoder().decode(second.value)).toBe("second");
		expect((await reader.read()).done).toBe(true);
	});

	it("reports a connection lost mid-body as a closed socket", async () => {
		const server = await track(
			startServer("http", (_request, socket) => {
				socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npartial");
				setTimeout(() => socket.destroy(), 20);
			}),
		);

		const response = await fetchFromHttp(server);

		await expect(response.text()).rejects.toThrow(/socket connection was closed unexpectedly/);
	});

	it("sends a byte body unchanged with its length", async () => {
		const server = await track(startServer("http", (_request, socket) => reply(socket, 200, {}, "ok")));
		const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252]);

		await fetchFromHttp(server, { body: bytes });

		expect([...server.requests[0].body]).toEqual([...bytes]);
		expect(headerValue(server.requests[0], "Content-Length")).toBe("6");
	});

	it("measures Content-Length in UTF-8 bytes", async () => {
		const server = await track(startServer("http", (_request, socket) => reply(socket, 200, {}, "ok")));
		const body = JSON.stringify({ text: "é✓𝄞" });

		await fetchFromHttp(server, { body });

		expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
		expect(headerValue(server.requests[0], "Content-Length")).toBe(String(Buffer.byteLength(body)));
		expect(server.requests[0].body.toString("utf8")).toBe(body);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Abort and timeouts
// ---------------------------------------------------------------------------------------------------------------

describe("Claude Code transport cancellation", () => {
	function silentServer(): Promise<RawServer> {
		return track(startServer("http", () => {}));
	}

	it("rejects at once with an AbortError when the signal is already aborted", async () => {
		const server = await silentServer();
		const send = createClaudeCodeFetch();

		await expect(
			send(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: "POST",
				headers: claudeCodeHeaders(),
				body: billingBody(),
				signal: AbortSignal.abort(),
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(server.connections).toBe(0);
	});

	it("destroys the request and rejects with an AbortError when aborted before the response", async () => {
		const server = await silentServer();
		const controller = new AbortController();
		const send = createClaudeCodeFetch();

		const pending = send(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: "POST",
			headers: claudeCodeHeaders(),
			body: billingBody(),
			signal: controller.signal,
		});
		pending.catch(() => {});
		await vi.waitFor(() => expect(server.requests).toHaveLength(1));
		expect(server.closedConnections).toBe(0);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		// Destroying the request closes its socket instead of leaving it for the pool.
		await vi.waitFor(() => expect(server.closedConnections).toBe(1));
	});

	it("rejects with the abort reason an error carries", async () => {
		const server = await silentServer();
		const controller = new AbortController();
		const send = createClaudeCodeFetch();
		const reason = new Error("user pressed escape");

		const pending = send(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: "POST",
			headers: claudeCodeHeaders(),
			body: billingBody(),
			signal: controller.signal,
		});
		pending.catch(() => {});
		await vi.waitFor(() => expect(server.requests).toHaveLength(1));
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	it("aborts a body that is still streaming", async () => {
		const server = await track(
			startServer("http", (_request, socket) => {
				socket.write("HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\nstart");
			}),
		);
		const controller = new AbortController();
		const send = createClaudeCodeFetch();

		const response = await send(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: "POST",
			headers: claudeCodeHeaders(),
			body: billingBody(),
			signal: controller.signal,
		});
		const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("start");
		controller.abort();

		await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
	});

	it("fails a request whose socket goes quiet for the idle timeout", async () => {
		const server = await silentServer();
		const send = createClaudeCodeFetch({ idleTimeoutMs: 80 });

		await expect(
			send(`http://127.0.0.1:${server.port}/v1/messages`, {
				method: "POST",
				headers: claudeCodeHeaders(),
				body: billingBody(),
			}),
		).rejects.toThrow(/timed out after 80ms/);
	});

	it("fails a body that stalls for the idle timeout", async () => {
		const server = await track(
			startServer("http", (_request, socket) => {
				socket.write("HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\nstart");
			}),
		);
		const send = createClaudeCodeFetch({ idleTimeoutMs: 80 });

		const response = await send(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: "POST",
			headers: claudeCodeHeaders(),
			body: billingBody(),
		});

		await expect(response.text()).rejects.toThrow(/timed out after 80ms/);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Connection reuse and warm-up
// ---------------------------------------------------------------------------------------------------------------

describe("Claude Code connection reuse", () => {
	it("serves a warm-up HEAD and the next message request over one connection", async () => {
		const server = await track(
			startServer("http", (request, socket) =>
				request.head.startsWith("HEAD ")
					? socket.write("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n")
					: reply(socket, 200, {}, "ok"),
			),
		);
		const origin = `http://127.0.0.1:${server.port}`;

		const warm = await sendWithClaudeCodeProfile(new URL(origin), {
			method: "HEAD",
			headers: { "User-Agent": "credne-test" },
		});
		await warm.body?.cancel();
		const message = await createClaudeCodeFetch()(`${origin}/v1/messages`, {
			method: "POST",
			headers: claudeCodeHeaders(),
			body: billingBody(),
		});
		await message.text();
		const again = await sendWithClaudeCodeProfile(new URL(origin), { method: "HEAD", headers: {} });
		await again.body?.cancel();

		expect(server.requests.map((request) => request.head.split(" ")[0])).toEqual(["HEAD", "POST", "HEAD"]);
		expect(server.connections).toBe(1);
		expect(warm.status).toBe(405);
	});

	it("writes the warm-up as a HEAD with only the given headers and Host", async () => {
		const server = await track(
			startServer("http", (_request, socket) => socket.write("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n")),
		);

		await sendWithClaudeCodeProfile(new URL(`http://127.0.0.1:${server.port}`), {
			method: "HEAD",
			headers: { "User-Agent": "credne-test" },
		});

		const [request] = server.requests;
		expect(request.head.split("\r\n")[0]).toBe("HEAD / HTTP/1.1");
		expect(request.headerLines).toEqual([
			"User-Agent: credne-test",
			`Host: 127.0.0.1:${server.port}`,
			"Connection: keep-alive",
		]);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Latches are process-global with no reset, so this case runs last.
// ---------------------------------------------------------------------------------------------------------------

describe("Claude Code gzip rejection", () => {
	it("resends a body plain once the host rejects the encoding, and sends later bodies plain", async () => {
		const server = await track(
			startServer("tls", (request, socket) => {
				if (headerValue(request, "Content-Encoding") === "gzip") {
					reply(
						socket,
						400,
						{ "content-type": "application/json" },
						JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "request_body_encoding_invalid" },
						}),
					);
					return;
				}
				reply(socket, 200, {}, "accepted");
			}),
		);
		const proxy = await track(startProxy(server.port));
		setHttpsProxy(`http://127.0.0.1:${proxy.port}`);
		const body = billingBody(4000);

		const first = await post("https://api.anthropic.com/v1/messages", { ca: testCert, body });
		const second = await post("https://api.anthropic.com/v1/messages", { ca: testCert, body });

		expect(await first.text()).toBe("accepted");
		expect(await second.text()).toBe("accepted");
		const encodings = server.requests.map((request) => headerValue(request, "Content-Encoding"));
		expect(encodings).toEqual(["gzip", undefined, undefined]);
		expect(server.requests[1].body.length).toBe(4000);
	});
});
