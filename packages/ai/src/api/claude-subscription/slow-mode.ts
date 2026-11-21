// Anthropic subscription "slow mode" (Claude Code's `/low-priority`): the wire contract and the hooks a caller plugs
// its state machine into. After a Claude subscription account hits its 5-hour session limit, Anthropic may offer to
// keep serving it on spare capacity. A request opts in with `anthropic-usage-limit: slow`; the server reports the lane
// state back in `anthropic-ratelimit-unified-slow-*` response headers and answers "no spare capacity right now" with a
// 429 `slot_busy` or a 529 overload, which the client retries after the server-stated interval. Before the slow lane
// the server may grant a small wrap-up allowance past the session limit, reported as
// `anthropic-ratelimit-unified-grace-{5h,7d}-utilization` above zero on 2xx responses.
//
// This module owns the header names, their parsing and the lane of a request; the state machine lives with the caller,
// who opts in with the `anthropicSlowMode` stream option. Ported from oh-my-pi's `providers/anthropic-slow-mode.ts`.

import { shortHash } from "../../utils/hash.ts";
import { getHeaderValue, type HeadersLike } from "../../utils/retry-after.ts";

/** Request header that opts a first-party OAuth request into the slow lane. */
export const anthropicUsageLimitHeader = "anthropic-usage-limit";
/** Value of {@link anthropicUsageLimitHeader} that selects the slow lane. */
export const anthropicSlowUsageLimit = "slow";

/** Server-side experiment arm; only `treatment` accounts may enter the slow lane. */
export type AnthropicSlowOffer = "treatment" | "control";

/** `anthropic-ratelimit-unified-slow-status` values; unknown strings map to `unrecognized`. */
export type AnthropicSlowStatus =
	| "active"
	| "not_needed"
	| "slot_busy"
	| "weekly_limit"
	| "budget_exhausted"
	| "ineligible"
	| "off"
	| "unrecognized";

/** Slow-lane facts carried by one Anthropic response, successful or not. */
export interface AnthropicSlowModeSignal {
	offer?: AnthropicSlowOffer;
	status?: AnthropicSlowStatus;
	/** Server-stated interval between capacity retries. */
	retryAfterMs?: number;
	/** Server-stated ceiling on the total time spent waiting for capacity. */
	maxWaitMs?: number;
	/** Fraction (0..1) of the weekly slow-lane allowance already used. */
	budgetUtilization?: number;
	/** Epoch seconds when the slow-lane allowance resets. */
	budgetResetAtSec?: number;
	/** Epoch seconds of `anthropic-ratelimit-unified-reset`, the limit that was hit. */
	unifiedResetAtSec?: number;
	/** Epoch seconds of the 5-hour window reset. */
	fiveHourResetAtSec?: number;
	/** Epoch seconds of the weekly window reset. */
	weeklyResetAtSec?: number;
	/** True when the response carries unified usage-limit claim headers: a limit wall. */
	unifiedLimitClaim: boolean;
	/** True when extra usage (overage) is serving this account. */
	overageInUse: boolean;
	/** Wrap-up allowance usage (0..1) past the 5-hour and weekly limits; above zero, the request ran on the allowance. */
	graceUtilization?: { fiveHour: number; sevenDay: number };
	/** True when `anthropic-ratelimit-unified-overage-status` lets extra usage serve requests. */
	overageAllowed?: boolean;
}

/** One failure before any content that the stream loop hands to {@link AnthropicSlowModeHooks.onFailure}. */
export interface AnthropicSlowModeFailure {
	/** Account lane of the failed request (see {@link AnthropicSlowModeHooks}). */
	lane: string;
	httpStatus?: number;
	/** 529 or an `overloaded_error` envelope. */
	overloaded: boolean;
	signal?: AnthropicSlowModeSignal;
	/** Whether the failed request carried `anthropic-usage-limit: slow`. */
	sentSlow: boolean;
	/** Milliseconds this request has already spent waiting for slow-lane capacity. */
	waitedMs: number;
	/** Capacity waits already taken by this request. */
	attempts: number;
}

/** The retry a slow-mode hook asks for. */
export interface AnthropicSlowModeRetry {
	/** Delay before resending; `0` resends immediately. */
	delayMs: number;
	/** True when the delay is a capacity wait, which counts toward the max-wait budget. */
	capacityWait: boolean;
}

/**
 * Caller-owned slow-mode state machine. The stream loop consults it only for first-party OAuth requests
 * (`api.anthropic.com` with a subscription bearer). Slow-lane state belongs to one Claude account, so every call
 * carries a `lane` key naming the credential that served the request: `cred:<account uuid>` when the credential names
 * its account, else `key:<hash>` of the bearer (see {@link resolveSlowModeLane}).
 */
export interface AnthropicSlowModeHooks {
	/** Whether the next request on `lane` should carry `anthropic-usage-limit: slow`. */
	isActive(lane: string): boolean;
	/** Observes the slow-lane headers of a successful (2xx) response on `lane`. */
	observe(signal: AnthropicSlowModeSignal, lane: string): void;
	/**
	 * Decides how to react to a failure that arrived before any content: a retry to resend the request (with or
	 * without the slow header, per {@link isActive}), or undefined to let normal error handling run.
	 */
	onFailure(
		failure: AnthropicSlowModeFailure,
	): AnthropicSlowModeRetry | undefined | Promise<AnthropicSlowModeRetry | undefined>;
}

