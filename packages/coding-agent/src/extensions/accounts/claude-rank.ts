// Orders Claude subscriptions for one request by their usage, as oh-my-pi's auth/rank.ts does for OAuth credentials.
import {
	type ClaudeWindow,
	fiveHourMs,
	isWindowExpired,
	sevenDayMs,
	usedFraction,
	windowsForModel,
} from "./claude-limits.ts";

/**
 * A 5-hour window used at or above this share ranks the account behind cooler ones whatever its drain urgency:
 * it is about to block in the middle of a session.
 */
const hotPrimaryFraction = 0.85;
const metricEpsilon = 1e-9;
const hourMs = 3_600_000;
/** A stale reset must not produce an unbounded urgency, so the remaining time is at least a minute. */
const minRemainingMs = 60_000;

/** A subscription that may serve the request. */
export interface RankCandidate {
	/** Position in the pool's listing; the pinned account is listed first so that it wins real ties. */
	order: number;
	/** The account's windows; undefined or empty when its usage is unknown. */
	windows: readonly ClaudeWindow[] | undefined;
}

interface Metrics {
	allowanceSpent: boolean;
	isHot: boolean;
	isMeasured: boolean;
	secondaryDrain: number;
	secondaryUsed: number;
	primaryDrain: number;
	primaryUsed: number;
}

/**
 * Candidates best first. An account whose renewable allowance is spent yields to one with allowance left. A hot
 * 5-hour window ranks behind cool siblings. Measured accounts rank before unmeasured ones. Then the account whose
 * remaining weekly quota must burn fastest to avoid expiring unused at its reset comes first, then the least used
 * week, then the same two measures for the 5-hour window; the listing order breaks ties.
 */
export function rankByUsage<T extends RankCandidate>(
	candidates: readonly T[],
	kind: string | undefined,
	now: number,
): T[] {
	const ranked = candidates.map((candidate) => ({ candidate, metrics: metricsOf(candidate, kind, now) }));
	ranked.sort(
		(left, right) => compareMetrics(left.metrics, right.metrics) || left.candidate.order - right.candidate.order,
	);
	return ranked.map((entry) => entry.candidate);
}

function metricsOf(candidate: RankCandidate, kind: string | undefined, now: number): Metrics {
	// A window that has reset starts over: unused, with a full span ahead.
	const windows = (candidate.windows ?? []).map((window) =>
		isWindowExpired(window, now) ? { ...window, usedPercent: 0, resetAt: undefined } : window,
	);
	const primary = windows.find((window) => window.id === "5h");
	const secondary = mostPressured(
		windowsForModel(windows, kind).filter((window) => window.id.startsWith("7d")),
		now,
	);
	const used = windowsForModel(windows, kind).map((window) => usedFraction(window, now));
	return {
		allowanceSpent: used.length > 0 && Math.max(...used) >= 1,
		isHot: usedOf(primary) >= hotPrimaryFraction,
		isMeasured: primary !== undefined || secondary !== undefined,
		secondaryDrain: requiredDrain(secondary, now, sevenDayMs),
		secondaryUsed: usedOf(secondary),
		primaryDrain: requiredDrain(primary, now, fiveHourMs),
		primaryUsed: usedOf(primary),
	};
}

function compareMetrics(left: Metrics, right: Metrics): number {
	if (left.allowanceSpent !== right.allowanceSpent) return left.allowanceSpent ? 1 : -1;
	if (left.isHot !== right.isHot) return left.isHot ? 1 : -1;
	if (left.isMeasured !== right.isMeasured) return left.isMeasured ? -1 : 1;
	return (
		compareMetric(right.secondaryDrain, left.secondaryDrain) ||
		compareMetric(left.secondaryUsed, right.secondaryUsed) ||
		compareMetric(right.primaryDrain, left.primaryDrain) ||
		compareMetric(left.primaryUsed, right.primaryUsed)
	);
}

function compareMetric(left: number, right: number): number {
	const tolerance = Math.max(metricEpsilon, Math.max(Math.abs(left), Math.abs(right)) * 1e-6);
	const delta = left - right;
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

/** Share used, 0 to 1; half when the window is not reported. */
function usedOf(window: ClaudeWindow | undefined): number {
	return window === undefined ? 0.5 : Math.min(1, Math.max(0, window.usedPercent / 100));
}

/**
 * How fast the window's remaining quota must be used to be used up before it resets: headroom per remaining hour.
 * Quota that is about to expire unused ranks first. Without a reset the full span is assumed to remain.
 */
function requiredDrain(window: ClaudeWindow | undefined, now: number, fallbackDurationMs: number): number {
	const headroom = 1 - usedOf(window);
	if (headroom <= 0) return 0;
	const durationMs = window?.durationMs ?? fallbackDurationMs;
	const remainingMs = window?.resetAt === undefined ? durationMs : Math.min(window.resetAt - now, durationMs);
	return headroom / (Math.max(remainingMs, minRemainingMs) / hourMs);
}

/** The window using its quota fastest per elapsed hour, the more used one on a tie. */
function mostPressured(windows: readonly ClaudeWindow[], now: number): ClaudeWindow | undefined {
	return windows.reduce<ClaudeWindow | undefined>((selected, window) => {
		if (!selected) return window;
		const delta = drainRate(window, now) - drainRate(selected, now);
		if (delta !== 0) return delta > 0 ? window : selected;
		return usedOf(window) > usedOf(selected) ? window : selected;
	}, undefined);
}

function drainRate(window: ClaudeWindow, now: number): number {
	const used = usedOf(window);
	if (window.resetAt === undefined) return used;
	const remainingMs = Math.min(Math.max(window.resetAt - now, 0), window.durationMs);
	const elapsedHours = (window.durationMs - remainingMs) / hourMs;
	return elapsedHours > 0 ? used / elapsedHours : used;
}
