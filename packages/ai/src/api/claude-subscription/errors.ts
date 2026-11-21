// Classifies the failures of a Claude subscription (OAuth) request: which are worth replaying against the same
// account, which are account usage limits that waiting does not clear, and which name a request detail the endpoint
// refused. Ported from oh-my-pi's `error/retryable.ts`, `error/flags.ts` and `utils/fetch-retry.ts`.

import { getHeadersFromError, getShouldRetryFromHeaders } from "../../utils/retry-after.ts";
import {
	is402BillingCapBody,
	isAccountScopedCapText,
	isDashScopeTokenLimitText,
	isOpaqueStatusBody,
	isUsageLimitStatus,
	matchesUsageLimitText,
	parseRateLimitReason,
} from "./rate-limit.ts";

/** Prefix of the message of a malformed stream envelope; persisted error text is classified by it. */
export const STREAM_ENVELOPE_ERROR_PREFIX = "Anthropic stream envelope error:";

/** A response stream that violated the Anthropic event protocol, for example one that ended before `message_start`. */
export class AnthropicStreamEnvelopeError extends Error {
	constructor(detail: string) {
		super(`${STREAM_ENVELOPE_ERROR_PREFIX} ${detail}`);
		this.name = "AnthropicStreamEnvelopeError";
	}
}

/** A watchdog gave up on the response stream: no first event in time, or no progress for too long. */
export class AnthropicStreamTimeoutError extends Error {
	readonly kind: "first-event" | "idle";

	constructor(kind: "first-event" | "idle") {
		super(
			kind === "first-event"
				? "Anthropic stream timed out while waiting for the first event"
				: "Anthropic stream stalled while waiting for the next event",
		);
		this.name = "AnthropicStreamTimeoutError";
		this.kind = kind;
	}
}

/** Whether `status` is in the canonical transient set: 408, 429 or any 5xx. 409 is deliberately not. */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && (status === 408 || status === 429 || status >= 500);
}

