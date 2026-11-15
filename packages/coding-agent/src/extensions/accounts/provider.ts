import {
	type Api,
	createProvider,
	type Model,
	type Provider,
	type ProviderResponse,
	type ProviderStreams,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	type AccountCatalog,
	accountDisplayName,
	accountProviderId,
	BROKER_PLACEHOLDER_URL,
	poolDisplayName,
	poolProviderId,
} from "./catalog.ts";
import type { BrokerClient, BrokerTarget } from "./client.ts";

/** Response header naming the account that served a request, base64url encoded. */
export const ACCOUNT_HEADER = "x-credne-account";

/** What one Pi provider routes to. */
export interface AccountProviderSpec {
	id: string;
	name: string;
	target: BrokerTarget;
	/** Disabled accounts stay registered so sessions that used them fail with a clear reason. */
	disabled: boolean;
	models: Model<Api>[];
}

/** Called with the account key that served a request of a provider. */
export type ServedByListener = (providerId: string, accountKey: string) => void;

/** One spec per cached pool and account; pools first, `pool:all` leading. */
export function providerSpecs(catalog: AccountCatalog): AccountProviderSpec[] {
	return [
		...catalog.pools.map(
			(pool): AccountProviderSpec => ({
				id: poolProviderId(pool.name),
				name: poolDisplayName(pool),
				target: { type: "pool", name: pool.name },
				disabled: false,
				models: pool.models,
			}),
		),
		...catalog.accounts.map(
			(account): AccountProviderSpec => ({
				id: accountProviderId(account.id),
				name: accountDisplayName(account),
				target: { type: "account", key: account.key },
				disabled: account.disabled,
				models: account.models,
			}),
		),
	];
}

/**
 * A Pi provider backed by the account broker. Requests use Pi's own native API adapters, so
 * streaming, tool calls, reasoning and usage parsing are unchanged; only the endpoint and the
 * credential differ. The credential is the broker's per-run token, never a provider secret.
 */
export function createAccountProvider(
	spec: AccountProviderSpec,
	client: BrokerClient,
	onServedBy?: ServedByListener,
): Provider {
	const report = (response: ProviderResponse) => {
		const key = response.headers[ACCOUNT_HEADER];
		if (key) onServedBy?.(spec.id, key);
	};
	return createProvider({
		id: spec.id,
		name: spec.name,
		baseUrl: BROKER_PLACEHOLDER_URL,
		auth: {
			apiKey: {
				name: "Account broker",
				// Side-effect free: availability comes from the catalog, so listing models never starts the broker.
				check: async () => (spec.disabled ? undefined : { type: "api_key", source: "account broker" }),
				resolve: async ({ signal }) => {
					if (spec.disabled) return undefined;
					const connection = await client.connect(signal);
					return {
						auth: { apiKey: connection.token, baseUrl: client.routeBaseUrl(connection, spec.target) },
						source: "account broker",
					};
				},
			},
		},
		models: spec.models,
		// A pool may mix APIs (Claude and GPT models), so every adapter is available.
		api: {
			"anthropic-messages": observed(anthropicMessagesApi(), report),
			"openai-responses": observed(openAIResponsesApi(), report),
			"openai-completions": observed(openAICompletionsApi(), report),
		},
	});
}

/** Wraps an adapter so each HTTP response is reported before the caller's own onResponse runs. */
function observed(streams: ProviderStreams, report: (response: ProviderResponse) => void): ProviderStreams {
	const withReport = <T extends StreamOptions>(options: T | undefined): T =>
		({
			...options,
			onResponse: (response: ProviderResponse, model: Model<Api>) => {
				report(response);
				return options?.onResponse?.(response, model);
			},
		}) as T;
	return {
		stream: (model, context, options) => streams.stream(model, context, withReport(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, withReport(options)),
	};
}
