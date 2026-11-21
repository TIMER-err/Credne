import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyOAuth } from "../src/auth/helpers.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type {
	AuthContext,
	AuthEvent,
	AuthPrompt,
	Credential,
	CredentialStore,
	LoginOptions,
	OAuthCredential,
} from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;
const nativeFetch = globalThis.fetch;
/** Whether this host has an IPv6 loopback to bind; the IPv6 cases are skipped without one. */
const ipv6Available = await new Promise<boolean>((resolve) => {
	const probe = createServer();
	probe.once("error", () => resolve(false));
	probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});
const tokenUrl = "https://api.anthropic.com/v1/oauth/token";
const bootstrapUrl = "https://api.anthropic.com/api/claude_cli/bootstrap";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Token response without any signed-in account or organization. */
const anonymousTokenResponse = {
	access_token: "access-token",
	refresh_token: "refresh-token",
	expires_in: 3600,
};

/** Token response as Anthropic sends it, carrying the signed-in account and organization. */
const identityTokenResponse = {
	...anonymousTokenResponse,
	account: { uuid: "account-uuid", email_address: "user@example.com" },
	organization: { uuid: "org-uuid", name: "Example Org" },
};

interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

interface OAuthEndpointResponses {
	/** Token endpoint JSON body, or a function of the parsed request body. Defaults to the anonymous response. */
	token?: Record<string, unknown> | ((body: Record<string, string>) => Record<string, unknown>);
	/** Token endpoint failure status; replaces the body response. */
	tokenStatus?: number;
	/** CLI bootstrap endpoint response. Defaults to a 404. */
	bootstrap?: { status?: number; body: unknown } | "network-error";
}

/**
 * Replaces global fetch with a stub of the two Anthropic OAuth endpoints. Any other URL fails the test, so
 * nothing here can reach the real network.
 */
function stubOAuthEndpoints(responses: OAuthEndpointResponses = {}) {
	const calls: FetchCall[] = [];
	const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url = getUrl(input);
		calls.push({ url, init });
		if (url === tokenUrl) {
			if (responses.tokenStatus) return jsonResponse({ error: "invalid_grant" }, responses.tokenStatus);
			const token = responses.token ?? anonymousTokenResponse;
			return jsonResponse(typeof token === "function" ? token(getJsonBody(init)) : token);
		}
		if (url.startsWith(`${bootstrapUrl}?`)) {
			if (responses.bootstrap === "network-error") throw new TypeError("fetch failed");
			if (!responses.bootstrap) return jsonResponse({}, 404);
			return jsonResponse(responses.bootstrap.body, responses.bootstrap.status ?? 200);
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return {
		fetchMock,
		tokenCalls: () => calls.filter((call) => call.url === tokenUrl),
		bootstrapCalls: () => calls.filter((call) => call.url.startsWith(bootstrapUrl)),
	};
}

/** Copy code login: no callback server, the pasted code is exchanged directly. */
function loginWithCopiedCode(options?: LoginOptions): Promise<OAuthCredential> {
	let authUrl = "";
	return anthropicOAuth.login(
		{
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "copy_code";
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				return `copied-code#${new URL(authUrl).searchParams.get("state")}`;
			},
		},
		options,
	);
}

function storedCredential(extra: Record<string, unknown> = {}): OAuthCredential {
	return { type: "oauth", access: "old-access-token", refresh: "refresh-token", expires: 0, ...extra };
}

