// Claude subscription usage: the OAuth usage and profile endpoints of api.anthropic.com, as quota windows.
import { zstdDecompressSync } from "node:zlib";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { getClaudeCodeUserAgent } from "@earendil-works/pi-ai/api/claude-subscription/fingerprint";
import { type ClaudeWindow, fiveHourMs, sevenDayMs, type UsageEvidence } from "./claude-limits.ts";
import type { BrokerCredit, BrokerUsage } from "./client.ts";

const oauthApiUrl = "https://api.anthropic.com/api/oauth";

const usageBetas = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"redact-thinking-2026-02-12",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"advanced-tool-use-2025-11-20",
	"effort-2025-11-24",
	"extended-cache-ttl-2025-04-11",
].join(",");

interface WindowBucket {
	field: string;
	id: string;
	label: string;
	durationMs: number;
	/** The `limits[]` kind that reports the same shared window. */
	kind?: string;
	/** Model family of a scoped window. */
	tier?: string;
}

/** Window buckets of the usage payload in display order. */
const windowBuckets: readonly WindowBucket[] = [
	{ field: "five_hour", id: "5h", label: "5-hour", kind: "session", durationMs: fiveHourMs },
	{ field: "seven_day", id: "7d", label: "7-day", kind: "weekly_all", durationMs: sevenDayMs },
	{ field: "seven_day_sonnet", id: "7d:sonnet", label: "7-day Sonnet", tier: "sonnet", durationMs: sevenDayMs },
	{ field: "seven_day_opus", id: "7d:opus", label: "7-day Opus", tier: "opus", durationMs: sevenDayMs },
	{ field: "seven_day_fable", id: "7d:fable", label: "7-day Fable", tier: "fable", durationMs: sevenDayMs },
];

/** What the usage endpoint reports about a subscription. */
export interface ClaudeUsageReport extends UsageEvidence {
	windows: ClaudeWindow[];
	credits: BrokerCredit[];
}

/** The usage endpoint's answer: the report, or why there is none. */
export type ClaudeUsageResult = { type: "report"; report: ClaudeUsageReport } | { type: "failed"; reason: string };

export interface ClaudeRequestOptions {
	signal?: AbortSignal;
	/** Replaces the global fetch, for tests. */
	fetch?: FetchFunction;
}

/**
 * Fetch the usage windows of a subscription. Request, headers and parsing follow oh-my-pi's Claude usage
 * provider; the endpoint expects the Claude Code client identity. A refused or failed request is a `failed`
 * result with its reason, a network failure rejects.
 */
export async function fetchClaudeUsageReport(
	accessToken: string,
	options: ClaudeRequestOptions = {},
): Promise<ClaudeUsageResult> {
	const response = await (options.fetch ?? fetch)(`${oauthApiUrl}/usage`, {
		headers: oauthHeaders(accessToken),
		signal: options.signal,
	});
	if (!response.ok) return failed(failureReason(response.status));
	try {
		return parseClaudeUsageReport(JSON.parse(await readBody(response)));
	} catch {
		return failed("Claude returned usage data that could not be read.");
	}
}

/** The usage windows and credits as the accounts panel shows them. */
export async function fetchClaudeUsage(accessToken: string, options: ClaudeRequestOptions = {}): Promise<BrokerUsage> {
	return toBrokerUsage(await fetchClaudeUsageReport(accessToken, options));
}

/** The plan name of a subscription from the profile endpoint; undefined when the request fails or names no plan. */
export async function fetchClaudePlan(
	accessToken: string,
	options: ClaudeRequestOptions = {},
): Promise<string | undefined> {
	try {
		const response = await (options.fetch ?? fetch)(`${oauthApiUrl}/profile`, {
			headers: oauthHeaders(accessToken),
			signal: options.signal,
		});
		return response.ok ? claudeProfilePlan(await response.json()) : undefined;
	} catch {
		// The plan is a label; the caller keeps the one it has.
		return undefined;
	}
}

const organizationPlans: Readonly<Record<string, string>> = {
	claude_max: "Max",
	claude_pro: "Pro",
	claude_team: "Team",
	claude_enterprise: "Enterprise",
};

/**
 * Plan label of a `/profile` response: "Max 5x" or "Max 20x" from the rate-limit tier (the $100 and $200 Max
 * plans), else the organization type ("Max", "Pro", "Team", "Enterprise").
 */
