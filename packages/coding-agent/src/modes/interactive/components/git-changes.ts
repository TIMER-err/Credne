// Reads the working tree's changes since the session baseline: the changed files with line counts, and one file's
// diff as rows. Everything meant for display is made display-safe here, once, so rendering never has to.
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { completeRecords, type GitRunner, runGit } from "./git-runner.ts";
import type { BaselineScope, SessionBaseline } from "./session-baseline.ts";

/** How a changed file can be shown: as text, or only as a label because it is binary or too large to read. */
export type ChangedFileContent = "text" | "binary" | "large";

export interface ChangedFile {
	/** Path relative to the repository root, with forward slashes. Use it for git and the file system only. */
	path: string;
	/** The path made display-safe: control characters replaced. Use it for anything shown. */
	label: string;
	added: number;
	removed: number;
	isUntracked: boolean;
	content: ChangedFileContent;
}

export interface ChangesTotals {
	/** Every changed file, including those beyond the list cap. */
	files: number;
	added: number;
	removed: number;
}

export type ChangesSnapshot =
	| {
			status: "ready";
			root: string;
			/** The commit or tree the changes are measured against. */
			base: string;
			scope: BaselineScope;
			/** The first files by path, up to the list cap. */
			files: ChangedFile[];
			totals: ChangesTotals;
	  }
	| { status: "no-repo" }
	| { status: "error"; message: string };

/** A line of code in a diff, numbered on the old side, the new side, or both. Its text is display-safe. */
export interface DiffCodeRow {
	kind: "context" | "added" | "removed";
	oldNumber: number | undefined;
	newNumber: number | undefined;
	text: string;
}

export type DiffRow = { kind: "hunk"; text: string } | { kind: "note"; text: string } | DiffCodeRow;

export type FileDiff = { status: "ready"; rows: DiffRow[] } | { status: "error"; message: string };

/** More changed files than this are counted in the totals but not listed. */
const maxListedFiles = 500;
/** Untracked files above this size are labelled large and not read. */
const maxUntrackedBytes = 1024 * 1024;
/** Once this many bytes of untracked files were read, later ones are labelled large and not read. */
const untrackedByteBudget = 8 * 1024 * 1024;
/** A diff longer than this many rows is cut, with a note row at the end. */
const maxDiffRows = 2000;
/** A diff larger than this is cut, with a note row at the end. */
const maxDiffBytes = 256 * 1024;
/** The cap on the output of the commands that list changed files. */
const maxListBytes = 8 * 1024 * 1024;
/** git treats a file as binary when its first 8000 bytes contain a NUL byte. */
const binaryProbeBytes = 8000;

const truncatedNote: DiffRow = { kind: "note", text: "Diff truncated" };
const numstatRecord = /^(\d+|-)\t(\d+|-)\t(.+)$/s;
const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Tabs become spaces and runs of control characters one space, so text cannot move the cursor or break a width. */
export function sanitizeDisplayText(text: string): string {
	return text.replaceAll("\t", "   ").replace(controlCharacters, " ");
}

/** Parse `git diff --numstat -z --no-renames`. Binary files report `-` for both counts. */
export function parseNumstat(output: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	for (const record of output.split("\0")) {
		const match = numstatRecord.exec(record);
		if (!match) continue;
		const isBinary = match[1] === "-";
		files.push({
			path: match[3]!,
			label: sanitizeDisplayText(match[3]!),
			added: isBinary ? 0 : Number(match[1]),
			removed: isBinary ? 0 : Number(match[2]),
			isUntracked: false,
			content: isBinary ? "binary" : "text",
		});
	}
	return files;
}

/** Parse `git ls-files --others --exclude-standard -z`. Nested repositories are listed as `dir/` and skipped. */
export function parseUntrackedPaths(output: string): string[] {
	return output.split("\0").filter((path) => path.length > 0 && !path.endsWith("/"));
}

