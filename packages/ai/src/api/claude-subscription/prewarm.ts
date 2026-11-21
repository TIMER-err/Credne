/**
 * Connection warm-up for Anthropic subscription requests. Opens, or keeps alive, a pooled connection to Anthropic's
 * API so the next turn skips DNS, TCP and TLS. Ported from oh-my-pi's `providers/connection-prewarm.ts`.
 */

import type { Api, Model } from "../../types.ts";
import { type ClientIdentity, formatUserAgent } from "../../utils/identity.ts";
import { OFFICIAL_ANTHROPIC_ORIGIN, type ProfiledRequest, sendWithClaudeCodeProfile } from "./transport.ts";

/** Options of {@link prewarmModelConnection}. */
export interface PrewarmOptions {
	/** The app's identity; its `User-Agent` is sent on the probe. Default: pi-ai's detailed identity. */
	identity?: ClientIdentity;
	/** Sends the probe instead of the Claude Code transport. */
	send?: (url: URL, request: ProfiledRequest) => Promise<Response>;
}

// Idle pooled sockets outlive this by minutes, so a tighter cadence would only add requests.
const prewarmIntervalMs = 30_000;
const prewarmTimeoutMs = 10_000;

const prewarmedAt = new Map<string, number>();

/**
 * Warms the connection of an Anthropic model that talks to Anthropic's own API. Sends a credential-less `HEAD`
 * (nothing is billed) through the transport and socket pool of real subscription requests, because sockets pool
 * per transport and a warm-up made any other way is never reused. Acts for no other model, throttled to one probe
 * per origin per 30 seconds. Best effort: never throws.
 *
 * Whether the model's credential is a subscription token is the caller's decision: an API key request goes through
 * another transport, which this warm-up does not feed.
 */
export async function prewarmModelConnection(model: Model<Api>, options: PrewarmOptions = {}): Promise<void> {
	if (model.api !== "anthropic-messages") return;
	try {
		const url = new URL(model.baseUrl);
		if (url.origin !== OFFICIAL_ANTHROPIC_ORIGIN) return;
		const now = Date.now();
		const last = prewarmedAt.get(url.origin);
		if (last !== undefined && now - last < prewarmIntervalMs) return;
		prewarmedAt.set(url.origin, now);
		const send = options.send ?? sendWithClaudeCodeProfile;
		const response = await send(new URL(url.origin), {
			method: "HEAD",
			headers: { "User-Agent": formatUserAgent(options.identity) },
			signal: AbortSignal.timeout(prewarmTimeoutMs),
		});
		await response.body?.cancel();
	} catch {
		// Best effort: the real request reports any connection problem itself.
	}
}
