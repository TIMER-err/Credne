/**
 * Claude Code wire fingerprint for Anthropic subscription (OAuth) requests: CLI version, User-Agent,
 * Stainless client headers, beta profile, version adoption after a `claude_code_version_too_old` rejection.
 * Ported from oh-my-pi's `claude-code-fingerprint.ts` and `anthropic-headers.ts`.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";

/** Pinned Claude Code CLI version: the fallback for {@link getClaudeCodeVersion}. */
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.326";
/** `@anthropic-ai/sdk` version bundled by the pinned Claude Code release. */
export const CLAUDE_CODE_SDK_VERSION = "0.128.0";
/** Identity block Claude Code's CLI places before its system prompt. */
export const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_TOO_OLD_CODE = "claude_code_version_too_old";
const REQUIRED_VERSION_PATTERN = /version (\d+\.\d+\.\d+) or newer is required/i;

let adoptedClaudeCodeVersion: string | undefined;

/**
 * Claude Code version sent on the wire: `PI_AI_CLAUDE_CODE_VERSION`, then a version adopted from a server
 * rejection, then {@link DEFAULT_CLAUDE_CODE_VERSION}.
 */
export function getClaudeCodeVersion(): string {
	return getProviderEnvValue("PI_AI_CLAUDE_CODE_VERSION") || adoptedClaudeCodeVersion || DEFAULT_CLAUDE_CODE_VERSION;
}

/** User-Agent of Claude Code's CLI inference entrypoint. */
export function getClaudeCodeUserAgent(): string {
	return `claude-cli/${getClaudeCodeVersion()} (external, cli)`;
}

/** User-Agent Claude Code's bundled SDK sends on OAuth token refresh. */
export function getClaudeCodeOAuthUserAgent(): string {
	return `anthropic-sdk-typescript/${CLAUDE_CODE_SDK_VERSION} userOAuthProvider`;
}

