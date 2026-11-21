import type { JsonObject } from "../types.ts";

export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: JsonObject;
}

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: JsonObject,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

/** Diagnostic type recorded on a failed reply when the provider answered with an HTTP error response. */
export const PROVIDER_HTTP_ERROR_DIAGNOSTIC_TYPE = "provider_http_error";

/** The HTTP error response that ended a request, as read back from {@link getProviderHttpErrorDetails}. */
export interface ProviderHttpErrorDetails {
	status: number;
	/** Delay the server asked for before a retry, from `retry-after-ms`, `retry-after` or `x-ratelimit-reset*`. */
	retryAfterMs?: number;
	/**
	 * The rate-limit related response headers, lower-cased: `retry-after*`, `x-should-retry`, `request-id`,
	 * `anthropic-ratelimit-*` (including `anthropic-ratelimit-unified-*`) and `x-ratelimit-*`.
	 */
	headers: Record<string, string>;
}

/** The provider HTTP error response recorded on `message`, if its request ended with one. */
export function getProviderHttpErrorDetails(message: {
	diagnostics?: AssistantMessageDiagnostic[];
}): ProviderHttpErrorDetails | undefined {
	const diagnostic = message.diagnostics?.findLast((entry) => entry.type === PROVIDER_HTTP_ERROR_DIAGNOSTIC_TYPE);
	const details = diagnostic?.details;
	// Diagnostics are persisted JSON, so the shape is checked here rather than trusted.
	if (typeof details?.status !== "number") return undefined;
	const headers: Record<string, string> = {};
	const recordedHeaders = details.headers;
	if (recordedHeaders !== null && typeof recordedHeaders === "object" && !Array.isArray(recordedHeaders)) {
		for (const [name, value] of Object.entries(recordedHeaders)) {
			if (typeof value === "string") headers[name] = value;
		}
	}
	return {
		status: details.status,
		...(typeof details.retryAfterMs === "number" ? { retryAfterMs: details.retryAfterMs } : {}),
		headers,
	};
}
