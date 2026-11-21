import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
	type AssistantMessage,
	createModels,
	type FetchFunction,
	type LoginOptions,
	type Model,
	type OAuthAuth,
	type OAuthCredential,
	PROVIDER_HTTP_ERROR_DIAGNOSTIC_TYPE,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type * as AnthropicProviderModule from "@earendil-works/pi-ai/providers/anthropic";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { createVirtualModel, type ModelRouteRequest } from "../src/core/virtual-models.ts";
import {
	buildCatalog,
	isBrokerProvider,
	isLocalClaudeProvider,
	isVirtualPoolProvider,
} from "../src/extensions/accounts/catalog.ts";
import { importBrokerClaudeAccounts } from "../src/extensions/accounts/claude-import.ts";
import {
	ClaudeLimits,
	type ClaudeWindow,
	claudeModelKind,
	defaultBlockMs,
	fiveHourMs,
	sevenDayMs,
	usageFailureBackoffMs,
	usageLimitFailure,
	usageTtlMs,
	windowsFromHeaders,
} from "../src/extensions/accounts/claude-limits.ts";
import { LocalClaude, listLocalClaudeAccounts } from "../src/extensions/accounts/claude-local.ts";
import {
	type PoolRouting,
	poolMembers,
	routePool,
	virtualModelDefinitions,
	virtualPoolSpecs,
} from "../src/extensions/accounts/claude-pool.ts";
import { rankByUsage } from "../src/extensions/accounts/claude-rank.ts";
import { claudeAccountId, LocalClaudeStore } from "../src/extensions/accounts/claude-store.ts";
import {
	claudeProfilePlan,
	fetchClaudePlan,
	fetchClaudeUsage,
	fetchClaudeUsageReport,
	parseClaudeUsage,
} from "../src/extensions/accounts/claude-usage.ts";
import type { BrokerAccount, BrokerClient } from "../src/extensions/accounts/client.ts";
import { sessionAccountCosts } from "../src/extensions/accounts/costs.ts";
import accountsExtension from "../src/extensions/accounts/index.ts";
import {
	type AccountProviderSpec,
	type BrokerProviderSpec,
	providerSpecs,
} from "../src/extensions/accounts/provider.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

// Sign-in opens the browser; the tests only record the URL.
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

// The extension signs in with Anthropic's OAuth flow, which needs a browser and the network. Tests that use the
// command script it here; every other part of the provider stays the real one.
const scriptedLogin = vi.hoisted(() => ({
	run: undefined as
		| ((interaction: ProviderAuthInteraction, options?: LoginOptions) => Promise<OAuthCredential>)
		| undefined,
}));
vi.mock("@earendil-works/pi-ai/providers/anthropic", async (importOriginal) => {
	const original = await importOriginal<typeof AnthropicProviderModule>();
	return {
		...original,
		anthropicProvider: () => {
			const provider = original.anthropicProvider();
			const oauth = provider.auth.oauth!;
			return {
				...provider,
				auth: {
					...provider.auth,
					oauth: {
						...oauth,
						login: (...args: Parameters<OAuthAuth["login"]>) => (scriptedLogin.run ?? oauth.login)(...args),
					},
				},
			};
		},
	};
});

// Fake tokens only. No test sends a request to a real server.
const accessToken = "sk-ant-oat01-fake-access-token";
const refreshToken = "sk-ant-ort01-fake-refresh-token";

const directories: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-local-"));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
	scriptedLogin.run = undefined;
	vi.unstubAllEnvs();
	vi.mocked(openBrowser).mockClear();
});

function credential(overrides: Record<string, unknown> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + 3_600_000,
		accountId: "account-uuid-1",
		orgId: "org-uuid-1",
		orgName: "Example Org",
		email: "neil@example.com",
		deviceId: "device-1",
		...overrides,
	};
}

/** An OAuth flow whose refresh rotates the tokens and counts its calls; login replays a scripted credential. */
function fakeOAuth(login?: OAuthAuth["login"]): OAuthAuth & { refreshes: number } {
	const oauth = {
		refreshes: 0,
		name: "Fake Claude",
		isSubscription: true,
		login: login ?? (async () => credential()),
		async refresh(stored: OAuthCredential) {
			oauth.refreshes++;
			return {
				...stored,
				access: "sk-ant-oat01-refreshed",
				refresh: "refresh-rotated",
				expires: Date.now() + 3_600_000,
			};
		},
		async toAuth(stored: OAuthCredential) {
			return { apiKey: stored.access };
		},
		async toEnv(stored: OAuthCredential) {
			return typeof stored.accountId === "string" ? { CLAUDE_ACCOUNT_UUID: stored.accountId } : undefined;
		},
	};
	return oauth;
}

const signal = new AbortController().signal;

function assistantMessage(provider: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider,
		model: "opus",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...extra,
	};
}

const assistantReply = (provider: string) => assistantMessage(provider);

function errorMessageOf(provider: string, errorMessage: string | undefined): AssistantMessage {
	return assistantMessage(provider, { stopReason: "error", errorMessage });
}

