// The side panel's content: extension sections, a file index, and a scrollable sequence of per-file diffs.
import {
	type Component,
	sliceByColumn,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";
import type { ThemeBg } from "../theme/theme-tokens.ts";
import type { ChangedFile, ChangesSnapshot, ChangesTotals, DiffCodeRow, DiffRow, FileDiff } from "./git-changes.ts";
import type { BaselineScope } from "./session-baseline.ts";

export interface SidePanelSection {
	key: string;
	/** Sections render top to bottom by ascending order. */
	order: number;
	component: Component;
}

/** A file's diff, loading until the controller delivers it. */
export type PanelDiff = { status: "loading" } | FileDiff;

export interface SidePanelOptions {
	/** Rows the panel fills, so its left border runs the full height. */
	getHeight: () => number;
	/** What closes the panel, shown in the header: the toggle key, or "/diff". */
	getCloseHint: () => string;
	resize?: (screenX: number) => void;
}

const maxFileRows = 8;
/** The header row, and the blank rows above and below the file list. */
const framingRows = 3;
/** The "more above" and "more below" rows of an overflowing file list. */
const overflowRows = 2;
/** The file list gives up rows before the diff drops below this many. */
const minDiffRows = 4;
/** Longer lines are shown without syntax highlighting. */
const maxHighlightLength = 400;
const noLines: string[] = [];

interface DiffBlock {
	file: ChangedFile;
	diff: PanelDiff;
	start: number;
	length: number;
	gutterWidth: number;
	lines: Map<number, string>;
}

/**
 * Renders sections and git changes into a column that the interactive mode shows as an overlay.
 *
 * The TUI renders on every frame, so each part keeps its last result: sections are compared line by line,
 * the changes part is keyed by a revision that every change to its data bumps, and each diff row is
 * rendered once per width. A frame that changes none of them returns the previous array.
 */
export class SidePanel implements Component {
	private readonly options: SidePanelOptions;
	private sections: SidePanelSection[] = [];
	private changes: ChangesSnapshot | undefined;
	private selectedIndex = 0;
	private fileOffset = 0;
	private diffBlocks: DiffBlock[] = [];
	private diffOffset = 0;
	private diffViewRows = 1;
	private diffRowCount = 0;
	private fileViewRows = 1;
	private fileRegionStart = 0;
	private fileRegionEnd = 0;
	private fileRowIndices = new Map<number, number>();
	private followSelection = true;
	private sectionOffset = 0;
	private sectionViewRows = 0;
	private sectionRowCount = 0;
	private isResizing = false;
	/** Bumped by every change to what the changes part shows. */
	private revision = 0;
	private sectionCache: { width: number; rows: number; offset: number; raw: string[]; lines: string[] } | undefined;
	private changesCache: { revision: number; width: number; rows: number; hint: string; lines: string[] } | undefined;
	private outputCache: { sectionLines: string[]; changesLines: string[]; height: number; lines: string[] } | undefined;
	private diffRowCacheWidth = 0;

	constructor(options: SidePanelOptions) {
		this.options = options;
	}

	/** Replace the extension sections. They render above the changes, by ascending order. */
	setSections(sections: readonly SidePanelSection[]): void {
		this.sections = [...sections].sort((a, b) => a.order - b.order);
	}

	/** Show a new snapshot, keeping the selection on the same file when it is still changed. */
	setChanges(changes: ChangesSnapshot): void {
		const previousPath = this.getSelectedFile()?.path;
		const previousBlock = this.diffBlocks.find((block) => this.diffOffset < block.start + block.length);
		const previousOffset = previousBlock ? this.diffOffset - previousBlock.start : 0;
		this.changes = changes;
		const files = this.files();
		const sameIndex = files.findIndex((file) => file.path === previousPath);
		this.selectedIndex = sameIndex !== -1 ? sameIndex : Math.max(0, Math.min(this.selectedIndex, files.length - 1));
		const previousBlocks = new Map(this.diffBlocks.map((block) => [block.file.path, block]));
		this.diffBlocks = files.map((file) => {
			const previous = previousBlocks.get(file.path);
			previous?.lines.delete(1);
			return previous
				? { ...previous, file }
				: {
						file,
						diff: { status: "loading" },
						start: 0,
						length: 5,
						gutterWidth: 1,
						lines: new Map<number, string>(),
					};
		});
		this.updateDiffPositions();
		const anchor = this.diffBlocks.find((block) => block.file.path === previousBlock?.file.path);
		if (anchor) this.diffOffset = anchor.start + Math.min(previousOffset, anchor.length - 1);
		else this.jumpToSelectedFile();
		this.followSelection = true;
		this.revision++;
	}

	/** Replace a file's diff without moving the visible file when earlier sections grow. */
	setDiff(path: string, diff: PanelDiff): void {
		const block = this.diffBlocks.find((candidate) => candidate.file.path === path);
		if (!block) return;
		const anchor = this.diffBlocks.find((candidate) => this.diffOffset < candidate.start + candidate.length);
		const anchorOffset = anchor ? this.diffOffset - anchor.start : 0;
		block.diff = diff;
		block.lines.clear();
		block.gutterWidth = diff.status === "ready" ? gutterWidthFor(diff.rows) : 1;
		block.length = 4 + (diff.status === "ready" ? Math.max(1, diff.rows.length) : 1);
		this.updateDiffPositions();
		if (anchor) this.diffOffset = anchor.start + Math.min(anchorOffset, anchor.length - 1);
		this.revision++;
	}

	getSelectedFile(): ChangedFile | undefined {
		return this.files()[this.selectedIndex];
	}

	/** Move the selection by `delta` files, without wrapping. Returns whether it moved. */
	selectFile(delta: number): boolean {
		const files = this.files();
		const next = Math.max(0, Math.min(this.selectedIndex + delta, files.length - 1));
		if (files.length === 0 || next === this.selectedIndex) return false;
		this.selectedIndex = next;
		this.jumpToSelectedFile();
		this.followSelection = true;
		this.revision++;
		return true;
	}

	/** Scroll the diff by `lines`; negative values scroll up. */
	scrollDiff(lines: number): void {
		const next = Math.max(0, Math.min(this.diffOffset + lines, this.maxDiffOffset()));
		if (next === this.diffOffset) return;
		this.diffOffset = next;
		const index = this.diffBlocks.findIndex((block) => next < block.start + block.length);
		if (index !== -1 && this.selectedIndex !== index) {
			this.selectedIndex = index;
			this.followSelection = true;
		}
		this.revision++;
	}

	/** Scroll the diff by a screenful: 1 down, -1 up. */
	scrollDiffPage(direction: 1 | -1): void {
		this.scrollDiff(direction * Math.max(1, this.diffViewRows - 1));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "press" && event.button === "left" && event.x === 0 && this.options.resize) {
			this.isResizing = true;
			return { handled: true, capture: true };
		}
		if (this.isResizing && (event.type === "drag" || event.type === "release")) {
			this.options.resize?.(event.screenX);
			if (event.type === "release") this.isResizing = false;
			return { handled: true, render: true };
		}
		if (event.type === "press" && event.button === "left" && this.fileRowIndices.has(event.y)) {
			return { handled: true, render: false };
		}
		if (event.type === "click" && event.button === "left") {
			const index = this.fileRowIndices.get(event.y);
			if (index === undefined) return undefined;
			if (!this.selectFile(index - this.selectedIndex)) {
				this.jumpToSelectedFile();
				this.revision++;
			}
			return { handled: true };
		}
		if (event.type !== "wheel" || event.wheelDelta === undefined) return undefined;
		if (event.y < this.sectionViewRows) {
			this.sectionOffset = Math.max(
				0,
				Math.min(this.sectionOffset + event.wheelDelta, this.sectionRowCount - this.sectionViewRows),
			);
		} else if (event.y >= this.fileRegionStart && event.y < this.fileRegionEnd) {
			this.fileOffset = Math.max(
				0,
				Math.min(this.fileOffset + event.wheelDelta, this.files().length - this.fileViewRows),
			);
			this.followSelection = false;
			this.revision++;
		} else {
			this.scrollDiff(event.wheelDelta);
		}
		return { handled: true };
	}

	invalidate(): void {
		this.revision++;
		this.sectionCache = undefined;
		for (const block of this.diffBlocks) block.lines.clear();
		for (const section of this.sections) section.component.invalidate();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.options.getHeight());
		const bodyWidth = Math.max(0, width - 1);
		const sectionLines = this.renderSections(bodyWidth, Math.floor(height / 3));
		const changesLines = this.renderChanges(bodyWidth, Math.max(0, height - sectionLines.length));
		const cached = this.outputCache;
		if (cached?.sectionLines === sectionLines && cached.changesLines === changesLines && cached.height === height) {
			return cached.lines;
		}
		const lines = [...sectionLines, ...changesLines].slice(0, height);
		const blank = frame(exactWidth("", bodyWidth));
		while (lines.length < height) lines.push(blank);
		this.outputCache = { sectionLines, changesLines, height, lines };
		return lines;
	}

	private files(): readonly ChangedFile[] {
		return this.changes?.status === "ready" ? this.changes.files : [];
	}

	private updateDiffPositions(): void {
		let start = 0;
		for (const block of this.diffBlocks) {
			block.start = start;
			start += block.length;
		}
		this.diffRowCount = start;
	}

	private jumpToSelectedFile(): void {
		this.diffOffset = this.diffBlocks[this.selectedIndex]?.start ?? 0;
	}

	private maxDiffOffset(): number {
		const lastStart = this.diffBlocks.at(-1)?.start ?? 0;
		return Math.max(lastStart, this.diffRowCount - this.diffViewRows, 0);
	}

	/** The sections' lines, framed. The sections render every frame, so they are the only part compared by content. */
	private renderSections(bodyWidth: number, rows: number): string[] {
		const blocks = this.sections
			.map((section) => section.component.render(Math.max(1, bodyWidth - 2)))
			.filter((block) => block.length > 0);
		const raw = blocks.flatMap((block, index) => (index === 0 ? block : ["", ...block]));
		if (raw.length > 0) raw.push("");
		this.sectionRowCount = raw.length;
		this.sectionViewRows = Math.min(rows, raw.length);
		this.sectionOffset = Math.min(this.sectionOffset, Math.max(0, raw.length - this.sectionViewRows));
		if (raw.length === 0) return noLines;
		const cached = this.sectionCache;
		if (
			cached &&
			cached.width === bodyWidth &&
			cached.rows === rows &&
			cached.offset === this.sectionOffset &&
			sameLines(cached.raw, raw)
		)
			return cached.lines;
		const lines = raw
			.slice(this.sectionOffset, this.sectionOffset + rows)
			.map((line) => frame(padded(line, bodyWidth)));
		this.sectionCache = { width: bodyWidth, rows, offset: this.sectionOffset, raw, lines };
		return lines;
	}

	/** The changes part in `rows` rows, framed, rebuilt only when its data, width, height or hint changed. */
	private renderChanges(bodyWidth: number, rows: number): string[] {
		const hint = this.options.getCloseHint();
		const cached = this.changesCache;
		if (
			cached?.revision === this.revision &&
			cached.width === bodyWidth &&
			cached.rows === rows &&
			cached.hint === hint
		) {
			return cached.lines;
		}
		const lines = this.buildChanges(bodyWidth, rows, hint).map(frame);
		this.changesCache = { revision: this.revision, width: bodyWidth, rows, hint, lines };
		return lines;
	}

	/** The header, independently scrolling file index, and the diff viewport, unframed. */
	private buildChanges(bodyWidth: number, available: number, hint: string): string[] {
		const changes = this.changes;
		this.fileRowIndices.clear();
		this.fileRegionStart = this.sectionViewRows + 2;
		this.fileRegionEnd = this.fileRegionStart;
		if (changes === undefined) return [headerRow([muted("Loading changes…")], hint, bodyWidth)];
		if (changes.status === "no-repo") return [headerRow([muted("Not a git repository")], hint, bodyWidth)];
		if (changes.status === "error") return [headerRow([muted(`git: ${changes.message}`)], hint, bodyWidth)];
		if (changes.totals.files === 0) {
			return [headerRow([muted(`No changes ${scopeLabel(changes.scope)}`), muted("No changes")], hint, bodyWidth)];
		}

		const listRows = Math.max(
			1,
			Math.min(maxFileRows, changes.files.length, available - framingRows - overflowRows - minDiffRows),
		);
		const omitted = changes.totals.files - changes.files.length;
		const fileLines = this.buildFileList(changes.files, listRows, omitted, bodyWidth);
		this.fileRegionEnd = this.fileRegionStart + fileLines.length;
		const blank = exactWidth("", bodyWidth);
		return [
			headerRow(summaryTexts(changes.totals, changes.scope), hint, bodyWidth),
			blank,
			...fileLines,
			blank,
			...this.buildDiff(Math.max(0, available - framingRows - fileLines.length), bodyWidth),
		];
	}

	private buildFileList(
		files: readonly ChangedFile[],
		listRows: number,
		omitted: number,
		bodyWidth: number,
	): string[] {
		this.fileViewRows = listRows;
		if (this.followSelection) {
			if (this.selectedIndex < this.fileOffset) this.fileOffset = this.selectedIndex;
			else if (this.selectedIndex >= this.fileOffset + listRows) this.fileOffset = this.selectedIndex - listRows + 1;
			this.followSelection = false;
		}
		this.fileOffset = Math.max(0, Math.min(this.fileOffset, files.length - listRows));
		const above = this.fileOffset;
		const below = files.length - this.fileOffset - listRows;
		const lines: string[] = [];
		const overflows = files.length > listRows;
		if (overflows) lines.push(padded(muted(above > 0 ? `↑ ${above} more above` : ""), bodyWidth));
		for (let index = this.fileOffset; index < this.fileOffset + listRows; index++) {
			this.fileRowIndices.set(this.fileRegionStart + lines.length, index);
			lines.push(fileRow(files[index]!, index === this.selectedIndex, bodyWidth));
		}
		if (overflows || omitted > 0) {
			const notes = [
				below > 0 ? `↓ ${below} more below` : "",
				omitted > 0 ? `+${omitted} more not listed` : "",
			].filter(Boolean);
			lines.push(padded(muted(notes.join(" · ")), bodyWidth));
		}
		return lines;
	}

	private buildDiff(rows: number, bodyWidth: number): string[] {
		this.diffViewRows = Math.max(1, rows);
		if (rows <= 0) return [];
		this.diffOffset = Math.min(this.diffOffset, this.maxDiffOffset());
		if (this.diffRowCacheWidth !== bodyWidth) {
			for (const block of this.diffBlocks) block.lines.clear();
			this.diffRowCacheWidth = bodyWidth;
		}
		const lines: string[] = [];
		const end = this.diffOffset + rows;
		for (const block of this.diffBlocks) {
			if (block.start >= end) break;
			if (block.start + block.length <= this.diffOffset) continue;
			const first = Math.max(0, this.diffOffset - block.start);
			const last = Math.min(block.length, end - block.start);
			for (let index = first; index < last; index++) lines.push(this.diffRow(block, index, bodyWidth));
		}
		return padRows(lines, rows, bodyWidth);
	}

	private diffRow(block: DiffBlock, index: number, bodyWidth: number): string {
		const cached = block.lines.get(index);
		if (cached !== undefined) return cached;
		let line: string;
		if (index === 0 || index === 2) {
			line = theme.fg("borderMuted", "─".repeat(bodyWidth));
		} else if (index === 1) {
			line = fileRow(block.file, false, bodyWidth);
		} else if (index === block.length - 1) {
			line = exactWidth("", bodyWidth);
		} else if (block.diff.status !== "ready") {
			line = padded(muted(block.diff.status === "loading" ? "Loading diff…" : block.diff.message), bodyWidth);
		} else {
			const row = block.diff.rows[index - 3];
			line = row
				? this.renderDiffRow(row, bodyWidth, getLanguageFromPath(block.file.path), block.gutterWidth)
				: padded(muted("No text changes"), bodyWidth);
		}
		block.lines.set(index, line);
		return line;
	}

	private renderDiffRow(row: DiffRow, bodyWidth: number, language: string | undefined, gutterWidth: number): string {
		if (row.kind === "hunk" || row.kind === "note") return padded(muted(row.text), bodyWidth);
		const number = row.kind === "removed" ? row.oldNumber : row.newNumber;
		const gutter = theme.fg("dim", String(number ?? "").padStart(gutterWidth));
		const marker =
			row.kind === "added"
				? theme.fg("toolDiffAdded", "+")
				: row.kind === "removed"
					? theme.fg("toolDiffRemoved", "-")
					: " ";
		const textWidth = Math.max(0, bodyWidth - gutterWidth - 4);
		const text = truncateToWidth(styledDiffText(row, language), textWidth, "…", true);
		const line = exactWidth(` ${gutter} ${marker} ${text}`, bodyWidth);
		if (row.kind === "added") return fillBackground(line, bodyWidth, "toolSuccessBg");
		if (row.kind === "removed") return fillBackground(line, bodyWidth, "toolErrorBg");
		return line;
	}
}

