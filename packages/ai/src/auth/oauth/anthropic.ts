/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { getClaudeCodeOAuthUserAgent, getClaudeCodeVersion } from "../../api/claude-subscription/fingerprint.ts";
import {
	CLAUDE_ACCOUNT_UUID_ENV,
	CLAUDE_DEVICE_ID_ENV,
	deriveClaudeDeviceId,
} from "../../api/claude-subscription/identity.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { promptForManualCode, startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const BOOTSTRAP_MODEL = "claude-opus-4-8";
const OAUTH_BETA = "oauth-2025-04-20";
const IPV4_LOOPBACK = "127.0.0.1";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || IPV4_LOOPBACK;
// The redirect names `localhost`, which resolves to both loopback families, and a browser may try either. The default
// host is also bound on the IPv6 loopback, so a process holding that address on the same port cannot take the code.
const CALLBACK_COMPANION_HOST = CALLBACK_HOST === IPV4_LOOPBACK ? "::1" : undefined;
// oh-my-pi's preferred port, so it can be forwarded into containers or over SSH. Anthropic accepts any loopback port,
// so login falls back to a free port when this one cannot be bound (#10571).
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
// Claude Code's manual redirect: the page shows the code to copy and paste back.
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_BROWSER_LOGIN_METHOD = "browser";
const ANTHROPIC_COPY_CODE_LOGIN_METHOD = "copy_code";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
// oh-my-pi's PKCE verifier: 96 random bytes, 128 base64url characters.
const PKCE_VERIFIER_BYTES = 96;

/** A pasted redirect URL, query string, or `code#state` pair; a bare value is the code. */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	// A bare code, possibly with the state after a `#`.
	const [code, state] = value.split("#", 2);
	return { code, state };
}

/**
 * Whether a pasted input carries the state of another login. It answers a different sign-in, so the login asks for the
 * input again instead of failing, as oh-my-pi's manual prompt does. An input with no state is taken as this login's.
 */
function isForeignAuthorizationInput(input: string, expectedState: string): boolean {
	const { state } = parseAuthorizationInput(input);
	return Boolean(state) && state !== expectedState;
}

/** The CSRF state of a login: 16 random bytes as hex, as oh-my-pi's callback flow generates it. */
function generateOAuthState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The authorize URL's query, in oh-my-pi's order: the standard parameters, then `code=true`. */
function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: redirectUri,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		code: "true",
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

/** POSTs a JSON body with `headers` and then `Content-Type`, as oh-my-pi's token requests do; 30 seconds at most. */
async function postJson(
	url: string,
	body: Record<string, string | number>,
	signal: AbortSignal,
	headers?: Record<string, string>,
): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
				state,
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: AnthropicTokenResponse;
	try {
		tokenData = JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	const credential = tokenCredential(tokenData);
	const orgId = nonEmpty(tokenData.organization?.uuid);
	const orgName = nonEmpty(tokenData.organization?.name);
	if (orgId) credential.orgId = orgId;
	if (orgName) credential.orgName = orgName;
	return withBootstrapIdentity(credential, true, signal);
}

/** Token endpoint response (wire input); Anthropic includes the signed-in account and organization. */
interface AnthropicTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	account?: { uuid?: string; email_address?: string };
	organization?: { uuid?: string; name?: string };
}

function nonEmpty(value: string | undefined): string | undefined {
	return value ? value : undefined;
}

// A token is treated as expired this long before its stated expiry, as oh-my-pi's `skew-ms=300000` does.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * The credential a token response describes. A response without a refresh token keeps `previousRefresh` (a refresh
 * grant that does not rotate); one without an access token or a lifetime is refused, with its body in the message.
 */
function tokenCredential(tokenData: AnthropicTokenResponse, previousRefresh?: string): OAuthCredential {
	if (!tokenData.access_token) {
		throw new Error(`Anthropic token response missing access token: ${JSON.stringify(tokenData).slice(0, 500)}`);
	}
	if (typeof tokenData.expires_in !== "number" || !Number.isFinite(tokenData.expires_in)) {
		throw new Error("Anthropic token response missing expires_in");
	}
	const credential: OAuthCredential = {
		type: "oauth",
		refresh: nonEmpty(tokenData.refresh_token) ?? previousRefresh ?? "",
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - EXPIRY_SKEW_MS,
	};
	const accountId = nonEmpty(tokenData.account?.uuid);
	const email = nonEmpty(tokenData.account?.email_address);
	if (accountId) credential.accountId = accountId;
	if (email) credential.email = email;
	return credential;
}

/**
 * Fills account identity (and, at login, the organization) from Claude Code's CLI bootstrap endpoint when the
 * token response left it out. The organization is fixed at login: refreshes never rewrite it, so a background
 * refresh cannot silently move a credential to another subscription workspace.
 */
