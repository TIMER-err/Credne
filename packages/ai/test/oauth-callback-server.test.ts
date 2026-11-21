import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	promptForManualCode,
	startOAuthCallbackServer,
	waitForCallbackOrManualInput,
} from "../src/auth/oauth/callback-server.ts";
import type { AuthPrompt, ProviderAuthInteraction } from "../src/auth/types.ts";

const nativeFetch = globalThis.fetch;
/** Whether this host has an IPv6 loopback to bind; the IPv6 cases are skipped without one. */
const ipv6Available = await new Promise<boolean>((resolve) => {
	const probe = createServer();
	probe.once("error", () => resolve(false));
	probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

function callbackUrl(redirectUri: string, params: Record<string, string>): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

async function page(response: Response): Promise<{ status: number; contentType: string | null; body: string }> {
	return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

function interaction(prompt: (prompt: AuthPrompt) => Promise<string>, signal?: AbortSignal): ProviderAuthInteraction {
	return { signal: signal ?? new AbortController().signal, notify: () => {}, prompt };
}

/** A manual prompt that stays open until its signal aborts. */
function pendingPrompt(onPrompt?: (prompt: AuthPrompt) => void): (prompt: AuthPrompt) => Promise<string> {
	return (prompt) => {
		onPrompt?.(prompt);
		return new Promise((_, reject) => {
			prompt.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true });
		});
	};
}

describe.sequential("OAuth callback server", () => {
	const servers: { close(): void }[] = [];
	const start = async <T>(options: Partial<Parameters<typeof startOAuthCallbackServer<T>>[0]> = {}) => {
		const server = await startOAuthCallbackServer<T>({
			providerName: "Example",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			state: "expected-state",
			complete: async (code) => `completed:${code}` as T,
			...options,
		});
		servers.push(server);
		return server;
	};

	afterEach(() => {
		for (const server of servers.splice(0)) server.close();
	});

	it("ignores stray requests and resolves with the completed code", async () => {
		const server = await start<string>();
		expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

		const wrongPath = await page(await nativeFetch(new URL("/other", server.redirectUri)));
		expect(wrongPath.status).toBe(404);
		const wrongState = await page(await nativeFetch(callbackUrl(server.redirectUri, { code: "c", state: "other" })));
		expect(wrongState).toMatchObject({ status: 400, contentType: "text/html; charset=utf-8" });
		expect(wrongState.body).toContain("State mismatch.");
		const post = await nativeFetch(callbackUrl(server.redirectUri, { code: "c", state: "expected-state" }), {
			method: "POST",
		});
		expect(post.status).toBe(404);
		const missingCode = await page(await nativeFetch(callbackUrl(server.redirectUri, { state: "expected-state" })));
		expect(missingCode.status).toBe(400);

		const success = await page(
			await nativeFetch(callbackUrl(server.redirectUri, { code: "the-code", state: "expected-state" })),
		);
		expect(success).toMatchObject({ status: 200, contentType: "text/html; charset=utf-8" });
		expect(success.body).toContain("Authentication successful");
		expect(success.body).toContain("Signed in to Example.");
		expect(success.body).toContain('fill="#F09082"');
		expect(success.body).toContain('fill="#4D9ABF"');
		expect(success.body).toContain('fill="#F1BE58"');
		await expect(server.wait()).resolves.toBe("completed:the-code");
	});

	it("uses the redirect host and skips the state check when none is expected", async () => {
		const server = await start<string>({ redirectHost: "localhost", state: undefined });
		expect(server.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
		const response = await nativeFetch(callbackUrl(server.redirectUri, { code: "no-state" }));
		expect(response.status).toBe(200);
		await expect(server.wait()).resolves.toBe("completed:no-state");
	});

	it("shows completion failures on the page and rejects the wait", async () => {
		const server = await start<string>({
			complete: async () => {
				throw new Error("token exchange failed");
			},
		});
		const failure = await page(
			await nativeFetch(callbackUrl(server.redirectUri, { code: "c", state: "expected-state" })),
		);
		expect(failure.status).toBe(502);
		expect(failure.body).toContain("Example sign-in failed.");
		expect(failure.body).toContain("token exchange failed");
		await expect(server.wait()).rejects.toThrow("token exchange failed");
	});

	it("rejects the wait when the provider redirects with an error", async () => {
		const server = await start<string>();
		const failure = await page(
			await nativeFetch(
				callbackUrl(server.redirectUri, {
					error: "access_denied",
					error_description: "User denied access",
					state: "expected-state",
				}),
			),
		);
		expect(failure.status).toBe(400);
		expect(failure.body).toContain("User denied access");
		await expect(server.wait()).rejects.toThrow("Example authorization failed: User denied access");
	});

	it("completes only the first callback", async () => {
		let finishExchange: ((value: string) => void) | undefined;
		const server = await start<string>({
			complete: () =>
				new Promise<string>((resolve) => {
					finishExchange = resolve;
				}),
		});
		const url = callbackUrl(server.redirectUri, { code: "c", state: "expected-state" });
		const first = nativeFetch(url);
		await vi.waitFor(() => expect(finishExchange).toBeDefined());
		const second = await nativeFetch(url);
		expect(second.status).toBe(409);
		// A claimed callback keeps completing even when the caller switches to manual input.
		server.cancel();
		finishExchange?.("done");
		expect((await first).status).toBe(200);
		await expect(server.wait()).resolves.toBe("done");
	});

	it("resolves with undefined after cancel", async () => {
		const server = await start<string>();
		server.cancel();
		await expect(server.wait()).resolves.toBeUndefined();
		const late = await nativeFetch(callbackUrl(server.redirectUri, { code: "c", state: "expected-state" }));
		expect(late.status).toBe(409);
	});

	it("rejects the wait on abort and on timeout", async () => {
		const controller = new AbortController();
		const aborted = await start<string>({ signal: controller.signal });
		controller.abort();
		await expect(aborted.wait()).rejects.toThrow("Login cancelled");

		const timedOut = await start<string>({ timeoutMs: 10 });
		await expect(timedOut.wait()).rejects.toThrow("Example sign-in timed out");

		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await expect(start<string>({ signal: alreadyAborted.signal })).rejects.toThrow("Login cancelled");
	});

	describe("companion address", () => {
		const portOf = (redirectUri: string): string => new URL(redirectUri).port;

		it.skipIf(!ipv6Available)("also listens on it, at the port the first address got", async () => {
			const server = await start<string>({ companionHost: "::1" });
			const port = portOf(server.redirectUri);

			for (const host of ["127.0.0.1", "[::1]"]) {
				const mismatch = await page(await nativeFetch(`http://${host}:${port}/callback?code=c&state=other`));
				expect(mismatch.status).toBe(400);
				expect(mismatch.body).toContain("State mismatch.");
			}
			const success = await nativeFetch(`http://[::1]:${port}/callback?code=via-ipv6&state=expected-state`);
			expect(success.status).toBe(200);
			await expect(server.wait()).resolves.toBe("completed:via-ipv6");
		});

		it.skipIf(!ipv6Available)("stops listening on both addresses when closed", async () => {
			const server = await start<string>({ companionHost: "::1" });
			const port = portOf(server.redirectUri);

			server.close();

			await expect(nativeFetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
			await expect(nativeFetch(`http://[::1]:${port}/callback`)).rejects.toThrow();
		});

		it("is served by the first address alone when the host cannot bind the companion", async () => {
			// A documentation address no host owns, as a host without IPv6 owns no `::1`.
			const server = await start<string>({ companionHost: "192.0.2.1" });

			const response = await nativeFetch(
				callbackUrl(server.redirectUri, { code: "alone", state: "expected-state" }),
			);

			expect(response.status).toBe(200);
			await expect(server.wait()).resolves.toBe("completed:alone");
		});

		it.skipIf(!ipv6Available)(
			"fails as a port conflict when another process holds the companion address, and frees the first",
			async () => {
				const blocker = createServer();
				await new Promise<void>((resolve) => blocker.listen(0, "::1", resolve));
				try {
					const address = blocker.address();
					if (!address || typeof address === "string") throw new Error("blocker did not bind to TCP");

					await expect(start<string>({ port: address.port, companionHost: "::1" })).rejects.toMatchObject({
						code: "EADDRINUSE",
					});

					// The first address was released, so the port is free there again.
					const probe = createServer();
					await new Promise<void>((resolve, reject) => {
						probe.once("error", reject);
						probe.listen(address.port, "127.0.0.1", resolve);
					});
					probe.close();
				} finally {
					blocker.close();
				}
			},
		);

		it("lets a port the first address cannot get fail as it does without a companion", async () => {
			const blocker = createServer();
			await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
			try {
				const address = blocker.address();
				if (!address || typeof address === "string") throw new Error("blocker did not bind to TCP");

				await expect(start<string>({ port: address.port, companionHost: "::1" })).rejects.toMatchObject({
					code: "EADDRINUSE",
				});
			} finally {
				blocker.close();
			}
		});
	});

	it("fails instead of picking another port when the requested port is taken", async () => {
		const blocker: Server = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		try {
			const address = blocker.address();
			if (!address || typeof address === "string") throw new Error("blocker did not bind to TCP");
			await expect(start<string>({ port: address.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
		} finally {
			blocker.close();
		}
	});
});

describe.sequential("waitForCallbackOrManualInput", () => {
	it("returns the browser callback and aborts the manual prompt", async () => {
		let manualSignal: AbortSignal | undefined;
		const server = await startOAuthCallbackServer({
			providerName: "Example",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			complete: async (code) => code,
		});
		try {
			const result = waitForCallbackOrManualInput(
				interaction(
					pendingPrompt((prompt) => {
						manualSignal = prompt.signal;
					}),
				),
				server,
				{ message: "paste", placeholder: server.redirectUri },
			);
			await nativeFetch(callbackUrl(server.redirectUri, { code: "from-browser" }));
			await expect(result).resolves.toEqual({ type: "callback", value: "from-browser" });
			expect(manualSignal?.aborted).toBe(true);
		} finally {
			server.close();
		}
	});

	it("returns pasted input and stops waiting for the browser", async () => {
		const server = await startOAuthCallbackServer({
			providerName: "Example",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			complete: async (code) => code,
		});
		try {
			const result = await waitForCallbackOrManualInput(
				interaction(async () => "pasted"),
				server,
				{
					message: "paste",
					placeholder: server.redirectUri,
				},
			);
			expect(result).toEqual({ type: "manual", input: "pasted" });
		} finally {
			server.close();
		}
	});

	describe("an input the caller does not accept", () => {
		const accepts = (input: string): boolean => input.startsWith("good");

		it("is asked for again, and the first accepted input is returned", async () => {
			const answers = ["bad", "", "good-one", "good-two"];
			const prompts: AuthPrompt[] = [];
			const server = await startOAuthCallbackServer({
				providerName: "Example",
				host: "127.0.0.1",
				port: 0,
				path: "/callback",
				complete: async (code) => code,
			});
			try {
				const result = await waitForCallbackOrManualInput(
					interaction(async (prompt) => {
						prompts.push(prompt);
						return answers[prompts.length - 1] ?? "";
					}),
					server,
					{ message: "paste", placeholder: server.redirectUri, accepts },
				);

				expect(result).toEqual({ type: "manual", input: "good-one" });
				expect(prompts).toHaveLength(3);
				expect(prompts.map((prompt) => prompt.type)).toEqual(["manual_code", "manual_code", "manual_code"]);
			} finally {
				server.close();
			}
		});

		it("keeps the browser callback live while it asks again", async () => {
			let prompts = 0;
			let lastSignal: AbortSignal | undefined;
			const server = await startOAuthCallbackServer({
				providerName: "Example",
				host: "127.0.0.1",
				port: 0,
				path: "/callback",
				complete: async (code) => code,
			});
			try {
				const result = waitForCallbackOrManualInput(
					interaction((prompt) => {
						prompts++;
						lastSignal = prompt.signal;
						return prompts === 1 ? Promise.resolve("bad") : pendingPrompt()(prompt);
					}),
					server,
					{ message: "paste", placeholder: server.redirectUri, accepts },
				);
				await vi.waitFor(() => expect(prompts).toBe(2));
				await nativeFetch(callbackUrl(server.redirectUri, { code: "from-browser" }));

				await expect(result).resolves.toEqual({ type: "callback", value: "from-browser" });
				expect(lastSignal?.aborted).toBe(true);
			} finally {
				server.close();
			}
		});

		it("ends the wait with the failure of the prompt it asked again", async () => {
			let prompts = 0;

			const result = waitForCallbackOrManualInput(
				interaction(async () => {
					prompts++;
					if (prompts === 2) throw new Error("prompt cancelled");
					return "bad";
				}),
				undefined,
				{ message: "paste", placeholder: "http://localhost/callback", accepts },
			);

			await expect(result).rejects.toThrow("prompt cancelled");
		});

		it("takes every input when the caller sets no check, and stops asking once the signal aborted", async () => {
			expect(
				await promptForManualCode(
					interaction(async () => "anything"),
					{ message: "paste", placeholder: "x" },
					undefined,
				),
			).toBe("anything");

			const controller = new AbortController();
			const asking = promptForManualCode(
				interaction(async () => {
					controller.abort();
					return "bad";
				}),
				{ message: "paste", placeholder: "x", accepts },
				controller.signal,
			);

			await expect(asking).rejects.toThrow();
		});
	});

	it("uses only the manual prompt without a callback server", async () => {
		const result = await waitForCallbackOrManualInput(
			interaction(async () => "pasted"),
			undefined,
			{
				message: "paste",
				placeholder: "http://localhost/callback",
			},
		);
		expect(result).toEqual({ type: "manual", input: "pasted" });
	});

	it("propagates manual prompt failures", async () => {
		const server = await startOAuthCallbackServer({
			providerName: "Example",
			host: "127.0.0.1",
			port: 0,
			path: "/callback",
			complete: async (code) => code,
		});
		try {
			const result = waitForCallbackOrManualInput(
				interaction(async () => {
					throw new Error("prompt cancelled");
				}),
				server,
				{ message: "paste", placeholder: server.redirectUri },
			);
			await expect(result).rejects.toThrow("prompt cancelled");
		} finally {
			server.close();
		}
	});
});