/** The panel's left border, then the body line. */
function frame(body: string): string {
	return theme.fg("borderAccent", "│") + body;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, index) => line === b[index]);
}

function padRows(lines: string[], rows: number, bodyWidth: number): string[] {
	while (lines.length < rows) lines.push(exactWidth("", bodyWidth));
	return lines;
}

function muted(text: string): string {
	return theme.fg("muted", text);
}

function scopeLabel(scope: BaselineScope): string {
	return scope === "session" ? "since session start" : "since last commit";
}

/** The header's counts with the scope after them, and the counts alone for when there is no room for the scope. */
function summaryTexts(totals: ChangesTotals, scope: BaselineScope): string[] {
	const label = totals.files === 1 ? " file changed" : " files changed";
	const counts = [
		theme.bold(String(totals.files)) + muted(label),
		theme.fg("toolDiffAdded", `+${totals.added}`),
		theme.fg("toolDiffRemoved", `-${totals.removed}`),
	].join(" ");
	return [`${counts} ${muted(scopeLabel(scope))}`, counts];
}

/**
 * A row with the first of `lefts` that fits beside the close hint, right-aligned. When none fits, the hint is
 * dropped and the last left text is shown.
 */
function headerRow(lefts: readonly string[], closeHint: string, bodyWidth: number): string {
	const hint = muted(`${closeHint} to close`);
	const room = bodyWidth - 2;
	const left = lefts.find((candidate) => visibleWidth(candidate) + visibleWidth(hint) + 2 <= room);
	return padded(left === undefined ? lefts[lefts.length - 1]! : joinSides(left, hint, room), bodyWidth);
}

