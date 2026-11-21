// Claude subscription sign-in: pi-ai's Anthropic OAuth flow driven through the extension UI.
import type { AuthEvent, AuthPrompt, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";

const loginTimeoutMs = 5 * 60_000;

/** Thrown into the login flow when the user dismisses a dialog or the sign-in times out. */
class LoginCancelledError extends Error {
	constructor() {
		super("Login cancelled");
		this.name = "LoginCancelledError";
	}
}

/** Result of a sign-in: the credential, or why there is none. */
export type ClaudeSignIn =
	| { type: "signed-in"; credential: OAuthCredential }
	| { type: "cancelled" }
	| { type: "timed-out" };

/**
 * Run the Anthropic OAuth login. The flow opens the browser and waits for its callback; the user can paste the
 * redirect URL or code instead when the browser cannot reach this machine. `deviceId` is the installation id
 * the login derives the account's Claude Code device id from.
 */
export async function signInClaudeSubscription(
	ui: ExtensionUIContext,
	oauth: OAuthAuth,
	deviceId: string,
): Promise<ClaudeSignIn> {
	const signal = AbortSignal.timeout(loginTimeoutMs);
	const interaction: ProviderAuthInteraction = {
		signal,
		prompt: (prompt) => promptUser(ui, prompt, signal),
		notify: (event) => notifyUser(ui, event),
	};
	try {
		return { type: "signed-in", credential: await oauth.login(interaction, { getDeviceId: () => deviceId }) };
	} catch (error) {
		if (signal.aborted) return { type: "timed-out" };
		if (error instanceof LoginCancelledError) return { type: "cancelled" };
		throw error;
	}
}

async function promptUser(ui: ExtensionUIContext, prompt: AuthPrompt, flowSignal: AbortSignal): Promise<string> {
	const signal = prompt.signal ? AbortSignal.any([prompt.signal, flowSignal]) : flowSignal;
	if (prompt.type === "select") {
		const labels = prompt.options.map((option) => option.label);
		const choice = await ui.select(prompt.message, labels, { signal });
		const selected = prompt.options.find((option) => option.label === choice);
		if (!selected) throw new LoginCancelledError();
		return selected.id;
	}
	// Extension dialogs have no masked input, so a secret is visible while typed.
	const value = await ui.input(prompt.message, prompt.placeholder, { signal });
	if (value === undefined) throw new LoginCancelledError();
	return value;
}

function notifyUser(ui: ExtensionUIContext, event: AuthEvent): void {
	if (event.type === "auth_url") {
		openBrowser(event.url);
		const instructions = event.instructions ?? "Sign in to Claude in your browser.";
		ui.notify(`${instructions}\nIf the browser did not open, visit:\n${event.url}`, "info");
	} else if (event.type === "info") {
		const links = (event.links ?? []).map((link) => link.url);
		ui.notify([event.message, ...links].join("\n"), "info");
	} else if (event.type === "device_code") {
		ui.notify(`Enter the code ${event.userCode} at ${event.verificationUri}`, "info");
	} else {
		ui.notify(event.message, "info");
	}
}
