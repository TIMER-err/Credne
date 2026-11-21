// Local Claude subscription accounts: the credential file in the accounts home and the account list derived from it.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import {
	accountDisplayName,
	isLocalClaudeProvider,
	LOCAL_CLAUDE_PROVIDER_PREFIX,
	localClaudeProviderId,
} from "./catalog.ts";

/** The credential file sits inside the accounts home, which tools may not read. */
const storeFileName = "claude-subscriptions.json";
/** The installation id kept next to it when the app has none yet. */
const installIdFileName = "installation-id";

const identityHashLength = 8;
const maxEmailPartLength = 24;

/** One signed-in Claude subscription. No secrets. */
export interface LocalClaudeAccount {
	/** Short stable id: the identity hash, plus the email local part when known. */
	id: string;
	/** Pi provider id, `claude-sub:<id>`. */
	providerId: string;
	/** Display name for selectors and the footer. */
	name: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	email?: string;
	plan?: string;
	disabled: boolean;
}

/** Fields that tell two sign-ins apart. */
interface ClaudeIdentity {
	accountId?: string;
	orgId?: string;
	email?: string;
}

/** The accounts home of this installation; the broker keeps its files there too. */
export function defaultAccountsHome(): string {
	return join(getAgentDir(), "accounts");
}

/** Local Claude subscriptions in the order they were added, read synchronously so startup can register them. */
export function listLocalClaudeAccounts(home: string = defaultAccountsHome()): LocalClaudeAccount[] {
	return Object.entries(readStoredCredentials(home)).map(([providerId, credential]) =>
		toAccount(providerId, credential),
	);
}

/**
 * Stable id of an account: 8 hex digits of the identity hash, plus a sanitized email local part. The hash
 * covers account and organization, so one login in two organizations gives two accounts.
 */
export function claudeAccountId(identity: ClaudeIdentity): string {
	return composeAccountId(identityHash(identity), identity.email);
}

/** The identity fields of a stored or freshly signed-in credential. */
export function credentialIdentity(credential: OAuthCredential): ClaudeIdentity {
	return { accountId: text(credential.accountId), orgId: text(credential.orgId), email: text(credential.email) };
}

/** Result of storing a credential: the account and whether it is new. */
export interface SavedClaudeAccount {
	account: LocalClaudeAccount;
	added: boolean;
}

/**
 * The credentials of local Claude subscriptions, one OAuth credential per `claude-sub:<id>` provider id in
 * `<home>/claude-subscriptions.json`. Writes and refreshes go through AuthStorage's file lock, so
 * concurrent harness processes never refresh the same rotating refresh token twice.
 */
export class LocalClaudeStore {
	readonly home: string;
	private storage: AuthStorage | undefined;

	constructor(home: string) {
		this.home = home;
	}

	list(): LocalClaudeAccount[] {
		return listLocalClaudeAccounts(this.home);
	}

	get(providerId: string): LocalClaudeAccount | undefined {
		return this.list().find((account) => account.providerId === providerId);
	}

	/**
	 * The installation id the device ids of Claude accounts derive from: the app's, which a login creates, else one kept
	 * in the accounts home so that signing in again to an account keeps its device id.
	 */
	installationId(appDeviceId: string | undefined): string {
		if (appDeviceId) return appDeviceId;
		const path = join(this.home, installIdFileName);
		const kept = readInstallationId(path);
		if (kept) return kept;
		mkdirSync(this.home, { recursive: true, mode: 0o700 });
		try {
			const created = randomUUID();
			// "wx": a concurrent process that created the id first wins, and is read back below.
			writeFileSync(
				path,
				`${created}
`,
				{ flag: "wx", mode: 0o600 },
			);
			return created;
		} catch {
			return readInstallationId(path) ?? randomUUID();
		}
	}

	/** Created on first use, so a user without subscriptions never gets the file. */
	get credentials(): CredentialStore {
		this.storage ??= AuthStorage.create(join(this.home, storeFileName));
		return this.storage;
	}