function fileRow(file: ChangedFile, isSelected: boolean, bodyWidth: number): string {
	const counts = fileCounts(file);
	const pathWidth = Math.max(1, bodyWidth - 2 - visibleWidth(counts) - 2);
	const path = truncatePathStart(file.label, pathWidth);
	const row = padded(joinSides(theme.fg(isSelected ? "text" : "muted", path), counts, bodyWidth - 2), bodyWidth);
	return isSelected ? fillBackground(row, bodyWidth, "selectedBg") : row;
}

/** Syntax-highlighted text when the language is known, otherwise the kind's diff color. */
function styledDiffText(row: DiffCodeRow, language: string | undefined): string {
	const text = row.text;
	if (language === undefined || text.length === 0 || text.length > maxHighlightLength) {
		return theme.fg(
			row.kind === "added" ? "toolDiffAdded" : row.kind === "removed" ? "toolDiffRemoved" : "toolDiffContext",
			text,
		);
	}
	return highlightCode(text, language)[0] ?? text;
}

/** Pad or cut a line to exactly `width` columns. */
function exactWidth(line: string, width: number): string {
	return truncateToWidth(line, width, "", true);
}

/** A body line: one column of margin, then the text cut to fit. */
function padded(text: string, bodyWidth: number): string {
	return truncateToWidth(` ${text}`, bodyWidth, "…", true);
}