describe("local Claude account store", () => {
	it("stores each account under claude-sub:<id> in the accounts home and lists it without secrets", async () => {
		const home = tempDir();
		const store = new LocalClaudeStore(home);
		expect(store.list()).toEqual([]);

		const { account, added } = await store.save(credential());
		expect(added).toBe(true);
		expect(account.id).toMatch(/^[0-9a-f]{8}-neil$/);
		expect(account).toMatchObject({
			providerId: `claude-sub:${account.id}`,
			email: "neil@example.com",
			orgName: "Example Org",
			name: "Claude · neil@example.com (subscription)",
			disabled: false,
		});
		expect(JSON.stringify(store.list())).not.toContain(accessToken);
		expect(Object.keys(JSON.parse(readFileSync(join(home, "claude-subscriptions.json"), "utf8")))).toEqual([
			account.providerId,
		]);
		expect(listLocalClaudeAccounts(home)).toEqual([account]);
	});

	it("derives the id from account and organization so one login in two organizations is two accounts", async () => {
		expect(claudeAccountId({ accountId: "a", orgId: "o1", email: "N.User+tag@example.com" })).toMatch(
			/^[0-9a-f]{8}-n\.usertag$/,
		);
		expect(claudeAccountId({ accountId: "a", orgId: "o1" })).not.toBe(
			claudeAccountId({ accountId: "a", orgId: "o2" }),
		);
		expect(claudeAccountId({ accountId: "a", orgId: "o1" })).toMatch(/^[0-9a-f]{8}$/);

		const store = new LocalClaudeStore(tempDir());
		await store.save(credential());
		await store.save(credential({ orgId: "org-uuid-2" }));
		expect(store.list()).toHaveLength(2);
	});

	it("signing in again to a known account replaces its tokens and keeps it disabled", async () => {
		const store = new LocalClaudeStore(tempDir());
		const { account } = await store.save(credential());
		await store.setDisabled(account.providerId, true);

		const again = await store.save(credential({ access: "sk-ant-oat01-newer", refresh: "newer-refresh" }));
		expect(again).toMatchObject({ added: false, account: { providerId: account.providerId, disabled: true } });
		expect(store.list()).toHaveLength(1);
		expect(await store.credentials.read(account.providerId)).toMatchObject({
			access: "sk-ant-oat01-newer",
			refresh: "newer-refresh",
			disabled: true,
		});
	});

	it("enables, disables and removes accounts", async () => {
		const store = new LocalClaudeStore(tempDir());
		const { account } = await store.save(credential());
		await store.setDisabled(account.providerId, true);
		expect(store.get(account.providerId)?.disabled).toBe(true);
		await store.setDisabled(account.providerId, false);
		expect(store.get(account.providerId)?.disabled).toBe(false);
		await store.remove(account.providerId);
		expect(store.list()).toEqual([]);
	});

	it("derives device ids from the app's installation id, or keeps one in the accounts home", () => {
		const home = tempDir();
		const store = new LocalClaudeStore(home);
		expect(store.installationId("install-1")).toBe("install-1");
		expect(listLocalClaudeAccounts(home)).toEqual([]);

		// Without an app id one is created once, so signing in again to an account keeps its device id.
		const created = store.installationId(undefined);
		expect(created).toMatch(/^[0-9a-f-]{36}$/);
		expect(readFileSync(join(home, "installation-id"), "utf8").trim()).toBe(created);
		expect(store.installationId(undefined)).toBe(created);
		expect(new LocalClaudeStore(home).installationId(undefined)).toBe(created);
	});

	it("tells local providers and virtual pools from the physical providers of the broker", () => {
		expect(isLocalClaudeProvider("claude-sub:1a2b3c4d-neil")).toBe(true);
		expect(isLocalClaudeProvider("acct:claude-api-x")).toBe(false);
		expect(isVirtualPoolProvider("pool:claude")).toBe(true);
		expect(isVirtualPoolProvider("pool:all")).toBe(true);
		expect(isVirtualPoolProvider("pool:codex")).toBe(false);
		expect(isVirtualPoolProvider("claude-sub:1a2b3c4d")).toBe(false);
		// Only the broker understands its own cache option: pinned broker accounts and broker pools, not local routes.
		expect(["acct:claude-api-x", "pool:codex"].map(isBrokerProvider)).toEqual([true, true]);
		expect(["claude-sub:1a2b3c4d", "pool:claude", "pool:all", "anthropic"].map(isBrokerProvider)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});
});

describe("import from the broker", () => {
	const brokerFile = {
		type: "claude",
		access_token: "sk-ant-oat01-broker-access",
		refresh_token: "sk-ant-ort01-broker-refresh",
		id_token: "ignored",
		expired: "2030-01-01T00:00:00Z",
		last_refresh: "2026-11-01T00:00:00Z",
		email: "neil@example.com",
		account_uuid: "account-uuid-1",
		organization_uuid: "org-uuid-1",
		organization_name: "Example Org",
		claude_device_ids: ["device-from-broker", "device-2"],
		disabled: true,
	};

	function brokerHome(files: Record<string, unknown>): string {
		const home = tempDir();
		mkdirSync(join(home, "auths"), { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(home, "auths", name), typeof content === "string" ? content : JSON.stringify(content));
		}
		return home;
	}

	function runningBroker(removeAccount: (key: string) => Promise<void> = async () => {}) {
		return {
			connectExisting: vi.fn(async () => ({ url: "http://127.0.0.1:1", token: "t", pid: 1 })),
			removeAccount: vi.fn(removeAccount),
		};
	}

	it("converts the broker file, carries disabled over and removes the broker copy through the broker API", async () => {
		const home = brokerHome({ "claude-aaaa-neil@example.com.json": brokerFile });
		const store = new LocalClaudeStore(home);
		const broker = runningBroker();

		expect(await importBrokerClaudeAccounts(store, broker as unknown as BrokerClient)).toBe(1);

		const [account] = store.list();
		expect(account).toMatchObject({ email: "neil@example.com", orgId: "org-uuid-1", disabled: true });
		expect(await store.credentials.read(account!.providerId)).toEqual({
			type: "oauth",
			access: "sk-ant-oat01-broker-access",
			refresh: "sk-ant-ort01-broker-refresh",
			expires: Date.parse("2030-01-01T00:00:00Z"),
			accountId: "account-uuid-1",
			orgId: "org-uuid-1",
			orgName: "Example Org",
			email: "neil@example.com",
			deviceId: "device-from-broker",
			disabled: true,
		});
		// The broker key is the base64url of the file name, written only after the local write succeeded.
		expect(broker.removeAccount).toHaveBeenCalledExactlyOnceWith(
			Buffer.from("claude-aaaa-neil@example.com.json").toString("base64url"),
		);
	});

	it("is idempotent: a second run keeps the local tokens and retries the removal", async () => {
		const home = brokerHome({ "claude-a.json": brokerFile });
		const store = new LocalClaudeStore(home);
		const failing = runningBroker(async () => {
			throw new Error("broker busy");
		});
		// A failed removal is not counted, and the credential is stored anyway.
		expect(await importBrokerClaudeAccounts(store, failing as unknown as BrokerClient)).toBe(0);
		const [account] = store.list();
		expect(account).toBeDefined();

		// The local tokens rotate meanwhile; the next import must not bring the broker's older tokens back.
		await store.credentials.modify(account!.providerId, async (current) =>
			current?.type === "oauth" ? { ...current, access: "sk-ant-oat01-rotated" } : undefined,
		);
		const broker = runningBroker();
		expect(await importBrokerClaudeAccounts(store, broker as unknown as BrokerClient)).toBe(1);
		expect(store.list()).toHaveLength(1);
		expect(await store.credentials.read(account!.providerId)).toMatchObject({ access: "sk-ant-oat01-rotated" });
		expect(broker.removeAccount).toHaveBeenCalledTimes(1);
	});

	it("deletes the file itself when no broker is running, and leaves other files alone", async () => {
		const home = brokerHome({
			"claude-a.json": { ...brokerFile, expired: "not a date" },
			"claude-broken.json": "{ not json",
			"claude-notokens.json": { type: "claude", email: "x@example.com" },
			"claude-other.json": { type: "codex", access_token: "x", refresh_token: "y" },
			"codex-a.json": { type: "codex", access_token: "x", refresh_token: "y" },
		});
		const store = new LocalClaudeStore(home);
		const broker = { connectExisting: vi.fn(async () => undefined), removeAccount: vi.fn() };

		expect(await importBrokerClaudeAccounts(store, broker as unknown as BrokerClient)).toBe(1);

		expect(broker.removeAccount).not.toHaveBeenCalled();
		const [account] = store.list();
		// An unreadable expiry counts as expired, so the first request refreshes the token.
		expect(await store.credentials.read(account!.providerId)).toMatchObject({ expires: 0 });
		const remaining = ["claude-broken.json", "claude-notokens.json", "claude-other.json", "codex-a.json"];
		for (const name of remaining) expect(() => readFileSync(join(home, "auths", name))).not.toThrow();
		expect(() => readFileSync(join(home, "auths", "claude-a.json"))).toThrow();
	});

	it("does nothing without a broker auths directory", async () => {
		const store = new LocalClaudeStore(tempDir());
		const broker = runningBroker();
		expect(await importBrokerClaudeAccounts(store, broker as unknown as BrokerClient)).toBe(0);
		expect(broker.connectExisting).not.toHaveBeenCalled();
		expect(store.list()).toEqual([]);
	});
});

describe("local Claude provider", () => {
	async function signedIn(
		options: { oauth?: ReturnType<typeof fakeOAuth>; fetch?: FetchFunction; stored?: Record<string, unknown> } = {},
	) {
		const oauth = options.oauth ?? fakeOAuth();
		const local = new LocalClaude({ home: tempDir(), oauth, fetch: options.fetch });
		const { account } = await local.store.save(credential(options.stored));
		return { local, oauth, account, spec: local.spec(account) };
	}

	it("lists the built-in Anthropic models under its own provider id and endpoint", async () => {
		const { local, spec, account } = await signedIn();
		const provider = local.createProvider(spec);
		expect(provider.id).toBe(`claude-sub:${account.id}`);
		expect(provider.baseUrl).toBe("https://api.anthropic.com");
		const models = provider.getModels();
		expect(models.length).toBeGreaterThan(5);
		expect(models.every((model) => model.provider === provider.id && model.api === "anthropic-messages")).toBe(true);
		// Pi prices a refusal fallback by provider and model, so the fallbacks name the account's provider too.
		const withFallbacks = models.filter((model) => model.compat && "allowedFallbackModels" in model.compat);
		const fallbacks = withFallbacks.flatMap(
			(model) => (model.compat as { allowedFallbackModels?: { provider: string }[] }).allowedFallbackModels ?? [],
		);
		expect(fallbacks.every((fallback) => fallback.provider === provider.id)).toBe(true);
	});

	it("check() reports a subscription for an enabled account and nothing for a disabled or removed one", async () => {
		const { local, spec, account } = await signedIn();
		const check = () => local.createProvider(spec).auth.apiKey!.check!({ ctx: undefined as never, signal });
		expect(await check()).toEqual({ type: "oauth", source: "Claude subscription" });
		await local.store.setDisabled(account.providerId, true);
		expect(await check()).toBeUndefined();
		await local.store.remove(account.providerId);
		expect(await check()).toBeUndefined();
	});

	it("declares a subscription OAuth method whose login points to /accounts", async () => {
		const { local, spec } = await signedIn();
		const oauth = local.createProvider(spec).auth.oauth!;
		expect(oauth.isSubscription).toBe(true);
		await expect(oauth.login({ signal, prompt: async () => "", notify: () => {} })).rejects.toThrow(
			"/accounts add claude-subscription",
		);
	});

	it("resolve() returns the stored token and the account's identity env without refreshing a fresh token", async () => {
		const { local, oauth, spec } = await signedIn();
		const auth = await local.createProvider(spec).auth.apiKey!.resolve({ ctx: undefined as never, signal });
		expect(auth).toEqual({
			auth: { apiKey: accessToken },
			env: { CLAUDE_ACCOUNT_UUID: "account-uuid-1" },
			source: "OAuth",
		});
		expect(oauth.refreshes).toBe(0);
	});

	it("resolve() refreshes a token that expires within five minutes once and persists the rotated tokens", async () => {
		const { local, oauth, spec, account } = await signedIn({ stored: { expires: Date.now() + 60_000 } });
		const provider = local.createProvider(spec);
		const resolve = () => provider.auth.apiKey!.resolve({ ctx: undefined as never, signal });

		expect((await resolve())?.auth).toEqual({ apiKey: "sk-ant-oat01-refreshed" });
		expect(await local.store.credentials.read(account.providerId)).toMatchObject({
			access: "sk-ant-oat01-refreshed",
			refresh: "refresh-rotated",
		});
		expect((await resolve())?.auth).toEqual({ apiKey: "sk-ant-oat01-refreshed" });
		expect(oauth.refreshes).toBe(1);
	});

	it("resolve() has nothing for a disabled or removed account", async () => {
		const { local, spec, account } = await signedIn();
		const provider = local.createProvider(spec);
		await local.store.setDisabled(account.providerId, true);
		expect(await provider.auth.apiKey!.resolve({ ctx: undefined as never, signal })).toBeUndefined();
		await local.store.remove(account.providerId);
		expect(await provider.auth.apiKey!.resolve({ ctx: undefined as never, signal })).toBeUndefined();
	});

	function sseResponse(headers: Record<string, string>): Response {
		const events: [string, unknown][] = [
			[
				"message_start",
				{
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "claude-test",
						content: [],
						stop_reason: null,
						usage: { input_tokens: 3, output_tokens: 0 },
					},
				},
			],
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
			["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
			["message_stop", { type: "message_stop" }],
		];
		const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
	}

	it("sends requests to api.anthropic.com with the account's token and records its window utilization", async () => {
		// A plain key keeps this test on the adapter's standard request path; the account's own token is what matters here.
		const { local, spec } = await signedIn({ stored: { access: "fake-plain-token" } });
		const provider = local.createProvider(spec);
		const models = createModels();
		models.setProvider(provider);
		const resetSeconds = Math.floor(Date.now() / 1000) + 3600;
		const requests: { url: string; apiKey: string | null }[] = [];
		const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				url: String(input instanceof Request ? input.url : input),
				apiKey: new Headers(init?.headers).get("x-api-key"),
			});
			return sseResponse({
				"anthropic-ratelimit-unified-5h-utilization": "1",
				"anthropic-ratelimit-unified-5h-reset": String(resetSeconds),
				"anthropic-ratelimit-unified-7d-utilization": "0.25",
				"anthropic-ratelimit-unified-7d-reset": String(resetSeconds + 86_400),
			});
		});

		const model = provider.getModels()[0]!;
		const message = await models.completeSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ fetch: fetchStub as unknown as FetchFunction, maxRetries: 0 },
		);

		expect(message.stopReason).toBe("stop");
		expect(requests[0]?.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
		expect(requests[0]?.apiKey).toBe("fake-plain-token");
		// The 5-hour window is used up until its reset, so routing skips the account.
		expect(local.limits.blockedUntil(provider.id, "opus")).toBe(resetSeconds * 1000);
		expect(local.limits.windows(provider.id).map((entry) => [entry.id, entry.usedPercent])).toEqual([
			["5h", 100],
			["7d", 25],
		]);
		expect(local.state(local.accounts()[0]!)).toMatch(/^limit reached until /);
	});

	it("starts a cooldown when a request fails with a rate limit", async () => {
		const { local, spec } = await signedIn({ stored: { access: "fake-plain-token" } });
		const provider = local.createProvider(spec);
		const models = createModels();
		models.setProvider(provider);
		const fetchStub = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "This request would exceed your limit" },
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
		);

		const opus = provider.getModels().find((candidate) => candidate.id.includes("opus"))!;
		const message = await models.completeSimple(
			opus,
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ fetch: fetchStub as unknown as FetchFunction, maxRetries: 0 },
		);

		expect(message.stopReason).toBe("error");
		// A limit on a model without a cap of its own blocks the whole account, for a minute without a stated reset.
		expect(local.limits.blockedUntil(provider.id, "opus")).toBeGreaterThan(Date.now());
		expect(local.limits.blockedUntil(provider.id, "sonnet")).toBeGreaterThan(Date.now());
		expect(local.limits.blockedUntil(provider.id, "fable")).toBeGreaterThan(Date.now());
	});

	it("reads the rate-limit headers of a rejected request from the reply's HTTP error diagnostic", async () => {
		const { local } = await signedIn();
		const providerId = "claude-sub:test";
		const resetSeconds = Math.floor(Date.now() / 1000) + 7200;
		const reply = errorMessageOf(providerId, "429 rate limited");
		reply.diagnostics = [
			{
				type: PROVIDER_HTTP_ERROR_DIAGNOSTIC_TYPE,
				timestamp: Date.now(),
				error: { message: "429 rate limited" },
				details: {
					status: 429,
					headers: {
						"anthropic-ratelimit-unified-status": "rejected",
						"anthropic-ratelimit-unified-7d-utilization": "1",
						"anthropic-ratelimit-unified-7d-reset": String(resetSeconds),
					},
				},
			},
		];

		local.observer(providerId).result?.(reply);

		// The window says when the weekly limit resets, which outlasts the default block.
		expect(local.limits.blockedUntil(providerId, "opus")).toBe(resetSeconds * 1000);
		expect(local.limits.windows(providerId).map((entry) => entry.id)).toEqual(["7d"]);
		// A reply that did not fail reports nothing.
		local.observer("claude-sub:other").result?.(assistantReply("claude-sub:other"));
		expect(local.limits.blockedUntil("claude-sub:other", "opus")).toBeUndefined();
	});

	it("shows the usage of an account fetched with a refreshed token", async () => {
		const seen: string[] = [];
		const urls: string[] = [];
		const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(String(new Headers(init?.headers).get("authorization")));
			urls.push(String(input));
			if (String(input).endsWith("/profile")) {
				return Response.json({
					organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
				});
			}
			return Response.json({ five_hour: { utilization: 10, resets_at: "2026-11-20T15:00:00Z" } });
		});
		const { local, oauth, account } = await signedIn({
			fetch: fetchStub as unknown as FetchFunction,
			stored: { expires: Date.now() + 1_000 },
		});

		expect(await local.usage(account.providerId, signal)).toEqual({
			status: "available",
			windows: [{ label: "5-hour", usedPercent: 10, resetAt: "2026-11-20T15:00:00.000Z" }],
			credits: [],
		});
		expect(seen).toEqual(["Bearer sk-ant-oat01-refreshed", "Bearer sk-ant-oat01-refreshed"]);
		expect(urls.sort()).toEqual([
			"https://api.anthropic.com/api/oauth/profile",
			"https://api.anthropic.com/api/oauth/usage",
		]);
		expect(oauth.refreshes).toBe(1);
		// The windows rank the account in pools, and the plan from the profile names it.
		expect(local.limits.windows(account.providerId).map((entry) => entry.id)).toEqual(["5h"]);
		expect(local.store.get(account.providerId)?.plan).toBe("Max 5x");
		expect(local.store.get(account.providerId)?.name).toContain("Max 5x");

		await local.store.setDisabled(account.providerId, true);
		expect(await local.usage(account.providerId, signal)).toMatchObject({ status: "unavailable" });
		expect(seen).toHaveLength(2);
	});

	it("refreshUsage() records the windows for ranking, and a failed request keeps the endpoint quiet", async () => {
		let status = 200;
		const fetchStub = vi.fn(async () =>
			status === 200
				? Response.json({
						five_hour: { utilization: 40, resets_at: "2026-11-20T15:00:00Z" },
						seven_day: { utilization: 10 },
					})
				: new Response("limited", { status }),
		);
		const { local, account } = await signedIn({ fetch: fetchStub as unknown as FetchFunction });
		expect(local.limits.needsUsage(account.providerId)).toBe(true);

		await local.refreshUsage(account.providerId, signal);
		expect(local.limits.windows(account.providerId).map((entry) => [entry.id, entry.usedPercent])).toEqual([
			["5h", 40],
			["7d", 10],
		]);
		expect(local.limits.needsUsage(account.providerId)).toBe(false);

		const other = await local.store.save(
			credential({ accountId: "account-uuid-2", orgId: "org-2", email: "b@example.com" }),
		);
		status = 429;
		await local.refreshUsage(other.account.providerId, signal);
		expect(local.limits.windows(other.account.providerId)).toEqual([]);
		expect(local.limits.needsUsage(other.account.providerId)).toBe(false);
		// Nothing for an account that is signed out, and nothing thrown.
		await local.refreshUsage("claude-sub:gone", signal);
	});
});

