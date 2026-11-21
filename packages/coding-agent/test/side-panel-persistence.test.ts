// Verifies saved diff baselines, durable git references, and global diff panel preferences.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { loadChanges, loadFileDiff } from "../src/modes/interactive/components/git-changes.ts";
import type { GitOutput, GitRunner } from "../src/modes/interactive/components/git-runner.ts";
import { emptyTreeId } from "../src/modes/interactive/components/session-baseline.ts";
import { loadSessionBaseline } from "../src/modes/interactive/side-panel-persistence.ts";

const directories: string[] = [];
const baselineId = "a".repeat(40);
const headId = "b".repeat(40);

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-side-panel-persistence-"));
	directories.push(path);
	return path;
}

function fakeRepository(): string {
	const root = directory();
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	return root;
}

function ok(stdout = ""): GitOutput {
	return { status: "ok", stdout, isTruncated: false };
}

function runner() {
	return vi.fn<GitRunner>(async (args) => {
		if (args[0] === "stash") return ok(`${baselineId}\n`);
		if (args[0] === "rev-parse") return ok(`${headId}\n`);
		if (args[0] === "ls-files") return ok("scratch.txt\0notes.md\0");
		return ok();
	});
}

function addConversation(session: SessionManager): void {
	session.appendMessage({ role: "user", content: "Make an edit", timestamp: Date.now() });
}

describe("saved session diff baselines", () => {
	it("serializes untracked paths and restores a saved session without capturing the current working tree", async () => {
		const root = fakeRepository();
		const session = SessionManager.create(root, directory());
		addConversation(session);
		const run = runner();
		const baseline = await loadSessionBaseline(session, () => true, run);
		expect(baseline).toMatchObject({ base: baselineId, untracked: new Set(["scratch.txt", "notes.md"]) });
		const saved = readFileSync(session.getSessionFile()!, "utf8");
		expect(saved).toContain('"untracked":["scratch.txt","notes.md"]');
		expect(run.mock.calls.find(([args]) => args[0] === "update-ref")?.[0]).toEqual([
			"update-ref",
			expect.stringMatching(/^refs\/credne\/session-baselines\/[a-f0-9]{64}$/),
			baselineId,
		]);

		run.mockClear();
		const resumed = SessionManager.open(session.getSessionFile()!);
		expect(await loadSessionBaseline(resumed, () => true, run)).toEqual(baseline);
		expect(run).not.toHaveBeenCalled();
		expect(resumed.getEntries()).toHaveLength(2);
	});

	it("saves setup metadata in memory until the first conversation message flushes it", async () => {
		const root = fakeRepository();
		const session = SessionManager.create(root, directory());
		const baseline = await loadSessionBaseline(session, () => true, runner());
		addConversation(session);
		const resumed = SessionManager.open(session.getSessionFile()!);
		const run = runner();
		expect(await loadSessionBaseline(resumed, () => true, run)).toEqual(baseline);
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		{ untracked: {} },
		{ untracked: ["valid", 3] },
		{ base: "--bad-object-id" },
		{ scope: "invalid" },
		{ version: 2 },
		{ sessionId: "another-session" },
		{ root: "/different/repository" },
	])("recaptures malformed or inapplicable saved metadata: %j", async (override) => {
		const root = fakeRepository();
		const session = SessionManager.inMemory(root);
		session.appendCustomEntry("side-panel-baseline", {
			version: 1,
			sessionId: session.getSessionId(),
			root,
			base: headId,
			scope: "session",
			untracked: [],
			...override,
		});
		const run = runner();
		expect(await loadSessionBaseline(session, () => true, run)).toMatchObject({ base: baselineId });
		expect(run.mock.calls.map(([args]) => args[0])).toEqual(["stash", "rev-parse", "ls-files", "update-ref"]);
	});

	it("does not store a capture in another session if the manager is switched during capture", async () => {
		const session = SessionManager.inMemory(fakeRepository());
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = runner();
		run.mockImplementationOnce(async () => {
			await gate;
			return ok(`${baselineId}\n`);
		});
		const pending = loadSessionBaseline(session, () => true, run);
		session.newSession();
		release();
		await pending;
		expect(session.getEntries()).toEqual([]);
		expect(run.mock.calls.some(([args]) => args[0] === "update-ref")).toBe(false);
	});

	it("rechecks the active session after the reference write before appending metadata", async () => {
		const session = SessionManager.inMemory(fakeRepository());
		const run = runner();
		const defaults = run.getMockImplementation()!;
		run.mockImplementation(async (...args) => {
			if (args[0][0] === "update-ref") session.newSession();
			return defaults(...args);
		});
		await loadSessionBaseline(session, () => true, run);
		expect(session.getEntries()).toEqual([]);
	});

	it("does not append metadata after another session becomes active on a different manager", async () => {
		const session = SessionManager.inMemory(fakeRepository());
		let active = true;
		const run = runner();
		const defaults = run.getMockImplementation()!;
		run.mockImplementation(async (...args) => {
			if (args[0][0] === "update-ref") active = false;
			return defaults(...args);
		});
		await loadSessionBaseline(session, () => active, run);
		expect(session.getEntries()).toEqual([]);
	});

	it("does not retain the virtual empty tree before a repository has its first commit", async () => {
		const session = SessionManager.inMemory(fakeRepository());
		const run = vi.fn<GitRunner>(async () => ok());
		expect(await loadSessionBaseline(session, () => true, run)).toMatchObject({ base: emptyTreeId });
		expect(run).toHaveBeenCalledTimes(3);
		expect(session.getEntries()).toHaveLength(1);
	});

	it("reports a reference write failure without saving an unprotected baseline", async () => {
		const session = SessionManager.inMemory(fakeRepository());
		const run = runner();
		const defaults = run.getMockImplementation()!;
		run.mockImplementation(async (...args) =>
			args[0][0] === "update-ref"
				? { status: "failed", reason: "error", message: "read-only repository" }
				: defaults(...args),
		);
		expect(await loadSessionBaseline(session, () => true, run)).toEqual({
			status: "error",
			message: "Could not preserve diff baseline: read-only repository",
		});
		expect(session.getEntries()).toEqual([]);
	});

	it("captures fresh baselines for forks instead of inheriting another session's metadata", async () => {
		const root = fakeRepository();
		const session = SessionManager.create(root, directory());
		addConversation(session);
		await loadSessionBaseline(session, () => true, runner());
		const fork = SessionManager.forkFrom(session.getSessionFile()!, root, directory());
		const run = runner();
		await loadSessionBaseline(fork, () => true, run);
		expect(run).toHaveBeenCalledTimes(4);
		expect(fork.getEntries().at(-1)).toMatchObject({ data: { sessionId: fork.getSessionId() } });
	});
});