export function claudeProfilePlan(profile: unknown): string | undefined {
	if (!isRecord(profile) || !isRecord(profile.organization)) return undefined;
	const { rate_limit_tier: tier, organization_type: type } = profile.organization;
	const multiplier = typeof tier === "string" ? /max_(\d+x)/i.exec(tier)?.[1] : undefined;
	if (multiplier) return `Max ${multiplier.toLowerCase()}`;
	return typeof type === "string" ? organizationPlans[type.toLowerCase()] : undefined;
}

/** Map a usage payload to quota windows and extra-usage credits. */
export function parseClaudeUsageReport(payload: unknown): ClaudeUsageResult {
	if (!isRecord(payload)) return failed("Claude returned usage data that could not be read.");
	const windows = quotaWindows(payload);
	const credits = extraUsageCredits(payload);
	if (windows.length === 0 && credits.length === 0) return failed("Claude did not report quota windows or credits.");
	return { type: "report", report: { windows, credits, inactiveShared: inactiveSharedWindows(payload) } };
}

/** The usage payload as the accounts panel shows it. */
export function parseClaudeUsage(payload: unknown): BrokerUsage {
	return toBrokerUsage(parseClaudeUsageReport(payload));
}

/** The usage result as the accounts panel shows it. */
export function toBrokerUsage(result: ClaudeUsageResult): BrokerUsage {
	if (result.type === "failed") return { status: "unavailable", reason: result.reason, windows: [], credits: [] };
	const windows = result.report.windows.map((window) => ({
		label: window.label,
		usedPercent: window.usedPercent,
		...(window.resetAt === undefined ? {} : { resetAt: new Date(window.resetAt).toISOString() }),
	}));
	return { status: "available", windows, credits: result.report.credits };
}

function oauthHeaders(accessToken: string): Record<string, string> {
	return {
		accept: "application/json, text/plain, */*",
		"accept-encoding": "gzip, deflate, br, zstd",
		"anthropic-beta": usageBetas,
		"content-type": "application/json",
		connection: "keep-alive",
		"user-agent": getClaudeCodeUserAgent(),
		authorization: `Bearer ${accessToken}`,
	};
}

/** Fetch decodes gzip, deflate and br itself but hands zstd bodies through undecoded. */
async function readBody(response: Response): Promise<string> {
	if (response.headers.get("content-encoding")?.trim().toLowerCase() !== "zstd") return response.text();
	return zstdDecompressSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
}

function failureReason(status: number): string {
	if (status === 401 || status === 403) return `Claude refused the access token (HTTP ${status}). Sign in again.`;
	if (status === 429) return "Claude rate limits the usage endpoint; try again in a few minutes.";
	return `Claude usage request failed (HTTP ${status}).`;
}

function failed(reason: string): ClaudeUsageResult {
	return { type: "failed", reason };
}

interface UsageBucket {
	/** Share used, 0 to 100. */
	utilization: number;
	resetAt?: number;
}

function quotaWindows(payload: Record<string, unknown>): ClaudeWindow[] {
	const limits = Array.isArray(payload.limits) ? payload.limits.filter(isRecord) : [];
	const windows: ClaudeWindow[] = [];
	for (const bucket of windowBuckets) {
		const found =
			parseBucket(payload[bucket.field]) ??
			(bucket.kind
				? parseBucket(
						limits.find((limit) => limit.kind === bucket.kind),
						"percent",
					)
				: undefined);
		if (found) windows.push(toWindow(bucket.id, bucket.label, bucket.durationMs, found, bucket.tier));
	}
	// Since mid-2026 the per-model weekly buckets are null and model caps only arrive as scoped limits.
	for (const limit of limits.filter((entry) => entry.kind === "weekly_scoped")) {
		const name = scopeName(limit);
		const found = parseBucket(limit, "percent");
		if (!name || !found) continue;
		const tier = slugify(name);
		const id = `7d:${tier}`;
		if (tier && !windows.some((window) => window.id === id)) {
			windows.push(toWindow(id, `7-day ${name}`, sevenDayMs, found, tier));
		}
	}
	return windows;
}

function toWindow(
	id: string,
	label: string,
	durationMs: number,
	bucket: UsageBucket,
	tier: string | undefined,
): ClaudeWindow {
	return {
		id,
		label,
		usedPercent: bucket.utilization,
		durationMs,
		shared: tier === undefined,
		...(bucket.resetAt === undefined ? {} : { resetAt: bucket.resetAt }),
		...(tier === undefined ? {} : { tier }),
	};
}

