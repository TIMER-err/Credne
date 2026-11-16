// Opens and closes the side panel: shows it as an overlay, reserves its columns, and keeps its git data fresh.
//
// A closed panel costs nothing: no component is mounted, and agent events pass through one check. The only git work
// while closed is capturing the session's starting state, once per session and not at all outside a repository.
// While open, git refreshes after agent_end and tool_execution_end (debounced), then loads the files' diffs one
// process step at a time. Selection prioritizes pending files. Rendering never starts git work.
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { type ChangedFile, type ChangesSnapshot, loadChanges, loadFileDiff } from "./components/git-changes.ts";
import { type GitRunner, runGit } from "./components/git-runner.ts";
import { captureBaseline, type SessionBaseline } from "./components/session-baseline.ts";
import { SidePanel, type SidePanelSection } from "./components/side-panel.ts";
import { sidePanelMinColumns, sidePanelWidthFor, type TranscriptReservation } from "./components/side-panel-layout.ts";
import { type Theme, theme } from "./theme/theme.ts";

export type SidePanelSectionComponent = Component & { dispose?(): void };
export type SidePanelSectionFactory = (tui: TUI, theme: Theme) => SidePanelSectionComponent;

export interface SidePanelHost {
	/** Stable reference that follows renderer replacement. */
	readonly ui: TUI;
	/** Working directory whose git changes the panel shows. */
	getCwd(): string;
	/** What closes the panel, for the header: the configured toggle key, or "/diff". */
	getCloseHint(): string;
	showStatus(message: string): void;
	/** Free `getWidth()` columns beside the transcript on the current renderer, leaving the input dock full width. */
	reserveTranscriptColumns(getWidth: () => number): TranscriptReservation;
}

/** Agent events after which the working tree may have changed. */
const refreshEventTypes: ReadonlySet<string> = new Set(["agent_end", "tool_execution_end"]);
const refreshDebounceMs = 300;

/** Owns the side panel's lifecycle for the interactive mode. */
export class SidePanelController {
	private readonly host: SidePanelHost;
	private readonly runGit: GitRunner;
	private readonly sections = new Map<string, SidePanelSection & { component: SidePanelSectionComponent }>();
	private panel: SidePanel | undefined;
	private handle: OverlayHandle | undefined;
	private reservation: TranscriptReservation | undefined;
	private snapshot: ChangesSnapshot | undefined;
	/** The repository state the session started from, being captured or captured. */
	private baseline: Promise<SessionBaseline> | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private isPumping = false;
	private isChangesRequested = false;
	private isDiffRequested = false;
	private pendingDiffs: ChangedFile[] = [];
	private requestedWidth: number | undefined;
	/** The git step in flight, so close() and a new file selection can stop it. */
	private step: { kind: "changes" | "diff"; abort: AbortController } | undefined;

	constructor(host: SidePanelHost, run: GitRunner = runGit) {
		this.host = host;
		this.runGit = run;
	}

	get isOpen(): boolean {
		return this.panel !== undefined;
	}

	toggle(): void {
		if (this.isOpen) this.close();
		else this.open();
	}

	open(): void {
		if (this.panel) return;
		const ui = this.host.ui;
		if (sidePanelWidthFor(ui.terminal.columns) === 0) {
			this.host.showStatus(`The side panel needs a terminal at least ${sidePanelMinColumns} columns wide`);
			return;
		}
		const getWidth = () => sidePanelWidthFor(ui.terminal.columns, this.requestedWidth);
		const reservation = this.host.reserveTranscriptColumns(getWidth);
		const panel = new SidePanel({
			getHeight: () => reservation.getRows(),
			getCloseHint: () => this.host.getCloseHint(),
			resize: (screenX) => {
				this.requestedWidth = sidePanelWidthFor(ui.terminal.columns, ui.terminal.columns - screenX);
				ui.requestRender();
			},
		});
		panel.setSections([...this.sections.values()]);
		this.reservation = reservation;
		this.panel = panel;
		this.handle = ui.showOverlay(panel, createOverlayOptions(getWidth, reservation));
		ui.requestRender();
		this.requestChanges();
	}

	close(): void {
		if (!this.panel) return;
		clearTimeout(this.refreshTimer);
		this.step?.abort.abort();
		this.isChangesRequested = false;
		this.isDiffRequested = false;
		this.pendingDiffs = [];
		this.panel = undefined;
		this.snapshot = undefined;
		this.handle?.hide();
		this.handle = undefined;
		this.reservation?.release();
		this.reservation = undefined;
		this.host.ui.requestRender();
	}

	/** Close the panel before a renderer swap. The returned function opens it again on the new renderer. */
	suspend(): () => void {
		if (!this.panel) return () => {};
		this.close();
		return () => this.open();
	}

