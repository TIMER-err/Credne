// Server retry hints carried by provider response headers, and the HTTP error facts callers need from a failed request.
// Ported from oh-my-pi's `utils/retry-after.ts`.

/** Response headers as an SDK error exposes them. */
export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

/** HTTP status of a failed provider request, looking through `cause` chains. Undefined for transport failures. */
export function getHttpStatusFromError(error: unknown): number | undefined {
	const record = asRecord(error);
	if (!record) return undefined;
	if (typeof record.status === "number") return record.status;
	return getHttpStatusFromError(record.cause);
}

/** Response headers of a failed provider request, looking through `cause` chains. */
export function getHeadersFromError(error: unknown): HeadersLike {
	const record = asRecord(error);
	if (!record) return undefined;
	const direct = asHeaders(record.headers) ?? asHeaders(asRecord(record.response)?.headers);
	if (direct) return direct;
	return getHeadersFromError(record.cause);
}

/**
 * Delay the server asked for before a retry, in milliseconds: the largest of `retry-after-ms`,
 * `retry-after` (seconds or HTTP date), `x-ratelimit-reset-ms` and `x-ratelimit-reset`.
 * Undefined when the response carries none of them.
 */
export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;
	const candidates = [
		parseRetryAfterMsHeader(getHeaderValue(headers, "retry-after-ms")),
		parseRetryAfterHeader(getHeaderValue(headers, "retry-after")),
		parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms")),
		parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), 1000),
	].filter((value): value is number => value !== undefined);
	return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/**
 * The server's explicit `x-should-retry` verdict: `true` or `false` when the header says so, undefined when it is
 * absent or unrecognised. When present it overrides every status and text heuristic.
 */
export function getShouldRetryFromHeaders(headers: HeadersLike): boolean | undefined {
	if (!headers) return undefined;
	const value = getHeaderValue(headers, "x-should-retry");
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

/** One header value, matched case-insensitively. */
export function getHeaderValue(headers: NonNullable<HeadersLike>, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && typeof value === "string") return value;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asHeaders(value: unknown): HeadersLike {
	if (value instanceof Headers) return value;
	return asRecord(value) as Record<string, string | undefined> | undefined;
}

/** `retry-after-ms`: a plain millisecond delta. */
function parseRetryAfterMsHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Number(value.trim());
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	return Math.ceil(ms);
}

function parseRetryAfterHeader(value: string | undefined): number | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) return seconds <= 0 ? undefined : Math.ceil(seconds * 1000);
	const dateMs = Date.parse(trimmed);
	if (Number.isNaN(dateMs)) return undefined;
	const delay = dateMs - Date.now();
	return delay > 0 ? Math.ceil(delay) : undefined;
}

/**
 * `x-ratelimit-reset*`: a delta, an epoch in seconds, or an epoch in milliseconds. `unitMs` is what one unit of a
 * delta is worth (1 for the `-ms` header, 1000 for seconds).
 */
function parseResetHeader(value: string | undefined, unitMs = 1): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
	const targetMs = resetEpochMs(numeric);
	if (targetMs === undefined) return Math.ceil(numeric * unitMs);
	const delay = targetMs - Date.now();
	return delay > 0 ? Math.ceil(delay) : undefined;
}

/** Epoch milliseconds of a reset header that carries an absolute time; undefined for a delta. */
function resetEpochMs(numeric: number): number | undefined {
	if (numeric > 1e12) return numeric;
	if (numeric > 1e9) return numeric * 1000;
	return undefined;
}
