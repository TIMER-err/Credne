import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { type AccountCatalog, buildCatalog, readCatalog, writeCatalog } from "./catalog.ts";
import type { BrokerAccount, BrokerClient } from "./client.ts";
import { type AccountProviderSpec, createAccountProvider, providerSpecs, type ServedByListener } from "./provider.ts";

/**
 * Keeps one Pi provider registered per broker pool and account. Startup registers from the cached
 * catalog without contacting the broker; `sync()` refreshes the catalog from the broker.
 */
export class AccountRegistry {
	private readonly pi: ExtensionAPI;
	private readonly client: BrokerClient;
	private readonly catalogPath: string;
	private readonly onServedBy: ServedByListener;
	private specs: AccountProviderSpec[] = [];

	constructor(pi: ExtensionAPI, client: BrokerClient, catalogPath: string, onServedBy: ServedByListener) {
		this.pi = pi;
		this.client = client;
		this.catalogPath = catalogPath;
		this.onServedBy = onServedBy;
		this.apply(readCatalog(catalogPath));
	}

	/** Providers registered from the current catalog. */
	providers(): readonly AccountProviderSpec[] {
		return this.specs;
	}

	provider(id: string): AccountProviderSpec | undefined {
		return this.specs.find((spec) => spec.id === id);
	}

	/** The pinned-account provider whose broker key is `key`. */
	accountByKey(key: string): AccountProviderSpec | undefined {
		return this.specs.find((spec) => spec.target.type === "account" && spec.target.key === key);
	}

	/** Refresh accounts and models from the broker, re-register providers and wait until Pi sees them. */
	async sync(ctx: ExtensionContext, signal?: AbortSignal): Promise<BrokerAccount[]> {
		const accounts = await this.client.listAccounts(signal);
		const accountModels = new Map(
			await Promise.all(
				accounts.map(
					async (account) => [account.key, await this.client.accountModels(account.key, signal)] as const,
				),
			),
		);
		const catalog = buildCatalog(accounts, accountModels, (provider, id) => ctx.modelRegistry.find(provider, id));
		writeCatalog(this.catalogPath, catalog);
		const previous = this.specs.map((spec) => spec.id);
		this.apply(catalog);
		const changed = [...new Set([...previous, ...this.specs.map((spec) => spec.id)])];
		// Registration recomputes availability asynchronously; wait so setModel() sees new accounts.
		await ctx.modelRegistry.refresh({ providers: changed, allowNetwork: false, signal });
		return accounts;
	}

	private apply(catalog: AccountCatalog): void {
		const specs = providerSpecs(catalog);
		const ids = new Set(specs.map((spec) => spec.id));
		for (const spec of this.specs) {
			if (!ids.has(spec.id)) this.pi.unregisterProvider(spec.id);
		}
		for (const spec of specs) this.pi.registerProvider(createAccountProvider(spec, this.client, this.onServedBy));
		this.specs = specs;
	}
}