describe.sequential("Anthropic OAuth", () => {
	beforeEach(() => {
		// Nothing may reach the real network: tests that expect requests install their own stub.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				throw new Error(`Unexpected network request: ${getUrl(input)}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const { tokenCalls, bootstrapCalls, fetchMock } = stubOAuthEndpoints({
			token: (body) => {
				expect(body.grant_type).toBe("authorization_code");
				expect(body.code).toBe("manual-code");
				expect(body.redirect_uri).toBe("http://localhost:54545/callback");
				return identityTokenResponse;
			},
		});

		const credentials = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "browser";
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) throw new Error("Missing OAuth state or redirect_uri in auth URL");
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(tokenCalls()[0]?.init?.method).toBe("POST");
		expect(tokenCalls()).toHaveLength(1);
		expect(bootstrapCalls()).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("offers browser login first and uses the selected Anthropic copy code flow", async () => {
		const selectPrompts: Array<{
			message: string;
			options: readonly { id: string; label: string }[];
		}> = [];
		let authUrl = "";
		const { tokenCalls, fetchMock } = stubOAuthEndpoints({
			token: (body) => {
				expect(body.grant_type).toBe("authorization_code");
				expect(body.code).toBe("copied-code");
				expect(body.state).toBe(new URL(authUrl).searchParams.get("state"));
				expect(body.redirect_uri).toBe("https://platform.claude.com/oauth/code/callback");
				return identityTokenResponse;
			},
		});

		const credentials = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") {
					selectPrompts.push(prompt);
					return "copy_code";
				}
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				return `copied-code#${new URL(authUrl).searchParams.get("state")}`;
			},
		});

		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(new URL(authUrl).searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
		expect(tokenCalls()).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(selectPrompts).toEqual([
			{
				type: "select",
				message: "Select Anthropic login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "copy_code", label: "Copy code login (headless)" },
				],
			},
		]);
	});

	it("cancels when Anthropic login method selection is cancelled", async () => {
		await expect(
			anthropicOAuth.login({
				signal: neverAbortedSignal,
				prompt: async () => {
					throw new Error("Login cancelled");
				},
				notify: () => {},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("reports a rejected token exchange with the token url", async () => {
		stubOAuthEndpoints({ tokenStatus: 400 });

		await expect(loginWithCopiedCode()).rejects.toThrow(`Token exchange request failed. url=${tokenUrl}`);
	});

	it("omits scope from refresh token requests", async () => {
		const { tokenCalls, bootstrapCalls, fetchMock } = stubOAuthEndpoints({
			token: (body) => {
				expect(body.grant_type).toBe("refresh_token");
				expect(body.client_id).toBeTruthy();
				expect(body.refresh_token).toBe("refresh-token");
				expect(body).not.toHaveProperty("scope");
				return {
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 3600,
					account: { uuid: "account-uuid", email_address: "user@example.com" },
				};
			},
		});

		const credentials = await anthropicOAuth.refresh(
			storedCredential({ accountId: "account-uuid", email: "user@example.com" }),
			neverAbortedSignal,
		);

		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
		expect(tokenCalls()[0]?.init?.method).toBe("POST");
		expect(bootstrapCalls()).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("anthropicOAuth.login resolves through the manual_code prompt and aborts it after settling", async () => {
		stubOAuthEndpoints({ token: identityTokenResponse });

		const events: AuthEvent[] = [];
		const prompts: AuthPrompt[] = [];
		let manualSignal: AbortSignal | undefined;

		const credential = await anthropicOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => events.push(event),
			prompt: async (prompt) => {
				prompts.push(prompt);
				if (prompt.type === "select") return "browser";
				if (prompt.type === "manual_code") {
					manualSignal = prompt.signal;
					return "the-code";
				}
				throw new Error(`Unexpected prompt: ${prompt.type}`);
			},
		});

		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("access-token");
		expect(events.some((e) => e.type === "auth_url")).toBe(true);
		expect(prompts.some((p) => p.type === "manual_code")).toBe(true);
		// the prompt's signal is aborted once login settles, so UIs can dismiss it
		expect(manualSignal?.aborted).toBe(true);
	});

	it("completes login through the browser callback and shows the sign-in page", async () => {
		const login = await loginThroughBrowserCallback();

		expect(login.credential.access).toBe("access");
		expect(login.exchangedCode).toBe("browser-code");
		expect(login.exchangedRedirectUri).toBe(login.redirectUri);
		expect(login.pageStatus).toBe(200);
		expect(login.pageText).toContain("Signed in to Anthropic.");
	});

	// #10571
	it("falls back to a free callback port when the preferred port cannot be bound", async () => {
		const blocker = createServer();
		await listen(blocker, 54545);
		try {
			const login = await loginThroughBrowserCallback();
			const redirectUri = new URL(login.redirectUri);

			expect(redirectUri.hostname).toBe("localhost");
			expect(redirectUri.pathname).toBe("/callback");
			expect(redirectUri.port).not.toBe("54545");
			expect(login.credential.access).toBe("access");
			expect(login.exchangedRedirectUri).toBe(login.redirectUri);
			expect(login.pageStatus).toBe(200);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	describe("callback server addresses", () => {
		/** Logs in through the browser callback, reaching the server at the given loopback addresses. */
		async function loginReachingCallbackAt(hosts: string[]) {
			stubOAuthEndpoints({
				token: (body) => ({ ...identityTokenResponse, access_token: `access-for-${body.code}` }),
			});
			const pages: Array<Promise<Response>> = [];
			let port = "";
			const credential = await anthropicOAuth.login({
				signal: neverAbortedSignal,
				notify: (event) => {
					if (event.type !== "auth_url") return;
					const params = new URL(event.url).searchParams;
					port = new URL(params.get("redirect_uri") ?? "").port;
					for (const host of hosts) {
						const url = `http://${host}:${port}/callback?code=code-via-${host}&state=${params.get("state")}`;
						pages.push(nativeFetch(url));
					}
				},
				prompt: (prompt) =>
					prompt.type === "select"
						? Promise.resolve("browser")
						: new Promise((_, reject) => {
								prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
							}),
			});
			return { credential, port, statuses: (await Promise.all(pages)).map((page) => page.status) };
		}

		it("answers on the IPv4 loopback", async () => {
			const login = await loginReachingCallbackAt(["127.0.0.1"]);

			expect(login.statuses).toEqual([200]);
			expect(login.credential.access).toBe("access-for-code-via-127.0.0.1");
		});

		it.skipIf(!ipv6Available)("answers on the IPv6 loopback at the port of the IPv4 one", async () => {
			const login = await loginReachingCallbackAt(["[::1]"]);

			expect(login.statuses).toEqual([200]);
			expect(login.credential.access).toBe("access-for-code-via-[::1]");
		});

		it.skipIf(!ipv6Available)(
			"serves a request on each family, the first callback completing the login",
			async () => {
				const login = await loginReachingCallbackAt(["127.0.0.1", "[::1]"]);

				expect(login.statuses.filter((status) => status === 200)).toHaveLength(1);
				expect(login.credential.access).toMatch(/^access-for-code-via-/);
			},
		);

		it.skipIf(!ipv6Available)(
			"falls back to a free port when the preferred port is held on the IPv6 loopback alone",
			async () => {
				const blocker = createServer();
				await listen(blocker, 54545, "::1");
				try {
					const login = await loginThroughBrowserCallback();

					expect(new URL(login.redirectUri).port).not.toBe("54545");
					expect(login.credential.access).toBe("access");
					expect(login.pageStatus).toBe(200);
				} finally {
					await new Promise<void>((resolve) => blocker.close(() => resolve()));
				}
			},
		);
	});

	describe("signed-in identity at login", () => {
		it("stores the account and organization from the token response", async () => {
			const { bootstrapCalls } = stubOAuthEndpoints({ token: identityTokenResponse });
			const before = Date.now();

			const credential = await loginWithCopiedCode();

			const after = Date.now();
			expect(credential).toMatchObject({
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				accountId: "account-uuid",
				email: "user@example.com",
				orgId: "org-uuid",
				orgName: "Example Org",
			});
			// Valid for expires_in minus the five minute refresh margin.
			expect(credential.expires).toBeGreaterThanOrEqual(before + 3_600_000 - 300_000);
			expect(credential.expires).toBeLessThanOrEqual(after + 3_600_000 - 300_000);
			expect(bootstrapCalls()).toHaveLength(0);
		});

		it("falls back to the CLI bootstrap endpoint when the token response lacks account and organization", async () => {
			const { bootstrapCalls, tokenCalls } = stubOAuthEndpoints({
				bootstrap: {
					body: {
						oauth_account: {
							account_uuid: "bootstrap-account",
							account_email: "bootstrap@example.com",
							organization_uuid: "bootstrap-org",
							organization_name: "Bootstrap Org",
						},
					},
				},
			});

			const credential = await loginWithCopiedCode();

			expect(credential).toMatchObject({
				access: "access-token",
				accountId: "bootstrap-account",
				email: "bootstrap@example.com",
				orgId: "bootstrap-org",
				orgName: "Bootstrap Org",
			});
			expect(tokenCalls()).toHaveLength(1);
			expect(bootstrapCalls()).toHaveLength(1);
			const [call] = bootstrapCalls();
			expect(call?.url).toBe(`${bootstrapUrl}?entrypoint=cli&model=claude-opus-4-8`);
			expect(call?.init?.method).toBeUndefined();
			const headers = new Headers(call?.init?.headers);
			expect(headers.get("authorization")).toBe("Bearer access-token");
			expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
			expect(headers.get("user-agent")).toMatch(/^claude-code\/\d+\.\d+\.\d+$/);
		});

		it("treats empty identity fields as missing", async () => {
			const { bootstrapCalls } = stubOAuthEndpoints({
				token: {
					...anonymousTokenResponse,
					account: { uuid: "", email_address: "" },
					organization: { uuid: "", name: "" },
				},
				bootstrap: {
					body: { oauth_account: { account_uuid: "bootstrap-account", organization_uuid: "bootstrap-org" } },
				},
			});

			const credential = await loginWithCopiedCode();

			expect(bootstrapCalls()).toHaveLength(1);
			expect(credential).toMatchObject({ accountId: "bootstrap-account", orgId: "bootstrap-org" });
			expect(credential).not.toHaveProperty("email");
			expect(credential).not.toHaveProperty("orgName");
		});

		it("only fills from the bootstrap endpoint what the token response left out", async () => {
			stubOAuthEndpoints({
				token: {
					...anonymousTokenResponse,
					account: { uuid: "token-account", email_address: "token@example.com" },
				},
				bootstrap: {
					body: {
						oauth_account: {
							account_uuid: "bootstrap-account",
							account_email: "bootstrap@example.com",
							organization_uuid: "bootstrap-org",
							organization_name: "Bootstrap Org",
						},
					},
				},
			});

			const credential = await loginWithCopiedCode();

			expect(credential).toMatchObject({
				accountId: "token-account",
				email: "token@example.com",
				orgId: "bootstrap-org",
				orgName: "Bootstrap Org",
			});
		});

		it.each([
			["an HTTP error", { status: 500, body: { error: "boom" } }],
			["a network error", "network-error" as const],
		])("still logs in without identity after %s from the bootstrap endpoint", async (_name, bootstrap) => {
			const { bootstrapCalls } = stubOAuthEndpoints({ bootstrap });

			const credential = await loginWithCopiedCode();

			expect(bootstrapCalls()).toHaveLength(1);
			expect(credential).toMatchObject({ type: "oauth", access: "access-token", refresh: "refresh-token" });
			for (const field of ["accountId", "email", "orgId", "orgName", "deviceId"]) {
				expect(credential).not.toHaveProperty(field);
			}
		});
	});

	describe("device id at login", () => {
		it("stores a 64 hex device id derived from the app installation id and the account", async () => {
			stubOAuthEndpoints({ token: identityTokenResponse });
			const getDeviceId = vi.fn(() => "install-1");

			const credential = await loginWithCopiedCode({ getDeviceId });

			expect(credential.deviceId).toMatch(/^[0-9a-f]{64}$/);
			expect(credential.deviceId).toBe(sha256Hex("omp-claude-device-id-v2\0install-1\0account-uuid"));
			expect(getDeviceId).toHaveBeenCalledOnce();
		});

		it("derives the device id from the account found through the bootstrap endpoint", async () => {
			stubOAuthEndpoints({ bootstrap: { body: { oauth_account: { account_uuid: "bootstrap-account" } } } });

			const credential = await loginWithCopiedCode({ getDeviceId: () => "install-1" });

			expect(credential.deviceId).toBe(sha256Hex("omp-claude-device-id-v2\0install-1\0bootstrap-account"));
		});

		it("derives the device id from the installation alone when no account is known", async () => {
			stubOAuthEndpoints();

			const credential = await loginWithCopiedCode({ getDeviceId: () => "install-1" });

			expect(credential.deviceId).toBe(sha256Hex("omp-claude-device-id-v1:install-1"));
		});

		it("gives each installation and account its own device id", async () => {
			stubOAuthEndpoints({ token: identityTokenResponse });

			const first = await loginWithCopiedCode({ getDeviceId: () => "install-1" });
			const second = await loginWithCopiedCode({ getDeviceId: () => "install-2" });
			const repeated = await loginWithCopiedCode({ getDeviceId: () => "install-1" });

			expect(second.deviceId).not.toBe(first.deviceId);
			expect(repeated.deviceId).toBe(first.deviceId);
		});

		it.each([
			["no getDeviceId", undefined],
			["an empty installation id", { getDeviceId: () => "" }],
		])("stores no device id with %s", async (_name, options) => {
			stubOAuthEndpoints({ token: identityTokenResponse });

			const credential = await loginWithCopiedCode(options);

			expect(credential).not.toHaveProperty("deviceId");
		});

		it("stores the device id for browser login as well", async () => {
			const login = await loginThroughBrowserCallback({ getDeviceId: () => "install-1" });

			expect(login.credential.deviceId).toBe(sha256Hex("omp-claude-device-id-v2\0install-1\0account-uuid"));
		});
	});

	describe("refresh", () => {
		const refreshResponse = {
			access_token: "new-access-token",
			refresh_token: "new-refresh-token",
			expires_in: 3600,
		};

		it("sends the Claude Code OAuth beta and SDK user agent", async () => {
			const { tokenCalls } = stubOAuthEndpoints({ token: refreshResponse });

			await anthropicOAuth.refresh(storedCredential({ accountId: "a", email: "e@example.com" }), neverAbortedSignal);

			const [call] = tokenCalls();
			expect(call?.url).toBe(tokenUrl);
			const headers = new Headers(call?.init?.headers);
			expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
			expect(headers.get("user-agent")).toBe("anthropic-sdk-typescript/0.128.0 userOAuthProvider");
			expect(headers.get("content-type")).toBe("application/json");
			expect(getJsonBody(call?.init)).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-token" });
		});

		it("keeps the organization and device id of the stored credential and ignores the organization in the response", async () => {
			const { bootstrapCalls } = stubOAuthEndpoints({
				token: {
					...refreshResponse,
					account: { uuid: "new-account", email_address: "new@example.com" },
					organization: { uuid: "other-org", name: "Other Org" },
				},
			});

			const credential = await anthropicOAuth.refresh(
				storedCredential({
					accountId: "stored-account",
					email: "stored@example.com",
					orgId: "stored-org",
					orgName: "Stored Org",
					deviceId: "stored-device",
					custom: "kept",
				}),
				neverAbortedSignal,
			);

			expect(credential).toMatchObject({
				type: "oauth",
				access: "new-access-token",
				refresh: "new-refresh-token",
				orgId: "stored-org",
				orgName: "Stored Org",
				deviceId: "stored-device",
				custom: "kept",
				// Account identity follows the token response; the organization does not.
				accountId: "new-account",
				email: "new@example.com",
			});
			expect(credential.expires).toBeGreaterThan(Date.now());
			expect(bootstrapCalls()).toHaveLength(0);
		});

		it("carries stored identity over when the response and the bootstrap endpoint have none", async () => {
			const { bootstrapCalls } = stubOAuthEndpoints({ token: refreshResponse });

			const credential = await anthropicOAuth.refresh(
				storedCredential({
					accountId: "stored-account",
					email: "stored@example.com",
					orgId: "stored-org",
					orgName: "Stored Org",
					deviceId: "stored-device",
				}),
				neverAbortedSignal,
			);

			expect(credential).toMatchObject({
				accountId: "stored-account",
				email: "stored@example.com",
				orgId: "stored-org",
				orgName: "Stored Org",
				deviceId: "stored-device",
			});
			// The hook runs on what the response carried, whatever the stored row holds.
			expect(bootstrapCalls()).toHaveLength(1);
		});

		it("fills missing account identity from the bootstrap endpoint but never touches the organization", async () => {
			const bootstrap = {
				body: {
					oauth_account: {
						account_uuid: "bootstrap-account",
						account_email: "bootstrap@example.com",
						organization_uuid: "bootstrap-org",
						organization_name: "Bootstrap Org",
					},
				},
			};
			stubOAuthEndpoints({ token: refreshResponse, bootstrap });

			const withOrg = await anthropicOAuth.refresh(
				storedCredential({ orgId: "stored-org", orgName: "Stored Org" }),
				neverAbortedSignal,
			);
			const withoutOrg = await anthropicOAuth.refresh(storedCredential(), neverAbortedSignal);

			expect(withOrg).toMatchObject({
				accountId: "bootstrap-account",
				email: "bootstrap@example.com",
				orgId: "stored-org",
				orgName: "Stored Org",
			});
			expect(withoutOrg).toMatchObject({ accountId: "bootstrap-account", email: "bootstrap@example.com" });
			expect(withoutOrg).not.toHaveProperty("orgId");
			expect(withoutOrg).not.toHaveProperty("orgName");
		});

		it("still refreshes when the bootstrap endpoint fails", async () => {
			stubOAuthEndpoints({ token: refreshResponse, bootstrap: "network-error" });

			const credential = await anthropicOAuth.refresh(storedCredential(), neverAbortedSignal);

			expect(credential).toMatchObject({ access: "new-access-token", refresh: "new-refresh-token" });
			expect(credential).not.toHaveProperty("accountId");
		});

		it("reports a rejected refresh with the token url", async () => {
			stubOAuthEndpoints({ tokenStatus: 400 });

			await expect(anthropicOAuth.refresh(storedCredential(), neverAbortedSignal)).rejects.toThrow(
				`Anthropic token refresh request failed. url=${tokenUrl}`,
			);
		});
	});

	describe("requests as oh-my-pi sends them", () => {
		interface Captured {
			authUrl: URL;
			exchange: { headers: Record<string, string>; keys: string[]; body: Record<string, string> };
		}

		/** Logs in by pasting the redirect URL and returns the authorize URL and the token exchange request. */
		async function captureLogin(method: "browser" | "copy_code", paste: (authUrl: URL) => string): Promise<Captured> {
			let authUrl = new URL("https://placeholder.invalid/");
			const { tokenCalls } = stubOAuthEndpoints({ token: identityTokenResponse });
			await anthropicOAuth.login({
				signal: neverAbortedSignal,
				notify: (event) => {
					if (event.type === "auth_url") authUrl = new URL(event.url);
				},
				prompt: async (prompt) => {
					if (prompt.type === "select") return method;
					if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
					return paste(authUrl);
				},
			});
			const init = tokenCalls()[0]?.init;
			const headers = Object.fromEntries(
				Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name, value]),
			);
			const body = getJsonBody(init);
			return { authUrl, exchange: { headers, keys: Object.keys(body), body } };
		}

		const pasteRedirect = (authUrl: URL): string =>
			`${authUrl.searchParams.get("redirect_uri")}?code=the-code&state=${authUrl.searchParams.get("state")}`;

		it("sends the authorize parameters in oh-my-pi's order, with code=true last", async () => {
			const { authUrl } = await captureLogin("browser", pasteRedirect);

			expect(`${authUrl.origin}${authUrl.pathname}`).toBe("https://claude.ai/oauth/authorize");
			expect([...authUrl.searchParams.keys()]).toEqual([
				"client_id",
				"response_type",
				"redirect_uri",
				"scope",
				"code_challenge",
				"code_challenge_method",
				"state",
				"code",
			]);
			expect(authUrl.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
			expect(authUrl.searchParams.get("response_type")).toBe("code");
			expect(authUrl.searchParams.get("scope")).toBe(
				"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
			);
			expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
			expect(authUrl.searchParams.get("code")).toBe("true");
		});

		it("uses a random hex state of its own and a 128 character PKCE verifier", async () => {
			const first = await captureLogin("browser", pasteRedirect);
			const second = await captureLogin("browser", pasteRedirect);

			const state = first.authUrl.searchParams.get("state") ?? "";
			const verifier = first.exchange.body.code_verifier;
			expect(state).toMatch(/^[0-9a-f]{32}$/);
			expect(state).not.toBe(second.authUrl.searchParams.get("state"));
			expect(verifier).toMatch(/^[A-Za-z0-9_-]{128}$/);
			expect(state).not.toBe(verifier);
			expect(first.authUrl.searchParams.get("code_challenge")).toBe(
				createHash("sha256").update(verifier).digest("base64url"),
			);
		});

		it("sends the token exchange in oh-my-pi's key order with only a JSON content type", async () => {
			const { authUrl, exchange } = await captureLogin("browser", pasteRedirect);

			expect(exchange.keys).toEqual(["grant_type", "client_id", "code", "redirect_uri", "code_verifier", "state"]);
			expect(exchange.body).toMatchObject({
				grant_type: "authorization_code",
				client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
				code: "the-code",
				redirect_uri: authUrl.searchParams.get("redirect_uri"),
				state: authUrl.searchParams.get("state"),
			});
			expect(exchange.headers).toEqual({ "Content-Type": "application/json" });
		});

		it("uses Claude Code's manual redirect for the copy code flow, and the loopback one for the browser flow", async () => {
			const copy = await captureLogin("copy_code", (authUrl) => `the-code#${authUrl.searchParams.get("state")}`);
			const browser = await captureLogin("browser", pasteRedirect);

			expect(copy.authUrl.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
			expect(copy.exchange.body.redirect_uri).toBe("https://platform.claude.com/oauth/code/callback");
			expect(new URL(browser.authUrl.searchParams.get("redirect_uri") ?? "").pathname).toBe("/callback");
		});

		it("exchanges a pasted bare code with the state it asked for", async () => {
			const bare = await captureLogin("browser", () => "just-a-code");

			expect(bare.exchange.body.code).toBe("just-a-code");
			expect(bare.exchange.body.state).toBe(bare.authUrl.searchParams.get("state"));
		});

		describe("a pasted input of another login", () => {
			/** Pastes each of `answers` in turn (a function of the authorize URL), and reports every manual prompt. */
			async function loginWithAnswers(method: "browser" | "copy_code", answers: Array<(authUrl: URL) => string>) {
				let authUrl = new URL("https://placeholder.invalid/");
				const { tokenCalls } = stubOAuthEndpoints({ token: identityTokenResponse });
				const prompts: Array<{ type: string; signal?: AbortSignal }> = [];
				const credential = await anthropicOAuth.login({
					signal: neverAbortedSignal,
					notify: (event) => {
						if (event.type === "auth_url") authUrl = new URL(event.url);
					},
					prompt: async (prompt) => {
						prompts.push(prompt);
						if (prompt.type === "select") return method;
						const answer = answers[prompts.filter((entry) => entry.type === "manual_code").length - 1];
						if (!answer) throw new Error("No more pasted answers");
						return answer(authUrl);
					},
				});
				return {
					credential,
					manualPrompts: prompts.filter((prompt) => prompt.type === "manual_code"),
					exchanges: tokenCalls().map((call) => getJsonBody(call.init)),
					authUrl,
				};
			}

			const foreignRedirect = (authUrl: URL): string =>
				`${authUrl.searchParams.get("redirect_uri")}?code=foreign-code&state=not-our-state`;

			it.each(["browser", "copy_code"] as const)("asks again instead of failing in the %s flow", async (method) => {
				const login = await loginWithAnswers(method, [
					() => "foreign-code#not-our-state",
					foreignRedirect,
					(authUrl) => `the-code#${authUrl.searchParams.get("state")}`,
				]);

				expect(login.credential.access).toBe("access-token");
				expect(login.manualPrompts).toHaveLength(3);
				expect(login.exchanges).toHaveLength(1);
				expect(login.exchanges[0]).toMatchObject({
					code: "the-code",
					state: login.authUrl.searchParams.get("state"),
				});
			});

			it("takes a pasted redirect URL that carries this login's state at once", async () => {
				const login = await loginWithAnswers("browser", [pasteRedirect]);

				expect(login.manualPrompts).toHaveLength(1);
				expect(login.exchanges[0]).toMatchObject({ code: "the-code" });
			});

			it("keeps the browser callback live while it asks again, and ends the prompt when the login settles", async () => {
				stubOAuthEndpoints({ token: identityTokenResponse });
				let authUrl = new URL("https://placeholder.invalid/");
				let manualPrompts = 0;
				let lastPromptSignal: AbortSignal | undefined;
				const callbackReached = Promise.withResolvers<void>();

				const credential = await anthropicOAuth.login({
					signal: neverAbortedSignal,
					notify: (event) => {
						if (event.type === "auth_url") authUrl = new URL(event.url);
					},
					prompt: async (prompt) => {
						if (prompt.type === "select") return "browser";
						manualPrompts++;
						lastPromptSignal = prompt.signal;
						if (manualPrompts === 1) return "foreign-code#not-our-state";
						// The second prompt is still open: the browser completes the login through the callback server.
						const callbackUrl = new URL(authUrl.searchParams.get("redirect_uri") ?? "");
						callbackUrl.hostname = "127.0.0.1";
						callbackUrl.search = new URLSearchParams({
							code: "browser-code",
							state: authUrl.searchParams.get("state") ?? "",
						}).toString();
						void nativeFetch(callbackUrl).then(() => callbackReached.resolve());
						return new Promise<string>((_, reject) => {
							prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						});
					},
				});
				await callbackReached.promise;

				expect(credential.access).toBe("access-token");
				expect(manualPrompts).toBe(2);
				expect(lastPromptSignal?.aborted).toBe(true);
			});
		});

		it("sends the refresh headers in oh-my-pi's order, without an Accept header", async () => {
			const { tokenCalls } = stubOAuthEndpoints({
				token: { access_token: "a", refresh_token: "r", expires_in: 60 },
			});

			await anthropicOAuth.refresh(storedCredential({ accountId: "a", email: "e@example.com" }), neverAbortedSignal);

			const init = tokenCalls()[0]?.init;
			expect(Object.keys((init?.headers ?? {}) as Record<string, string>)).toEqual([
				"anthropic-beta",
				"User-Agent",
				"Content-Type",
			]);
			expect(Object.keys(getJsonBody(init))).toEqual(["grant_type", "client_id", "refresh_token"]);
		});

		it("treats a token as expired five minutes before its stated expiry", async () => {
			stubOAuthEndpoints({ token: { access_token: "a", refresh_token: "r", expires_in: 3600 } });
			const before = Date.now();

			const credential = await anthropicOAuth.refresh(
				storedCredential({ accountId: "a", email: "e@example.com" }),
				neverAbortedSignal,
			);

			expect(credential.expires).toBeGreaterThanOrEqual(before + 3_600_000 - 300_000);
			expect(credential.expires).toBeLessThanOrEqual(Date.now() + 3_600_000 - 300_000);
		});

		it("keeps the stored refresh token when the response does not rotate it", async () => {
			stubOAuthEndpoints({ token: { access_token: "new-access", expires_in: 3600 } });

			const credential = await anthropicOAuth.refresh(
				storedCredential({ accountId: "a", email: "e@example.com", refresh: "stored-refresh" }),
				neverAbortedSignal,
			);

			expect(credential.refresh).toBe("stored-refresh");
			expect(credential.access).toBe("new-access");
		});

		it("refuses a token response without an access token or a lifetime", async () => {
			stubOAuthEndpoints({ token: { refresh_token: "r", expires_in: 3600 } });
			await expect(anthropicOAuth.refresh(storedCredential(), neverAbortedSignal)).rejects.toThrow(
				"missing access token",
			);

			stubOAuthEndpoints({ token: { access_token: "a", refresh_token: "r" } });
			await expect(anthropicOAuth.refresh(storedCredential(), neverAbortedSignal)).rejects.toThrow(
				"missing expires_in",
			);
		});

		it("asks the bootstrap endpoint after a refresh only for what the response left out, with Claude Code's headers", async () => {
			const { bootstrapCalls } = stubOAuthEndpoints({
				token: { access_token: "a", refresh_token: "r", expires_in: 3600, account: { uuid: "acct-1" } },
				bootstrap: { body: { oauth_account: { account_uuid: "other", account_email: "found@example.com" } } },
			});

			const credential = await anthropicOAuth.refresh(
				storedCredential({ email: "stored@example.com" }),
				neverAbortedSignal,
			);

			expect(bootstrapCalls()).toHaveLength(1);
			const call = bootstrapCalls()[0];
			expect(call?.url).toBe(`${bootstrapUrl}?entrypoint=cli&model=claude-opus-4-8`);
			expect(Object.keys((call?.init?.headers ?? {}) as Record<string, string>)).toEqual([
				"Accept",
				"Authorization",
				"Content-Type",
				"User-Agent",
				"anthropic-beta",
			]);
			expect(new Headers(call?.init?.headers).get("user-agent")).toMatch(/^claude-code\/\d+\.\d+\.\d+$/);
			// The response's account wins; the email the response lacked comes from the bootstrap, ahead of the stored one.
			expect(credential).toMatchObject({ accountId: "acct-1", email: "found@example.com" });
		});
	});

	describe("request auth and env", () => {
		it("uses the access token as the api key", async () => {
			expect(await anthropicOAuth.toAuth(storedCredential({ access: "access-token" }))).toEqual({
				apiKey: "access-token",
			});
		});

		it("derives the account uuid and device id env from the credential", async () => {
			expect(
				await anthropicOAuth.toEnv?.(storedCredential({ accountId: "account-uuid", deviceId: "device-id" })),
			).toEqual({
				ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-uuid",
				ANTHROPIC_OAUTH_DEVICE_ID: "device-id",
			});
		});

		it.each([
			["only the account", { accountId: "account-uuid" }, { ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-uuid" }],
			["only the device", { deviceId: "device-id" }, { ANTHROPIC_OAUTH_DEVICE_ID: "device-id" }],
			["neither", { orgId: "org-uuid", email: "user@example.com" }, {}],
			["non-string values", { accountId: 123, deviceId: { id: "device-id" } }, {}],
		])("derives env from %s", async (_name, extra, expected) => {
			expect(await anthropicOAuth.toEnv?.(storedCredential(extra))).toEqual(expected);
		});

		it("merges the credential env into the resolved request auth", async () => {
			const credential = storedCredential({
				access: "stored-access",
				expires: Date.now() + 60 * 60 * 1000,
				accountId: "account-uuid",
				deviceId: "device-id",
			});

			const result = await resolveProviderAuth(
				{ id: "anthropic", auth: { oauth: anthropicOAuth } },
				memoryStore(credential),
				emptyAuthContext,
			);

			expect(result).toEqual({
				auth: { apiKey: "stored-access" },
				env: { ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-uuid", ANTHROPIC_OAUTH_DEVICE_ID: "device-id" },
				source: "OAuth",
			});
		});

		it("resolves request auth without env when the credential has no identity", async () => {
			const credential = storedCredential({ access: "stored-access", expires: Date.now() + 60 * 60 * 1000 });

			const result = await resolveProviderAuth(
				{ id: "anthropic", auth: { oauth: anthropicOAuth } },
				memoryStore(credential),
				emptyAuthContext,
			);

			expect(result).toEqual({ auth: { apiKey: "stored-access" }, env: {}, source: "OAuth" });
		});

		it("forwards toEnv through a lazily loaded OAuth auth", async () => {
			const lazy = lazyOAuth({ name: "Anthropic", load: async () => anthropicOAuth });

			expect(await lazy.toEnv?.(storedCredential({ accountId: "account-uuid" }))).toEqual({
				ANTHROPIC_OAUTH_ACCOUNT_UUID: "account-uuid",
			});
		});
	});
});

const emptyAuthContext: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};

function memoryStore(credential: Credential): CredentialStore {
	return {
		read: async () => credential,
		list: async () => [{ providerId: "anthropic", type: credential.type }],
		modify: async (_providerId, fn) => fn(credential),
		delete: async () => {},
	};
}

function listen(server: Server, port: number, host: string = "127.0.0.1"): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function loginThroughBrowserCallback(options?: LoginOptions) {
	let exchangedCode: string | undefined;
	let exchangedRedirectUri: string | undefined;
	stubOAuthEndpoints({
		token: (body) => {
			exchangedCode = body.code;
			exchangedRedirectUri = body.redirect_uri;
			return { ...identityTokenResponse, access_token: "access", refresh_token: "refresh" };
		},
	});

	let redirectUri = "";
	let callbackPage: Promise<Response> | undefined;
	const credential = await anthropicOAuth.login(
		{
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const params = new URL(event.url).searchParams;
				redirectUri = params.get("redirect_uri") ?? "";
				const callbackUrl = new URL(redirectUri);
				callbackUrl.hostname = "127.0.0.1";
				callbackUrl.search = new URLSearchParams({
					code: "browser-code",
					state: params.get("state") ?? "",
				}).toString();
				// The local callback server is the only thing reached with the real fetch.
				callbackPage = nativeFetch(callbackUrl);
			},
			prompt: (prompt) =>
				prompt.type === "select"
					? Promise.resolve("browser")
					: new Promise((_, reject) => {
							prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						}),
		},
		options,
	);
	const page = await callbackPage;
	return {
		credential,
		redirectUri,
		exchangedCode,
		exchangedRedirectUri,
		pageStatus: page?.status,
		pageText: await page?.text(),
	};
}
