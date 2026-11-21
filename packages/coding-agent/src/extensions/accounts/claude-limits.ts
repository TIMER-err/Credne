// What this process knows about the usage limits of Claude subscriptions: windows, blocks and limit failures.
// Semantics follow oh-my-pi's auth/blocks.ts, usage/claude.ts and auth/rotation.ts.
import { type AssistantMessage, getProviderHttpErrorDetails } from "@earendil-works/pi-ai";

const hourMs = 3_600_000;
export const fiveHourMs = 5 * hourMs;
export const sevenDayMs = 7 * 24 * hourMs;

/** Block applied to an account that reported a limit without saying when it resets. */
export const defaultBlockMs = 60_000;
/** A usage snapshot older than this is fetched again before it ranks accounts. */
export const usageTtlMs = 5 * 60_000;
/** After a failed usage request the endpoint is left alone for this long; it stays rate limited for minutes. */
export const usageFailureBackoffMs = 60_000;

const unifiedHeaderPrefix = "anthropic-ratelimit-unified-";

/** One usage window of a subscription, from the usage endpoint or from rate-limit headers. */
export interface ClaudeWindow {
	/** `5h`, `7d`, or `7d:<tier>` for a model-scoped weekly cap. */
	id: string;
	/** Display label: `5-hour`, `7-day`, `7-day Sonnet`. */
	label: string;
	/** Share used, 0 to 100. */
	usedPercent: number;
	/** Epoch milliseconds when the window resets. */
	resetAt?: number;
	durationMs: number;
	/** Whether the window gates every request, whatever the model. */
	shared: boolean;
	/** Model family a scoped window meters: `opus`, `sonnet`, `fable`, ... */
	tier?: string;
}

/** The headers carry the 5-hour and 7-day windows and, as `7d_oi`, the model-scoped weekly cap. */
const headerWindows: readonly {
	prefix: string;
	template: Omit<ClaudeWindow, "usedPercent" | "resetAt">;
}[] = [
	{ prefix: "5h", template: { id: "5h", label: "5-hour", durationMs: fiveHourMs, shared: true } },
	{ prefix: "7d", template: { id: "7d", label: "7-day", durationMs: sevenDayMs, shared: true } },
	{
		prefix: "7d_oi",
		template: { id: "7d:fable", label: "7-day Fable", durationMs: sevenDayMs, shared: false, tier: "fable" },
	},
];

/** Model families whose weekly cap is one shared model-scoped counter (see oh-my-pi's `isScopedWeeklyKind`). */
const scopedTiers: readonly string[] = ["fable", "mythos"];

/** The family a model id belongs to, when it has a family cap of its own. */
export function claudeModelKind(modelId: string): string | undefined {
	const id = modelId.toLowerCase();
	return ["fable", "mythos", "opus", "sonnet"].find((kind) => id.includes(kind));
}

/** The windows the rate-limit headers of one response report. Utilization is a 0 to 1 share. */
export function windowsFromHeaders(headers: Record<string, string>): ClaudeWindow[] {
	const windows: ClaudeWindow[] = [];
	for (const { prefix, template } of headerWindows) {
		const used = headerNumber(headers, `${prefix}-utilization`);
		if (used === undefined) continue;
		const reset = headerNumber(headers, `${prefix}-reset`);
		windows.push({
			...template,
			usedPercent: used * 100,
			...(reset !== undefined && reset > 0 ? { resetAt: reset * 1000 } : {}),
		});
	}
	return windows;
}

