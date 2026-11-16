import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadChanges, loadFileDiff } from "../src/modes/interactive/components/git-changes.ts";
import type { GitOutput, GitRunner } from "../src/modes/interactive/components/git-runner.ts";
import {
	captureBaseline,
	emptyTreeId,
	type SessionBaseline,
	selectBase,
} from "../src/modes/interactive/components/session-baseline.ts";

const commitId = "0123456789abcdef0123456789abcdef01234567";
const headId = "fedcba9876543210fedcba9876543210fedcba98";

function ok(stdout: string): GitOutput {
	return { status: "ok", stdout, isTruncated: false };
}

const failed: GitOutput = { status: "failed", reason: "error", message: "git exited with code 128" };

describe("selectBase", () => {
	it("uses the commit that git stash create made when the tree has changes", () => {
		expect(selectBase(ok(`${commitId}\n`), ok(`${headId}\n`))).toEqual({ base: commitId, scope: "session" });
	});

	it("uses HEAD when git stash create prints nothing, which means a clean tree", () => {
		expect(selectBase(ok(""), ok(`${headId}\n`))).toEqual({ base: headId, scope: "session" });
	});

	it("uses the empty tree when there is no HEAD", () => {
		expect(selectBase(failed, failed)).toEqual({ base: emptyTreeId, scope: "session" });
		expect(selectBase(ok(""), failed)).toEqual({ base: emptyTreeId, scope: "session" });
	});

	it("falls back to HEAD, marked as the last commit, when the working tree could not be captured", () => {
		expect(selectBase(failed, ok(`${headId}\n`))).toEqual({ base: headId, scope: "commit" });
		expect(selectBase(ok("not an object id"), ok(`${headId}\n`))).toEqual({ base: headId, scope: "commit" });
		expect(selectBase({ status: "aborted" }, ok(`${headId}\n`))).toEqual({ base: headId, scope: "commit" });
	});
});

const temporaryDirectories: string[] = [];