	/** Add, replace or remove a section. A section is created once, here, and disposed when replaced or removed. */
	setSection(key: string, factory: SidePanelSectionFactory | undefined, order = 0): void {
		this.sections.get(key)?.component.dispose?.();
		this.sections.delete(key);
		if (factory) this.sections.set(key, { key, order, component: factory(this.host.ui, theme) });
		this.refreshSections();
	}

	clearSections(): void {
		for (const section of this.sections.values()) section.component.dispose?.();
		this.sections.clear();
		this.refreshSections();
	}

	/**
	 * Capture the repository state that a new session starts from, in the background. The panel shows the changes since.
	 * Call it when a session becomes active, at startup and on every session switch.
	 */
	beginSession(): void {
		this.baseline = captureBaseline(this.host.getCwd(), this.runGit);
		this.scheduleRefresh();
	}

	/** Reload the changes soon, merging bursts of calls. Does nothing while the panel is closed. */
	scheduleRefresh(): void {
		if (!this.panel) return;
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => this.requestChanges(), refreshDebounceMs);
	}

	/** Reload the changes after agent events that may have touched the working tree. */
	handleAgentEvent(eventType: string): void {
		if (this.panel && refreshEventTypes.has(eventType)) this.scheduleRefresh();
	}

	selectFile(delta: number): void {
		if (!this.panel?.selectFile(delta)) return;
		this.host.ui.requestRender();
	}

	scrollDiffPage(direction: 1 | -1): void {
		if (!this.panel) return;
		this.panel.scrollDiffPage(direction);
		this.host.ui.requestRender();
	}

	/** A closed panel renders nothing, so a section change only needs a render while it is open. */
	private refreshSections(): void {
		if (!this.panel) return;
		this.panel.setSections([...this.sections.values()]);
		this.host.ui.requestRender();
	}

	private requestChanges(): void {
		this.isChangesRequested = true;
		if (this.step?.kind === "diff") this.step.abort.abort();
		void this.pump();
	}

	/** Runs the requested git work one step at a time, so at most one step is in flight. Requests merge. */
	private async pump(): Promise<void> {
		if (this.isPumping) return;
		this.isPumping = true;
		try {
			while (this.panel && (this.isChangesRequested || this.isDiffRequested)) {
				if (this.isChangesRequested) {
					this.isChangesRequested = false;
					await this.loadChangesOnce();
				} else {
					this.isDiffRequested = false;
					await this.loadDiffOnce();
				}
			}
		} finally {
			this.isPumping = false;
		}
	}

	private async loadChangesOnce(): Promise<void> {
		const panel = this.panel;
		if (!panel) return;
		const load = new AbortController();
		this.step = { kind: "changes", abort: load };
		// A panel opened before the baseline is captured waits for it.
		this.baseline ??= captureBaseline(this.host.getCwd(), this.runGit);
		const snapshot = await loadChanges(await this.baseline, load.signal, this.runGit);
		if (this.step?.abort === load) this.step = undefined;
		// close() aborted this load, or the panel was closed and opened again: drop the result.
		if (snapshot === undefined || load.signal.aborted || this.panel !== panel) return;
		panel.setChanges(snapshot);
		this.snapshot = snapshot;
		this.pendingDiffs = snapshot.status === "ready" ? [...snapshot.files] : [];
		this.host.ui.requestRender();
		this.isDiffRequested = this.pendingDiffs.length > 0;
	}

	private async loadDiffOnce(): Promise<void> {
		const panel = this.panel;
		const snapshot = this.snapshot;
		if (!panel || snapshot?.status !== "ready") return;
		const selectedPath = panel.getSelectedFile()?.path;
		const index = Math.max(
			0,
			this.pendingDiffs.findIndex((file) => file.path === selectedPath),
		);
		const [file] = this.pendingDiffs.splice(index, 1);
		if (!file) return;
		this.isDiffRequested = this.pendingDiffs.length > 0;
		const load = new AbortController();
		this.step = { kind: "diff", abort: load };
		const diff = await loadFileDiff(snapshot, file, load.signal, this.runGit);
		if (this.step?.abort === load) this.step = undefined;
		if (diff === undefined || load.signal.aborted || this.panel !== panel || this.snapshot !== snapshot) return;
		panel.setDiff(file.path, diff);
		this.host.ui.requestRender();
	}
}

/** Top-right overlay over the transcript area only, which keeps the input box focused. */
function createOverlayOptions(getWidth: () => number, reservation: TranscriptReservation): OverlayOptions {
	return {
		anchor: "top-right",
		// The TUI reads the options on every render, so getters follow terminal resizes and the dock's height.
		get width() {
			return getWidth();
		},
		get maxHeight() {
			return reservation.getRows();
		},
		nonCapturing: true,
		visible: () => getWidth() > 0 && reservation.getRows() > 0,
	};
}