describe("Claude usage", () => {
	const fetchOf = (response: () => Response) =>
		vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response()) as unknown as FetchFunction & {
			mock: { calls: [string | URL | Request, RequestInit | undefined][] };
		};

	it("requests the OAuth usage endpoint with Claude Code's headers", async () => {
		const fetchStub = fetchOf(() => Response.json({ five_hour: { utilization: 1 } }));
		await fetchClaudeUsage("sk-ant-oat01-token", { fetch: fetchStub, signal });

		const [url, init] = fetchStub.mock.calls[0]!;
		expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
		const headers = new Headers(init?.headers);
		expect(Object.fromEntries(headers)).toEqual({
			accept: "application/json, text/plain, */*",
			"accept-encoding": "gzip, deflate, br, zstd",
			"anthropic-beta":
				"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
			authorization: "Bearer sk-ant-oat01-token",
			connection: "keep-alive",
			"content-type": "application/json",
			"user-agent": expect.stringMatching(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/),
		});
		expect(init?.signal).toBe(signal);
	});

	it("maps the five-hour, seven-day and per-model windows and the extra-usage credits", () => {
		expect(
			parseClaudeUsage({
				five_hour: { utilization: 23.5, resets_at: "2026-11-20T15:00:00.000000+00:00" },
				seven_day: { utilization: 61, resets_at: "2026-11-24T09:30:00Z" },
				seven_day_sonnet: { utilization: 12, resets_at: "2026-11-24T09:30:00Z" },
				seven_day_opus: null,
				seven_day_fable: { utilization: 150, resets_at: "not a date" },
				extra_usage: {
					is_enabled: true,
					monthly_limit: 5000,
					used_credits: 1234,
					decimal_places: 2,
					currency: "USD",
				},
				unrelated: { secret: "never forwarded" },
			}),
		).toEqual({
			status: "available",
			windows: [
				{ label: "5-hour", usedPercent: 23.5, resetAt: "2026-11-20T15:00:00.000Z" },
				{ label: "7-day", usedPercent: 61, resetAt: "2026-11-24T09:30:00.000Z" },
				{ label: "7-day Sonnet", usedPercent: 12, resetAt: "2026-11-24T09:30:00.000Z" },
				// Out-of-range utilization is clamped, an unreadable reset time is left out.
				{ label: "7-day Fable", usedPercent: 100 },
			],
			credits: [
				{ label: "Extra usage spent", amount: 12.34, unit: "USD", unlimited: false },
				{ label: "Extra usage monthly limit", amount: 50, unit: "USD", unlimited: false },
			],
		});
	});

	it("falls back to limits[] for the shared windows and reads model caps from scoped limits", () => {
		expect(
			parseClaudeUsage({
				five_hour: null,
				seven_day: null,
				seven_day_sonnet: null,
				limits: [
					{ kind: "session", percent: 40, resets_at: "2026-11-20T15:00:00Z" },
					{ kind: "weekly_all", percent: 5, resets_at: "2026-11-24T09:30:00Z" },
					{
						kind: "weekly_scoped",
						percent: 90,
						resets_at: "2026-11-24T09:30:00Z",
						scope: { model: { display_name: "Fable" } },
					},
					{ kind: "weekly_scoped", percent: 20 },
				],
			}),
		).toEqual({
			status: "available",
			windows: [
				{ label: "5-hour", usedPercent: 40, resetAt: "2026-11-20T15:00:00.000Z" },
				{ label: "7-day", usedPercent: 5, resetAt: "2026-11-24T09:30:00.000Z" },
				{ label: "7-day Fable", usedPercent: 90, resetAt: "2026-11-24T09:30:00.000Z" },
			],
			credits: [],
		});
	});

	it("reads extra usage from the spend shape and reports an unlimited cap", () => {
		const usage = parseClaudeUsage({
			spend: { enabled: true, used: { amount_minor: 250, exponent: 2, currency: "USD" }, limit: null },
		});
		expect(usage).toEqual({
			status: "available",
			windows: [],
			credits: [
				{ label: "Extra usage spent", amount: 2.5, unit: "USD", unlimited: false },
				{ label: "Extra usage monthly limit", unit: "USD", unlimited: true },
			],
		});
		// Amounts in another currency, or without one where the shape requires it, are not reported.
		expect(
			parseClaudeUsage({
				spend: { enabled: true, used: { amount_minor: 250, exponent: 2, currency: "EUR" }, limit: null },
			}),
		).toMatchObject({ status: "unavailable" });
		expect(
			parseClaudeUsage({ extra_usage: { is_enabled: false, used_credits: 100, monthly_limit: 500 } }),
		).toMatchObject({ status: "unavailable" });
	});

	it.each([
		{ body: {}, name: "an empty payload" },
		{ body: { five_hour: null, seven_day: null }, name: "only null windows" },
		{ body: "text", name: "a non-object payload" },
	])("reports unavailable for $name instead of inventing zero usage", ({ body }) => {
		expect(parseClaudeUsage(body)).toMatchObject({ status: "unavailable", windows: [], credits: [] });
	});

	it("reports refused and failed requests with their reason", async () => {
		const run = (status: number) => fetchClaudeUsage("t", { fetch: fetchOf(() => new Response("nope", { status })) });
		expect(await run(401)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Sign in again") });
		expect(await run(429)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("rate limits") });
		expect(await run(500)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("HTTP 500") });
		expect(await fetchClaudeUsage("t", { fetch: fetchOf(() => new Response("{ not json")) })).toMatchObject({
			status: "unavailable",
		});
	});

	it("decodes a zstd body, which fetch hands through undecoded", async () => {
		const body = zstdCompressSync(Buffer.from(JSON.stringify({ five_hour: { utilization: 7 } })));
		const usage = await fetchClaudeUsage("t", {
			fetch: fetchOf(() => new Response(body, { headers: { "content-encoding": "zstd" } })),
		});
		expect(usage).toEqual({ status: "available", windows: [{ label: "5-hour", usedPercent: 7 }], credits: [] });
	});

	it("reports the windows with their ids, tiers and reset times for ranking, and the shared windows declared inactive", async () => {
		const result = await fetchClaudeUsageReport("t", {
			fetch: fetchOf(() =>
				Response.json({
					five_hour: null,
					seven_day: { utilization: 30, resets_at: "2026-11-24T09:30:00Z" },
					seven_day_sonnet: { utilization: 5 },
					limits: [
						{ kind: "weekly_all", percent: 30, resets_at: "2026-11-24T09:30:00Z" },
						{
							kind: "weekly_scoped",
							percent: 95,
							resets_at: "2026-11-24T09:30:00Z",
							scope: { model: { display_name: "Fable" } },
						},
					],
				}),
			),
		});
		expect(result).toMatchObject({
			type: "report",
			report: {
				inactiveShared: ["5h"],
				windows: [
					{
						id: "7d",
						usedPercent: 30,
						resetAt: Date.parse("2026-11-24T09:30:00Z"),
						shared: true,
						durationMs: sevenDayMs,
					},
					{ id: "7d:sonnet", usedPercent: 5, shared: false, tier: "sonnet" },
					{ id: "7d:fable", label: "7-day Fable", usedPercent: 95, shared: false, tier: "fable" },
				],
			},
		});
	});

	it("reads the plan from the profile endpoint, as oh-my-pi does", async () => {
		const plan = (organization: Record<string, string>) => claudeProfilePlan({ organization });
		expect(plan({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" })).toBe("Max 20x");
		expect(plan({ organization_type: "claude_max" })).toBe("Max");
		expect(plan({ organization_type: "claude_pro" })).toBe("Pro");
		expect(plan({ organization_type: "claude_team" })).toBe("Team");
		expect(plan({ organization_type: "claude_enterprise" })).toBe("Enterprise");
		expect(plan({ organization_type: "other" })).toBeUndefined();
		expect(claudeProfilePlan(null)).toBeUndefined();

		const fetchStub = fetchOf(() => Response.json({ organization: { organization_type: "claude_pro" } }));
		expect(await fetchClaudePlan("sk-ant-oat01-token", { fetch: fetchStub, signal })).toBe("Pro");
		const [url, init] = fetchStub.mock.calls[0]!;
		expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-ant-oat01-token");
		// A failed request keeps the plan the account has.
		expect(await fetchClaudePlan("t", { fetch: fetchOf(() => new Response("no", { status: 500 })) })).toBeUndefined();
		const offline = (async () => {
			throw new Error("offline");
		}) as unknown as FetchFunction;
		expect(await fetchClaudePlan("t", { fetch: offline })).toBeUndefined();
	});

	it("rejects when the network fails", async () => {
		await expect(
			fetchClaudeUsage("t", {
				fetch: (async () => {
					throw new Error("offline");
				}) as unknown as FetchFunction,
			}),
		).rejects.toThrow("offline");
	});
});

describe("Claude limits", () => {
	const now = 1_800_000_000_000;
	const nowSeconds = now / 1000;
	const headers = (prefix: string, used: string, resetInSeconds: number): Record<string, string> => ({
		[`anthropic-ratelimit-unified-${prefix}-utilization`]: used,
		[`anthropic-ratelimit-unified-${prefix}-reset`]: String(nowSeconds + resetInSeconds),
	});
	const window = (
		id: string,
		usedPercent: number,
		options: { resetIn?: number; tier?: string } = {},
	): ClaudeWindow => ({
		id,
		label: id,
		usedPercent,
		durationMs: id === "5h" ? fiveHourMs : sevenDayMs,
		shared: options.tier === undefined,
		...(options.resetIn === undefined ? {} : { resetAt: now + options.resetIn }),
		...(options.tier === undefined ? {} : { tier: options.tier }),
	});

	it("reads the 5-hour, 7-day and model-scoped windows from the unified headers", () => {
		expect(
			windowsFromHeaders({
				...headers("5h", "0.4", 3600),
				...headers("7d", "0.05", 86_400),
				...headers("7d_oi", "1", 600),
				"anthropic-ratelimit-unified-status": "allowed",
			}),
		).toEqual([
			{ id: "5h", label: "5-hour", usedPercent: 40, resetAt: now + 3_600_000, durationMs: fiveHourMs, shared: true },
			{ id: "7d", label: "7-day", usedPercent: 5, resetAt: now + 86_400_000, durationMs: sevenDayMs, shared: true },
			{
				id: "7d:fable",
				label: "7-day Fable",
				usedPercent: 100,
				resetAt: now + 600_000,
				durationMs: sevenDayMs,
				shared: false,
				tier: "fable",
			},
		]);
		// A window needs its utilization; a reset of zero names no time.
		expect(windowsFromHeaders({ "anthropic-ratelimit-unified-5h-reset": "1800003600" })).toEqual([]);
		expect(windowsFromHeaders({ ...headers("5h", "0.4", 0), "anthropic-ratelimit-unified-5h-reset": "0" })).toEqual([
			expect.not.objectContaining({ resetAt: expect.anything() }),
		]);
	});

	it("blocks an account while a window that gates the request is used up and frees it at the reset", () => {
		const limits = new ClaudeLimits();
		limits.ingestHeaders("a", headers("5h", "0.4", 3600), now);
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();

		limits.ingestHeaders("a", { ...headers("5h", "1", 600), ...headers("7d", "1.0", 7200) }, now);
		// The latest reset of any used-up window decides.
		expect(limits.blockedUntil("a", "opus", now)).toBe(now + 7_200_000);
		expect(limits.blockedUntil("a", undefined, now + 7_199_000)).toBe(now + 7_200_000);
		expect(limits.blockedUntil("a", "opus", now + 7_201_000)).toBeUndefined();
		expect(limits.blockedUntil("other", "opus", now)).toBeUndefined();
	});

	it("keeps a window the headers do not report and replaces one they do", () => {
		const limits = new ClaudeLimits();
		limits.ingestUsage(
			"a",
			{
				windows: [window("5h", 10), window("7d", 30), window("7d:sonnet", 90, { tier: "sonnet" })],
				inactiveShared: [],
			},
			now,
		);
		limits.ingestHeaders("a", headers("5h", "0.5", 60), now);
		expect(limits.windows("a").map((entry) => [entry.id, entry.usedPercent])).toEqual([
			["7d", 30],
			["7d:sonnet", 90],
			["5h", 50],
		]);
	});

	it("applies a model family's cap only to requests of that family", () => {
		const limits = new ClaudeLimits();
		const sonnetCap = window("7d:sonnet", 100, { resetIn: 3_600_000, tier: "sonnet" });
		limits.ingestUsage("a", { windows: [window("5h", 10), window("7d", 30), sonnetCap], inactiveShared: [] }, now);
		expect(limits.blockedUntil("a", "sonnet", now)).toBe(now + 3_600_000);
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();
		expect(limits.blockedUntil("a", undefined, now)).toBeUndefined();
	});

	it("blocks a Fable or Mythos request only by a confirmed used-up scoped cap, and either name finds it", () => {
		const limits = new ClaudeLimits();
		const fable = (usedPercent: number, resetIn?: number) =>
			window("7d:fable", usedPercent, { resetIn, tier: "fable" });
		// High utilization short of the cap says little: those counters report high while the account serves.
		limits.ingestUsage(
			"a",
			{ windows: [window("5h", 10), window("7d", 30), fable(97, 3_600_000)], inactiveShared: [] },
			now,
		);
		expect(limits.blockedUntil("a", "fable", now)).toBeUndefined();
		limits.ingestUsage(
			"a",
			{ windows: [window("5h", 10), window("7d", 30), fable(100, 3_600_000)], inactiveShared: [] },
			now,
		);
		expect(limits.blockedUntil("a", "fable", now)).toBe(now + 3_600_000);
		// One scoped counter meters both families, labelled with the one the plan names.
		expect(limits.blockedUntil("a", "mythos", now)).toBe(now + 3_600_000);
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();
		// Used up without a reset ahead is not confirmed.
		limits.ingestUsage("a", { windows: [window("5h", 10), window("7d", 30), fable(100)], inactiveShared: [] }, now);
		expect(limits.blockedUntil("a", "fable", now)).toBeUndefined();
	});

	it("treats a window whose reset has passed as unused, and a used-up window without a reset as a short block", () => {
		const limits = new ClaudeLimits();
		limits.ingestUsage("a", { windows: [window("5h", 100, { resetIn: -1000 })], inactiveShared: [] }, now);
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();
		limits.ingestUsage("a", { windows: [window("5h", 100)], inactiveShared: [] }, now);
		expect(limits.blockedUntil("a", "opus", now)).toBe(now + defaultBlockMs);
		expect(limits.blockedUntil("a", "opus", now + defaultBlockMs)).toBeUndefined();
	});

	it("keeps the longest block, scopes a Fable block to its family, and lifts both when a request succeeds", () => {
		const limits = new ClaudeLimits();
		limits.markReached("a", "opus", now + 600_000);
		limits.markReached("a", "opus", now + 60_000);
		expect(limits.blockedUntil("a", "opus", now)).toBe(now + 600_000);
		expect(limits.blockedUntil("a", "sonnet", now)).toBe(now + 600_000);

		limits.recordServed("a", "opus", now);
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();
		expect(limits.servedAt("a")).toBe(now);

		limits.markReached("a", "fable", now + 600_000);
		expect(limits.blockedUntil("a", "fable", now)).toBe(now + 600_000);
		expect(limits.blockedUntil("a", "mythos", now)).toBeUndefined();
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();
		// A success on another family leaves the Fable block alone.
		limits.recordServed("a", "opus", now);
		expect(limits.blockedUntil("a", "fable", now)).toBe(now + 600_000);
	});

	it("lifts a block when a usage report covers both shared windows and shows nothing used up", () => {
		const limits = new ClaudeLimits();
		limits.markReached("a", "opus", now + 600_000);
		const healthy = [window("5h", 20, { resetIn: 3_600_000 }), window("7d", 30, { resetIn: 86_400_000 })];
		limits.ingestUsage("a", { windows: healthy, inactiveShared: [] }, now);
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();

		// A report without the 7-day window cannot rule out that it caused the block.
		limits.markReached("a", "opus", now + 600_000);
		limits.ingestUsage("a", { windows: [healthy[0]!], inactiveShared: [] }, now);
		expect(limits.blockedUntil("a", "opus", now)).toBe(now + 600_000);
		// A window the payload declares inactive counts as covered, as does a used-up window that keeps the block.
		limits.ingestUsage("a", { windows: [healthy[1]!], inactiveShared: ["5h"] }, now);
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();
		limits.markReached("a", "opus", now + 600_000);
		limits.ingestUsage(
			"a",
			{ windows: [window("5h", 100, { resetIn: 1000 }), healthy[1]!], inactiveShared: [] },
			now,
		);
		expect(limits.blockedUntil("a", "opus", now)).toBe(now + 600_000);
	});

	it("asks the usage endpoint when windows are unknown or stale, and leaves it alone for a minute after a failure", () => {
		const limits = new ClaudeLimits();
		expect(limits.needsUsage("a", now)).toBe(true);
		limits.ingestUsage("a", { windows: [window("5h", 10)], inactiveShared: [] }, now);
		expect(limits.needsUsage("a", now + usageTtlMs - 1)).toBe(false);
		expect(limits.needsUsage("a", now + usageTtlMs)).toBe(true);
		// Response headers keep the windows fresh too.
		limits.ingestHeaders("a", headers("5h", "0.2", 3600), now + usageTtlMs);
		expect(limits.needsUsage("a", now + usageTtlMs + 1)).toBe(false);

		limits.noteUsageFailure("b", now);
		expect(limits.needsUsage("b", now + usageFailureBackoffMs - 1)).toBe(false);
		expect(limits.needsUsage("b", now + usageFailureBackoffMs)).toBe(true);
	});

	it("forgets an account on clear()", () => {
		const limits = new ClaudeLimits();
		limits.markReached("a", undefined, now + 600_000);
		limits.ingestHeaders("a", headers("5h", "1", 600), now);
		limits.clear("a");
		expect(limits.blockedUntil("a", "opus", now)).toBeUndefined();
		expect(limits.windows("a")).toEqual([]);
	});

	it.each([
		["opus", "opus"],
		["claude-sonnet-4-5", "sonnet"],
		["claude-fable-1", "fable"],
		["claude-mythos-preview", "mythos"],
		["claude-haiku-4-5", undefined],
	])("tells the family of %s", (modelId, kind) => {
		expect(claudeModelKind(modelId)).toBe(kind);
	});
});

describe("Claude usage limit failures", () => {
	const now = 1_800_000_000_000;

	function failure(
		errorMessage: string | undefined,
		http?: { status: number; retryAfterMs?: number; headers?: Record<string, string> },
	): AssistantMessage {
		const message = errorMessageOf("claude-sub:a", errorMessage);
		if (http) {
			message.diagnostics = [
				{
					type: PROVIDER_HTTP_ERROR_DIAGNOSTIC_TYPE,
					timestamp: now,
					error: { message: errorMessage ?? "" },
					details: {
						status: http.status,
						...(http.retryAfterMs === undefined ? {} : { retryAfterMs: http.retryAfterMs }),
						headers: http.headers ?? {},
					},
				},
			];
		}
		return message;
	}

	it.each([
		{
			name: "an HTTP 429 without a time",
			message: failure('429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'),
			until: { until: now + defaultBlockMs, timed: false },
		},
		{
			name: "a retry-after in the message",
			message: failure("Too many requests. retry-after: 90"),
			until: { until: now + 90_000, timed: true },
		},
		{
			name: "Claude's usage limit with its reset",
			message: failure("Claude usage limit reached|1800009000"),
			until: { until: 1_800_009_000_000, timed: true },
		},
		{
			name: "a rejected unified response with its reset header",
			message: failure("rate limited", {
				status: 429,
				headers: {
					"anthropic-ratelimit-unified-status": "rejected",
					"anthropic-ratelimit-unified-reset": String(now / 1000 + 4000),
				},
			}),
			until: { until: now + 4_000_000, timed: true },
		},
		{
			name: "an HTTP 429 with a retry-after header",
			message: failure("rate limited", { status: 429, retryAfterMs: 30_000 }),
			until: { until: now + 30_000, timed: true },
		},
		{
			name: "a per-minute token throttle, which clears by itself",
			message: failure(
				'429 {"error":{"type":"rate_limit_error","message":"exceeds the rate limit of 8,000 output tokens per minute"}}',
			),
			until: undefined,
		},
		{ name: "an overloaded server", message: failure('529 {"error":{"type":"overloaded_error"}}'), until: undefined },
		{
			name: "an invalid request",
			message: failure('400 {"error":{"type":"invalid_request_error"}}'),
			until: undefined,
		},
		{ name: "no message", message: failure(undefined), until: undefined },
	])("reads $name", ({ message, until }) => {
		expect(usageLimitFailure(message, now)).toEqual(until);
	});

	it("reads nothing from a reply that did not fail", () => {
		expect(usageLimitFailure({ ...failure("429 rate limit"), stopReason: "stop" }, now)).toBeUndefined();
	});
});

describe("Claude usage ranking", () => {
	const now = 1_800_000_000_000;
	const hours = (count: number) => count * 3_600_000;
	const window = (id: "5h" | "7d", usedPercent: number, resetInHours?: number): ClaudeWindow => ({
		id,
		label: id,
		usedPercent,
		durationMs: id === "5h" ? fiveHourMs : sevenDayMs,
		shared: true,
		...(resetInHours === undefined ? {} : { resetAt: now + hours(resetInHours) }),
	});
	const candidate = (name: string, order: number, windows?: ClaudeWindow[]) => ({ name, order, windows });
	const names = (ranked: { name: string }[]) => ranked.map((entry) => entry.name);

	it("puts the account whose remaining weekly quota expires soonest first, so staggered resets land fully used", () => {
		const ranked = rankByUsage(
			[
				candidate("late", 0, [window("5h", 10, 4), window("7d", 60, 144)]),
				candidate("soon", 1, [window("5h", 10, 4), window("7d", 60, 2)]),
			],
			"opus",
			now,
		);
		expect(names(ranked)).toEqual(["soon", "late"]);
	});

	it("prefers the account with the most remaining capacity when resets coincide", () => {
		const ranked = rankByUsage(
			[
				candidate("busy", 0, [window("5h", 10, 4), window("7d", 70, 100)]),
				candidate("idle", 1, [window("5h", 10, 4), window("7d", 20, 100)]),
			],
			"opus",
			now,
		);
		expect(names(ranked)).toEqual(["idle", "busy"]);
	});

	it("ranks an account with a nearly used up 5-hour window behind cooler ones whatever its weekly headroom", () => {
		const ranked = rankByUsage(
			[
				candidate("hot", 0, [window("5h", 90, 1), window("7d", 5, 2)]),
				candidate("cool", 1, [window("5h", 10, 4), window("7d", 80, 144)]),
			],
			"opus",
			now,
		);
		expect(names(ranked)).toEqual(["cool", "hot"]);
	});

	it("ranks measured accounts before unmeasured ones, and breaks real ties by listing order", () => {
		const same = [window("5h", 10, 4), window("7d", 50, 100)];
		const ranked = rankByUsage(
			[candidate("unknown", 0, undefined), candidate("second", 2, same), candidate("first", 1, same)],
			"opus",
			now,
		);
		expect(names(ranked)).toEqual(["first", "second", "unknown"]);
	});

	it("ranks an account whose allowance for the model is spent behind accounts with allowance left", () => {
		const sonnetCap: ClaudeWindow = { ...window("7d", 100, 50), id: "7d:sonnet", shared: false, tier: "sonnet" };
		const ranked = rankByUsage(
			[
				candidate("capped", 0, [window("5h", 10, 4), window("7d", 10, 2), sonnetCap]),
				candidate("open", 1, [window("5h", 10, 4), window("7d", 60, 100)]),
			],
			"sonnet",
			now,
		);
		expect(names(ranked)).toEqual(["open", "capped"]);
		// The same account ranks first for a model the cap does not meter.
		expect(names(rankByUsage(ranked, "opus", now))).toEqual(["capped", "open"]);
	});

	it("treats a window that has reset as unused", () => {
		const ranked = rankByUsage(
			[
				candidate("stale", 0, [window("5h", 95, -1), window("7d", 90, -1)]),
				candidate("current", 1, [window("5h", 30, 3), window("7d", 50, 100)]),
			],
			"opus",
			now,
		);
		expect(names(ranked)[0]).toBe("stale");
	});
});

describe("Claude pools", () => {
	const now = 1_800_000_000_000;

	function model(provider: string, id: string): Model<"anthropic-messages"> {
		return {
			id,
			name: `Model ${id}`,
			api: "anthropic-messages",
			provider,
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		};
	}

	function member(
		id: string,
		options: {
			subscription: boolean;
			family?: string;
			models?: string[];
			disabled?: boolean;
			target?: AccountProviderSpec["target"];
		},
	): AccountProviderSpec {
		return {
			id,
			name: id,
			target: options.target ?? (options.subscription ? { type: "local", id } : { type: "account", key: id }),
			family: options.family ?? "claude",
			subscription: options.subscription,
			disabled: options.disabled ?? false,
			models: (options.models ?? ["opus", "sonnet"]).map((modelId) => model(id, modelId)),
		};
	}

	const subA = member("claude-sub:a", { subscription: true });
	const subB = member("claude-sub:b", { subscription: true });
	const subC = member("claude-sub:c", { subscription: true });
	const apiX = member("acct:api-x", { subscription: false });
	const apiY = member("acct:api-y", { subscription: false });
	const codex = member("acct:codex", { subscription: true, family: "codex", models: ["gpt"] });
	const gptKey = member("acct:gpt-key", { subscription: false, family: "openai", models: ["gpt"] });

	const lookup = (providers: readonly AccountProviderSpec[]) => (provider: string, id: string) =>
		providers.find((spec) => spec.id === provider)?.models.find((entry) => entry.id === id);

	function failedMessage(errorMessage: string, provider = "claude-sub:a"): AssistantMessage {
		return errorMessageOf(provider, errorMessage);
	}

	function request(reason: ModelRouteRequest["reason"], extra: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
		return { model: model("pool:claude", "opus"), thinkingLevel: "high", reason, messages: [], ...extra };
	}

	const window = (id: "5h" | "7d", usedPercent: number, resetInHours: number): ClaudeWindow => ({
		id,
		label: id,
		usedPercent,
		durationMs: id === "5h" ? fiveHourMs : sevenDayMs,
		shared: true,
		resetAt: now + resetInHours * 3_600_000,
	});

	/** Windows of an account as the usage endpoint reports them. */
	function reported(limits: ClaudeLimits, providerId: string, windows: ClaudeWindow[]): void {
		limits.ingestUsage(providerId, { windows, inactiveShared: [] }, now);
	}

	function routingOf(members: readonly AccountProviderSpec[], options: Partial<PoolRouting> = {}): PoolRouting {
		return {
			limits: new ClaudeLimits(),
			refreshUsage: async () => {},
			find: lookup(members),
			now: () => now,
			...options,
		};
	}

	async function chosen(
		members: readonly AccountProviderSpec[],
		route: ModelRouteRequest,
		routing: PoolRouting = routingOf(members),
	): Promise<string> {
		return (await routePool(route, members, routing)).model.provider;
	}

	it("orders members subscriptions first, then API accounts, each in listing order, and skips disabled ones", () => {
		const disabled = member("claude-sub:off", { subscription: true, disabled: true });
		const pool = poolMembers([apiX, subA, disabled, gptKey, subB, apiY, codex], "claude");
		expect(pool.map((spec) => spec.id)).toEqual(["claude-sub:a", "claude-sub:b", "acct:api-x", "acct:api-y"]);
		// The combined pool adds the other families: their subscriptions before their API accounts.
		expect(poolMembers([apiX, subA, gptKey, codex], "all").map((spec) => spec.id)).toEqual([
			"claude-sub:a",
			"acct:codex",
			"acct:api-x",
			"acct:gpt-key",
		]);
		// Pools themselves are never members.
		const virtual = virtualPoolSpecs([subA, apiX]);
		expect(poolMembers([...virtual, subA], "all").map((spec) => spec.id)).toEqual(["claude-sub:a"]);
	});

	it("lists pool:all before pool:claude, each with the models of its members, and none without members", () => {
		const specs = virtualPoolSpecs([subA, apiX, codex]);
		expect(specs.map((spec) => [spec.id, spec.name])).toEqual([
			["pool:all", "All accounts pool (3 accounts)"],
			["pool:claude", "Claude pool (2 accounts)"],
		]);
		expect(specs[0]!.models.map((entry) => [entry.id, entry.provider])).toEqual([
			["opus", "pool:all"],
			["sonnet", "pool:all"],
			["gpt", "pool:all"],
		]);
		expect(specs[1]!.target).toEqual({ type: "virtual-pool", name: "claude" });
		expect(virtualPoolSpecs([])).toEqual([]);
		expect(virtualPoolSpecs([codex]).map((spec) => spec.id)).toEqual(["pool:all"]);
	});

	it("builds one virtual model per pool model that routes with the current members", async () => {
		let current: readonly AccountProviderSpec[] = [subA, apiX];
		const definitions = virtualModelDefinitions(virtualPoolSpecs(current), () => current, {
			limits: new ClaudeLimits(),
			refreshUsage: async () => {},
			now: () => now,
		});
		expect(definitions.map((definition) => `${definition.provider}/${definition.id}`)).toEqual([
			"pool:all/opus",
			"pool:all/sonnet",
			"pool:claude/opus",
			"pool:claude/sonnet",
		]);
		expect(definitions[0]).toMatchObject({
			name: "Model opus",
			contextWindow: 200_000,
			maxTokens: 64_000,
			input: ["text", "image"],
		});
		const route = definitions[2]!.route;
		const ctx = { modelRegistry: { find: lookup([subA, subB, apiX]) } } as never;
		expect((await route(request("user"), ctx)).model.provider).toBe("claude-sub:a");
		// Accounts added or removed later take effect without registering the models again.
		current = [subB, apiX];
		expect((await route(request("user"), ctx)).model.provider).toBe("claude-sub:b");
	});

	it("routes to the first enabled subscription when no usage is known, and keeps the thinking level", async () => {
		const members = poolMembers([apiX, subA, subB], "claude");
		expect(await routePool(request("user"), members, routingOf(members))).toMatchObject({
			model: { provider: "claude-sub:a", id: "opus" },
			thinkingLevel: "high",
		});
	});

	it("ranks subscriptions by their usage, then falls back to API accounts in listing order", async () => {
		const members = poolMembers([apiX, subA, subB, subC, apiY], "claude");
		const routing = routingOf(members);
		reported(routing.limits, "claude-sub:a", [window("5h", 10, 4), window("7d", 70, 100)]);
		reported(routing.limits, "claude-sub:b", [window("5h", 10, 4), window("7d", 20, 100)]);
		// c has no windows: it ranks behind the measured accounts.
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:b");

		routing.limits.markReached("claude-sub:b", "opus", now + 60_000);
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:a");
		routing.limits.markReached("claude-sub:a", "opus", now + 60_000);
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:c");
		routing.limits.markReached("claude-sub:c", "opus", now + 60_000);
		expect(await chosen(members, request("user"), routing)).toBe("acct:api-x");
	});

	it("asks the usage endpoint about subscriptions with unknown or stale windows before it ranks, once", async () => {
		const members = poolMembers([subA, subB, apiX], "claude");
		const asked: string[] = [];
		const routing = routingOf(members, {
			refreshUsage: async (providerId) => {
				asked.push(providerId);
				reported(
					routing.limits,
					providerId,
					providerId === "claude-sub:a"
						? [window("5h", 10, 4), window("7d", 90, 100)]
						: [window("5h", 10, 4), window("7d", 10, 100)],
				);
			},
		});

		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:b");
		expect(asked.sort()).toEqual(["claude-sub:a", "claude-sub:b"]);
		// The windows are fresh now.
		await chosen(members, request("user"), routing);
		expect(asked).toHaveLength(2);
	});

	it("ranks without an account whose usage request failed, and does not ask again for a minute", async () => {
		const members = poolMembers([subA, subB], "claude");
		let asked = 0;
		const routing = routingOf(members, {
			refreshUsage: async (providerId) => {
				asked++;
				if (providerId === "claude-sub:a") routing.limits.noteUsageFailure(providerId, now);
				else reported(routing.limits, providerId, [window("5h", 10, 4), window("7d", 50, 100)]);
			},
		});
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:b");
		await chosen(members, request("user"), routing);
		// b is fresh and a is in its backoff.
		expect(asked).toBe(2);
	});

	it("keeps the previous account while it can serve, without asking the usage endpoint", async () => {
		const members = poolMembers([subA, subB, apiX], "claude");
		const refreshUsage = vi.fn(async () => {});
		const previous = { model: model("claude-sub:b", "sonnet") };
		for (const reason of ["user", "continuation", "direct"] as const) {
			expect(await chosen(members, request(reason, { previous }), routingOf(members, { refreshUsage }))).toBe(
				"claude-sub:b",
			);
		}
		expect(refreshUsage).not.toHaveBeenCalled();
		// The previous account answered another model of the pool; the same account serves this one.
		expect(await chosen(members, request("user", { previous: { model: model("acct:api-x", "sonnet") } }))).toBe(
			"claude-sub:a",
		);
	});

	it("ranks again when the conversation has been idle longer than the prompt cache lives", async () => {
		const members = poolMembers([subA, subB], "claude");
		const routing = routingOf(members);
		reported(routing.limits, "claude-sub:a", [window("5h", 10, 4), window("7d", 80, 100)]);
		reported(routing.limits, "claude-sub:b", [window("5h", 10, 4), window("7d", 10, 100)]);
		const previous = { model: model("claude-sub:a", "opus") };
		const answeredAt = (minutesAgo: number): ModelRouteRequest["messages"] => [
			{ ...assistantReply("claude-sub:a"), timestamp: now - minutesAgo * 60_000 },
		];
		expect(await chosen(members, request("user", { previous, messages: answeredAt(59) }), routing)).toBe(
			"claude-sub:a",
		);
		expect(await chosen(members, request("user", { previous, messages: answeredAt(61) }), routing)).toBe(
			"claude-sub:b",
		);
	});

	it("keeps an API account that has the conversation only while no subscription can serve", async () => {
		const members = [subA, apiX, apiY];
		const previous = { model: model("acct:api-y", "opus") };
		const routing = routingOf(members);
		routing.limits.markReached("claude-sub:a", "opus", now + 60_000);
		expect(await chosen(members, request("user", { previous }), routing)).toBe("acct:api-y");
		// The subscription recovered: stop spending API credit.
		const later = routingOf(members, { limits: routing.limits, now: () => now + 61_000 });
		expect(await chosen(members, request("user", { previous }), later)).toBe("claude-sub:a");
	});

	it("skips an account whose window is used up until it resets", async () => {
		const members = [subA, subB];
		const routing = routingOf(members);
		routing.limits.ingestHeaders(
			"claude-sub:a",
			{
				"anthropic-ratelimit-unified-5h-utilization": "1",
				"anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 600),
			},
			now,
		);
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:b");
		// Past the reset the window starts over and a leads again.
		const later = routingOf(members, { limits: routing.limits, now: () => now + 601_000 });
		expect(await chosen(members, request("user"), later)).toBe("claude-sub:a");
	});

	it("blocks a Fable limit only for Fable requests, and any other limit for the whole account", async () => {
		const models = ["opus", "claude-fable-1"];
		const members = [
			member("claude-sub:a", { subscription: true, models }),
			member("claude-sub:b", { subscription: true, models }),
		];
		const routing = routingOf(members);
		const fable = request("user", { model: model("pool:claude", "claude-fable-1") });
		routing.limits.markReached("claude-sub:a", "fable", now + 600_000);
		expect(await chosen(members, fable, routing)).toBe("claude-sub:b");
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:a");

		// An Opus limit blocks b for every model, Fable included.
		routing.limits.markReached("claude-sub:b", "opus", now + 600_000);
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:a");
		expect(routing.limits.blockedUntil("claude-sub:b", "fable", now)).toBe(now + 600_000);
	});

	it("a retry after a usage limit blocks the failed account and moves to the next one", async () => {
		const members = poolMembers([subA, subB, apiX], "claude");
		const routing = routingOf(members);
		const failed = {
			model: model("claude-sub:a", "opus"),
			message: failedMessage('429 {"error":{"type":"rate_limit_error","message":"usage limit reached|1800003000"}}'),
		};
		expect(await chosen(members, request("retry", { failed }), routing)).toBe("claude-sub:b");
		// The block lasts until the reset the failure named.
		expect(routing.limits.blockedUntil("claude-sub:a", "opus", now)).toBe(1_800_003_000_000);
		// The next user turn keeps skipping it without a new failure.
		const previous = { model: model("claude-sub:b", "opus") };
		expect(await chosen(members, request("user", { previous }), routing)).toBe("claude-sub:b");
		routing.limits.markReached("claude-sub:b", "opus", now + 60_000);
		expect(await chosen(members, request("user", { previous }), routing)).toBe("acct:api-x");
	});

	it("rotates away from a broker account that reported a limit", async () => {
		const members = poolMembers([apiX, apiY], "claude");
		const failed = {
			model: model("acct:api-x", "opus"),
			message: failedMessage("429 Too many requests", "acct:api-x"),
		};
		expect(await chosen(members, request("retry", { failed }))).toBe("acct:api-y");
	});

	it.each([
		['529 {"error":{"type":"overloaded_error"}}', "an overloaded server"],
		['429 {"error":{"message":"exceeds the rate limit of 8,000 output tokens per minute"}}', "a per-minute throttle"],
		["Connection error.", "a network failure"],
	])("a retry after %s stays on the same account (%s)", async (errorMessage) => {
		const failed = { model: model("claude-sub:b", "opus"), message: failedMessage(errorMessage, "claude-sub:b") };
		expect(await chosen([subA, subB, apiX], request("retry", { failed }))).toBe("claude-sub:b");
	});

	it("gives the request to the account that frees up first when every account is blocked", async () => {
		const members = [subA, subB, apiX];
		const routing = routingOf(members);
		routing.limits.markReached("claude-sub:a", "opus", now + 900_000);
		routing.limits.markReached("claude-sub:b", "opus", now + 300_000);
		routing.limits.markReached("acct:api-x", "opus", now + 600_000);
		expect(await chosen(members, request("user"), routing)).toBe("claude-sub:b");
	});

	it("waits for a sibling that frees up within seconds when a retry finds every account blocked", async () => {
		const members = [subA, subB];
		const routing = routingOf(members);
		routing.limits.markReached("claude-sub:a", "opus", now + 40);
		routing.limits.markReached("claude-sub:b", "opus", now + 900_000);
		const failed = { model: model("claude-sub:b", "opus"), message: failedMessage("overloaded", "claude-sub:b") };
		const started = Date.now();
		expect(await chosen(members, request("retry", { failed }), routing)).toBe("claude-sub:a");
		expect(Date.now() - started).toBeGreaterThanOrEqual(30);
		// A longer wait is the caller's own backoff to make.
		const quick = Date.now();
		routing.limits.markReached("claude-sub:a", "opus", now + 60_000);
		await chosen(members, request("retry", { failed }), routing);
		expect(Date.now() - quick).toBeLessThan(1000);
	});

	it("serves pool:all models of other families from the broker accounts that offer them", async () => {
		const members = poolMembers([subA, apiX, codex, gptKey], "all");
		const gpt = request("user", { model: model("pool:all", "gpt") });
		const routing = routingOf(members);
		expect(await chosen(members, gpt, routing)).toBe("acct:codex");
		routing.limits.markReached("acct:codex", undefined, now + 60_000);
		expect(await chosen(members, gpt, routing)).toBe("acct:gpt-key");
	});

	it("fails clearly when no account offers the model", async () => {
		await expect(chosen([subA], request("user", { model: model("pool:claude", "haiku") }))).rejects.toThrow(
			"No account offers haiku",
		);
		await expect(routePool(request("user"), [subA], routingOf([subA], { find: () => undefined }))).rejects.toThrow(
			"does not list opus",
		);
	});
});

describe("accounts extension with local Claude subscriptions", () => {
	async function loadExtension(agentDir: string) {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const runtime = createExtensionRuntime();
		runtime.getSettings = () => ({ defaultProvider: "anthropic" });
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:accounts",
		);
		return { runtime, extension };
	}

	function uiContext() {
		const notifications: { message: string; type?: string }[] = [];
		const statuses: (string | undefined)[] = [];
		const ctx = {
			hasUI: false,
			model: undefined as { provider: string; id: string } | undefined,
			modelRegistry: { find: () => undefined, refresh: vi.fn(async () => {}), getAll: () => [] },
			sessionManager: { getEntries: () => [], getBranch: () => [] },
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			},
		};
		return { ctx, notifications, statuses };
	}

	it("registers signed-in subscriptions and the Claude pools at startup without a broker", async () => {
		const agentDir = tempDir();
		const home = join(agentDir, "accounts");
		const { account } = await new LocalClaudeStore(home).save(credential());
		const { runtime } = await loadExtension(agentDir);

		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual([
			account.providerId,
		]);
		const virtual = runtime.pendingVirtualModelRegistrations.map(
			({ definition }) => `${definition.provider}/${definition.id}`,
		);
		expect(virtual).toContain("pool:claude/claude-opus-4-8");
		expect(virtual).toContain("pool:all/claude-opus-4-8");
		expect(virtual.filter((entry) => entry.startsWith("pool:claude/"))).toHaveLength(
			virtual.filter((entry) => entry.startsWith("pool:all/")).length,
		);
	});

	it("lists, disables, enables and removes a subscription without starting the broker", async () => {
		const agentDir = tempDir();
		const home = join(agentDir, "accounts");
		const { account } = await new LocalClaudeStore(home).save(credential());
		const { extension } = await loadExtension(agentDir);
		const { ctx, notifications } = uiContext();
		const run = (args: string) => extension.commands.get("accounts")!.handler(args, ctx as never);

		await run("list");
		expect(notifications.pop()?.message).toContain(`${account.name} - ready - `);
		await run("disable neil");
		expect(notifications.pop()).toEqual({ message: `Disabled ${account.name}`, type: "info" });
		expect(listLocalClaudeAccounts(home)[0]?.disabled).toBe(true);
		await run("list");
		expect(notifications.pop()?.message).toContain("- disabled -");
		await run("enable neil");
		expect(notifications.pop()).toEqual({ message: `Enabled ${account.name}`, type: "info" });
		expect(listLocalClaudeAccounts(home)[0]?.disabled).toBe(false);
		await run("reset neil");
		expect(notifications.pop()).toEqual({ message: `Cleared cooldown for ${account.name}`, type: "info" });
		await run("remove neil");
		expect(notifications.pop()).toEqual({ message: `Removed ${account.name}`, type: "info" });
		expect(listLocalClaudeAccounts(home)).toEqual([]);
		// No broker was needed for any of it.
		expect(notifications).toEqual([]);
	});

	it("moves broker-held subscriptions to the local store when a session starts", async () => {
		const agentDir = tempDir();
		const auths = join(agentDir, "accounts", "auths");
		mkdirSync(auths, { recursive: true });
		const file = join(auths, "claude-aaaa-neil@example.com.json");
		writeFileSync(
			file,
			JSON.stringify({
				type: "claude",
				access_token: accessToken,
				refresh_token: refreshToken,
				expired: "2030-01-01T00:00:00Z",
				email: "neil@example.com",
				account_uuid: "account-uuid-1",
				organization_uuid: "org-uuid-1",
			}),
		);
		const { extension } = await loadExtension(agentDir);
		const { ctx } = uiContext();

		const [onStart] = extension.handlers.get("session_start") ?? [];
		await onStart!({ type: "session_start", reason: "startup" } as never, ctx as never);

		await vi.waitFor(() => expect(listLocalClaudeAccounts(join(agentDir, "accounts"))).toHaveLength(1));
		await vi.waitFor(() => expect(() => readFileSync(file)).toThrow());
		expect(ctx.modelRegistry.refresh).toHaveBeenCalled();
	});

	it("names the account that served the last answer of a virtual pool in the footer", async () => {
		const agentDir = tempDir();
		const { account } = await new LocalClaudeStore(join(agentDir, "accounts")).save(credential());
		const { extension } = await loadExtension(agentDir);
		const { ctx, statuses } = uiContext();
		ctx.model = { provider: "pool:claude", id: "claude-opus-4-8" };

		const [onEnd] = extension.handlers.get("message_end") ?? [];
		const answer = (stopReason: string) =>
			({ type: "message_end", message: { role: "assistant", provider: account.providerId, stopReason } }) as never;
		await onEnd!(answer("stop"), ctx as never);
		expect(statuses.pop()).toBe(`account: Claude pool (1 account) -> ${account.name}`);

		// A failed answer does not change who is named.
		await onEnd!(
			{ type: "message_end", message: { role: "assistant", provider: "acct:other", stopReason: "error" } } as never,
			ctx as never,
		);
		expect(statuses).toEqual([]);
	});

	it("skips broker pools and accounts from the specs of a catalog that still lists subscriptions", () => {
		const subscription: BrokerAccount = {
			id: "claude-a.json",
			key: "a",
			provider: "claude",
			kind: "oauth",
			source: "file",
			status: "active",
			disabled: false,
			unavailable: false,
			quotaExceeded: false,
			modelCount: 1,
		};
		const catalog = buildCatalog([subscription], new Map(), () => undefined);
		expect(providerSpecs(catalog)).toEqual([] satisfies BrokerProviderSpec[]);
	});
});

