// Text classification of provider rate-limit and quota failures: which are account-level usage limits that waiting
// does not clear (the account is parked and a caller rotates it), and which are throttles that clear on their own.
// Ported from oh-my-pi's `error/rate-limit.ts`. Google's structured `RESOURCE_EXHAUSTED` bodies are left out: no
// Anthropic endpoint answers in that shape.

type RateLimitReason =
	| "QUOTA_EXHAUSTED"
	| "RATE_LIMIT_EXCEEDED"
	| "CONCURRENT_LIMIT"
	| "MODEL_CAPACITY_EXHAUSTED"
	| "SERVER_ERROR"
	| "UNKNOWN";

const accountRateLimitPattern = /\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const insufficientBalancePattern = /insufficient.?balance/i;
// Prepaid-credit exhaustion phrased around the credit balance rather than a quota: Anthropic "This request would
// exceed your available credits given your current in-flight requests" (402), "credits exhausted".
const creditsExhaustedPattern =
	/\b(?:exceed\w*|insufficient|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b/i;
// Anthropic subscription entitlement wall: "Usage credits are required for this model" with `error_code:
// credits_required`. Bounded to the documented sentence and the exact code: bare "usage credits" also appears in
// unrelated diagnostics, which must not park a healthy credential.
const anthropicCreditsRequiredPattern = /\busage credits are required\b|\bcredits_required\b/i;
const prepaidBalanceExhaustedPattern =
	/\busage_pricing_required\b|\bprepaid balance\b[^\n]{0,40}\b(?:used up|exhausted|depleted)\b/i;
// Account billing ceilings: Anthropic "monthly spend limit". The `\b` after `cap` keeps "spending capacity", a
// throttle, out.
const spendLimitPattern = /spend(?:ing)?[\s_-]?(?:limit|cap)\b/i;
const budgetExceededPattern = /\bbudget(?:[\s_-]+has[\s_-]+been)?[\s_-]+exceeded\b/i;
const subscriptionCapPattern =
	/\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;
const transientIntervalRateLimitPattern = /\bper\s+(?:second|minute)\b/i;
const openRouterDailyFreeLimitPattern = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;
const clinePassQuotaPattern = /clinepass limit|free limit reached on model/i;
// gRPC/Connect end-streams carry the status as its name (`resource_exhausted`), HTTP bodies as a phrase.
const resourceExhaustedPattern = /resource.?exhausted/gi;
const concurrentLimitPattern =
	/\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b|\bconcurren[a-z]*[-_](?:[a-z]+[_-])*(?:limit|quota|exceed\w*|reach\w*)/i;
const accountScoped403Pattern =
	/\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;
// Simplified Chinese account-quota exhaustion; anchored on 使用 / 用量 so a per-minute or concurrency cap is not taken
// for a quota.
const cnQuotaExhaustedPattern = /(?:使用|用量).{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;
const cnTransientCapPattern =
	/速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;
const cnThrottlePattern = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/;
// DashScope's per-minute token throttle wears OpenAI's billing wording but clears within the minute.
const dashScopeTokenLimitDocPattern = /error-code[^()\s]*#token-limit/i;
const dashScopeTokenLimitMessagePattern =
	/\byou exceeded your current quota, please check your plan and billing details\b/i;
// Rolling per-minute token/request throttles (TPM/RPM) self-heal within the minute, whatever their wording.
const tpmRpmThrottlePattern =
	/\b(?:tpm|rpm)\b[^\n]{0,40}\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b|\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b[^\n]{0,40}\b(?:tpm|rpm)\b|\bRateLimitExceeded\.(?:Endpoint)?(?:TPM|RPM)\w*/i;
// A 429 whose `x-ratelimit-limit-*` header reports 0 is an entitlement wall, not a window; the notice a transport
// appends to the message names it.
const zeroAllowancePattern = /\bx-ratelimit-limit-[a-z0-9-]+:\s*0(?![\d.])/i;
const usageLimitPattern =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|out of (?:extra )?usage|spending[- _]?limit|personal-team-blocked|clinepass limit|free limit reached on model|access_terminated_error/i;
const status402QuotaPattern =
	/\b(?:payment(?:\s+is)?[-_.\s]*required|deactivated_workspace|insufficient.?(?:balance|account.?funds))\b/i;

function matchesSubscriptionCapText(message: string): boolean {
	return subscriptionCapPattern.test(message) && !transientIntervalRateLimitPattern.test(message);
}

/** True for DashScope/Bailian's documented OpenAI-compatible TPM/TPS throttle. */
export function isDashScopeTokenLimitText(message: string): boolean {
	return dashScopeTokenLimitDocPattern.test(message) && dashScopeTokenLimitMessagePattern.test(message);
}

/**
 * Classifies a rate-limit error message. Order of precedence: a quota that will reset, Chinese quota wording, the
 * DashScope throttle, a concurrency cap, model capacity, account caps and billing ceilings, rate limits (including
 * TPM/RPM windows), generic quota wording, server errors, a bare resource-exhausted status, unknown.
 */
export function parseRateLimitReason(message: string): RateLimitReason {
	const lowerWithStatus = message.toLowerCase();
	const lower = lowerWithStatus.replace(resourceExhaustedPattern, "");
	const hasResourceExhaustedStatus = lower !== lowerWithStatus;
	if (
		lower.includes("quota will reset") ||
		lower.includes("exhausted your capacity") ||
		zeroAllowancePattern.test(message)
	) {
		return "QUOTA_EXHAUSTED";
	}
	if (cnQuotaExhaustedPattern.test(message) && !cnTransientCapPattern.test(message)) return "QUOTA_EXHAUSTED";
	if (isDashScopeTokenLimitText(message)) return "RATE_LIMIT_EXCEEDED";
	if (concurrentLimitPattern.test(message)) return "CONCURRENT_LIMIT";
	if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
		return "MODEL_CAPACITY_EXHAUSTED";
	}
	if (isQuotaWording(message)) return "QUOTA_EXHAUSTED";
	if (
		lower.includes("per minute") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("presque") ||
		tpmRpmThrottlePattern.test(message)
	) {
		return "RATE_LIMIT_EXCEEDED";
	}
	if (isGenericQuotaWording(lower, message)) return "QUOTA_EXHAUSTED";
	if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
		return "SERVER_ERROR";
	}
	return hasResourceExhaustedStatus ? "MODEL_CAPACITY_EXHAUSTED" : "UNKNOWN";
}