/** `left` and `right` on one line of `width` columns, or `left` alone when they do not fit with a gap. */
function joinSides(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 2 ? left + " ".repeat(gap) + right : left;
}

/** The right side of a file row: green and red line counts, or a label for files without counts. */
function fileCounts(file: ChangedFile): string {
	if (file.content === "binary") return theme.fg("muted", "binary");
	if (file.content === "large") return theme.fg("muted", "large");
	const parts: string[] = [];
	if (file.added > 0) parts.push(theme.fg("toolDiffAdded", `+${file.added}`));
	if (file.removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${file.removed}`));
	return parts.join(" ");
}

/** Cut the start of a path so its file name stays visible. */
function truncatePathStart(path: string, width: number): string {
	const pathWidth = visibleWidth(path);
	if (pathWidth <= width) return path;
	if (width <= 1) return "…".slice(0, width);
	return `…${sliceByColumn(path, pathWidth - (width - 1), width - 1, true)}`;
}

/** Widest line number in the diff, as a column width. */
function gutterWidthFor(rows: readonly DiffRow[]): number {
	let largest = 0;
	for (const row of rows) {
		if (row.kind === "hunk" || row.kind === "note") continue;
		largest = Math.max(largest, row.oldNumber ?? 0, row.newNumber ?? 0);
	}
	return String(largest).length;
}

/** Paint `bg` behind a line, padded to `width`. Truncation ends with a full reset, so the color is restored after each. */
function fillBackground(line: string, width: number, bg: ThemeBg): string {
	const open = theme.getBgAnsi(bg);
	const filled = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	return `${open}${filled.replaceAll("\x1b[0m", `\x1b[0m${open}`)}\x1b[49m`;
}
