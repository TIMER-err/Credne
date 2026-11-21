// Records the provider HTTP error response that ended a request on the failed reply. The reader,
// `getProviderHttpErrorDetails`, lives in `diagnostics.ts`, which the model catalog loads; this writer needs the retry
// helpers and so stays out of that graph.

import {
	type AssistantMessageDiagnostic,
	appendAssistantMessageDiagnostic,
	extractDiagnosticError,
	PROVIDER_HTTP_ERROR_DIAGNOSTIC_TYPE,
} from "./diagnostics.ts";
import {
	getHeadersFromError,
	getHttpStatusFromError,
	getRetryAfterMsFromHeaders,
	type HeadersLike,
} from "./retry-after.ts";

const rateLimitHeaderPattern =
	/^(?:retry-after(?:-ms)?|x-should-retry|request-id|anthropic-ratelimit-.+|x-ratelimit-.+)$/;

/**
 * Records the HTTP status and rate-limit headers of the provider error response that ended a request, so callers
 * that rotate accounts or track usage can read them from the final reply. Does nothing for failures that carry
 * no HTTP status (transport errors, stream errors after a 200 response).
 */
export function appendProviderHttpErrorDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	error: unknown,
): void {
	const status = getHttpStatusFromError(error);
	if (status === undefined) return;
	const headers = getHeadersFromError(error);
	const retryAfterMs = getRetryAfterMsFromHeaders(headers);
	// The stack says nothing about a response the provider chose to send.
	const { stack: _stack, ...errorInfo } = extractDiagnosticError(error);
	appendAssistantMessageDiagnostic(message, {
		type: PROVIDER_HTTP_ERROR_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		error: errorInfo,
		details: {
			status,
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			headers: pickRateLimitHeaders(headers),
		},
	});
}

function pickRateLimitHeaders(headers: HeadersLike): Record<string, string> {
	const picked: Record<string, string> = {};
	if (!headers) return picked;
	const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
	for (const [name, value] of entries) {
		const lowerName = name.toLowerCase();
		if (typeof value === "string" && rateLimitHeaderPattern.test(lowerName)) picked[lowerName] = value;
	}
	return picked;
}
