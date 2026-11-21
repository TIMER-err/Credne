// The header record of a Claude subscription (OAuth) request, in the order and casing Claude Code sends it. The wire
// order is part of the fingerprint, so the record is built here, in insertion order, and every later layer (the
// client, the transport) passes it on untouched. Ported from the OAuth branch of oh-my-pi's `buildAnthropicHeaders`.

import { buildClaudeCodeHeaders } from "./fingerprint.ts";

const anthropicVersion = "2023-06-01";
const acceptEncoding = "gzip, deflate, br, zstd";
const claudeCliUserAgentPrefix = "claude-cli";

// Headers the record sets itself. A caller's header of one of these names is replaced by ours, except its
// `User-Agent`, when it is Claude Code's own, and its `X-Api-Key`.
const enforcedHeaderNames: ReadonlySet<string> = new Set([
	"accept",
	"accept-encoding",
	"connection",
	"content-type",
	"anthropic-version",
	"anthropic-dangerous-direct-browser-access",
	"anthropic-beta",
	"user-agent",
	"x-app",
	"authorization",
	"x-api-key",
	"x-claude-code-session-id",
	"x-client-request-id",
	"cf-aig-authorization",
]);

/** What one request's headers depend on. */
export interface ClaudeSubscriptionHeaderInput {
	/** The OAuth access token, sent as the bearer. */
	token: string;
	/** `anthropic-beta` values, in order. */
	betas: readonly string[];
	/** The session id sent as `X-Claude-Code-Session-Id`; none is sent without one. */
	sessionId: string | undefined;
	/** Headers the caller configured for the model and the request, in their casing. */
	callerHeaders: Record<string, string> | undefined;
}

/** The `anthropic-beta` value: the betas trimmed and deduplicated, in order. Empty when there are none. */
export function buildBetaHeader(betas: readonly string[]): string {
	const unique = new Set<string>();
	for (const beta of betas) {
		const trimmed = beta.trim();
		if (trimmed) unique.add(trimmed);
	}
	return [...unique].join(",");
}

/**
 * The request headers, in wire order: the caller's own headers, then `Accept`, `Content-Type`, `User-Agent`, the
 * session id, the Stainless client headers, `anthropic-beta`, the browser-access marker, `anthropic-version`,
 * `Authorization`, `x-app`, `Connection`, `Accept-Encoding`, and last a caller's `X-Api-Key`. The caller's `User-Agent`
 * is kept only when it is a Claude Code one.
 */
export function buildClaudeSubscriptionHeaders(input: ClaudeSubscriptionHeaderInput): Record<string, string> {
	const client = buildClaudeCodeHeaders(input.sessionId);
	const stainless = Object.entries(client).filter(([name]) => name.startsWith("X-Stainless-"));
	const enforced = new Set([...enforcedHeaderNames, ...stainless.map(([name]) => name.toLowerCase())]);
	const caller = splitCallerHeaders(input.callerHeaders, enforced);
	const userAgent = caller.userAgent?.toLowerCase().startsWith(claudeCliUserAgentPrefix)
		? caller.userAgent
		: client["User-Agent"];
	const betaHeader = buildBetaHeader(input.betas);
	return {
		...caller.passed,
		Accept: client.Accept,
		"Content-Type": "application/json",
		"User-Agent": userAgent,
		...(input.sessionId ? { "X-Claude-Code-Session-Id": client["X-Claude-Code-Session-Id"] } : {}),
		...Object.fromEntries(stainless),
		...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
		"anthropic-dangerous-direct-browser-access": client["anthropic-dangerous-direct-browser-access"],
		"anthropic-version": anthropicVersion,
		Authorization: `Bearer ${input.token}`,
		"x-app": client["x-app"],
		Connection: "keep-alive",
		"Accept-Encoding": acceptEncoding,
		...(caller.apiKey ? { "X-Api-Key": caller.apiKey } : {}),
	};
}

interface CallerHeaders {
	/** The caller's headers that are not enforced, in their order and casing. */
	passed: Record<string, string>;
	userAgent: string | undefined;
	apiKey: string | undefined;
}

function splitCallerHeaders(headers: Record<string, string> | undefined, enforced: ReadonlySet<string>): CallerHeaders {
	const caller: CallerHeaders = { passed: {}, userAgent: undefined, apiKey: undefined };
	for (const [name, value] of Object.entries(headers ?? {})) {
		const lowerName = name.toLowerCase();
		if (lowerName === "user-agent") caller.userAgent = value;
		else if (lowerName === "x-api-key") caller.apiKey = value;
		else if (!enforced.has(lowerName)) caller.passed[name] = value;
	}
	return caller;
}