afterAll(() => {
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-session-baseline-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** A directory that findGitPaths takes for a repository, for tests that fake git itself. */
function createFakeRepository(): string {
	const root = createTemporaryDirectory();
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	return root;
}

describe("captureBaseline with a fake git", () => {
	it("spawns no git outside a repository", async () => {
		const run = vi.fn<GitRunner>(async () => ok(""));

		expect(await captureBaseline(createTemporaryDirectory(), run)).toEqual({ status: "no-repo" });
		expect(run).not.toHaveBeenCalled();
	});

	it("takes the baseline commit, and the untracked files of the moment, from three git calls", async () => {
		const root = createFakeRepository();
		const run = vi.fn<GitRunner>(async (args): Promise<GitOutput> => {
			if (args[0] === "stash") return ok(`${commitId}\n`);
			if (args[0] === "rev-parse") return ok(`${headId}\n`);
			return ok("scratch.txt\0nested/repo/\0docs/notes.md\0");
		});

		const baseline = await captureBaseline(join(root, "sub-directory-that-need-not-exist"), run);

		expect(baseline).toEqual({
			status: "ready",
			root,
			base: commitId,
			scope: "session",
			untracked: new Set(["scratch.txt", "docs/notes.md"]),
		});
		expect(run.mock.calls.map(([args]) => args.join(" "))).toEqual([
			"stash create",
			"rev-parse --verify --quiet HEAD",
			"ls-files --others --exclude-standard -z",
		]);
		expect(run.mock.calls.every(([, cwd]) => cwd === root)).toBe(true);
	});

	it("reports a failing untracked listing as an error, and a missing git as such", async () => {
		const root = createFakeRepository();
		const failing: GitRunner = async (args) =>
			args[0] === "ls-files" ? { status: "failed", reason: "error", message: "bad\x07 listing" } : ok("");
		const missing: GitRunner = async () => ({ status: "failed", reason: "missing", message: "spawn git ENOENT" });

		expect(await captureBaseline(root, failing)).toEqual({ status: "error", message: "bad  listing" });
		expect(await captureBaseline(root, missing)).toEqual({ status: "error", message: "git is not installed" });
	});
});

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function readyBaseline(baseline: SessionBaseline): Extract<SessionBaseline, { status: "ready" }> {
	if (baseline.status !== "ready") throw new Error(`expected a ready baseline, got ${JSON.stringify(baseline)}`);
	return baseline;
}

describe.skipIf(!gitAvailable)("changes since the session started, with a real repository", () => {
	beforeEach(() => {
		// git stash create and git commit need an identity.
		vi.stubEnv("GIT_AUTHOR_NAME", "test");
		vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.com");
		vi.stubEnv("GIT_COMMITTER_NAME", "test");
		vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.com");
	});
	afterEach(() => vi.unstubAllEnvs());

	function createRepository(): string {
		const root = createTemporaryDirectory();
		git(root, "init", "--quiet");
		writeFileSync(join(root, "tracked.txt"), "one\n");
		writeFileSync(join(root, "mod.txt"), "a\n");
		writeFileSync(join(root, "pre-mod.txt"), "p\n");
		git(root, "add", "-A");
		git(root, "commit", "--quiet", "-m", "initial");
		return root;
	}

	const signal = new AbortController().signal;

	it("hides what was already changed or untracked at the start, and shows what changed afterwards", async () => {
		const root = createRepository();
		// Before the session starts: two modified files and one untracked file.
		writeFileSync(join(root, "tracked.txt"), "one\nPRE\n");
		writeFileSync(join(root, "pre-mod.txt"), "p\nPRE\n");
		writeFileSync(join(root, "pre-untracked.txt"), "u\n");

		const baseline = readyBaseline(await captureBaseline(root));

		expect(baseline.scope).toBe("session");
		expect(baseline.untracked).toEqual(new Set(["pre-untracked.txt"]));
		// The worktree and the index are untouched by capturing.
		const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
		expect(status.split("\n").filter(Boolean).sort()).toEqual([
			" M pre-mod.txt",
			" M tracked.txt",
			"?? pre-untracked.txt",
		]);

		// During the session: more edits to one pre-modified file, a new modification, and a new file.
		writeFileSync(join(root, "tracked.txt"), "one\nPRE\nLATER\n");
		writeFileSync(join(root, "mod.txt"), "a\nLATER\n");
		writeFileSync(join(root, "new.txt"), "n1\nn2\n");
		// Files untracked at the start cannot be diffed against the baseline, so edits to them are not shown.
		writeFileSync(join(root, "pre-untracked.txt"), "u\nEDITED\n");

		const snapshot = await loadChanges(baseline, signal);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files.map((file) => [file.path, file.isUntracked, file.added, file.removed])).toEqual([
			["mod.txt", false, 1, 0],
			["new.txt", true, 2, 0],
			["tracked.txt", false, 1, 0],
		]);
		expect(snapshot.totals).toEqual({ files: 3, added: 4, removed: 0 });

		const trackedDiff = await loadFileDiff(snapshot, snapshot.files[2]!, signal);
		if (trackedDiff?.status !== "ready") throw new Error("expected a ready diff");
		const added = trackedDiff.rows.filter((row) => row.kind === "added").map((row) => row.text);
		expect(added).toEqual(["LATER"]);
	});

	it("keeps showing the session's changes after they are committed", async () => {
		const root = createRepository();
		const baseline = readyBaseline(await captureBaseline(root));
		writeFileSync(join(root, "mod.txt"), "a\nLATER\n");
		git(root, "commit", "--quiet", "-am", "later");

		const snapshot = await loadChanges(baseline, signal);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files.map((file) => [file.path, file.added])).toEqual([["mod.txt", 1]]);
	});

	it("shows nothing for a clean tree, using HEAD as the baseline", async () => {
		const root = createRepository();
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

		const baseline = readyBaseline(await captureBaseline(root));
		const snapshot = await loadChanges(baseline, signal);

		expect(baseline.base).toBe(head);
		expect(snapshot).toMatchObject({ status: "ready", files: [], totals: { files: 0 } });
	});

	it("uses the empty tree before the first commit, so staged files count as changes", async () => {
		const root = createTemporaryDirectory();
		git(root, "init", "--quiet");
		writeFileSync(join(root, "first.txt"), "x\n");
		git(root, "add", "first.txt");

		const baseline = readyBaseline(await captureBaseline(root));
		const snapshot = await loadChanges(baseline, signal);

		expect(baseline.base).toBe(emptyTreeId);
		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files.map((file) => [file.path, file.added])).toEqual([["first.txt", 1]]);
	});
});
