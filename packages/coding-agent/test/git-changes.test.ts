import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	type ChangedFile,
	type ChangesSnapshot,
	countLines,
	loadChanges,
	loadFileDiff,
	parseNumstat,
	parseUnifiedDiff,
	parseUntrackedPaths,
	sanitizeDisplayText,
	summarizeChanges,
	untrackedDiffRows,
} from "../src/modes/interactive/components/git-changes.ts";
import type { GitOutput, GitRunner } from "../src/modes/interactive/components/git-runner.ts";
import type { SessionBaseline } from "../src/modes/interactive/components/session-baseline.ts";

function changedFile(path: string, added = 0, removed = 0, overrides: Partial<ChangedFile> = {}): ChangedFile {
	return { path, label: path, added, removed, isUntracked: false, content: "text", ...overrides };
}

const temporaryDirectories: string[] = [];

afterAll(() => {
	for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-git-changes-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("sanitizeDisplayText", () => {
	it("turns tabs into three spaces and each run of control characters into one space", () => {
		expect(sanitizeDisplayText("\tindent")).toBe("   indent");
		expect(sanitizeDisplayText("a\x1b[31mb\x07c")).toBe("a [31mb c");
		expect(sanitizeDisplayText("evil\x1b]0;title\x07\x1b\x07name")).toBe("evil ]0;title name");
		expect(sanitizeDisplayText("line\r\n")).toBe("line ");
		expect(sanitizeDisplayText("plain 日本語 text")).toBe("plain 日本語 text");
	});
});

describe("parseNumstat", () => {
	it("parses NUL-separated records with counts, paths containing spaces, and binary files", () => {
		const output = ["12\t3\tsrc/a.ts", "0\t5\tdocs/old notes.md", "-\t-\timg/logo.png", ""].join("\0");

		expect(parseNumstat(output)).toEqual([
			changedFile("src/a.ts", 12, 3),
			changedFile("docs/old notes.md", 0, 5),
			changedFile("img/logo.png", 0, 0, { content: "binary" }),
		]);
	});

	it("keeps the raw path for git and a display-safe label for the screen", () => {
		const [file] = parseNumstat("1\t0\tevil\x1b[31m\x07\tname.ts\0");

		expect(file?.path).toBe("evil\x1b[31m\x07\tname.ts");
		expect(file?.label).toBe("evil [31m    name.ts");
	});

	it("returns nothing for empty output", () => {
		expect(parseNumstat("")).toEqual([]);
	});
});

describe("parseUntrackedPaths", () => {
	it("lists files and skips nested repositories, which git reports as directories", () => {
		expect(parseUntrackedPaths(["new.ts", "vendor/lib/", "dir/other file.txt", ""].join("\0"))).toEqual([
			"new.ts",
			"dir/other file.txt",
		]);
	});
});

describe("countLines", () => {
	it("counts a last line without a newline", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("a\n")).toBe(1);
		expect(countLines("a\nb")).toBe(2);
		expect(countLines("a\n\nb\n")).toBe(3);
	});
});

describe("summarizeChanges", () => {
	it("sums files and line counts", () => {
		const files = [changedFile("a", 3, 1), changedFile("b", 4, 0), changedFile("c", 0, 0, { content: "binary" })];

		expect(summarizeChanges(files)).toEqual({ files: 3, added: 7, removed: 1 });
	});
});