// The account-scoped and billing arms that rank above the generic rate-limit wording.
function isQuotaWording(message: string): boolean {
	return (
		accountRateLimitPattern.test(message) ||
		spendLimitPattern.test(message) ||
		budgetExceededPattern.test(message) ||
		matchesSubscriptionCapText(message) ||
		openRouterDailyFreeLimitPattern.test(message) ||
		clinePassQuotaPattern.test(message) ||
		anthropicCreditsRequiredPattern.test(message) ||
		prepaidBalanceExhaustedPattern.test(message)
	);
}

// The loose quota wording that ranks below the rate-limit wording.
function isGenericQuotaWording(lower: string, message: string): boolean {
	return (
		lower.includes("exhausted") ||
		lower.includes("quota") ||
		lower.includes("usage limit") ||
		lower.includes("run out of credits") ||
		lower.includes("out of credits") ||
		lower.includes("spending-limit") ||
		lower.includes("spending limit") ||
		lower.includes("access_terminated_error") ||
		insufficientBalancePattern.test(message) ||
		creditsExhaustedPattern.test(message)
	);
}

/** HTTP statuses that, absent richer body classification, are an account-local usage cap: 429 and 402. */
export function isUsageLimitStatus(status: number | undefined): boolean {
	return status === 429 || status === 402;
}

/**
 * Whether a usage-limit status body is opaque: it carries no signal beyond the status itself (empty, the status
 * digits with HTTP or JSON framing, generic punctuation), so the failure is treated as an account cap conservatively.
 */
export function isOpaqueStatusBody(message: string): boolean {
	const cleaned = message
		.replace(/\b(?:429|402)\b/g, "")
		.replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "")
		.replace(/\(?\bno body\b\)?/gi, "");
	return (
		!/[a-z\d]{3,}/i.test(cleaned) &&
		!cnQuotaExhaustedPattern.test(cleaned) &&
		!cnTransientCapPattern.test(cleaned) &&
		!cnThrottlePattern.test(cleaned)
	);
}

/** Whether a 402 body is an account billing cap: opaque, payment or balance wording, or a quota or concurrency cap. */
export function is402BillingCapBody(message: string | undefined): boolean {
	if (message === undefined || isOpaqueStatusBody(message)) return true;
	if (status402QuotaPattern.test(message)) return true;
	const reason = parseRateLimitReason(message);
	return reason === "QUOTA_EXHAUSTED" || reason === "CONCURRENT_LIMIT";
}

/** Whether a message is persistent account usage or quota wording. */
export function matchesUsageLimitText(message: string): boolean {
	if (isDashScopeTokenLimitText(message)) return false;
	// Rolling TPM/RPM windows self-heal, so they never park a credential. The reason re-check is the precedence guard:
	// an account-scoped cap that merely quotes a TPM number resolves to a quota earlier and keeps its verdict.
	if (tpmRpmThrottlePattern.test(message) && parseRateLimitReason(message) === "RATE_LIMIT_EXCEEDED") return false;
	return (
		usageLimitPattern.test(message) ||
		anthropicCreditsRequiredPattern.test(message) ||
		prepaidBalanceExhaustedPattern.test(message) ||
		creditsExhaustedPattern.test(message) ||
		(cnQuotaExhaustedPattern.test(message) && !cnTransientCapPattern.test(message)) ||
		budgetExceededPattern.test(message) ||
		spendLimitPattern.test(message) ||
		accountRateLimitPattern.test(message) ||
		matchesSubscriptionCapText(message) ||
		openRouterDailyFreeLimitPattern.test(message) ||
		zeroAllowancePattern.test(message)
	);
}

/**
 * Account-scoped cap phrasing delivered on a 403 or without a status: "Reached overall message rate limit", "Your
 * limit will reset in ...". Ambiguous without that context, so callers gate it on the status.
 */
export function isAccountScopedCapText(message: string): boolean {
	return accountScoped403Pattern.test(message);
}

/** A concurrency cap on a non-billing status is shed-and-backoff, not an account cap. A 402 stays a billing cap. */
export function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
	return message !== undefined && parseRateLimitReason(message) === "CONCURRENT_LIMIT" && status !== 402;
}
