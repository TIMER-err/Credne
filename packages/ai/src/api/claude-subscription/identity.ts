/**
 * Request shaping that makes an Anthropic subscription (OAuth) request match Claude Code's CLI: the billing
 * system block with its `cch` body hash, the metadata `user_id`, and the wire-only tool-name prefix.
 * Ported from oh-my-pi's `providers/anthropic.ts` and `providers/anthropic-identity.ts`.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { xxHash64 } from "../../utils/xxhash64.ts";
import { getClaudeCodeVersion } from "./fingerprint.ts";

/** Provider env name carrying the subscription account uuid of the serving credential. */
export const CLAUDE_ACCOUNT_UUID_ENV = "ANTHROPIC_OAUTH_ACCOUNT_UUID";
/** Provider env name carrying the stable Claude device id of the serving credential. */
export const CLAUDE_DEVICE_ID_ENV = "ANTHROPIC_OAUTH_DEVICE_ID";

/** Per-request Claude Code values that need async hashing, computed once before the body is built. */
export interface ClaudeCodeRequestIdentity {
	/** `cc_version` value of the billing block: `<version>.<3 hex fingerprint chars>`. */
	ccVersion: string;
	/**
	 * The caller's session id, sent verbatim as `X-Claude-Code-Session-Id`: the request's `sessionId`, else the session
	 * of the caller's metadata `user_id`, else its prompt cache key. Undefined when the request has none of them, and
	 * then no header is sent.
	 */
	sessionId: string | undefined;
	/** Metadata `user_id`: Claude Code's JSON with session, account and device, or the caller's own Claude id. */
	userId: string;
}

const BILLING_FINGERPRINT_SALT = "59cf53e54c78";
const DEVICE_ID_INSTALL_DOMAIN = "omp-claude-device-id-v1:";
const DEVICE_ID_ACCOUNT_DOMAIN = "omp-claude-device-id-v2";

/**
 * Computes the billing `cc_version` and the metadata `user_id` for one request. The billing fingerprint uses
 * characters 4, 7 and 20 of the first user turn, as Claude Code's `computeFingerprint` does. `metadata` is the caller's
 * request metadata: its `user_id` is kept when it is a Claude Code id, and the account it names
 * ({@link readClaudeMetadataAccountId}) is the account of an id built for the request; `promptCacheKey` is the last
 * resort for the session header.
 */
export async function prepareClaudeCodeRequest(
	firstUserText: string,
	sessionId: string | undefined,
	env: Record<string, string> | undefined,
	metadata?: Record<string, unknown>,
	promptCacheKey?: string,
): Promise<ClaudeCodeRequestIdentity> {
	const version = getClaudeCodeVersion();
	const sample = [4, 7, 20].map((index) => firstUserText[index] ?? "0").join("");
	const fingerprint = (await sha256Hex(`${BILLING_FINGERPRINT_SALT}${sample}${version}`)).slice(0, 3);
	const callerUserId = readMetadataString(metadata, "user_id");
	const servingAccountId = getProviderEnvValue(CLAUDE_ACCOUNT_UUID_ENV, env);
	return {
		ccVersion: `${version}.${fingerprint}`,
		sessionId: sessionId ?? extractClaudeMetadataSessionId(callerUserId) ?? promptCacheKey,
		userId: await resolveClaudeUserId(callerUserId, sessionId, {
			serving: servingAccountId,
			built: readClaudeMetadataAccountId(metadata) ?? servingAccountId,
			env,
		}),
	};
}

/** A non-empty string of the caller's request metadata, which the caller types freely. */
function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The account a caller's request metadata names: `account_uuid`, else the aliases `accountId` and `account_id`, as
 * oh-my-pi reads them.
 */
export function readClaudeMetadataAccountId(metadata: Record<string, unknown> | undefined): string | undefined {
	return (
		readMetadataString(metadata, "account_uuid") ??
		readMetadataString(metadata, "accountId") ??
		readMetadataString(metadata, "account_id")
	);
}

/**
 * Derives the stable device id stored with a credential at login, from the app installation id and the
 * subscription account. One installation shows one device per account, as Claude Code does.
 */
export async function deriveClaudeDeviceId(installId: string, accountId: string | undefined): Promise<string> {
	if (accountId) return sha256Hex(`${DEVICE_ID_ACCOUNT_DOMAIN}\0${installId}\0${accountId}`);
	return sha256Hex(`${DEVICE_ID_INSTALL_DOMAIN}${installId}`);
}

