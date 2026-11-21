/**
 * Loopback OAuth redirect handler shared by the browser sign-in flows.
 *
 * NOTE: This module uses node:http. It is only reachable through the lazily
 * loaded OAuth flow modules, never from browser-facing entry points.
 */

import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
import type { ProviderAuthInteraction } from "../types.ts";

export interface OAuthCallbackServerOptions<T> {
	/** Provider name used on the browser page, for example `OpenAI`. */
	providerName: string;
	/** Address to listen on. */
	host: string;
	/** Port to listen on; `0` picks a free port. */
	port: number;
	/**
	 * A second address to listen on, at the port `host` got: the IPv6 loopback beside the IPv4 one, since
	 * `localhost` resolves to both and a browser may try either. Binding only one hands the authorization code to
	 * whatever else holds the other address on that port. A host that cannot bind it is served by `host` alone;
	 * another process holding it exactly is a port conflict, like one on `host`.
	 */
	companionHost?: string;
	path: string;
	/** Host in `redirectUri` when it differs from `host`, for example `localhost`. */
	redirectHost?: string;
	/** Expected `state` parameter. Omit when the provider does not send one. */
	state?: string;
	/**
	 * Finishes the sign-in with the received code before the browser page is sent, so the page can
	 * show exchange failures. Pass `async (code) => code` to exchange the code later.
	 */
	complete: (code: string) => Promise<T>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface OAuthCallbackServer<T> {
	redirectUri: string;
	/**
	 * Resolves with the result of `complete`, or `undefined` after `cancel()`. Rejects when the provider
	 * redirects with an error, `complete` fails, the signal aborts, or the timeout elapses.
	 */
	wait(): Promise<T | undefined>;
	/** Stop waiting for the browser unless a callback is already being completed. */
	cancel(): void;
	close(): void;
}

function sendPage(response: ServerResponse, status: number, html: string): void {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(html);
}

export async function startOAuthCallbackServer<T>(
	options: OAuthCallbackServerOptions<T>,
): Promise<OAuthCallbackServer<T>> {
	const { providerName, signal } = options;
	if (signal?.aborted) throw new Error("Login cancelled");

	let resolveWait: (value: T | undefined) => void = () => {};
	let rejectWait: (error: Error) => void = () => {};
	const waitPromise = new Promise<T | undefined>((resolve, reject) => {
		resolveWait = resolve;
		rejectWait = reject;
	});
	// A cancelled or closed wait may never be observed.
	waitPromise.catch(() => undefined);

	let claimed = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => finish({ error: new Error("Login cancelled") });
	const finish = (result: { value: T | undefined } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		if ("error" in result) rejectWait(result.error);
		else resolveWait(result.value);
	};

	const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (request.method !== "GET" || url.pathname !== options.path) {
				sendPage(response, 404, oauthErrorHtml("Callback route not found."));
				return;
			}
			if (options.state !== undefined && url.searchParams.get("state") !== options.state) {
				sendPage(response, 400, oauthErrorHtml("State mismatch."));
				return;
			}
			if (claimed || settled) {
				sendPage(response, 409, oauthErrorHtml("This sign-in has already been handled."));
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const description = url.searchParams.get("error_description") ?? error;
				sendPage(response, 400, oauthErrorHtml(`${providerName} authorization failed.`, description));
				finish({ error: new Error(`${providerName} authorization failed: ${description}`) });
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
				return;
			}
			claimed = true;
			try {
				const value = await options.complete(code);
				sendPage(response, 200, oauthSuccessHtml(`Signed in to ${providerName}. You may now close this page.`));
				finish({ value });
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				sendPage(response, 502, oauthErrorHtml(`${providerName} sign-in failed.`, failure.message));
				finish({ error: failure });
			}
		})();
	};

	const { servers, port } = await listenCallbackServers(handleRequest, options);
	for (const server of servers) server.on("error", (error) => finish({ error }));
	signal?.addEventListener("abort", onAbort, { once: true });
	if (options.timeoutMs !== undefined) {
		timer = setTimeout(() => finish({ error: new Error(`${providerName} sign-in timed out`) }), options.timeoutMs);
	}
	const redirectHost = options.redirectHost ?? options.host;
	return {
		redirectUri: `http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${port}${options.path}`,
		wait: () => waitPromise,
		cancel: () => {
			if (!claimed) finish({ value: undefined });
		},
		close: () => {
			finish({ error: new Error("OAuth callback server closed") });
			for (const server of servers) server.close();
		},
	};
}