async function withBootstrapIdentity(
	credential: OAuthCredential,
	includeOrg: boolean,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const orgSatisfied = !includeOrg || credential.orgId !== undefined;
	if (credential.accountId && credential.email && orgSatisfied) return credential;
	try {
		const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(BOOTSTRAP_MODEL)}`;
		const response = await fetch(url, {
			headers: {
				Accept: "application/json, text/plain, */*",
				Authorization: `Bearer ${credential.access}`,
				"Content-Type": "application/json",
				"User-Agent": `claude-code/${getClaudeCodeVersion()}`,
				"anthropic-beta": OAUTH_BETA,
			},
			signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
		});
		if (!response.ok) return credential;
		const data = (await response.json()) as {
			oauth_account?: {
				account_uuid?: string;
				account_email?: string;
				organization_uuid?: string;
				organization_name?: string;
			};
		};
		const account = data.oauth_account;
		const filled: OAuthCredential = { ...credential };
		const accountId = credential.accountId ?? nonEmpty(account?.account_uuid);
		const email = credential.email ?? nonEmpty(account?.account_email);
		if (accountId) filled.accountId = accountId;
		if (email) filled.email = email;
		if (includeOrg) {
			const orgId = credential.orgId ?? nonEmpty(account?.organization_uuid);
			const orgName = credential.orgName ?? nonEmpty(account?.organization_name);
			if (orgId) filled.orgId = orgId;
			if (orgName) filled.orgName = orgName;
		}
		return filled;
	} catch {
		// Identity is best effort: login and refresh succeed without it.
		return credential;
	}
}

/** Stores the device id Claude Code requests from this installation will report for the account. */
async function withDeviceId(credential: OAuthCredential, options: LoginOptions | undefined): Promise<OAuthCredential> {
	const installId = options?.getDeviceId?.();
	if (!installId) return credential;
	const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
	return { ...credential, deviceId: await deriveClaudeDeviceId(installId, accountId) };
}

async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE(PKCE_VERIFIER_BYTES);
	const expectedState = generateOAuthState();
	const startCallbackServer = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Anthropic",
			host: CALLBACK_HOST,
			port,
			companionHost: CALLBACK_COMPANION_HOST,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			state: expectedState,
			complete: async (code) => code,
			signal: interaction.signal,
		});
	// Without a callback server, login continues with the pasted redirect URL.
	const callback = await startCallbackServer(CALLBACK_PORT)
		.catch(() => startCallbackServer(0))
		.catch(() => undefined);
	const redirectUri = callback?.redirectUri ?? REDIRECT_URI;

	try {
		interaction.notify({
			type: "auth_url",
			url: buildAuthorizeUrl(redirectUri, challenge, expectedState),
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: redirectUri,
			accepts: (input) => !isForeignAuthorizationInput(input, expectedState),
		});
		let code: string | undefined;
		let state = expectedState;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			code = parsed.code;
			state = parsed.state ?? expectedState;
		}

		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, state, verifier, redirectUri, interaction.signal);
	} finally {
		callback?.close();
	}
}

async function loginAnthropicCopyCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE(PKCE_VERIFIER_BYTES);
	const expectedState = generateOAuthState();
	interaction.notify({
		type: "auth_url",
		url: buildAuthorizeUrl(COPY_CODE_REDIRECT_URI, challenge, expectedState),
		instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
	});

	const input = await promptForManualCode(
		interaction,
		{
			message: "Paste the code Anthropic shows after you sign in:",
			placeholder: "code#state",
			accepts: (pasted) => !isForeignAuthorizationInput(pasted, expectedState),
		},
		interaction.signal,
	);
	const parsed = parseAuthorizationInput(input);
	if (!parsed.code) throw new Error("Missing authorization code");
	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	return await exchangeAuthorizationCode(
		parsed.code,
		parsed.state ?? expectedState,
		verifier,
		COPY_CODE_REDIRECT_URI,
		interaction.signal,
	);
}

/**
 * Refreshes an Anthropic OAuth token with the headers Claude Code sends on refresh. Identity the response
 * leaves out, the organization chosen at login and the stored device id carry over from the stored credential.
 */
async function refreshAnthropicToken(stored: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: stored.refresh,
			},
			signal,
			{ "anthropic-beta": OAUTH_BETA, "User-Agent": getClaudeCodeOAuthUserAgent() },
		);
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: AnthropicTokenResponse;
	try {
		data = JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	// The bootstrap runs on what the response itself carried, as oh-my-pi's `after-refresh` hook does; only then is
	// the stored row merged under the result.
	const refreshed = await withBootstrapIdentity(tokenCredential(data, stored.refresh), false, signal);
	return mergeRefreshedCredential(stored, refreshed);
}

/**
 * The stored credential with the refreshed tokens on top. The refreshed account and email win; the stored row fills
 * what the refresh left out, and everything else it holds (the organization chosen at login, the device id) carries
 * over unchanged.
 */
function mergeRefreshedCredential(stored: OAuthCredential, refreshed: OAuthCredential): OAuthCredential {
	const merged: OAuthCredential = {
		...stored,
		access: refreshed.access,
		refresh: refreshed.refresh,
		expires: refreshed.expires,
	};
	const accountId = refreshed.accountId ?? stored.accountId;
	const email = refreshed.email ?? stored.email;
	if (accountId !== undefined) merged.accountId = accountId;
	if (email !== undefined) merged.email = email;
	return merged;
}

export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,

	async login(interaction, options) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select Anthropic login method:",
			options: [
				{ id: ANTHROPIC_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: ANTHROPIC_COPY_CODE_LOGIN_METHOD, label: "Copy code login (headless)" },
			],
		});

		if (method === ANTHROPIC_COPY_CODE_LOGIN_METHOD) {
			return withDeviceId(await loginAnthropicCopyCode(interaction), options);
		}
		if (method !== ANTHROPIC_BROWSER_LOGIN_METHOD) {
			throw new Error(`Unknown Anthropic login method: ${method}`);
		}

		return withDeviceId(await loginAnthropic(interaction), options);
	},

	refresh: (credential, signal) => refreshAnthropicToken(credential, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},

	async toEnv(credential) {
		const env: Record<string, string> = {};
		if (typeof credential.accountId === "string") env[CLAUDE_ACCOUNT_UUID_ENV] = credential.accountId;
		if (typeof credential.deviceId === "string") env[CLAUDE_DEVICE_ID_ENV] = credential.deviceId;
		return env;
	},
};