/** A 4xx other than 408 and 429: the request itself was refused and fails identically on replay. */
function isTerminalClientErrorStatus(status: number | undefined): boolean {
	return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP status of an error, as oh-my-pi reads it in its two places: the error flags and the retry helpers.
// ---------------------------------------------------------------------------------------------------------------

const flagStatusMessagePatterns = [
	/\bstatus(?:_code)?[:=]\s*(\d{3})\b/i,
	/\bstatus\s+(\d{3})\b/i,
	/\bHTTP\s+(\d{3})\b/i,
	/\b(?:error|failed)\s*[:=]?\s*(\d{3})\b/i,
	/(?:^|\s)(\d{3})\s+(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
];

const retryStatusMessagePatterns = [
	/\berror\s*[:=]\s*(\d{3})\b/i,
	/error\s*\((\d{3})\)/i,
	/status\s*[:=]?\s*(\d{3})/i,
	/\bhttp\s*(\d{3})\b/i,
	/\b(\d{3})\s*(?:status|error)\b/i,
];

function isHttpStatus(value: unknown): value is number {
	return typeof value === "number" && value >= 100 && value <= 599;
}

function statusFromMessage(message: string, patterns: readonly RegExp[]): number | undefined {
	for (const pattern of patterns) {
		const code = Number(pattern.exec(message)?.[1]);
		if (isHttpStatus(code)) return code;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function messageOf(value: unknown): string | undefined {
	if (value instanceof Error) return value.message;
	if (typeof value === "string") return value;
	const message = asRecord(value)?.message;
	return typeof message === "string" ? message : undefined;
}

/** HTTP status of an error: its status fields, its causes up to depth 2, then a status named in the message. */
function getErrorStatus(error: unknown, depth = 0): number | undefined {
	if (depth > 2 || error === undefined || error === null) return undefined;
	const record = asRecord(error);
	if (record) {
		const direct = [record.status, record.statusCode, record.errorStatus, asRecord(record.response)?.status].find(
			isHttpStatus,
		);
		if (direct !== undefined) return direct;
		if ("cause" in record) {
			const nested = getErrorStatus(record.cause, depth + 1);
			if (nested !== undefined) return nested;
		}
	}
	// A bare string carries no status field; only an error or an object with a message is searched for one.
	const message = typeof error === "string" ? undefined : messageOf(error);
	return message === undefined ? undefined : statusFromMessage(message, flagStatusMessagePatterns);
}

/** The status the retry helpers read: status fields (numbers or numeric strings) through two causes, then the message. */
function getRetryHelperStatus(error: unknown, depth = 0): number | undefined {
	const record = asRecord(error);
	if (!record || depth > 2) return undefined;
	const raw = record.status ?? record.statusCode ?? asRecord(record.response)?.status;
	const status = typeof raw === "string" ? Number(raw) : raw;
	if (isHttpStatus(status)) return status;
	if (typeof record.message === "string") {
		const fromMessage = statusFromMessage(record.message, retryStatusMessagePatterns);
		if (fromMessage !== undefined) return fromMessage;
	}
	return record.cause ? getRetryHelperStatus(record.cause, depth + 1) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Transient wording.
// ---------------------------------------------------------------------------------------------------------------

// Transport-failure wording that marks an error transient: overload, rate limits, 5xx wording, dropped connections,
// timeouts, and the sentences oh-my-pi's network classifier writes (offline, unreachable, refused, TLS).
const transientTransportPattern =
	/\b(?:no[_ -]?capacity|(?:high|peak)[ _-]?demand|(?:at|over|insufficient)[ _-]?capacity|capacity[ _-]?(?:exceeded|exhausted)|peak[ _-]?load)\b|overloaded|provider.?returned.?error|rate.?limit|too many requests|auth-gateway\s+5\d{2}(?=[:\s]|$)|\b(?:429|500|502|503|504)\b|service.?unavailable|temporar(?:y|ily)[ _-]?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|unable.?to.?connect\.\s*is the computer able to access the url\?|other side closed|use of closed network connection|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|nghttp2_(?:internal_error|refused_stream)|stream closed with error code nghttp2_(?:internal_error|refused_stream)|\bE(?:TIMEOUT|NOTFOUND|NETUNREACH|HOSTUNREACH)\b|\bFailedToOpenSocket\b|no internet connection|couldn.?t reach|couldn.?t connect to|tls certificate verification failed|malformed.?function.?call/i;
// Node's spelling of the connection failures Bun reports in words: an undici or node:https error names its errno.
const nodeTransportPattern = /\bE(?:CONNRESET|CONNREFUSED|PIPE|AI_AGAIN|TIMEDOUT)\b/i;
// Provider-stream phrasings the shared pattern lacks: TLS record corruption, HTTP/2 peer stream errors, code 1302.
const providerTransientExtraPattern = /bad record mac|stream error.*received from peer|1302/i;

/** Whether the message says the socket closed unexpectedly, as Bun and some proxies report a reset stream. */
function isUnexpectedSocketCloseMessage(message: string): boolean {
	return (
		/\b(?:the\s+)?socket connection (?:was )?closed unexpectedly\b/i.test(message) ||
		/^(?:error:\s*)?socket is closed\.?$/i.test(message.trim())
	);
}

function isTransientTransportMessage(message: string): boolean {
	return message.includes("tls: bad record mac") || message.includes("type=server_error");
}

// A response truncated mid-JSON.
const streamParseTruncationPattern =
	/unterminated string|unexpected end of json input|unexpected end of data|unexpected eof|end of file|eof while parsing|truncated/i;
// The transport itself dropped: the connection ended before a terminal event, with no JSON-parse signal.
const streamDropPattern =
	/stream disconnected before completion|(?:stream|websocket) closed before response\.completed|stream (?:was )?interrupted|stream ended before (?:terminal (?:chunk|completion event)|message_(?:start|delta|stop))|socket disconnected before secure tls connection/i;
const streamEventOrderPattern = /stream event order|before message_start/i;

/** Whether `error` is a stream that arrived cut off mid-JSON. */
export function isTransientStreamParseError(error: unknown): boolean {
	return error instanceof Error && streamParseTruncationPattern.test(error.message);
}

/** Whether `error` is a stream the transport dropped before its terminal event. */
function isTransientStreamDropError(error: unknown): boolean {
	return error instanceof Error && streamDropPattern.test(error.message);
}

/** Whether `error` is a malformed stream envelope: tagged by its prefix, or an out-of-order or missing event. */
export function isStreamEnvelopeError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes(STREAM_ENVELOPE_ERROR_PREFIX) || streamEventOrderPattern.test(error.message))
	);
}

/** Whether a stream failure can be replayed as long as nothing of the reply has been shown yet. */
export function isTransientStreamFailure(error: unknown): boolean {
	return isTransientStreamParseError(error) || isStreamEnvelopeError(error);
}

// ---------------------------------------------------------------------------------------------------------------
// Usage limits and cache_control, classified over the whole cause chain as oh-my-pi's `classify` does.
// ---------------------------------------------------------------------------------------------------------------

// Rejected `cache_control`: the field itself, or an option of it, is not accepted by the endpoint.
const cacheControlFieldPattern = /\bcache_control\b/i;
const cacheControlRejectionPattern =
	/\bunexpected\b|\bunrecognized\b|\bnot permitted\b|\bnot allowed\b|\bnot recognized\b|\bnot supported\b|\bunsupported\b|\binvalid[_ ]field\b|\bextra (?:inputs?|fields?)\b/i;
// The bare-word gate above misses snake_cased error codes (`unsupported_parameter`) and strict decoders that report a
// refused member (`unknown field "cache_control"`, `Invalid parameter: cache_control`). Both families stay anchored to
// a schema-member noun one joiner away: `invalid_request_error` prefixes nearly every Anthropic 400 and cannot match.
const cacheControlMemberRefusalPattern =
	/\b(?:un(?:known|permitted|supported|recognized|expected)|invalid|bad|not (?:an? )?(?:known|valid|accepted|supported|permitted|allowed|recognized))[_ -](?:field|name|param(?:eter)?|argument|key|propert(?:y|ies)|attribute|member|option|input)s?\b/i;
// A breakpoint on an empty text block is a content fault: dropping every breakpoint neither fixes it nor proves the
// endpoint lacks prompt caching.
const cacheControlEmptyTextPattern =
	/empty text block|text content block.*non-(?:empty|whitespace)|text.{0,40}must (?:be non-empty|not be empty)/i;

function matchesCacheControlRejection(message: string, status: number | undefined): boolean {
	if (status !== 400) return false;
	if (!cacheControlFieldPattern.test(message)) return false;
	if (cacheControlEmptyTextPattern.test(message)) return false;
	return cacheControlRejectionPattern.test(message) || cacheControlMemberRefusalPattern.test(message);
}

/** What a message and its status say, for the kinds the retry decisions use. */
interface TextKinds {
	usageLimit: boolean;
	cacheControlRejection: boolean;
}

function classifyText(message: string | undefined, errorStatus: number | undefined): TextKinds {
	const kinds: TextKinds = { usageLimit: false, cacheControlRejection: false };
	const status = errorStatus ?? (message ? getErrorStatus({ message }) : undefined);
	if (message) {
		const reason = parseRateLimitReason(message);
		// A concurrency cap is shed-and-backoff, not an account cap, even when its wording reads like a quota; a 402
		// whose body merely mentions concurrency still is one.
		const concurrencyExcluded = reason === "CONCURRENT_LIMIT" && status !== 402;
		kinds.usageLimit =
			!concurrencyExcluded &&
			((status === 402 && is402BillingCapBody(message)) ||
				matchesUsageLimitText(message) ||
				((status === 403 || status === undefined) && isAccountScopedCapText(message)) ||
				(isUsageLimitStatus(status) && (isOpaqueStatusBody(message) || reason === "QUOTA_EXHAUSTED")));
		kinds.cacheControlRejection = matchesCacheControlRejection(message, status);
	}
	if (status === 402 && (message === undefined || isOpaqueStatusBody(message))) kinds.usageLimit = true;
	return kinds;
}

/**
 * The usage-limit verdict of a provider HTTP error's own code: the body's `error_code`, else its `error.type`. Only
 * an object that carries an HTTP status is one.
 */
function isUsageLimitCode(link: unknown): boolean {
	const record = asRecord(link);
	if (!record || typeof record.status !== "number") return false;
	const code = record.code ?? record.type;
	return (
		code === "usage_limit_reached" ||
		(code === "insufficient_quota" && !isDashScopeTokenLimitText(messageOf(link) ?? ""))
	);
}

function classifyChain(error: unknown): TextKinds {
	const kinds: TextKinds = { usageLimit: false, cacheControlRejection: false };
	const seen = new Set<object>();
	let link: unknown = error;
	// A terminal 4xx on an outer link governs its own cause diagnostics: a wrapped phrase describes why the
	// deterministic request failed, not an independent fault.
	let governingTerminalStatus: number | undefined;
	while (link !== undefined && link !== null) {
		if (typeof link === "object") {
			if (seen.has(link)) break;
			seen.add(link);
		}
		const linkStatus = getErrorStatus(link);
		const text = classifyText(messageOf(link), linkStatus ?? governingTerminalStatus);
		kinds.usageLimit ||= text.usageLimit || isUsageLimitCode(link);
		kinds.cacheControlRejection ||= text.cacheControlRejection;
		if (isTerminalClientErrorStatus(linkStatus)) governingTerminalStatus = linkStatus;
		link = typeof link === "object" && "cause" in link ? link.cause : undefined;
	}
	return kinds;
}

/**
 * Whether an error is an account usage or quota limit: the persistent kind that waiting does not clear. The stream
 * loop leaves those to the caller (account rotation, the session retry layer) instead of replaying them.
 */
export function isUsageLimitError(error: unknown): boolean {
	return classifyChain(error).usageLimit;
}

/** Whether an HTTP 400 says the endpoint refused `cache_control`, or an option of it. */
export function isCacheControlRejection(error: unknown): boolean {
	return classifyChain(error).cacheControlRejection;
}

// ---------------------------------------------------------------------------------------------------------------
// Retryable.
// ---------------------------------------------------------------------------------------------------------------

const transientMessagePattern =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server error|internal error|connection.?error|unable to connect|fetch failed|network error|stream stall|other side closed|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)/i;
const validationMessagePattern =
	/invalid|validation|bad request|unsupported|schema|missing required|not found|unauthorized|forbidden/i;

/** The generic fallback of oh-my-pi's `isRetryableError`: aborts and timeouts, retryable statuses, transient phrases. */
function isRetryableByHelper(error: Error): boolean {
	if (error.name === "AbortError" || /timeout|timed out|aborted/i.test(error.message)) return true;
	const status = getRetryHelperStatus(error);
	if (status !== undefined) {
		if (status >= 500 || status === 408 || status === 429) return true;
		if (status >= 400 && status < 500) return false;
	}
	if (validationMessagePattern.test(error.message)) return false;
	return isUnexpectedSocketCloseMessage(error.message) || transientMessagePattern.test(error.message);
}

/**
 * Whether an error should be replayed against the same account: a transient status, a transport failure, or a
 * dropped stream. Usage limits are not (the account is parked), nor is any 4xx other than 408 and 429 (the request
 * itself was refused and fails identically on replay), nor is 409. A captured `x-should-retry` header overrides
 * everything else.
 */
export function isClaudeCodeRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (isUsageLimitError(error)) return false;
	const verdict = getShouldRetryFromHeaders(getHeadersFromError(error));
	if (verdict !== undefined) return verdict;
	if (isTerminalClientErrorStatus(getErrorStatus(error))) return false;
	const message = error.message.toLowerCase();
	return (
		isUnexpectedSocketCloseMessage(message) ||
		isTransientTransportMessage(message) ||
		transientTransportPattern.test(message) ||
		nodeTransportPattern.test(message) ||
		providerTransientExtraPattern.test(message) ||
		isTransientStreamParseError(error) ||
		isTransientStreamDropError(error) ||
		streamEventOrderPattern.test(error.message) ||
		isRetryableByHelper(error)
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Thinking blocks the endpoint can no longer verify.
// ---------------------------------------------------------------------------------------------------------------

const invalidThinkingSignaturePattern = /invalid\s+`?signature`?\s+in\s+`?thinking`?(?:\s+block)?/i;
const missingThinkingSignaturePattern = /thinking\.signature\b[^"\n]{0,32}\brequired\b/i;
const thinkingPrefixBindingPattern =
	/(?:bound to a different conversation|block_binding\.prefix_mismatch_behavior|prefix_mismatch_behavior)/i;
const immutableLatestThinkingPattern =
	/messages\.\d+\.content\.\d+.*\b(?:thinking|redacted_thinking)\b.*\blatest assistant message cannot be modified\b/is;
const compactionCodePattern = /\bcompaction_[a-z_]+\b/i;

/** Detects the preserved-thinking error caused by rewriting a signed block's conversation prefix. */
export function isThinkingPrefixBindingError(message: string): boolean {
	return (
		!compactionCodePattern.test(message) &&
		invalidThinkingSignaturePattern.test(message) &&
		thinkingPrefixBindingPattern.test(message)
	);
}

/** Detects a rejected thinking signature, or a thinking block sent without one. */
export function isInvalidThinkingSignatureError(message: string): boolean {
	if (compactionCodePattern.test(message)) return false;
	return invalidThinkingSignaturePattern.test(message) || missingThinkingSignaturePattern.test(message);
}

/** Detects the rejection of a replayed latest assistant turn whose thinking blocks no longer verify. */
export function isImmutableLatestThinkingText(message: string): boolean {
	return immutableLatestThinkingPattern.test(message);
}