// The stored device id belongs to the serving account, so it is never paired with another account's uuid. Credentials
// stored before device ids existed have no install id; the account keeps them stable.
async function resolveDeviceId(
	accountId: string,
	servingAccountId: string | undefined,
	env: Record<string, string> | undefined,
): Promise<string> {
	const stored = accountId === servingAccountId ? getProviderEnvValue(CLAUDE_DEVICE_ID_ENV, env) : undefined;
	return stored ?? (await deriveClaudeDeviceId("credne", accountId));
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Claude Code's legacy "cloaking" id: a 64 hex user hash, then lowercase account and session uuids.
const CLOAKING_USER_ID_PATTERN = new RegExp(`^user_[0-9a-fA-F]{64}_account_${UUID_SOURCE}_session_(${UUID_SOURCE})$`);

/** The record of a Claude Code JSON `user_id`: an object with a non-empty string `session_id`. */
function parseClaudeJsonUserId(userId: string): Record<string, unknown> | undefined {
	if (!userId.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	return typeof record.session_id === "string" && record.session_id.length > 0 ? record : undefined;
}

/** The session id inside a caller's Claude Code metadata `user_id`, in either of its shapes. */
export function extractClaudeMetadataSessionId(userId: unknown): string | undefined {
	if (typeof userId !== "string") return undefined;
	const cloaked = CLOAKING_USER_ID_PATTERN.exec(userId);
	if (cloaked) return cloaked[1];
	const session = parseClaudeJsonUserId(userId)?.session_id;
	return typeof session === "string" ? session : undefined;
}

/** The accounts a metadata `user_id` is resolved against. */
interface UserIdAccounts {
	/** The account of the serving credential, from its env. */
	serving: string | undefined;
	/** The account of an id built for the request: the one the caller's metadata names, else the serving one. */
	built: string | undefined;
	env: Record<string, string> | undefined;
}

/**
 * The metadata `user_id` of a request. A caller's Claude Code id is kept verbatim, unless it names another account
 * than the serving credential: then it is rebuilt for the serving account (device, session, account) so an account
 * rotation never pairs one account's token with another's identity. Otherwise the id is built in the form Claude Code
 * sends: session, then account and device, which are present only when the account is known.
 */
async function resolveClaudeUserId(
	callerUserId: string | undefined,
	sessionId: string | undefined,
	accounts: UserIdAccounts,
): Promise<string> {
	const { serving, built, env } = accounts;
	if (callerUserId !== undefined) {
		if (CLOAKING_USER_ID_PATTERN.test(callerUserId)) return callerUserId;
		const caller = parseClaudeJsonUserId(callerUserId);
		if (caller && (!serving || caller.account_uuid === serving)) return callerUserId;
		if (caller && serving) {
			const rebound = {
				device_id: await resolveDeviceId(serving, serving, env),
				session_id: caller.session_id,
				account_uuid: serving,
			};
			return JSON.stringify(rebound);
		}
	}
	const userId: Record<string, string> = { session_id: sessionId ?? globalThis.crypto.randomUUID() };
	if (built) {
		userId.account_uuid = built;
		userId.device_id = await resolveDeviceId(built, serving, env);
	}
	return JSON.stringify(userId);
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CCH_PLACEHOLDER_TEXT = "cch=00000";

/** Text of the billing system block; `cch=00000` is replaced by {@link signClaudeCodeBody} on the wire. */
export function buildClaudeBillingBlockText(ccVersion: string): string {
	return `${BILLING_HEADER_PREFIX} cc_version=${ccVersion}; cc_entrypoint=cli; ${CCH_PLACEHOLDER_TEXT};`;
}

const CCH_SEED = 0x4d659218e32a3268n;
const textEncoder = new TextEncoder();
// The SDK serializes `messages` before `system`, so user content cannot match this system[0] prefix.
const BILLING_SYSTEM_MARKER = `"system":[{"type":"text","text":"${BILLING_HEADER_PREFIX}`;
const CCH_SEARCH_WINDOW = 150;

/**
 * Writes the `cch` value over the billing block placeholder of a serialized request body: the low 20 bits of
 * XXH64(body with the placeholder, seed), as 5 hex characters. Returns the body unchanged when it carries no
 * billing block. Must run on the uncompressed body.
 */
export function signClaudeCodeBody(body: string): string {
	const markerIndex = body.indexOf(BILLING_SYSTEM_MARKER);
	if (markerIndex === -1) return body;
	const searchFrom = markerIndex + BILLING_SYSTEM_MARKER.length;
	const placeholderIndex = body.indexOf(CCH_PLACEHOLDER_TEXT, searchFrom);
	if (placeholderIndex === -1 || placeholderIndex - searchFrom > CCH_SEARCH_WINDOW) return body;
	// The hash covers the UTF-8 bytes with the placeholder in place; only ASCII characters are replaced.
	const cch = (xxHash64(textEncoder.encode(body), CCH_SEED) & 0xfffffn).toString(16).padStart(5, "0");
	const valueIndex = placeholderIndex + "cch=".length;
	return `${body.slice(0, valueIndex)}${cch}${body.slice(valueIndex + cch.length)}`;
}

/** Prefix Claude Code's wire format puts on client tools, keeping them apart from Anthropic's built-in tools. */
const CLAUDE_TOOL_PREFIX = "_";
const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set(["web_search", "code_execution", "text_editor", "computer"]);

/** Adds the wire-only tool prefix; Anthropic's built-in tool names stay unprefixed. */
export function applyClaudeToolPrefix(name: string): string {
	if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;
	return `${CLAUDE_TOOL_PREFIX}${name}`;
}

/** Removes one wire-only tool prefix. */
export function stripClaudeToolPrefix(name: string): string {
	return name.startsWith(CLAUDE_TOOL_PREFIX) ? name.slice(CLAUDE_TOOL_PREFIX.length) : name;
}