function compareSemver(a: string, b: string): number {
	const pa = SEMVER_PATTERN.exec(a);
	const pb = SEMVER_PATTERN.exec(b);
	if (!pa || !pb) return 0;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(pa[i]) - Number(pb[i]);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Adopts the minimum version named by a `claude_code_version_too_old` rejection for the rest of the process.
 * `error` is the rejection or its message. Returns true only when that version is newer than `sentVersion`, the
 * version the failed request sent, so a caller retries once per newer version and a repeated rejection cannot loop.
 * Always false while `PI_AI_CLAUDE_CODE_VERSION` pins the version.
 */
export function adoptRequiredClaudeCodeVersion(error: unknown, sentVersion: string): boolean {
	if (getProviderEnvValue("PI_AI_CLAUDE_CODE_VERSION")) return false;
	const message = error instanceof Error ? error.message : String(error);
	if (!message.includes(VERSION_TOO_OLD_CODE)) return false;
	const required = REQUIRED_VERSION_PATTERN.exec(message)?.[1];
	if (!required || compareSemver(required, sentVersion) <= 0) return false;
	// Concurrent requests may adopt out of order; adoption never moves backwards.
	if (adoptedClaudeCodeVersion === undefined || compareSemver(required, adoptedClaudeCodeVersion) > 0) {
		adoptedClaudeCodeVersion = required;
	}
	return true;
}

/** Maps Node's platform identifier to the Stainless wire value. */
export function mapStainlessOs(platform: string): string {
	switch (platform.toLowerCase()) {
		case "darwin":
			return "MacOS";
		case "windows":
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${platform.toLowerCase()}`;
	}
}

/** Maps Node's architecture identifier to the Stainless wire value. */
export function mapStainlessArch(arch: string): string {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

const OAUTH_BETA = "oauth-2025-04-20";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const THINKING_TOKEN_COUNT_BETA = "thinking-token-count-2026-05-13";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";
const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";
/** Betas of a Claude Code request without tools or thinking (its "utility" profile: title, summary, side questions). */
const UTILITY_BETA_DEFAULTS: readonly string[] = [
	OAUTH_BETA,
	INTERLEAVED_THINKING_BETA,
	THINKING_TOKEN_COUNT_BETA,
	CONTEXT_MANAGEMENT_BETA,
	PROMPT_CACHING_SCOPE_BETA,
	STRUCTURED_OUTPUTS_BETA,
];
/** Betas of a Claude Code agent request, which carries tools or thinking. */
const AGENT_BETA_DEFAULTS: readonly string[] = [
	"claude-code-20250219",
	OAUTH_BETA,
	INTERLEAVED_THINKING_BETA,
	THINKING_TOKEN_COUNT_BETA,
	CONTEXT_MANAGEMENT_BETA,
	PROMPT_CACHING_SCOPE_BETA,
];
export const CLAUDE_CODE_CONTEXT_MANAGEMENT_BETA = CONTEXT_MANAGEMENT_BETA;
export const CLAUDE_CODE_EFFORT_BETA = "effort-2025-11-24";
const FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01";

export interface ClaudeCodeBetaProfile {
	/** The request carries tools or thinking, so it is an agent request; otherwise it takes the utility profile. */
	agentRequest: boolean;
	/** Thinking is enabled, which adds the effort beta to an agent request. */
	thinkingRequest: boolean;
	/** Strict tools are off, which leaves the structured-outputs beta out of the utility profile. */
	disableStrictTools?: boolean;
	/** The model accepts `context_management`; false leaves its beta out. */
	supportsContextManagement?: boolean;
	/** The endpoint rejected `cache_control`: withhold the prompt-cache betas. */
	dropPromptCacheBetas?: boolean;
}

/**
 * Betas Claude Code sends on a request. `context-1m-2025-08-07` is never sent: subscription credentials
 * have no long-context credit balance, so Anthropic rejects every request that advertises it.
 */
export function buildClaudeCodeBetas({
	agentRequest,
	thinkingRequest,
	disableStrictTools = false,
	supportsContextManagement = true,
	dropPromptCacheBetas = false,
}: ClaudeCodeBetaProfile): string[] {
	const betas = (agentRequest ? AGENT_BETA_DEFAULTS : UTILITY_BETA_DEFAULTS).filter(
		(beta) =>
			!(disableStrictTools && beta === STRUCTURED_OUTPUTS_BETA) &&
			!(!supportsContextManagement && beta === CONTEXT_MANAGEMENT_BETA) &&
			!(dropPromptCacheBetas && beta === PROMPT_CACHING_SCOPE_BETA),
	);
	if (!agentRequest) return betas;
	if (thinkingRequest) betas.push(CLAUDE_CODE_EFFORT_BETA);
	betas.push(FALLBACK_CREDIT_BETA);
	return betas;
}

/**
 * Client headers Claude Code's CLI sends on every inference request, keyed in its casing and in the order of its
 * header record: `Accept`, `User-Agent`, the session id, the Stainless values, then the browser-access marker and
 * `x-app`.
 */
export function buildClaudeCodeHeaders(sessionId: string | undefined): Record<string, string> {
	return {
		Accept: "application/json",
		"User-Agent": getClaudeCodeUserAgent(),
		...(sessionId ? { "X-Claude-Code-Session-Id": sessionId } : {}),
		"X-Stainless-Arch": mapStainlessArch(process.arch),
		"X-Stainless-Lang": "js",
		"X-Stainless-OS": mapStainlessOs(process.platform),
		"X-Stainless-Package-Version": CLAUDE_CODE_SDK_VERSION,
		"X-Stainless-Retry-Count": "0",
		"X-Stainless-Runtime": "node",
		"X-Stainless-Runtime-Version": "v26.12.1",
		"X-Stainless-Timeout": "600",
		"anthropic-dangerous-direct-browser-access": "true",
		"x-app": "cli",
	};
}