describe("global side panel settings", () => {
	it("defaults to disabled with an automatic width", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getSidePanelEnabled()).toBe(false);
		expect(settings.getSidePanelWidth()).toBeUndefined();
	});

	it("persists enabled and width independently and restores them in a new manager", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ theme: "dark", sidePanel: { width: 56 } }));
		storage.withLock("project", () => JSON.stringify({ sidePanel: { enabled: false, width: 44 } }));
		const settings = SettingsManager.fromStorage(storage);
		settings.setSidePanelEnabled(true);
		await settings.flush();
		const resumed = SettingsManager.fromStorage(storage);
		expect(resumed.getSidePanelEnabled()).toBe(true);
		expect(resumed.getSidePanelWidth()).toBe(56);
		resumed.setSidePanelWidth(72);
		await resumed.flush();
		const restarted = SettingsManager.fromStorage(storage);
		expect(restarted.getSidePanelEnabled()).toBe(true);
		expect(restarted.getSidePanelWidth()).toBe(72);
		expect(restarted.getGlobalSettings().theme).toBe("dark");
		expect(restarted.getProjectSettings().sidePanel).toEqual({ enabled: false, width: 44 });
	});

	it.each([0, -1, 1.5, "wide", null, Number.MAX_SAFE_INTEGER + 1])(
		"ignores invalid width from a settings file: %j",
		(width) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ sidePanel: { enabled: "yes", width } }));
			const settings = SettingsManager.fromStorage(storage);
			expect(settings.getSidePanelEnabled()).toBe(false);
			expect(settings.getSidePanelWidth()).toBeUndefined();
		},
	);
});

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe.skipIf(!gitAvailable)("saved diff baselines with real git", () => {
	it("survives restart and git pruning without changing the index, worktree, or stash list", async () => {
		vi.stubEnv("GIT_AUTHOR_NAME", "test");
		vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.com");
		vi.stubEnv("GIT_COMMITTER_NAME", "test");
		vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.com");
		const root = directory();
		git(root, "init", "--quiet");
		writeFileSync(join(root, "tracked.txt"), "initial\n");
		git(root, "add", "tracked.txt");
		git(root, "commit", "--quiet", "-m", "initial");
		writeFileSync(join(root, "tracked.txt"), "initial\nBEFORE\n");
		writeFileSync(join(root, "scratch.txt"), "pre-existing untracked\n");
		const status = git(root, "status", "--porcelain");
		const index = git(root, "write-tree");
		const session = SessionManager.create(root, directory());
		addConversation(session);
		const baseline = await loadSessionBaseline(session, () => true);
		expect(baseline.status).toBe("ready");
		expect(git(root, "status", "--porcelain")).toBe(status);
		expect(git(root, "write-tree")).toBe(index);
		expect(git(root, "stash", "list")).toBe("");
		writeFileSync(join(root, "tracked.txt"), "initial\nBEFORE\nAFTER\n");
		git(root, "gc", "--prune=now");
		const resumed = SessionManager.open(session.getSessionFile()!);
		const restored = await loadSessionBaseline(resumed, () => true);
		expect(restored).toEqual(baseline);
		const snapshot = await loadChanges(restored, new AbortController().signal);
		if (snapshot?.status !== "ready") throw new Error("Expected ready changes");
		expect(snapshot.files.map((file) => file.path)).toEqual(["tracked.txt"]);
		const diff = await loadFileDiff(snapshot, snapshot.files[0]!, new AbortController().signal);
		if (diff?.status !== "ready") throw new Error("Expected ready diff");
		expect(diff.rows.filter((row) => row.kind === "added").map((row) => row.text)).toEqual(["AFTER"]);
	});
});