function headerNumber(headers: Record<string, string>, name: string): number | undefined {
	const value = headers[`${unifiedHeaderPrefix}${name}`];
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isScopedWeekly(window: ClaudeWindow): boolean {
	return !window.shared && window.tier !== undefined && scopedTiers.includes(window.tier);
}

/**
 * The scoped weekly rows that gate a Fable or Mythos request: the row labelled with its family, else every
 * scoped row, because the label names what the plan meters and not the model that is requested.
 */
function scopedGates(windows: readonly ClaudeWindow[], kind: string): ClaudeWindow[] {
	const scoped = windows.filter(isScopedWeekly);
	const labelled = scoped.filter((window) => window.tier === kind);
	return labelled.length > 0 ? labelled : scoped;
}

/** The windows that put pressure on a request for a model of `kind`: shared windows and its family's cap. */
export function windowsForModel(windows: readonly ClaudeWindow[], kind: string | undefined): ClaudeWindow[] {
	if (kind === undefined || !scopedTiers.includes(kind)) {
		return windows.filter((window) => window.shared || (kind !== undefined && window.tier === kind));
	}
	const gates = new Set(scopedGates(windows, kind));
	return windows.filter((window) => window.shared || gates.has(window));
}

/**
 * The windows that block a request. A Fable or Mythos cap blocks only when it is confirmed used up with a reset
 * ahead, because those counters report high utilization while the account can still serve.
 */
function gatingWindows(windows: readonly ClaudeWindow[], kind: string | undefined, now: number): ClaudeWindow[] {
	if (kind === undefined || !scopedTiers.includes(kind)) return windowsForModel(windows, kind);
	const confirmed = new Set(
		scopedGates(windows, kind).filter((window) => window.usedPercent >= 100 && (window.resetAt ?? 0) > now),
	);
	return windows.filter((window) => window.shared || confirmed.has(window));
}

/** A window whose reset has passed starts over. */
export function isWindowExpired(window: ClaudeWindow, now: number): boolean {
	return window.resetAt !== undefined && window.resetAt <= now;
}

/** Share of a window used, 0 to 1; a window that has reset is unused. */
export function usedFraction(window: ClaudeWindow, now: number): number {
	if (isWindowExpired(window, now)) return 0;
	return Math.min(1, Math.max(0, window.usedPercent / 100));
}

interface Snapshot {
	windows: ClaudeWindow[];
	/** When a response or the usage endpoint last reported the windows. */
	updatedAt: number;
}

interface AccountLimits {
	snapshot?: Snapshot;
	/** Blocks by scope: `""` for the whole account, `tier:<family>` for a model-scoped cap. */
	blocks: Map<string, number>;
	usageFailedAt?: number;
	servedAt?: number;
}

/** What a usage report covers, for deciding whether it may lift a block. */
export interface UsageEvidence {
	windows: readonly ClaudeWindow[];
	/** Shared windows the payload declared inactive: `five_hour: null` and no `session` row. */
	inactiveShared: readonly string[];
}

/**
 * Usage windows and blocks per provider id, in memory. Every response carries the unified window headers; the usage
 * endpoint adds the rest. An account is blocked while a window that gates the request is used up and after a
 * failure named a limit, each until its reset; blocks keep the longest deadline.
 */
export class ClaudeLimits {
	private readonly accounts = new Map<string, AccountLimits>();

	/** Merge the windows of a response's rate-limit headers into the account's snapshot. */
	ingestHeaders(providerId: string, headers: Record<string, string>, now: number = Date.now()): void {
		const reported = windowsFromHeaders(headers);
		if (reported.length === 0) return;
		const account = this.account(providerId);
		const kept = (account.snapshot?.windows ?? []).filter(
			(window) => !reported.some((entry) => entry.id === window.id),
		);
		account.snapshot = { windows: [...kept, ...reported], updatedAt: now };
	}

	/** Replace the snapshot with a usage report; a report that shows the account healthy lifts its blocks. */
	ingestUsage(providerId: string, evidence: UsageEvidence, now: number = Date.now()): void {
		const account = this.account(providerId);
		account.snapshot = { windows: [...evidence.windows], updatedAt: now };
		account.usageFailedAt = undefined;
		this.healBlocks(account, evidence, now);
	}

	/** Note that the usage endpoint failed, so it is not asked again for a minute. */
	noteUsageFailure(providerId: string, now: number = Date.now()): void {
		this.account(providerId).usageFailedAt = now;
	}

	/** Whether the account's windows are unknown or stale and the usage endpoint may be asked. */
	needsUsage(providerId: string, now: number = Date.now()): boolean {
		const account = this.accounts.get(providerId);
		if (account?.usageFailedAt !== undefined && now - account.usageFailedAt < usageFailureBackoffMs) return false;
		return account?.snapshot === undefined || now - account.snapshot.updatedAt >= usageTtlMs;
	}

	/** Block the account for a request of `kind` until `until`; the longest block wins. */
	markReached(providerId: string, kind: string | undefined, until: number): void {
		const blocks = this.account(providerId).blocks;
		const scope = blockScope(kind);
		blocks.set(scope, Math.max(blocks.get(scope) ?? 0, until));
	}

	/** A request succeeded: the account serves `kind` now, whatever a block said. */
	recordServed(providerId: string, kind: string | undefined, now: number = Date.now()): void {
		const account = this.account(providerId);
		account.servedAt = now;
		account.blocks.delete("");
		account.blocks.delete(blockScope(kind));
	}

	/** Epoch milliseconds when the account serves a request of `kind` again; undefined when it can serve now. */
	blockedUntil(providerId: string, kind: string | undefined, now: number = Date.now()): number | undefined {
		const account = this.accounts.get(providerId);
		if (!account) return undefined;
		let until: number | undefined;
		for (const scope of new Set(["", blockScope(kind)])) {
			const deadline = account.blocks.get(scope);
			if (deadline !== undefined && deadline > now) until = Math.max(until ?? 0, deadline);
		}
		const windows = account.snapshot ? gatingWindows(account.snapshot.windows, kind, now) : [];
		for (const window of windows) {
			if (window.usedPercent < 100 || isWindowExpired(window, now)) continue;
			// A used-up window that names no reset blocks for the default span after it was reported.
			const reset = window.resetAt ?? (account.snapshot?.updatedAt ?? now) + defaultBlockMs;
			if (reset > now) until = Math.max(until ?? 0, reset);
		}
		return until;
	}

	/** The latest windows reported for the account. */
	windows(providerId: string): readonly ClaudeWindow[] {
		return this.accounts.get(providerId)?.snapshot?.windows ?? [];
	}

	/** When a response of the account last succeeded, in epoch milliseconds. */
	servedAt(providerId: string): number | undefined {
		return this.accounts.get(providerId)?.servedAt;
	}

	/** Forget everything about an account, for example when the user clears its cooldown. */
	clear(providerId: string): void {
		this.accounts.delete(providerId);
	}

	private account(providerId: string): AccountLimits {
		let account = this.accounts.get(providerId);
		if (!account) {
			account = { blocks: new Map() };
			this.accounts.set(providerId, account);
		}
		return account;
	}

	/**
	 * A report that covers every shared window and shows nothing used up proves the account healthy, as when the plan
	 * changed. A model-scoped block is lifted when its cap's row has room.
	 */
	private healBlocks(account: AccountLimits, evidence: UsageEvidence, now: number): void {
		const covered = ["5h", "7d"].every(
			(id) => evidence.windows.some((window) => window.id === id) || evidence.inactiveShared.includes(id),
		);
		if (!covered) return;
		const used = (window: ClaudeWindow) => window.usedPercent >= 100 && !isWindowExpired(window, now);
		if (!evidence.windows.some(used)) account.blocks.delete("");
		for (const tier of scopedTiers) {
			const gates = scopedGates(evidence.windows, tier);
			if (gates.length > 0 && !gates.some(used)) account.blocks.delete(blockScope(tier));
		}
	}
}

function blockScope(kind: string | undefined): string {
	return kind !== undefined && scopedTiers.includes(kind) ? `tier:${kind}` : "";
}

/** A failed request that named a usage limit: when the account can serve again, and whether the server said so. */
export interface UsageLimitFailure {
	/** Epoch milliseconds. */
	until: number;
	/** Whether `until` comes from the server (a reset or retry-after) and not from the default block. */
	timed: boolean;
}

// Anthropic's usage-limit texts: "Claude usage limit reached|1760000000", "You've hit your limit", HTTP 429 rate_limit_error.
const limitTextPattern =
	/\b429\b|rate[_ -]?limit|usage[_ -]limit|limit (?:reached|exceeded)|hit your limit|too many requests|spend(?:ing)?[\s_-]?limit|usage credits are required/i;
// Rolling per-minute throttles clear themselves, so they are not a reason to leave the account.
const transientThrottlePattern = /\bper[\s-](?:second|minute)\b|\b(?:tpm|rpm)\b/i;
/** Claude's usage-limit text carries the reset as epoch seconds. */
const resetInTextPattern = /limit reached\|(\d{9,11})\b/i;
const retryAfterInTextPattern = /retry[- ]after\D{0,12}(\d+)/i;

/**
 * The usage limit a failed reply reports, or undefined when it failed for another reason. HTTP 429 with the
 * unified rate-limit headers is the real signal; the error text covers replies that carry no HTTP details.
 */
export function usageLimitFailure(message: AssistantMessage, now: number): UsageLimitFailure | undefined {
	if (message.stopReason !== "error") return undefined;
	const details = getProviderHttpErrorDetails(message);
	const text = message.errorMessage ?? "";
	const headers = details?.headers ?? {};
	const rejected = headers[`${unifiedHeaderPrefix}status`] === "rejected";
	const namesLimit = details?.status === 429 || limitTextPattern.test(text);
	if (!rejected && !(namesLimit && !transientThrottlePattern.test(text))) return undefined;
	const retryAfterMs = details?.retryAfterMs ?? textRetryAfterMs(text);
	const resetAt = textResetAt(text) ?? headerResetAt(headers);
	if (resetAt !== undefined && resetAt > now) return { until: resetAt, timed: true };
	if (retryAfterMs !== undefined) return { until: now + retryAfterMs, timed: true };
	return { until: now + defaultBlockMs, timed: false };
}

function textResetAt(text: string): number | undefined {
	const seconds = resetInTextPattern.exec(text)?.[1];
	return seconds === undefined ? undefined : Number(seconds) * 1000;
}

function textRetryAfterMs(text: string): number | undefined {
	const seconds = retryAfterInTextPattern.exec(text)?.[1];
	return seconds === undefined ? undefined : Number(seconds) * 1000;
}

/** The overall reset the unified headers name, in epoch milliseconds. */
function headerResetAt(headers: Record<string, string>): number | undefined {
	const seconds = headerNumber(headers, "reset");
	return seconds !== undefined && seconds > 0 ? seconds * 1000 : undefined;
}
