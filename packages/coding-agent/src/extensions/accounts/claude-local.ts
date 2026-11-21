// Claude subscriptions served by this process: providers on pi-ai's Anthropic adapter, token refresh and usage.
import {
	type Api,
	type AssistantMessage,
	type AuthResult,
	createProvider,
	type FetchFunction,
	getProviderHttpErrorDetails,
	type Model,
	type OAuthAuth,
	type OAuthCredential,
	type Provider,
	type ProviderResponse,
	refreshStoredOAuthCredential,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { ClaudeLimits, claudeModelKind, usageLimitFailure } from "./claude-limits.ts";
import { type ClaudeSignIn, signInClaudeSubscription } from "./claude-login.ts";
import { type LocalClaudeAccount, LocalClaudeStore, type SavedClaudeAccount } from "./claude-store.ts";
import { type ClaudeUsageResult, fetchClaudePlan, fetchClaudeUsageReport, toBrokerUsage } from "./claude-usage.ts";
import type { BrokerUsage } from "./client.ts";
import { type AccountProviderSpec, observed, type StreamObserver } from "./provider.ts";

export { type LocalClaudeAccount, listLocalClaudeAccounts } from "./claude-store.ts";

const claudeApiUrl = "https://api.anthropic.com";

/** Tokens that expire within this window are refreshed before a request, as pi-ai does for stored OAuth. */
const minTokenValidityMs = 5 * 60_000;

export interface LocalClaudeOptions {
	/** Accounts home that holds `claude-subscriptions.json`. */
	home: string;
	/** Replaces Anthropic's OAuth flow, for tests. */
	oauth?: OAuthAuth;
	/** Replaces the global fetch for usage requests, for tests. */
	fetch?: FetchFunction;
}

/** Result of `LocalClaude.signIn()`. */
export type LocalClaudeSignIn = ({ type: "saved" } & SavedClaudeAccount) | Exclude<ClaudeSignIn, { type: "signed-in" }>;

/**
 * The Claude subscriptions of this installation. Each one is a Pi provider `claude-sub:<id>` that sends
 * requests from pi-ai's own Anthropic adapter straight to api.anthropic.com with the account's OAuth
 * token. The adapter shapes them like Claude Code requests. Tokens are stored and refreshed here; the
 * broker never sees them.
 */
export class LocalClaude {
	readonly store: LocalClaudeStore;
	readonly limits = new ClaudeLimits();
	private readonly oauth: OAuthAuth;
	private readonly baseProvider = anthropicProvider();
	private readonly fetch: FetchFunction | undefined;

	constructor(options: LocalClaudeOptions) {
		this.store = new LocalClaudeStore(options.home);
		this.fetch = options.fetch;
		const oauth = options.oauth ?? this.baseProvider.auth.oauth;
		if (!oauth) throw new Error("pi-ai's anthropic provider has no OAuth login");
		this.oauth = oauth;
	}

	/** Signed-in subscriptions in the order they were added. */
	accounts(): LocalClaudeAccount[] {
		return this.store.list();
	}

	/** The provider entry of an account: the built-in Anthropic models, listed under the account's provider id. */
	spec(account: LocalClaudeAccount): AccountProviderSpec {
		return {
			id: account.providerId,
			name: account.name,
			target: { type: "local", id: account.id },
			family: "claude",
			subscription: true,
			disabled: account.disabled,
			models: this.baseProvider.getModels().map((model) => cloneModel(model, account.providerId)),
		};
	}

	/** What the provider's streams report: window headers of every response and the final reply of every request. */
	observer(providerId: string): StreamObserver {
		return {
			response: (response, model) => this.recordResponse(providerId, response, model),
			result: (message) => this.recordFailure(providerId, message),
		};
	}

	createProvider(spec: AccountProviderSpec): Provider {
		return createProvider({
			id: spec.id,
			name: spec.name,
			baseUrl: claudeApiUrl,
			auth: {
				apiKey: {
					name: "Claude subscription",
					// Side-effect free: the sign-in is checked on disk, and no token is refreshed.
					check: async () =>
						this.store.get(spec.id)?.disabled === false
							? { type: "oauth", source: "Claude subscription" }
							: undefined,
					resolve: ({ signal }) => this.resolveAuth(spec.id, signal),
				},
				// Declared so the footer marks the account as a subscription. Sign-in lives in /accounts, because the
				// credential belongs to this extension's store and not to /login's.
				oauth: {
					...this.oauth,
					name: "Claude subscription",
					isSubscription: true,
					login: () =>
						Promise.reject(new Error("Add Claude subscriptions with /accounts add claude-subscription.")),
				},
			},
			models: spec.models,
			api: observed(anthropicMessagesApi(), this.observer(spec.id)),
		});
	}

	/** Browser sign-in; the account is stored, and an account that signs in again keeps its id and `disabled`. */
	async signIn(ui: ExtensionUIContext, deviceId: string): Promise<LocalClaudeSignIn> {
		const result = await signInClaudeSubscription(ui, this.oauth, deviceId);
		if (result.type !== "signed-in") return result;
		return { type: "saved", ...(await this.store.save(result.credential)) };
	}

	/**
	 * Usage windows and extra-usage credits of an account, fetched with a fresh token. The windows also update the
	 * limits that rank the account in pools, and the plan from the profile endpoint is stored with the account.
	 */
	async usage(providerId: string, signal: AbortSignal = new AbortController().signal): Promise<BrokerUsage> {
		const token = (await this.resolveAuth(providerId, signal))?.auth.apiKey;
		if (!token) {
			return {
				status: "unavailable",
				reason: "This subscription is disabled or no longer signed in.",
				windows: [],
				credits: [],
			};
		}
		const [result, plan] = await Promise.all([
			this.fetchUsageReport(providerId, token, signal),
			fetchClaudePlan(token, { signal, fetch: this.fetch }),
		]);
		if (plan) await this.store.setPlan(providerId, plan);
		return toBrokerUsage(result);
	}

	/**
	 * Ask the usage endpoint for an account's windows so pools can rank it. Best effort: a failure leaves the
	 * account unmeasured and keeps the endpoint quiet for a minute.
	 */
	async refreshUsage(providerId: string, signal: AbortSignal): Promise<void> {
		try {
			const token = (await this.resolveAuth(providerId, signal))?.auth.apiKey;
			if (token) await this.fetchUsageReport(providerId, token, signal);
		} catch {
			this.limits.noteUsageFailure(providerId);
		}
	}

	/** Short availability summary for lists. */
	state(account: LocalClaudeAccount): string {
		if (account.disabled) return "disabled";
		const until = this.limits.blockedUntil(account.providerId, undefined);
		return until === undefined ? "ready" : `limit reached until ${new Date(until).toLocaleTimeString()}`;
	}

	/** The stored token, refreshed under the credential file's lock when it expires within five minutes. */
	async resolveAuth(providerId: string, signal: AbortSignal): Promise<AuthResult | undefined> {
		const credentials = this.store.credentials;
		const stored = await credentials.read(providerId, { signal });
		if (stored?.type !== "oauth" || stored.disabled === true) return undefined;
		const expiresSoon = (credential: OAuthCredential) => Date.now() + minTokenValidityMs >= credential.expires;
		const current = expiresSoon(stored)
			? await refreshStoredOAuthCredential(credentials, providerId, this.oauth, expiresSoon, signal)
			: stored;
		if (!current || current.disabled === true) return undefined;
		const env = await this.oauth.toEnv?.(current);
		return { auth: await this.oauth.toAuth(current), ...(env ? { env } : {}), source: "OAuth" };
	}

	private async fetchUsageReport(providerId: string, token: string, signal: AbortSignal): Promise<ClaudeUsageResult> {
		let result: ClaudeUsageResult;
		try {
			result = await fetchClaudeUsageReport(token, { signal, fetch: this.fetch });
		} catch (error) {
			this.limits.noteUsageFailure(providerId);
			throw error;
		}
		if (result.type === "report") this.limits.ingestUsage(providerId, result.report);
		else this.limits.noteUsageFailure(providerId);
		return result;
	}

	/** Every response reports the unified windows; a successful one also proves the account serves the model. */
	private recordResponse(providerId: string, response: ProviderResponse, model: Model<Api>): void {
		this.limits.ingestHeaders(providerId, response.headers);
		if (response.status >= 200 && response.status < 300) {
			this.limits.recordServed(providerId, claudeModelKind(model.id));
		}
	}

	/**
	 * A failed reply carries the rejected response's rate-limit headers in its HTTP error diagnostic; a failure
	 * that names a usage limit blocks the account until the reset.
	 */
	private recordFailure(providerId: string, message: AssistantMessage): void {
		if (message.stopReason !== "error") return;
		const headers = getProviderHttpErrorDetails(message)?.headers;
		if (headers) this.limits.ingestHeaders(providerId, headers);
		const failure = usageLimitFailure(message, Date.now());
		if (failure) this.limits.markReached(providerId, claudeModelKind(message.model), failure.until);
	}
}

function cloneModel(model: Model<"anthropic-messages">, providerId: string): Model<"anthropic-messages"> {
	const fallbacks = model.compat?.allowedFallbackModels;
	if (!model.compat || !fallbacks) return { ...model, provider: providerId };
	// Pi prices a fallback response by provider and model, so the fallbacks name the cloned provider.
	const compat = {
		...model.compat,
		allowedFallbackModels: fallbacks.map((entry) => ({ ...entry, provider: providerId })),
	};
	return { ...model, provider: providerId, compat };
}