describe("session costs of accounts", () => {
	const entry = (provider: string, total: number, extra: Partial<AssistantMessage> = {}) =>
		({
			type: "message",
			message: assistantMessage(provider, {
				usage: {
					input: total,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
				},
				...extra,
			}),
		}) as never;

	it("counts a response a virtual pool routed for the account that served it", () => {
		const entries = [
			entry("claude-sub:a", 1),
			entry("claude-sub:b", 10),
			entry("claude-sub:a", 2),
			// Broker pools record only the pool, so their cost stays unattributed.
			entry("pool:codex", 100),
			// A request that failed before routing leaves the virtual pool on its message and cost nothing.
			entry("pool:claude", 0, { stopReason: "error" }),
			entry("acct:api-x", 1000),
		];

		const costs = sessionAccountCosts(entries, "claude-sub:a");

		expect(costs.account.total).toBe(3);
		expect(costs.accountResponses).toBe(2);
		expect(costs.unattributedPools.total).toBe(100);
		expect(costs.poolResponses).toBe(1);
		expect(sessionAccountCosts(entries, "claude-sub:b").account.total).toBe(10);
	});
});

describe("signing in to a Claude subscription", () => {
	const authorizeUrl = "https://claude.ai/oauth/authorize?code=true&client_id=test";
	const pastedUrl = "http://localhost:53692/callback?code=abc&state=xyz";

	/** The flow as pi-ai's Anthropic login drives it: a method menu, the auth URL, then the pasted code. */
	function scriptBrowserLogin(deviceIds: (string | undefined)[], fresh: Record<string, unknown> = {}): void {
		scriptedLogin.run = async (interaction, options) => {
			const method = await interaction.prompt({
				type: "select",
				message: "Select Anthropic login method:",
				options: [
					{ id: "browser", label: "Browser login (default)" },
					{ id: "copy_code", label: "Copy code login (headless)" },
				],
			});
			expect(method).toBe("browser");
			interaction.notify({ type: "auth_url", url: authorizeUrl, instructions: "Complete login in your browser." });
			const pasted = await interaction.prompt({
				type: "manual_code",
				message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
				placeholder: "http://localhost:53692/callback",
				signal: interaction.signal,
			});
			expect(pasted).toBe(pastedUrl);
			deviceIds.push(options?.getDeviceId?.());
			return credential(fresh);
		};
	}

	interface AddOptions {
		agentDir?: string;
		settings?: Record<string, unknown>;
		inputs?: (string | undefined)[];
		selects?: (string | undefined)[];
	}

	async function runAdd(options: AddOptions = {}) {
		const agentDir = options.agentDir ?? tempDir();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const runtime = createExtensionRuntime();
		runtime.getSettings = () => ({ defaultProvider: "anthropic", ...options.settings });
		const setModel = vi.fn(async () => true);
		runtime.setModel = setModel;
		const extension = await loadExtensionFromFactory(
			accountsExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:accounts",
		);
		const notifications: { message: string; type?: string }[] = [];
		const dialogs: { kind: string; title: string }[] = [];
		const inputs = [...(options.inputs ?? [pastedUrl])];
		const selects = [...(options.selects ?? ["Browser login (default)"])];
		const refresh = vi.fn(async () => {});
		const ctx = {
			hasUI: true,
			model: undefined,
			modelRegistry: {
				find: () => undefined,
				refresh,
				getAll: () =>
					runtime.pendingVirtualModelRegistrations.map(({ definition }) => createVirtualModel(definition)),
			},
			ui: {
				select: async (title: string, choices: string[]) => {
					dialogs.push({ kind: "select", title });
					// Choosing a model for the pool takes the first one listed.
					return title.startsWith("Model on") ? choices[0] : selects.shift();
				},
				input: async (title: string) => {
					dialogs.push({ kind: "input", title });
					return inputs.shift();
				},
				notify: (message: string, type?: string) => notifications.push({ message, type }),
				setStatus: () => {},
			},
		};
		const add = () => extension.commands.get("accounts")!.handler("add claude-subscription", ctx as never);
		return { agentDir, add, notifications, dialogs, refresh, setModel };
	}

	it("runs the browser flow in this process and stores the account locally", async () => {
		const deviceIds: (string | undefined)[] = [];
		scriptBrowserLogin(deviceIds);
		const { agentDir, add, notifications, dialogs, refresh } = await runAdd({ settings: { deviceId: "install-1" } });

		await add();

		const [account] = listLocalClaudeAccounts(join(agentDir, "accounts"));
		expect(account).toMatchObject({ email: "neil@example.com", disabled: false });
		// The login derives the device id of the account from the id of this installation.
		expect(deviceIds).toEqual(["install-1"]);
		expect(dialogs.map((dialog) => dialog.title)).toEqual([
			"Select Anthropic login method:",
			"Complete login in your browser, or paste the authorization code / redirect URL here:",
		]);
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith(authorizeUrl);
		expect(notifications.map((entry) => entry.message)).toEqual([
			`Complete login in your browser.\nIf the browser did not open, visit:\n${authorizeUrl}`,
			`Added ${account!.name}. It funds pool:claude and pool:all; /accounts switch pins it.`,
		]);
		// The new provider and the pools are registered and awaited, so a model switch sees them.
		expect(refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				providers: expect.arrayContaining([account!.providerId, "pool:claude", "pool:all"]),
			}),
		);
		expect(readFileSync(join(agentDir, "accounts", "claude-subscriptions.json"), "utf8")).toContain(
			account!.providerId,
		);
	});

	it("uses the pool of all accounts for new sessions when it is the first account and no default is set", async () => {
		scriptBrowserLogin([]);
		const { add, setModel } = await runAdd({ settings: { defaultProvider: undefined } });

		await add();

		expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "pool:all", api: "pi-virtual" }), {
			persist: true,
		});
	});

	it("tells when the account signed in again, and keeps one entry", async () => {
		const agentDir = tempDir();
		await new LocalClaudeStore(join(agentDir, "accounts")).save(credential());
		scriptBrowserLogin([], { access: "sk-ant-oat01-second" });
		const { add, notifications } = await runAdd({ agentDir });

		await add();

		expect(listLocalClaudeAccounts(join(agentDir, "accounts"))).toHaveLength(1);
		expect(notifications.at(-1)?.message).toMatch(/^Signed in again to Claude · neil@example\.com/);
	});

	it.each([
		{ name: "dismissing the method menu", selects: [undefined], inputs: [] },
		{ name: "dismissing the code dialog", selects: ["Browser login (default)"], inputs: [undefined] },
	])("stores nothing after $name", async ({ selects, inputs }) => {
		scriptBrowserLogin([]);
		const { agentDir, add, notifications } = await runAdd({ selects, inputs });

		await add();

		expect(notifications.at(-1)).toEqual({ message: "Sign-in cancelled.", type: "warning" });
		expect(listLocalClaudeAccounts(join(agentDir, "accounts"))).toEqual([]);
	});

	it("reports a failed sign-in as an error and stores nothing", async () => {
		scriptedLogin.run = async () => {
			throw new Error("Token exchange request failed");
		};
		const { agentDir, add, notifications } = await runAdd();

		await add();

		expect(notifications.at(-1)).toEqual({ message: "Token exchange request failed", type: "error" });
		expect(listLocalClaudeAccounts(join(agentDir, "accounts"))).toEqual([]);
	});
});