	/** Store a signed-in credential; signing in again to a known account replaces its tokens and keeps `disabled`. */
	save(credential: OAuthCredential): Promise<SavedClaudeAccount> {
		return this.write(credential, (current) => ({ ...credential, ...keptDisabled(current) }));
	}

	/** Store a credential unless the account already has one, so an import never overwrites newer tokens. */
	adopt(credential: OAuthCredential): Promise<SavedClaudeAccount> {
		return this.write(credential, (current) => (current ? undefined : credential));
	}

	async setDisabled(providerId: string, disabled: boolean): Promise<void> {
		await this.credentials.modify(providerId, async (current) =>
			current?.type === "oauth" ? { ...current, disabled } : undefined,
		);
	}

	/** Record the plan the profile endpoint reports; the plan can change under a long-lived credential. */
	async setPlan(providerId: string, plan: string): Promise<void> {
		await this.credentials.modify(providerId, async (current) =>
			current?.type === "oauth" && current.plan !== plan ? { ...current, plan } : undefined,
		);
	}

	remove(providerId: string): Promise<void> {
		return this.credentials.delete(providerId);
	}

	private async write(
		credential: OAuthCredential,
		next: (current: OAuthCredential | undefined) => OAuthCredential | undefined,
	): Promise<SavedClaudeAccount> {
		const identity = credentialIdentity(credential);
		const hash = identityHash(identity);
		const existing = this.list().find((account) => identityHash(account) === hash);
		const providerId = existing?.providerId ?? localClaudeProviderId(composeAccountId(hash, identity.email));
		await this.credentials.modify(providerId, async (current) =>
			next(current?.type === "oauth" ? current : undefined),
		);
		const account = this.get(providerId);
		if (!account) throw new Error(`Could not store the Claude subscription in ${join(this.home, storeFileName)}`);
		return { account, added: existing === undefined };
	}
}

function readInstallationId(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function keptDisabled(current: OAuthCredential | undefined): { disabled?: true } {
	return current?.disabled === true ? { disabled: true } : {};
}

function composeAccountId(hash: string, email: string | undefined): string {
	const emailPart = sanitizedEmailPart(email);
	return emailPart ? `${hash}-${emailPart}` : hash;
}

function identityHash(identity: ClaudeIdentity): string {
	const known = identity.accountId || identity.orgId;
	// Without either id the email is the only stable identity; without that, every sign-in is a new account.
	const source = known ? `${identity.accountId ?? ""}:${identity.orgId ?? ""}` : (identity.email ?? randomUUID());
	return createHash("sha256").update(source).digest("hex").slice(0, identityHashLength);
}

function sanitizedEmailPart(email: string | undefined): string {
	const localPart = email?.split("@")[0] ?? "";
	return localPart
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "")
		.slice(0, maxEmailPartLength);
}

/** A non-empty string field of a stored credential, which is read from disk or from a login and so is not typed. */
function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** The credential file is read from disk, so every field is checked here. */
function readStoredCredentials(home: string): Record<string, Record<string, unknown>> {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(join(home, storeFileName), "utf8"));
	} catch {
		return {};
	}
	if (typeof data !== "object" || data === null) return {};
	const credentials: Record<string, Record<string, unknown>> = {};
	for (const [providerId, value] of Object.entries(data)) {
		if (!isLocalClaudeProvider(providerId) || typeof value !== "object" || value === null) continue;
		const fields = value as Record<string, unknown>;
		if (fields.type === "oauth") credentials[providerId] = fields;
	}
	return credentials;
}

function toAccount(providerId: string, credential: Record<string, unknown>): LocalClaudeAccount {
	const id = providerId.slice(LOCAL_CLAUDE_PROVIDER_PREFIX.length);
	const email = text(credential.email);
	const orgName = text(credential.orgName);
	const plan = text(credential.plan);
	return {
		id,
		providerId,
		name: accountDisplayName({ provider: "claude", kind: "oauth", id, email, label: orgName, plan }),
		accountId: text(credential.accountId),
		orgId: text(credential.orgId),
		orgName,
		email,
		plan,
		disabled: credential.disabled === true,
	};
}
