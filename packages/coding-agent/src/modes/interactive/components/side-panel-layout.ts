// How the side panel and the transcript share the terminal width: the panel's width, and the layouts that reserve it.
//
// Only the transcript area gives up columns. The input dock (status row, widgets, editor, footer) keeps the full
// width, and the panel stops above it. Nothing here exists while the panel is closed: both reservations are
// installed on open and removed on close.
import { type Component, Container, type TUI } from "@earendil-works/pi-tui";
import type { ChatViewport } from "../chat-viewport.ts";

/** Terminals narrower than this cannot show the panel next to the transcript. */
export const sidePanelMinColumns = 100;

const sidePanelMinWidth = 40;
const sidePanelMaxWidth = 90;
const sidePanelWidthShare = 0.4;

/** Resolve the default or dragged width, leaving at least 40 columns for each pane. */
export function sidePanelWidthFor(columns: number, requestedWidth?: number): number {
	if (columns < sidePanelMinColumns) return 0;
	const desired = requestedWidth ?? Math.min(sidePanelMaxWidth, Math.floor(columns * sidePanelWidthShare));
	return Math.max(sidePanelMinWidth, Math.min(columns - sidePanelMinWidth, desired));
}

/** Columns reserved beside the transcript. */
export interface TranscriptReservation {
	/** Rows of the transcript area on screen as of the last render: the rows the panel may cover. */
	getRows(): number;
	/** Give the columns back. */
	release(): void;
}

/** Fullscreen: put a spacer of the reserved width beside the transcript, inside the chat layout. */
export function reserveFullscreenColumns(
	viewport: ChatViewport,
	getReservedWidth: () => number,
): TranscriptReservation {
	viewport.setTranscriptSpacer(new SidePanelSpacer(getReservedWidth));
	return {
		getRows: () => viewport.transcript.viewportHeight,
		release: () => viewport.setTranscriptSpacer(undefined),
	};
}

/**
 * Regular mode: replace the TUI's children with a layout that renders the transcript parts narrower and the dock
 * parts at full width. `parts` are the children in order, and `release` puts them back.
 */
export function reserveRegularColumns(
	tui: TUI,
	parts: { transcript: readonly Component[]; dock: readonly Component[] },
	getReservedWidth: () => number,
): TranscriptReservation {
	const children = [...parts.transcript, ...parts.dock];
	const layout = new RegularColumnsLayout(parts.transcript, parts.dock, getReservedWidth, () => tui.terminal.rows);
	for (const child of children) tui.removeChild(child);
	tui.addChild(layout);
	return {
		getRows: () => layout.transcriptRows,
		release: () => {
			tui.removeChild(layout);
			for (const child of children) tui.addChild(child);
		},
	};
}

/** Fills the reserved columns in the fullscreen layout. It measures as wide as the panel, so resizes are followed. */
class SidePanelSpacer implements Component {
	private readonly getWidth: () => number;

	constructor(getWidth: () => number) {
		this.getWidth = getWidth;
	}

	render(): string[] {
		const width = this.getWidth();
		return width > 0 ? [" ".repeat(width)] : [];
	}

	invalidate(): void {}
}

/**
 * Renders the transcript at the narrowed width and the dock at the full width. While columns are reserved it pads a
 * short transcript to the screen, so the dock stays at the bottom and the panel has the whole transcript area.
 * The transcript's rows follow from the dock's last rendered height, so nothing is rendered twice to measure it.
 */
class RegularColumnsLayout extends Container {
	transcriptRows = 0;
	private readonly transcript: readonly Component[];
	private readonly dock: readonly Component[];
	private readonly getReservedWidth: () => number;
	private readonly getTerminalRows: () => number;

	constructor(
		transcript: readonly Component[],
		dock: readonly Component[],
		getReservedWidth: () => number,
		getTerminalRows: () => number,
	) {
		super();
		this.transcript = transcript;
		this.dock = dock;
		this.getReservedWidth = getReservedWidth;
		this.getTerminalRows = getTerminalRows;
		// The children stay in the tree so focus and invalidation reach them.
		for (const child of [...transcript, ...dock]) this.addChild(child);
	}

	override render(width: number): string[] {
		const reserved = this.getReservedWidth();
		const lines: string[] = [];
		for (const part of this.transcript) {
			for (const line of part.render(Math.max(1, width - reserved))) lines.push(line);
		}
		const dockLines: string[] = [];
		for (const part of this.dock) {
			for (const line of part.render(width)) dockLines.push(line);
		}
		this.transcriptRows = Math.max(0, this.getTerminalRows() - dockLines.length);
		if (reserved > 0) {
			while (lines.length < this.transcriptRows) lines.push("");
		}
		for (const line of dockLines) lines.push(line);
		return lines;
	}
}