describe("parseUnifiedDiff", () => {
	const diff = [
		"diff --git a/src/a.ts b/src/a.ts",
		"index 83db48f..bf2a3c1 100644",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -10,4 +10,5 @@ function load() {",
		" const a = 1;",
		"-const b = 2;",
		"+const b = 3;",
		"+const c = 4;",
		" return a;",
		"@@ -40,2 +41,2 @@",
		" end",
		"-old",
		"\\ No newline at end of file",
		"+new",
		"",
	].join("\n");

	it("numbers context, removed and added rows from each hunk header", () => {
		expect(parseUnifiedDiff(diff)).toEqual([
			{ kind: "hunk", text: "@@ -10,4 +10,5 @@ function load() {" },
			{ kind: "context", oldNumber: 10, newNumber: 10, text: "const a = 1;" },
			{ kind: "removed", oldNumber: 11, newNumber: undefined, text: "const b = 2;" },
			{ kind: "added", oldNumber: undefined, newNumber: 11, text: "const b = 3;" },
			{ kind: "added", oldNumber: undefined, newNumber: 12, text: "const c = 4;" },
			{ kind: "context", oldNumber: 12, newNumber: 13, text: "return a;" },
			{ kind: "hunk", text: "@@ -40,2 +41,2 @@" },
			{ kind: "context", oldNumber: 40, newNumber: 41, text: "end" },
			{ kind: "removed", oldNumber: 41, newNumber: undefined, text: "old" },
			{ kind: "note", text: "No newline at end of file" },
			{ kind: "added", oldNumber: undefined, newNumber: 42, text: "new" },
		]);
	});

	it("keeps lines that look like diff markers inside a hunk", () => {
		const rows = parseUnifiedDiff(["@@ -1,1 +1,2 @@", " keep", "+++ not a header", ""].join("\n"));

		expect(rows[2]).toEqual({ kind: "added", oldNumber: undefined, newNumber: 2, text: "++ not a header" });
	});

	it("makes row and hunk text display-safe when parsing", () => {
		const rows = parseUnifiedDiff(["@@ -1 +1 @@ ctx\x1b[1m", "+\tindent\x1b[31m\x07", ""].join("\n"));

		expect(rows).toEqual([
			{ kind: "hunk", text: "@@ -1 +1 @@ ctx [1m" },
			{ kind: "added", oldNumber: undefined, newNumber: 1, text: "   indent [31m " },
		]);
	});

	it("reports a binary file as a note", () => {
		const output = "diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n";

		expect(parseUnifiedDiff(output)).toEqual([{ kind: "note", text: "Binary file" }]);
	});

	it("returns nothing when there are no hunks", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});
});

describe("untrackedDiffRows", () => {
	it("shows every line as added, numbered from 1, ignoring the final newline", () => {
		expect(untrackedDiffRows("one\ntwo\n")).toEqual([
			{ kind: "added", oldNumber: undefined, newNumber: 1, text: "one" },
			{ kind: "added", oldNumber: undefined, newNumber: 2, text: "two" },
		]);
		expect(untrackedDiffRows("")).toEqual([]);
	});

	it("makes the text display-safe", () => {
		expect(untrackedDiffRows("a\x1b[31m\tb\n")).toEqual([
			{ kind: "added", oldNumber: undefined, newNumber: 1, text: "a [31m   b" },
		]);
	});
});

function ok(stdout: string, isTruncated = false): GitOutput {
	return { status: "ok", stdout, isTruncated };
}

function readyBaseline(overrides: Partial<Extract<SessionBaseline, { status: "ready" }>> = {}): SessionBaseline {
	return { status: "ready", root: "/repo", base: "b4se", scope: "session", untracked: new Set(), ...overrides };
}

/** A runner that answers the three commands the panel uses, and records the calls. */
function createRunner(output: { numstat?: GitOutput; untracked?: string; diff?: GitOutput }) {
	const run = vi.fn<GitRunner>(async (args) => {
		if (args[0] === "ls-files") return ok(output.untracked ?? "");
		if (args.includes("--numstat")) return output.numstat ?? ok("");
		return output.diff ?? ok("");
	});
	return run;
}

const signal = new AbortController().signal;