/** How often a free port is drawn again when another process holds it on the companion address. */
const companionAttempts = 4;

interface ListeningServer {
	server: Server;
	port: number;
}

/** The companion listener: bound, held by another process, or impossible on this host. */
type CompanionListener =
	| { kind: "listening"; server: Server }
	| { kind: "in-use"; error: unknown }
	| { kind: "unavailable" };

/**
 * Binds `options.host` and, when `options.companionHost` is set, that address at the same port. A port that is held
 * on `host` fails as it is; one held on the companion address alone is the same conflict, so the caller can fall
 * back to another port. A free port (`0`) is drawn again instead.
 */
async function listenCallbackServers(
	handler: RequestListener,
	options: { host: string; port: number; companionHost?: string },
): Promise<{ servers: Server[]; port: number }> {
	for (let attempt = 0; ; attempt++) {
		const primary = await listen(handler, options.host, options.port);
		if (options.companionHost === undefined) return { servers: [primary.server], port: primary.port };
		const companion = await listenCompanion(handler, options.companionHost, primary.port);
		if (companion.kind === "listening") return { servers: [primary.server, companion.server], port: primary.port };
		if (companion.kind === "unavailable") return { servers: [primary.server], port: primary.port };
		await closeServer(primary.server);
		if (options.port !== 0 || attempt >= companionAttempts) throw companion.error;
	}
}

async function listen(handler: RequestListener, host: string, port: number): Promise<ListeningServer> {
	const server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("OAuth callback server did not bind to TCP");
	}
	return { server, port: address.port };
}

async function listenCompanion(handler: RequestListener, host: string, port: number): Promise<CompanionListener> {
	try {
		return { kind: "listening", server: (await listen(handler, host, port)).server };
	} catch (error) {
		// A host without that address (IPv6 disabled) is no conflict: the first listener alone is the endpoint.
		return isAddressInUse(error) ? { kind: "in-use", error } : { kind: "unavailable" };
	}
}

function isAddressInUse(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** The prompt for a pasted code or redirect URL. */
export interface ManualCodePrompt {
	message: string;
	placeholder: string;
	/**
	 * Whether a pasted input is usable. An input that is not is asked for again, so a stray paste, or one from another
	 * login, does not end this one. Every input is taken when unset.
	 */
	accepts?: (input: string) => boolean;
}

/**
 * Asks for a pasted code or redirect URL until `prompt.accepts` takes one, as oh-my-pi's manual prompt does. The
 * prompt's own failure, a cancel or an abort of `signal`, ends the wait.
 */
export async function promptForManualCode(
	interaction: ProviderAuthInteraction,
	prompt: ManualCodePrompt,
	signal: AbortSignal | undefined,
): Promise<string> {
	for (;;) {
		signal?.throwIfAborted();
		const input = await interaction.prompt({
			type: "manual_code",
			message: prompt.message,
			placeholder: prompt.placeholder,
			signal,
		});
		if (prompt.accepts === undefined || prompt.accepts(input)) return input;
	}
}

/**
 * Wait for the browser callback, or for the user to paste the code or redirect URL when the browser
 * cannot reach the loopback server (for example over SSH). Without a callback server only the manual
 * prompt is used. A pasted input that `prompt.accepts` refuses is asked for again, the browser callback staying live.
 */
export async function waitForCallbackOrManualInput<T>(
	interaction: ProviderAuthInteraction,
	callback: OAuthCallbackServer<T> | undefined,
	prompt: ManualCodePrompt,
): Promise<{ type: "callback"; value: T } | { type: "manual"; input: string }> {
	const manualAbort = new AbortController();
	let manualError: Error | undefined;
	const manual = promptForManualCode(interaction, prompt, manualAbort.signal)
		.then((input) => {
			callback?.cancel();
			return input;
		})
		.catch((error: unknown) => {
			manualError = error instanceof Error ? error : new Error(String(error));
			callback?.cancel();
			return undefined;
		});
	try {
		const value = await callback?.wait();
		if (manualError) throw manualError;
		if (value !== undefined) return { type: "callback", value };
		const input = await manual;
		if (manualError) throw manualError;
		return { type: "manual", input: input ?? "" };
	} finally {
		manualAbort.abort();
	}
}