/** The number of lines in a text: a last line without a newline still counts. */
export function countLines(text: string): number {
	if (text.length === 0) return 0;
	const newlines = text.split("\n").length - 1;
	return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Sum the file count and line counts of `files`. */
export function summarizeChanges(files: readonly ChangedFile[]): ChangesTotals {
	return {
		files: files.length,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}

/** Parse the hunks of `git diff -U3` output into display-safe rows with line numbers, up to the row cap. */
export function parseUnifiedDiff(output: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNumber = 0;
	let newNumber = 0;
	let isInHunk = false;
	for (const line of output.split("\n")) {
		if (rows.length >= maxDiffRows) {
			rows.push(truncatedNote);
			break;
		}
		const header = hunkHeader.exec(line);
		if (header) {
			oldNumber = Number(header[1]);
			newNumber = Number(header[2]);
			isInHunk = true;
			rows.push({ kind: "hunk", text: sanitizeDisplayText(line) });
			continue;
		}
		if (!isInHunk) {
			if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
				return [{ kind: "note", text: "Binary file" }];
			}
			continue;
		}
		const marker = line[0];
		const text = sanitizeDisplayText(line.slice(1));
		if (marker === "+") rows.push({ kind: "added", oldNumber: undefined, newNumber: newNumber++, text });
		else if (marker === "-") rows.push({ kind: "removed", oldNumber: oldNumber++, newNumber: undefined, text });
		else if (marker === " ") rows.push({ kind: "context", oldNumber: oldNumber++, newNumber: newNumber++, text });
		else if (marker === "\\") rows.push({ kind: "note", text: sanitizeDisplayText(line.slice(2)) });
	}
	return rows;
}

/** Rows that show an untracked file as one hunk of added lines, display-safe, up to the row cap. */
export function untrackedDiffRows(text: string): DiffRow[] {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const rows: DiffRow[] = lines.slice(0, maxDiffRows).map((line, index) => ({
		kind: "added",
		oldNumber: undefined,
		newNumber: index + 1,
		text: sanitizeDisplayText(line),
	}));
	if (lines.length > maxDiffRows) rows.push(truncatedNote);
	return rows;
}

/**
 * Load the files changed since `baseline` in the working tree. Resolves to undefined when `signal` aborts.
 *
 * Tracked files are diffed against the baseline, which includes edits made by subagents and shell commands. Files
 * that were untracked when the session started have no baseline content to diff against, so they are left out,
 * whether they are still untracked or were added to the index since.
 */
export async function loadChanges(
	baseline: SessionBaseline,
	signal: AbortSignal,
	run: GitRunner = runGit,
): Promise<ChangesSnapshot | undefined> {
	if (baseline.status !== "ready") return baseline;
	const { root, base, scope } = baseline;
	const [numstat, untracked] = await Promise.all([
		run(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", base, "--"], root, signal, maxListBytes),
		run(["ls-files", "--others", "--exclude-standard", "-z"], root, signal, maxListBytes),
	]);
	if (numstat.status === "aborted" || untracked.status === "aborted") return undefined;
	if (numstat.status === "failed") return { status: "error", message: sanitizeDisplayText(numstat.message) };
	if (untracked.status === "failed") return { status: "error", message: sanitizeDisplayText(untracked.message) };

	const isNew = (path: string) => !baseline.untracked.has(path);
	const tracked = parseNumstat(completeRecords(numstat, "\0")).filter((file) => isNew(file.path));
	const untrackedPaths = parseUntrackedPaths(completeRecords(untracked, "\0")).filter(isNew);
	const entries = [
		...tracked.map((file) => ({ path: file.path, tracked: file })),
		...untrackedPaths.map((path) => ({ path, tracked: undefined })),
	].sort((a, b) => comparePaths(a.path, b.path));
	const listed = entries.slice(0, maxListedFiles);
	const untrackedFiles = await describeUntrackedFiles(
		root,
		listed.filter((entry) => entry.tracked === undefined).map((entry) => entry.path),
	);
	if (signal.aborted) return undefined;

	const described = new Map(untrackedFiles.map((file) => [file.path, file]));
	const files = listed.map((entry) => entry.tracked ?? described.get(entry.path)!);
	const counted = summarizeChanges([...tracked, ...untrackedFiles]);
	return { status: "ready", root, base, scope, files, totals: { ...counted, files: entries.length } };
}

/** Load one file's diff for the panel. Resolves to undefined when `signal` aborts. */
export async function loadFileDiff(
	snapshot: Extract<ChangesSnapshot, { status: "ready" }>,
	file: ChangedFile,
	signal: AbortSignal,
	run: GitRunner = runGit,
): Promise<FileDiff | undefined> {
	if (file.isUntracked) return loadUntrackedDiff(snapshot.root, file, signal);
	if (file.content === "binary") return { status: "ready", rows: [{ kind: "note", text: "Binary file" }] };
	const args = ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", snapshot.base, "--", file.path];
	const output = await run(args, snapshot.root, signal, maxDiffBytes);
	if (output.status === "aborted") return undefined;
	if (output.status === "failed") return { status: "error", message: sanitizeDisplayText(output.message) };
	const rows = parseUnifiedDiff(completeRecords(output, "\n"));
	if (output.isTruncated && rows[rows.length - 1] !== truncatedNote) rows.push(truncatedNote);
	return { status: "ready", rows };
}

async function loadUntrackedDiff(root: string, file: ChangedFile, signal: AbortSignal): Promise<FileDiff | undefined> {
	if (file.content !== "text") {
		return {
			status: "ready",
			rows: [{ kind: "note", text: file.content === "binary" ? "Binary file" : "File too large to show" }],
		};
	}
	const read = await readUntrackedFile(root, file.path, maxUntrackedBytes);
	if (signal.aborted) return undefined;
	if (read.content !== "text") {
		return { status: "ready", rows: [{ kind: "note", text: "File changed while reading" }] };
	}
	return { status: "ready", rows: untrackedDiffRows(read.text) };
}

type UntrackedRead =
	| { content: "text"; text: string; bytes: number }
	| { content: "binary"; bytes: number }
	| { content: "large"; bytes: 0 };

/** Describe the untracked files one by one, reading no more than the byte budget in total. */
async function describeUntrackedFiles(root: string, paths: readonly string[]): Promise<ChangedFile[]> {
	const described: ChangedFile[] = [];
	let remaining = untrackedByteBudget;
	for (const path of paths) {
		const read = await readUntrackedFile(root, path, Math.min(maxUntrackedBytes, remaining));
		remaining -= read.bytes;
		const added = read.content === "text" ? countLines(read.text) : 0;
		described.push({
			path,
			label: sanitizeDisplayText(path),
			added,
			removed: 0,
			isUntracked: true,
			content: read.content,
		});
	}
	return described;
}

/** Read an untracked file of at most `maxBytes`. Larger and unreadable files are reported as large, unread. */
async function readUntrackedFile(root: string, path: string, maxBytes: number): Promise<UntrackedRead> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(join(root, path), "r");
		const { size } = await handle.stat();
		if (size > maxBytes) return { content: "large", bytes: 0 };
		const buffer = Buffer.alloc(size);
		const { bytesRead } = await handle.read(buffer, 0, size, 0);
		const bytes = buffer.subarray(0, bytesRead);
		if (bytes.subarray(0, binaryProbeBytes).includes(0)) return { content: "binary", bytes: bytesRead };
		return { content: "text", text: bytes.toString("utf8"), bytes: bytesRead };
	} catch {
		// Deleted or unreadable between listing and reading: show it as a label rather than failing the panel.
		return { content: "large", bytes: 0 };
	} finally {
		await handle?.close();
	}
}

/** Byte-wise order, like `git status`. */
function comparePaths(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
