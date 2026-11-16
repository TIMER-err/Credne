import { type Component, type Focusable, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { ActivitySpinner, renderActivityRow } from "../../modes/interactive/components/activity-row.ts";
import { formatKeyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { WorkerTeam, WorkerView } from "./team.ts";
import { highlightRow, renderWorkerRow } from "./widget.ts";

type SessionPanelTeam = Pick<WorkerTeam, "getViews" | "subscribe">;

/** What the picker chose: the main session, a worker to show in the main view, or nothing. */
export type SessionPanelResult = { kind: "main" } | { kind: "worker"; workerId: string } | { kind: "closed" };

/** Picker over the main session and every worker; the chosen session is shown in the main view. */
export class SubagentSessionPanel implements Component, Focusable {
	focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: SessionPanelResult) => void;
	private readonly spinner: ActivitySpinner;
	private readonly unsubscribe: () => void;
	private views: WorkerView[];
	private selectedIndex = 0;
	private listRows = 1;
	private disposed = false;
	private isRunning = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		team: SessionPanelTeam,
		done: (result: SessionPanelResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.views = team.getViews();
		this.spinner = new ActivitySpinner(
			tui,
			(text) => theme.fg("accent", text),
			(text) => text,
			"",
		);
		this.spinner.stop();
		this.unsubscribe = team.subscribe(() => this.updateViews(team.getViews()));
		this.updateViews(this.views);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const maxLines = Math.max(1, Math.floor(this.tui.terminal.rows * 0.9));
		const title = this.theme.bold(this.theme.fg("accent", "Subagent sessions"));
		const lines = maxLines >= 6 ? [this.border(width), title, this.border(width)] : [title];
		const footer = [
			this.theme.fg(
				"muted",
				`${this.keys("tui.select.up")}/${this.keys("tui.select.down")} navigate • ${this.keys("tui.select.confirm")} view • ${this.keys("tui.select.cancel")} close`,
			),
		];
		if (maxLines >= 6) footer.push(this.border(width));
		this.listRows = Math.max(1, maxLines - lines.length - footer.length);
		const itemCount = this.views.length + 1;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.listRows / 2), itemCount - this.listRows),
		);
		const end = Math.min(start + this.listRows, itemCount);
		for (let index = start; index < end; index++) {
			const selected = index === this.selectedIndex;
			const selectionIcon = selected ? this.theme.fg("accent", "›") : undefined;
			const line =
				index === 0
					? renderActivityRow(
							width,
							`${selectionIcon ?? "●"} ${this.theme.bold("main")}`,
							this.theme.fg("muted", "current session"),
						)
					: renderWorkerRow(this.views[index - 1], width, this.theme, this.spinner.render(1)[0], selectionIcon);
			lines.push(selected ? highlightRow(line, width) : line);
		}
		return [...lines, ...footer].slice(0, maxLines).map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		const matches = (binding: Keybinding) => this.keybindings.matches(data, binding);
		if (matches("tui.select.cancel")) {
			this.done({ kind: "closed" });
			return;
		}
		if (matches("tui.select.confirm")) {
			const worker = this.views[this.selectedIndex - 1];
			this.done(worker ? { kind: "worker", workerId: worker.id } : { kind: "main" });
			return;
		}
		if (matches("tui.select.up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		else if (matches("tui.select.down")) this.selectedIndex = Math.min(this.views.length, this.selectedIndex + 1);
		else if (matches("tui.select.pageUp")) this.selectedIndex = Math.max(0, this.selectedIndex - this.listRows);
		else if (matches("tui.select.pageDown"))
			this.selectedIndex = Math.min(this.views.length, this.selectedIndex + this.listRows);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.spinner.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		this.spinner.stop();
	}

	private updateViews(views: WorkerView[]): void {
		if (this.disposed) return;
		this.views = views;
		this.selectedIndex = Math.min(this.selectedIndex, views.length);
		const running = views.some((view) => view.status === "running");
		if (running !== this.isRunning) {
			this.isRunning = running;
			if (running) this.spinner.start();
			else this.spinner.stop();
		}
		this.tui.requestRender();
	}

	private border(width: number): string {
		return this.theme.fg("border", "─".repeat(width));
	}

	private keys(binding: Keybinding): string {
		return formatKeyText(this.keybindings.getKeys(binding).join("/"));
	}
}