/** A request's slow-mode wiring: the caller's hooks, and the account lane its requests are served on. */
export interface AnthropicSlowModeSession {
	hooks: AnthropicSlowModeHooks;
	lane: string;
}

/**
 * The lane of the account behind a request. The account uuid outlives a token refresh; a bearer whose credential names
 * no account is keyed by a hash of the bearer, which stays out of the hooks' state.
 */
export function resolveSlowModeLane(accountId: string | undefined, bearer: string): string {
	return accountId ? `cred:${accountId}` : `key:${shortHash(bearer)}`;
}

const slowHeaderPrefix = "anthropic-ratelimit-unified-slow-";

function readNonNegative(headers: NonNullable<HeadersLike>, name: string): number | undefined {
	const raw = getHeaderValue(headers, name)?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A utilization header clamped to 0..1; absent or malformed reads as 0. */
function readUtilization(headers: NonNullable<HeadersLike>, name: string): number {
	return Math.min(1, readNonNegative(headers, name) ?? 0);
}

function parseSlowStatus(raw: string | undefined): AnthropicSlowStatus | undefined {
	if (raw === undefined) return undefined;
	switch (raw.trim()) {
		case "active":
			return "active";
		case "not_needed":
			return "not_needed";
		case "slot_busy":
			return "slot_busy";
		case "weekly_limit":
			return "weekly_limit";
		case "budget_exhausted":
			return "budget_exhausted";
		case "ineligible":
			return "ineligible";
		case "off":
			return "off";
		default:
			return "unrecognized";
	}
}

/**
 * Parses the slow-lane and unified-limit headers relevant to slow mode. Returns undefined when the response carries
 * none of them.
 */
export function parseAnthropicSlowModeHeaders(headers: HeadersLike): AnthropicSlowModeSignal | undefined {
	if (!headers) return undefined;
	const offerRaw = getHeaderValue(headers, `${slowHeaderPrefix}offer`)?.trim();
	const offer = offerRaw === "treatment" || offerRaw === "control" ? offerRaw : undefined;
	const status = parseSlowStatus(getHeaderValue(headers, `${slowHeaderPrefix}status`));
	const retryAfterSec = readNonNegative(headers, `${slowHeaderPrefix}retry-after`);
	const maxWaitSec = readNonNegative(headers, `${slowHeaderPrefix}max-wait`);
	const budgetUtilization = readNonNegative(headers, `${slowHeaderPrefix}budget-utilization`);
	const budgetResetAtSec = readNonNegative(headers, `${slowHeaderPrefix}budget-reset`);
	const unifiedResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-reset");
	const fiveHourResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-5h-reset");
	const weeklyResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-7d-reset");
	const unifiedLimitClaim = Boolean(
		getHeaderValue(headers, "anthropic-ratelimit-unified-representative-claim") ||
			getHeaderValue(headers, "anthropic-ratelimit-unified-overage-status"),
	);
	const overageInUse = getHeaderValue(headers, "anthropic-ratelimit-unified-overage-in-use")?.trim() === "true";
	const overageStatus = getHeaderValue(headers, "anthropic-ratelimit-unified-overage-status")?.trim();
	const overageAllowed = overageStatus === "allowed" || overageStatus === "allowed_warning";
	// A unified-status response always carries wrap-up facts, even when both readings are zero: that is how the
	// controller sees the window close.
	const graceUtilization =
		getHeaderValue(headers, "anthropic-ratelimit-unified-status") === undefined
			? undefined
			: {
					fiveHour: readUtilization(headers, "anthropic-ratelimit-unified-grace-5h-utilization"),
					sevenDay: readUtilization(headers, "anthropic-ratelimit-unified-grace-7d-utilization"),
				};
	const hasSlowFacts = [offer, status, retryAfterSec, maxWaitSec, budgetUtilization, budgetResetAtSec].some(
		(fact) => fact !== undefined,
	);
	if (
		!hasSlowFacts &&
		graceUtilization === undefined &&
		!unifiedLimitClaim &&
		fiveHourResetAtSec === undefined &&
		unifiedResetAtSec === undefined
	) {
		return undefined;
	}
	return {
		...(offer !== undefined ? { offer } : {}),
		...(status !== undefined ? { status } : {}),
		...(retryAfterSec !== undefined ? { retryAfterMs: Math.round(retryAfterSec * 1000) } : {}),
		...(maxWaitSec !== undefined ? { maxWaitMs: Math.round(maxWaitSec * 1000) } : {}),
		...(budgetUtilization !== undefined ? { budgetUtilization: Math.min(1, budgetUtilization) } : {}),
		...(budgetResetAtSec !== undefined ? { budgetResetAtSec } : {}),
		...(unifiedResetAtSec !== undefined ? { unifiedResetAtSec } : {}),
		...(fiveHourResetAtSec !== undefined ? { fiveHourResetAtSec } : {}),
		...(weeklyResetAtSec !== undefined ? { weeklyResetAtSec } : {}),
		unifiedLimitClaim,
		overageInUse,
		...(overageAllowed ? { overageAllowed } : {}),
		...(graceUtilization !== undefined ? { graceUtilization } : {}),
	};
}