/**
 * Shared windows the payload positively declares inactive: the bucket field is present and null and no
 * `limits[]` row of that kind exists. Anthropic answers `five_hour: null` while an account has no running window.
 */
function inactiveSharedWindows(payload: Record<string, unknown>): string[] {
	if (!Array.isArray(payload.limits)) return [];
	const limits = payload.limits.filter(isRecord);
	return windowBuckets
		.filter(
			(bucket) =>
				bucket.kind !== undefined &&
				Object.hasOwn(payload, bucket.field) &&
				payload[bucket.field] === null &&
				!limits.some((limit) => limit.kind === bucket.kind),
		)
		.map((bucket) => bucket.id);
}

/** A bucket is `{utilization, resets_at}`; entries of `limits[]` name the percentage `percent` instead. */
function parseBucket(value: unknown, percentField: "utilization" | "percent" = "utilization"): UsageBucket | undefined {
	if (!isRecord(value)) return undefined;
	const percent = value[percentField];
	if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
	const resetMs = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : Number.NaN;
	return {
		utilization: Math.min(100, Math.max(0, percent)),
		...(Number.isFinite(resetMs) ? { resetAt: resetMs } : {}),
	};
}

function scopeName(limit: Record<string, unknown>): string | undefined {
	const scope = isRecord(limit.scope) ? limit.scope : undefined;
	const model = isRecord(scope?.model) ? scope.model : undefined;
	const name = model?.display_name;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Extra usage: `spend` carries minor units with an exponent and a currency, the older `extra_usage` carries
 * `used_credits` and `monthly_limit` in minor units with `decimal_places`. Only USD amounts are reported.
 */
function extraUsageCredits(payload: Record<string, unknown>): BrokerCredit[] {
	const spend = isRecord(payload.spend) ? payload.spend : undefined;
	const legacy = isRecord(payload.extra_usage) ? payload.extra_usage : undefined;
	const amounts = spend ? spendAmounts(spend) : legacy ? legacyAmounts(legacy) : undefined;
	if (!amounts) return [];
	return [
		{ label: "Extra usage spent", amount: amounts.used, unit: "USD", unlimited: false },
		amounts.limit === undefined
			? { label: "Extra usage monthly limit", unit: "USD", unlimited: true }
			: { label: "Extra usage monthly limit", amount: amounts.limit, unit: "USD", unlimited: false },
	];
}

interface ExtraAmounts {
	used: number;
	limit?: number;
}

function spendAmounts(spend: Record<string, unknown>): ExtraAmounts | undefined {
	if (spend.enabled !== true || !isRecord(spend.used)) return undefined;
	const used = moneyAmount(spend.used.amount_minor, spend.used.exponent, spend.used.currency, true);
	if (used === undefined) return undefined;
	if (!isRecord(spend.limit)) return { used };
	const limit = moneyAmount(spend.limit.amount_minor, spend.limit.exponent, spend.limit.currency, true);
	return limit === undefined ? undefined : { used, limit };
}

function legacyAmounts(extra: Record<string, unknown>): ExtraAmounts | undefined {
	if (extra.is_enabled !== true) return undefined;
	const exponent = extra.decimal_places === undefined ? 2 : extra.decimal_places;
	const used = moneyAmount(extra.used_credits, exponent, extra.currency, false);
	if (used === undefined) return undefined;
	if (extra.monthly_limit === null || extra.monthly_limit === undefined) return { used };
	const limit = moneyAmount(extra.monthly_limit, exponent, extra.currency, false);
	return limit === undefined ? undefined : { used, limit };
}

/** Dollars of an amount in minor units; undefined for anything but a non-negative USD amount. */
function moneyAmount(
	minor: unknown,
	exponent: unknown,
	currency: unknown,
	currencyRequired: boolean,
): number | undefined {
	if (typeof minor !== "number" || !Number.isFinite(minor) || minor < 0) return undefined;
	if (typeof exponent !== "number" || !Number.isInteger(exponent) || exponent < 0) return undefined;
	if (currency === undefined ? currencyRequired : typeof currency !== "string" || currency.toUpperCase() !== "USD") {
		return undefined;
	}
	return minor / 10 ** exponent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
