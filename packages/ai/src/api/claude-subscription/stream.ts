// The stream of Claude subscription (OAuth) requests: Anthropic's Messages API spoken directly over HTTP, with no SDK.
// It builds the request body, sends it through the client, and maps the event stream to pi's. The loop around the
// request owns every retry, as oh-my-pi's provider loop does: up to ten attempts, only until the first content block
// of the reply has started, with watchdogs on the stream, and one rewrite of the request for each detail the endpoint
// rejects (cache breakpoints, replayed thinking, a Claude Code version that is too old, strict tools, threads). A reply
// that completes empty is replayed around the whole loop, and a caller that opts in has slow mode (the slow lane
// of a subscription whose session limit is reached) waited through.

import type {
	MessageCreateParamsStreaming,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "../../types.ts";
import { appendAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { withCauseDetail } from "../../utils/error-body.ts";
import { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../../utils/headers.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { appendProviderHttpErrorDiagnostic } from "../../utils/provider-http-error.ts";
import { resolveTranscript, type TranscriptContext } from "../../utils/transcript.ts";
import type { AnthropicOptions } from "../anthropic-messages.ts";
import { buildAnthropicSimpleOptions, getAnthropicCompat } from "../anthropic-shared.ts";
import {
	hasExceededStrictToolLimits,
	isStrictToolLimitErrorMessage,
	markStrictToolLimitsExceeded,
} from "../strict-tool-limits.ts";
import { resolveClaudeCodeCacheControl } from "./cache.ts";
import {
	buildPromptCachePrewarmBody,
	getPromptCachePrewarmRejection,
	promptCachePrewarmEventStream,
} from "./cache-prewarm.ts";
import { AnthropicApiError, type ClaudeSubscriptionClient, createClaudeSubscriptionClient } from "./client.ts";
import { withEmptyCompletionRetry } from "./empty-completion.ts";
import { createEventMapper, type EventMapper } from "./events.ts";
import { adoptRequiredClaudeCodeVersion, getClaudeCodeVersion } from "./fingerprint.ts";
import { CLAUDE_ACCOUNT_UUID_ENV, type ClaudeCodeRequestIdentity, prepareClaudeCodeRequest } from "./identity.ts";
import { iterateLenientAnthropicEvents } from "./lenient-events.ts";
import {
	applyClaudeCodeRecovery,
	type ClaudeCodeRecovery,
	commitClaudeCodeRecovery,
	createClaudeCodeRecovery,
	recoverFromFailure,
} from "./recovery.ts";
import {
	type BuiltClaudeCodeParams,
	buildClaudeCodeParams,
	convertClaudeCodeReply,
	getFirstUserText,
} from "./request.ts";
import { createStreamWatchdog, primeStream, resolveStreamTimeouts, type StreamTimeouts } from "./retry.ts";
import {
	type AnthropicSlowModeSession,
	anthropicSlowUsageLimit,
	anthropicUsageLimitHeader,
	parseAnthropicSlowModeHeaders,
	resolveSlowModeLane,
} from "./slow-mode.ts";
import { iterateWithTerminalGrace, postStopGraceMs } from "./terminal-grace.ts";
import {
	claudeCodeThreadsEnabled,
	createThreadTurn,
	type StoredReply,
	type ThreadPlan,
	type ThreadRecovery,
	type ThreadTurn,
} from "./threads.ts";
import { createClaudeCodeFetch, OFFICIAL_ANTHROPIC_ORIGIN } from "./transport.ts";

/** Whether a request is a Claude subscription request: an OAuth access token, with no caller-built SDK client. */
export function isClaudeSubscriptionRequest(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions | undefined,
): boolean {
	return (
		options?.client === undefined &&
		model.provider !== "github-copilot" &&
		options?.apiKey?.includes("sk-ant-oat") === true
	);
}

/**
 * Streams a reply to a Claude subscription request. The endpoint sometimes ends a turn with a normal stop and no
 * content, which usually answers on replay, so an empty reply is requested again, as oh-my-pi's entry does.
 */
export const streamClaudeSubscription: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model,
	context,
	options,
) =>
	withEmptyCompletionRetry(model, () => streamClaudeSubscriptionOnce(model, context, options ?? {}), {
		signal: options?.signal,
	});

function streamClaudeSubscriptionOnce(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output = createOutput(model);
	void runStream(stream, output, model, context, options);
	return stream;
}

/** Streams a reply to a Claude subscription request from simple options: a reasoning level instead of a thinking budget. */
export const streamSimpleClaudeSubscription: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model,
	context,
	options,
) => streamClaudeSubscription(model, context, buildAnthropicSimpleOptions(model, context, options));

function createOutput(model: Model<"anthropic-messages">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function runStream(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
): Promise<void> {
	try {
		const state = await createRequestState(stream, output, model, context, options);
		const events = await openReply(state);
		const inputTransformations = await consumeEvents(state, events);
		finishReply(state, inputTransformations);
	} catch (error) {
		output.stopReason = options.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? withCauseDetail(error) : JSON.stringify(error);
		appendProviderHttpErrorDiagnostic(output, error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	}
}

/** What the attempts of one request share. */
interface RequestState {
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	model: Model<"anthropic-messages">;
	transcript: TranscriptContext;
	options: AnthropicOptions;
	client: ClaudeSubscriptionClient;
	/** The rewrites the endpoint's rejections made necessary, which later requests of the session start from. */
	recovery: ClaudeCodeRecovery;
	timeouts: StreamTimeouts;
	/** The session's thread, when this request may use one. */
	turn: ThreadTurn | undefined;
	claudeCode: ClaudeCodeRequestIdentity;
	/** The Claude Code version the last attempt sent, which a "version too old" rejection is judged against. */
	sentVersion: string;
	/** Strict tools are sent non-strict: Anthropic rejected them for this request or session. */
	disableStrictTools: boolean;
	/** The caller's slow-mode hooks and this request's lane; none when the caller did not opt in or the host has no slow lane. */
	slowMode: AnthropicSlowModeSession | undefined;
	/** `start` has been pushed. It follows the first response, so a request that fails first shows no start. */
	started: boolean;
}

async function createRequestState(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
): Promise<RequestState> {
	if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const compat = getAnthropicCompat(model);
	const transcript = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const claudeCode = await prepareIdentity(transcript, options);
	const client = createClaudeSubscriptionClient({
		token: options.apiKey,
		baseUrl: model.baseUrl,
		sessionId: claudeCode.sessionId,
		callerHeaders: providerHeadersToRecord(model.headers, options.headers),
		fetch: createClaudeCodeFetch({ fetch: options.fetch, idleTimeoutMs: options.timeoutMs }),
	});
	return {
		stream,
		output,
		model,
		transcript,
		options,
		client,
		recovery: createClaudeCodeRecovery(options.sessionId),
		timeouts: resolveStreamTimeouts(options.env),
		turn: createTurn(model, options),
		claudeCode,
		sentVersion: getClaudeCodeVersion(),
		disableStrictTools: hasExceededStrictToolLimits(options.sessionId),
		slowMode: createSlowMode(model, options, options.apiKey),
		started: false,
	};
}

function prepareIdentity(transcript: TranscriptContext, options: AnthropicOptions): Promise<ClaudeCodeRequestIdentity> {
	return prepareClaudeCodeRequest(
		getFirstUserText(transcript.messages),
		options.sessionId,
		options.env,
		options.metadata,
	);
}

/** Only a request to Anthropic's own API has a slow lane; a gateway would not know what the header asks for. */
function createSlowMode(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
	bearer: string,
): AnthropicSlowModeSession | undefined {
	const hooks = options.anthropicSlowMode;
	if (!hooks || !isOfficialAnthropicApi(model.baseUrl)) return undefined;
	return { hooks, lane: resolveSlowModeLane(getProviderEnvValue(CLAUDE_ACCOUNT_UUID_ENV, options.env), bearer) };
}

function isOfficialAnthropicApi(baseUrl: string): boolean {
	const lowerBaseUrl = baseUrl.toLowerCase();
	return lowerBaseUrl === OFFICIAL_ANTHROPIC_ORIGIN || lowerBaseUrl.startsWith(`${OFFICIAL_ANTHROPIC_ORIGIN}/`);
}

/** The thread of the session, for a request that may use one: it has a session, caching is on, and the model threads. */
function createTurn(model: Model<"anthropic-messages">, options: AnthropicOptions): ThreadTurn | undefined {
	if (!options.sessionId || options.disableContinuation === true || !claudeCodeThreadsEnabled(model)) return undefined;
	const cacheControl = resolveClaudeCodeCacheControl(
		getAnthropicCompat(model).supportsLongCacheRetention,
		options.cacheRetention,
		options.env,
	);
	return cacheControl === undefined ? undefined : createThreadTurn(options.sessionId, model.baseUrl);
}

/** One attempt: its own abort, so a watchdog can cut the transport of a stalled stream, besides the caller's. */
interface Attempt {
	signal: AbortSignal;
	abort(): void;
}

function startAttempt(callerSignal: AbortSignal | undefined): Attempt {
	const controller = new AbortController();
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	return { signal, abort: () => controller.abort() };
}

/** A request built for one attempt, with the body that went through the payload hook. */
interface PreparedAttempt {
	built: BuiltClaudeCodeParams;
	params: MessageCreateParamsStreaming;
	/** The attempt asks for the slow lane (`anthropic-usage-limit: slow`): the caller's slow mode is active on the lane. */
	sentSlow: boolean;
}

/**
 * Sends the request until a response opens and its first content block has started. A failure up to there is thrown
 * with nothing of the reply processed, so it can be answered and the request sent again.
 */
async function openReply(state: RequestState): Promise<AsyncGenerator<RawMessageStreamEvent>> {
	for (;;) {
		state.options.signal?.throwIfAborted();
		const attempt = startAttempt(state.options.signal);
		const prepared = await prepareAttempt(state);
		try {
			const plan = state.turn?.plan(prepared.params);
			const response = await sendRequest(state, attempt, prepared, plan);
			return await openEvents(state, attempt, response);
		} catch (error) {
			if (!(await recoverFromAttemptFailure(state, error, prepared))) throw error;
		}
	}
}

async function prepareAttempt(state: RequestState): Promise<PreparedAttempt> {
	const { recovery } = state;
	const built = buildClaudeCodeParams(state.model, state.transcript, state.options, state.claudeCode, {
		disableStrictTools: state.disableStrictTools,
		dropPromptCacheBetas: recovery.dropCacheControl || recovery.dropCacheControlOptions,
	});
	if (built.providerThinkingLevel) state.output.providerThinkingLevel = built.providerThinkingLevel;
	const params = applyClaudeCodeRecovery(built.params, recovery);
	const replacement = await state.options.onPayload?.(params, state.model);
	// The hook returns unknown: the body it hands back is its author's responsibility.
	return {
		built,
		params: replacement === undefined ? params : { ...(replacement as MessageCreateParamsStreaming), stream: true },
		sentSlow: state.slowMode?.hooks.isActive(state.slowMode.lane) === true,
	};
}

async function sendRequest(
	state: RequestState,
	attempt: Attempt,
	prepared: PreparedAttempt,
	plan: ThreadPlan | undefined,
): Promise<Response> {
	const body = plan?.body ?? prepared.params;
	const isPrewarm = state.options.prewarm === true && getPromptCachePrewarmRejection(body) === undefined;
	const requestOptions = {
		signal: attempt.signal,
		timeoutMs: state.options.timeoutMs ?? state.timeouts.firstEventTimeoutMs,
		...(prepared.sentSlow ? { headers: { [anthropicUsageLimitHeader]: anthropicSlowUsageLimit } } : {}),
	};
	try {
		const response = await state.client.createMessage(
			isPrewarm ? buildPromptCachePrewarmBody(body) : body,
			requestOptions,
		);
		return isPrewarm ? await promptCachePrewarmEventStream(response) : response;
	} catch (error) {
		// A rejected request has a response too, and usage tracking reads its rate-limit headers.
		if (error instanceof AnthropicApiError) await notifyResponse(state, error.status, error.headers);
		throw error;
	}
}

function notifyResponse(state: RequestState, status: number, headers: Headers): void | Promise<void> {
	return state.options.onResponse?.({ status, headers: headersToRecord(headers) }, state.model);
}

async function openEvents(
	state: RequestState,
	attempt: Attempt,
	response: Response,
): Promise<AsyncGenerator<RawMessageStreamEvent>> {
	await notifyResponse(state, response.status, response.headers);
	observeSlowMode(state, response.headers);
	if (!state.started) {
		state.started = true;
		state.stream.push({ type: "start", partial: state.output });
	}
	const watchdog = createStreamWatchdog(state.timeouts, attempt.abort);
	const events = watchdog.wrap(iterateLenientAnthropicEvents(response, attempt.signal, watchdog.ping));
	const drained = iterateWithTerminalGrace(events, {
		isTerminal: (event) => event.type === "message_stop",
		graceMs: postStopGraceMs,
		onGraceEnd: attempt.abort,
	});
	return primeStream(drained);
}

/** Lets the caller's slow-mode state machine read the slow-lane headers of a response that opened. */
function observeSlowMode(state: RequestState, headers: Headers): void {
	if (!state.slowMode) return;
	const signal = parseAnthropicSlowModeHeaders(headers);
	if (signal) state.slowMode.hooks.observe(signal, state.slowMode.lane);
}

/**
 * Answers a failed attempt. Returns true when the request should be sent again, false when `error` should surface.
 * A refusal of the thread, a transient failure, a slow-lane wait, a rejected request detail, a Claude Code version that
 * is too old, strict tools beyond Anthropic's limits and a 400 nothing else explained on a thread request each get
 * their answer.
 */
async function recoverFromAttemptFailure(
	state: RequestState,
	error: unknown,
	prepared: PreparedAttempt,
): Promise<boolean> {
	if (state.options.signal?.aborted) return false;
	const threadRecovery = state.turn?.recover(error);
	if (threadRecovery) {
		recordThreadFallback(state, error, threadRecovery);
		return true;
	}
	const failure = {
		params: prepared.params,
		recovery: state.recovery,
		output: state.output,
		signal: state.options.signal,
		slowMode: state.slowMode && { ...state.slowMode, sentSlow: prepared.sentSlow },
	};
	if (await recoverFromFailure(error, failure, state.options)) return true;
	if (await adoptRequiredVersion(state, error)) return true;
	if (downgradeStrictTools(state, prepared.built, error)) return true;
	return dropThreadAfterUnexplained400(state, error);
}

/** A 400 on a thread request that nothing explained is sent again without the thread; the turn then tells if it was the cause. */
function dropThreadAfterUnexplained400(state: RequestState, error: unknown): boolean {
	if (!state.turn?.dropAfterUnexplained400(error)) return false;
	recordThreadFallback(state, error, "unthreaded");
	return true;
}

function recordThreadFallback(state: RequestState, error: unknown, recovery: ThreadRecovery): void {
	const reason = error instanceof AnthropicApiError ? (error.code ?? String(error.status)) : recovery;
	appendAssistantMessageDiagnostic(state.output, {
		type: "anthropic_thread_fallback",
		timestamp: Date.now(),
		error: { message: error instanceof Error ? error.message : String(error) },
		details: { reason },
	});
}

/**
 * A server-side minimum Claude Code version costs one rejected request, then the version is adopted. The request is
 * not the one that failed any more, so its retry budget starts over, as oh-my-pi's attempt counter does.
 */
async function adoptRequiredVersion(state: RequestState, error: unknown): Promise<boolean> {
	if (!adoptRequiredClaudeCodeVersion(error, state.sentVersion)) return false;
	state.sentVersion = getClaudeCodeVersion();
	state.claudeCode = await prepareIdentity(state.transcript, state.options);
	state.recovery.retriesDone = 0;
	return true;
}

/** Strict tools beyond Anthropic's limits are rejected for the whole request: they are sent non-strict from then on. */
function downgradeStrictTools(state: RequestState, built: BuiltClaudeCodeParams, error: unknown): boolean {
	const isLimitRejection =
		error instanceof AnthropicApiError &&
		error.status === 400 &&
		error.type === "invalid_request_error" &&
		isStrictToolLimitErrorMessage(error.message);
	if (state.disableStrictTools || !built.hasStrictTools || !isLimitRejection) return false;
	state.disableStrictTools = true;
	markStrictToolLimitsExceeded(state.options.sessionId);
	appendAssistantMessageDiagnostic(state.output, {
		type: "anthropic_strict_tools_fallback",
		timestamp: Date.now(),
		error: { message: error.message },
		details: { reason: "strict_tool_limits_exceeded" },
	});
	return true;
}

/** Reads the events of the reply into the output, pushing the stream events. Returns the input transformations reported. */
async function consumeEvents(state: RequestState, events: AsyncGenerator<RawMessageStreamEvent>) {
	const mapper = createEventMapper(state.model, state.output, (event) => state.stream.push(event));
	for await (const event of events) {
		await state.options.onProviderStreamEvent?.(event, state.model);
		mapper.apply(event);
		// The reply is complete here: the rest of the body drains in the background, inside its grace window.
		if (event.type === "message_stop") break;
	}
	return mapper.getInputTransformations();
}

function finishReply(
	state: RequestState,
	inputTransformations: ReturnType<EventMapper["getInputTransformations"]>,
): void {
	const { output, options } = state;
	if (options.signal?.aborted) throw new Error("Request was aborted");
	if (output.stopReason === "pending") throw new Error("Anthropic stream ended without a stop reason");
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
	state.turn?.settle(storedReply(state.model, output));
	commitClaudeCodeRecovery(state.recovery);
	if (inputTransformations && inputTransformations.length > 0) {
		appendAssistantMessageDiagnostic(output, {
			type: "anthropic_input_transformations",
			timestamp: Date.now(),
			details: {
				transformations: inputTransformations.map((transformation) => ({
					type: transformation.type ?? undefined,
					path: transformation.path ?? undefined,
					reason: transformation.reason ?? undefined,
				})),
			},
		});
	}
	state.stream.push({ type: "done", reason: output.stopReason, message: output });
	state.stream.end();
}

/** The reply the next request can continue; none when a fallback model answered, which the server does not store. */
function storedReply(model: Model<"anthropic-messages">, output: AssistantMessage): StoredReply | undefined {
	if (output.responseId === undefined || output.responseModel !== undefined) return undefined;
	return { messageId: output.responseId, messages: convertClaudeCodeReply(model, output) };
}
