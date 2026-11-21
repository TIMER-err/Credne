// Which physical account answered last. A virtual pool chooses the account per request, so only the answers tell.
import type { SessionEntry } from "../../core/session-manager.ts";
import { ACCOUNT_PROVIDER_PREFIX, isLocalClaudeProvider } from "./catalog.ts";

/** Provider of the latest successful answer on the branch, which is the account a virtual pool picked. */
export function latestServingProvider(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const { stopReason, provider } = entry.message;
		if (stopReason !== "error" && stopReason !== "aborted") return provider;
	}
	return undefined;
}

/** Whether `providerId` is an account of this extension: a local Claude subscription or a pinned broker account. */
export function isAccountProvider(providerId: string): boolean {
	return isLocalClaudeProvider(providerId) || providerId.startsWith(ACCOUNT_PROVIDER_PREFIX);
}