describe("loadChanges", () => {
	it("measures the tracked changes against the baseline, and sorts by path", async () => {
		const run = createRunner({ numstat: ok("2\t1\tz.ts\0" + "1\t0\ta.ts\0"), untracked: "m.ts\0" });
		const root = createTemporaryDirectory();
		writeFileSync(join(root, "m.ts"), "one\ntwo\n");

		const snapshot = await loadChanges(readyBaseline({ root, base: "feedface" }), signal, run);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.base).toBe("feedface");
		expect(snapshot.scope).toBe("session");
		expect(snapshot.files.map((file) => file.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
		expect(snapshot.totals).toEqual({ files: 3, added: 5, removed: 1 });
		const numstatCall = run.mock.calls.find(([args]) => args.includes("--numstat"))!;
		expect(numstatCall[0].slice(-2)).toEqual(["feedface", "--"]);
		expect(numstatCall[1]).toBe(root);
	});

	it("hides files that were untracked when the session started, still untracked or added since", async () => {
		const root = createTemporaryDirectory();
		writeFileSync(join(root, "new.ts"), "x\n");
		writeFileSync(join(root, "old-untracked.ts"), "x\n");
		const run = createRunner({
			numstat: ok("3\t0\tstaged-since.ts\0" + "1\t1\ttracked.ts\0"),
			untracked: "new.ts\0old-untracked.ts\0",
		});
		const baseline = readyBaseline({ root, untracked: new Set(["old-untracked.ts", "staged-since.ts"]) });

		const snapshot = await loadChanges(baseline, signal, run);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files.map((file) => [file.path, file.isUntracked])).toEqual([
			["new.ts", true],
			["tracked.ts", false],
		]);
		expect(snapshot.totals).toEqual({ files: 2, added: 2, removed: 1 });
	});

	it("runs no git outside a repository or after a failed capture, and passes those states on", async () => {
		const run = createRunner({});

		expect(await loadChanges({ status: "no-repo" }, signal, run)).toEqual({ status: "no-repo" });
		expect(await loadChanges({ status: "error", message: "boom" }, signal, run)).toEqual({
			status: "error",
			message: "boom",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("lists the first 500 files by path and counts every file in the totals", async () => {
		const records = Array.from({ length: 520 }, (_, index) => `2\t1\tfile${String(index).padStart(4, "0")}.ts`);
		const run = createRunner({ numstat: ok(`${records.join("\0")}\0`) });

		const snapshot = await loadChanges(readyBaseline(), signal, run);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files).toHaveLength(500);
		expect(snapshot.files[0]?.path).toBe("file0000.ts");
		expect(snapshot.files[499]?.path).toBe("file0499.ts");
		expect(snapshot.totals).toEqual({ files: 520, added: 1040, removed: 520 });
	});

	it("drops the incomplete last record of listing output that hit the byte cap", async () => {
		const run = createRunner({ numstat: ok("1\t1\ta.ts\0" + "3\t3\tb.t", true) });

		const snapshot = await loadChanges(readyBaseline(), signal, run);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files.map((file) => file.path)).toEqual(["a.ts"]);
	});

	it("reports a git failure as an error with a display-safe message", async () => {
		const run: GitRunner = async () => ({ status: "failed", reason: "error", message: "bad\x1b]0;x\x07 object" });

		expect(await loadChanges(readyBaseline(), signal, run)).toEqual({ status: "error", message: "bad ]0;x  object" });
	});

	it("resolves to undefined when the runner reports an abort", async () => {
		const run: GitRunner = async () => ({ status: "aborted" });

		expect(await loadChanges(readyBaseline(), signal, run)).toBeUndefined();
	});

	it("gives files a display-safe label and keeps the raw path", async () => {
		const run = createRunner({ numstat: ok("1\t0\tevil\x1b[31m\x07.ts\0") });

		const snapshot = await loadChanges(readyBaseline(), signal, run);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files[0]).toMatchObject({ path: "evil\x1b[31m\x07.ts", label: "evil [31m .ts" });
	});

	it("labels untracked files over 1 MB as large without reading them, and stops reading after the byte budget", async () => {
		const root = createTemporaryDirectory();
		writeFileSync(join(root, "huge.txt"), Buffer.alloc(1024 * 1024 + 1, "a"));
		for (let index = 0; index < 10; index++) {
			writeFileSync(join(root, `mid${index}.txt`), `${"a".repeat(999)}\n`.repeat(1000));
		}
		const untracked = ["huge.txt", ...Array.from({ length: 10 }, (_, index) => `mid${index}.txt`)];
		const run = createRunner({ untracked: `${untracked.join("\0")}\0` });

		const snapshot = await loadChanges(readyBaseline({ root }), signal, run);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
		expect(byPath.get("huge.txt")).toMatchObject({ content: "large", added: 0 });
		// Each mid file is 1,000,000 bytes: eight fit in the 8 MiB budget, the last two do not.
		const contents = untracked.slice(1).map((path) => byPath.get(path)?.content);
		expect(contents).toEqual([...Array(8).fill("text"), "large", "large"]);
		expect(byPath.get("mid0.txt")?.added).toBe(1000);
	});

	it("labels binary untracked files", async () => {
		const root = createTemporaryDirectory();
		mkdirSync(join(root, "sub"));
		writeFileSync(join(root, "sub", "blob.bin"), Buffer.from([1, 0, 2]));
		const run = createRunner({ untracked: "sub/blob.bin\0" });

		const snapshot = await loadChanges(readyBaseline({ root }), signal, run);

		if (snapshot?.status !== "ready") throw new Error("expected a ready snapshot");
		expect(snapshot.files).toEqual([changedFile("sub/blob.bin", 0, 0, { isUntracked: true, content: "binary" })]);
	});
});

describe("loadFileDiff", () => {
	const file = changedFile("a.ts", 1, 1);
	const snapshot: Extract<ChangesSnapshot, { status: "ready" }> = {
		status: "ready",
		root: "/repo",
		base: "feedface",
		scope: "session",
		files: [file],
		totals: summarizeChanges([file]),
	};

	it("diffs the baseline against the working tree for that file", async () => {
		const run = createRunner({ diff: ok("@@ -1 +1 @@\n-old\n+new\n") });

		const diff = await loadFileDiff(snapshot, file, signal, run);

		const [args, cwd] = run.mock.calls[0]!;
		expect(args.slice(-3)).toEqual(["feedface", "--", "a.ts"]);
		expect(cwd).toBe("/repo");
		expect(diff).toEqual({
			status: "ready",
			rows: [
				{ kind: "hunk", text: "@@ -1 +1 @@" },
				{ kind: "removed", oldNumber: 1, newNumber: undefined, text: "old" },
				{ kind: "added", oldNumber: undefined, newNumber: 1, text: "new" },
			],
		});
	});

	it("cuts a diff at 2000 rows with a note", async () => {
		const body = Array.from({ length: 3000 }, (_, index) => `+line ${index}`).join("\n");
		const run = createRunner({ diff: ok(`@@ -0,0 +1,3000 @@\n${body}\n`) });

		const diff = await loadFileDiff(snapshot, file, signal, run);

		if (diff?.status !== "ready") throw new Error("expected a ready diff");
		expect(diff.rows).toHaveLength(2001);
		expect(diff.rows.at(-1)).toEqual({ kind: "note", text: "Diff truncated" });
	});

	it("drops the partial last line of a diff that hit the byte cap and adds the note", async () => {
		const run = createRunner({ diff: ok("@@ -1,2 +1,2 @@\n keep\n+new line that was cut o", true) });

		const diff = await loadFileDiff(snapshot, file, signal, run);

		if (diff?.status !== "ready") throw new Error("expected a ready diff");
		expect(diff.rows).toEqual([
			{ kind: "hunk", text: "@@ -1,2 +1,2 @@" },
			{ kind: "context", oldNumber: 1, newNumber: 1, text: "keep" },
			{ kind: "note", text: "Diff truncated" },
		]);
	});

	it("reports a git failure with a display-safe message", async () => {
		const run: GitRunner = async () => ({ status: "failed", reason: "error", message: "bad\x07 base" });

		expect(await loadFileDiff(snapshot, file, signal, run)).toEqual({ status: "error", message: "bad  base" });
	});

	it("shows a binary file as a note without running git", async () => {
		const run = createRunner({});

		const diff = await loadFileDiff(snapshot, changedFile("a.png", 0, 0, { content: "binary" }), signal, run);

		expect(diff).toEqual({ status: "ready", rows: [{ kind: "note", text: "Binary file" }] });
		expect(run).not.toHaveBeenCalled();
	});

	it("shows an untracked file as added lines, cut at 2000 rows with a note", async () => {
		const root = createTemporaryDirectory();
		writeFileSync(join(root, "long.txt"), "line\n".repeat(2500));
		const untracked = changedFile("long.txt", 2500, 0, { isUntracked: true });

		const diff = await loadFileDiff({ ...snapshot, root, files: [untracked] }, untracked, signal, createRunner({}));

		if (diff?.status !== "ready") throw new Error("expected a ready diff");
		expect(diff.rows).toHaveLength(2001);
		expect(diff.rows.at(-1)).toEqual({ kind: "note", text: "Diff truncated" });
	});
});
