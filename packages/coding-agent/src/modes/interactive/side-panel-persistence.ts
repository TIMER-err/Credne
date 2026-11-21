// Stores each session's diff baseline in its session file and retains the referenced git object.
import { createHash } from "node:crypto";
import { findGitPaths } from "../../core/footer-data-provider.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { pathsEqual } from "../../utils/paths.ts";
import { sanitizeDisplayText } from "./components/git-changes.ts";
import { type GitRunner, runGit } from "./components/git-runner.ts";
import { captureBaseline, emptyTreeId, type SessionBaseline } from "./components/session-baseline.ts";

export type SidePanelSession = Pick<SessionManager, "getCwd" | "getSessionId" | "getEntries" | "appendCustomEntry">;

type ReadyBaseline = Extract<SessionBaseline, { status: "ready" }>;

const baselineEntryType = "side-panel-baseline";
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const neverAborted = new AbortController().signal;

/** Restore this session's baseline, or capture and save it only while the originating session remains active. */
export async function loadSessionBaseline(
	session: SidePanelSession,
	isCurrentSession: () => boolean,
	run: GitRunner = runGit,
): Promise<SessionBaseline> {
	const sessionId = session.getSessionId();
	const restored = restoreBaseline(session, sessionId);
	if (restored) return restored;
	const baseline = await captureBaseline(session.getCwd(), run);
	if (baseline.status !== "ready" || !isCurrentSession() || session.getSessionId() !== sessionId) return baseline;
	try {
		if (baseline.base !== emptyTreeId) {
			const key = createHash("sha256").update(sessionId).digest("hex");
			const retained = await run(
				["update-ref", `refs/credne/session-baselines/${key}`, baseline.base],
				baseline.root,
				neverAborted,
				64 * 1024,
			);
			if (retained.status !== "ok") {
				return {
					status: "error",
					message: `Could not preserve diff baseline: ${retained.status === "failed" ? sanitizeDisplayText(retained.message) : "git was stopped"}`,
				};
			}
		}
		if (isCurrentSession() && session.getSessionId() === sessionId) {
			session.appendCustomEntry(baselineEntryType, {
				version: 1,
				sessionId,
				root: baseline.root,
				base: baseline.base,
				scope: baseline.scope,
				untracked: [...baseline.untracked],
			});
		}
		return baseline;
	} catch (error) {
		return { status: "error", message: `Could not save diff baseline: ${sanitizeDisplayText(String(error))}` };
	}
}

function restoreBaseline(session: SidePanelSession, sessionId: string): ReadyBaseline | undefined {
	const entries = session.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== baselineEntryType) continue;
		const baseline = parseBaseline(entry.data, sessionId);
		if (!baseline) continue;
		const repository = findGitPaths(session.getCwd());
		return repository && pathsEqual(repository.repoDir, baseline.root) ? baseline : undefined;
	}
	return undefined;
}

/** Session JSONL is an input boundary: a saved baseline must contain an object id and a string array, not a Set. */
function parseBaseline(data: unknown, sessionId: string): ReadyBaseline | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	if (
		!("version" in data) ||
		data.version !== 1 ||
		!("sessionId" in data) ||
		data.sessionId !== sessionId ||
		!("root" in data) ||
		typeof data.root !== "string" ||
		!("base" in data) ||
		typeof data.base !== "string" ||
		!objectId.test(data.base) ||
		!("scope" in data) ||
		(data.scope !== "session" && data.scope !== "commit") ||
		!("untracked" in data) ||
		!Array.isArray(data.untracked) ||
		!data.untracked.every((path: unknown) => typeof path === "string")
	) {
		return undefined;
	}
	return {
		status: "ready",
		root: data.root,
		base: data.base,
		scope: data.scope,
		untracked: new Set<string>(data.untracked),
	};
}
