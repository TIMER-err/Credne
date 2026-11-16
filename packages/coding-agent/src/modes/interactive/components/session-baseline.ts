// Captures the repository state a session starts from, so the side panel can show only what changed since.
import { findGitPaths } from "../../../core/footer-data-provider.ts";
import { parseUntrackedPaths, sanitizeDisplayText } from "./git-changes.ts";
import { completeRecords, type GitOutput, type GitRunner, runGit } from "./git-runner.ts";

/** The id git gives the empty tree. It needs no object in the repository, so it works before the first commit. */
export const emptyTreeId = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * What the panel diffs the working tree against. `session` is the tracked working tree when the session started;
 * `commit` is the HEAD commit, used when that state could not be captured.
 */
export type BaselineScope = "session" | "commit";

export type SessionBaseline =
	| {
			status: "ready";
			root: string;
			/** A commit or tree id to diff against. */
			base: string;
			scope: BaselineScope;
			/** Files that were untracked when the session started. */
			untracked: ReadonlySet<string>;
	  }
	| { status: "no-repo" }
	| { status: "error"; message: string };

/** Git never aborts a baseline capture: it is short, and the next session replaces it. */
const neverAborted = new AbortController().signal;
const maxSmallOutputBytes = 64 * 1024;
const maxListBytes = 8 * 1024 * 1024;
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function describeFailure(output: Exclude<GitOutput, { status: "ok" }>): string {
	if (output.status === "aborted") return "git was stopped";
	return output.reason === "missing" ? "git is not installed" : sanitizeDisplayText(output.message);
}

/**
 * Choose the id to diff against from the output of `git stash create` and `git rev-parse --verify HEAD`.
 *
 * `git stash create` writes a commit of the tracked working tree and index without touching the worktree, the index
 * or the stash list. It prints nothing when the tree is clean, so HEAD is the baseline then. Without a HEAD there is
 * no commit yet, so the baseline is the empty tree.
 */
export function selectBase(stash: GitOutput, head: GitOutput): { base: string; scope: BaselineScope } {
	const headId = head.status === "ok" ? head.stdout.trim() : "";
	const stashId = stash.status === "ok" ? stash.stdout.trim() : undefined;
	if (stashId !== undefined && objectId.test(stashId)) return { base: stashId, scope: "session" };
	if (headId === "") return { base: emptyTreeId, scope: "session" };
	// An empty stash output means a clean tree. A failed or unreadable one means the state could not be captured.
	return { base: headId, scope: stashId === "" ? "session" : "commit" };
}

/**
 * Capture the baseline of the repository containing `cwd`. Outside a repository this spawns nothing, and one git
 * call per question is all it ever costs.
 */
export async function captureBaseline(cwd: string, run: GitRunner = runGit): Promise<SessionBaseline> {
	const repository = findGitPaths(cwd);
	if (!repository) return { status: "no-repo" };
	const root = repository.repoDir;
	const [stash, head, untracked] = await Promise.all([
		run(["stash", "create"], root, neverAborted, maxSmallOutputBytes),
		run(["rev-parse", "--verify", "--quiet", "HEAD"], root, neverAborted, maxSmallOutputBytes),
		run(["ls-files", "--others", "--exclude-standard", "-z"], root, neverAborted, maxListBytes),
	]);
	if (untracked.status !== "ok") return { status: "error", message: describeFailure(untracked) };
	return {
		status: "ready",
		root,
		...selectBase(stash, head),
		untracked: new Set(parseUntrackedPaths(completeRecords(untracked, "\0"))),
	};
}
