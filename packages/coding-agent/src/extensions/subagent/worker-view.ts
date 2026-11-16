// Shows one worker's transcript in place of the main chat and routes the input box to that worker.
import type { Message } from "@earendil-works/pi-ai";
import { type Component, Markdown, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import { ActivitySpinner, renderActivityRow } from "../../modes/interactive/components/activity-row.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { WorkerTeam, WorkerView } from "./team.ts";
import { formatWorkerStats } from "./widget.ts";
import { renderWorkerName } from "./worker-color.ts";

export type WorkerViewTeam = Pick<WorkerTeam, "continue" | "getViews" | "send" | "subscribe">;

/** Switches the main view to a worker's transcript; the input box then sends follow-ups to that worker. */
export function showWorkerView(ui: ExtensionUIContext, team: WorkerViewTeam, workerId: string): void {
	const worker = team.getViews().find((view) => view.id === workerId);
	ui.setMainView({
		label: worker?.name ?? workerId,
		color: worker?.color,
		component: (tui, theme) => new WorkerTranscript(tui, theme, team, workerId),
		onSubmit: (text) => void sendToWorker(ui, team, workerId, text),
	});
}

async function sendToWorker(ui: ExtensionUIContext, team: WorkerViewTeam, workerId: string, prompt: string) {
	const worker = team.getViews().find((view) => view.id === workerId);
	if (!worker) return ui.notify(`Worker ${workerId} no longer exists.`, "warning");
	if (worker.status === "cancelled") return ui.notify(`${worker.name} has been cancelled.`, "warning");
	try {
		const result =
			worker.status === "interrupted" ? await team.continue(workerId, prompt) : await team.send(workerId, prompt);
		if (result === "cancelled" || result === "already_active")
			ui.notify(`${worker.name}: message not sent (${result})`, "warning");
	} catch (error) {
		ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

/** A worker's header, stats and full transcript, rendered at the transcript's width and updated live. */
export class WorkerTranscript implements Component {
	private readonly theme: Theme;
	private readonly team: WorkerViewTeam;
	private readonly workerId: string;
	private readonly spinner: ActivitySpinner;
	private readonly unsubscribe: () => void;
	private transcript?: { width: number; lines: string[] };
	private isRunning = false;

	constructor(tui: TUI, theme: Theme, team: WorkerViewTeam, workerId: string) {
		this.theme = theme;
		this.team = team;
		this.workerId = workerId;
		this.spinner = new ActivitySpinner(
			tui,
			(text) => theme.fg("accent", text),
			(text) => text,
			"",
		);
		this.spinner.stop();
		this.unsubscribe = team.subscribe(() => {
			this.transcript = undefined;
			this.updateSpinner();
			tui.requestRender();
		});
		this.updateSpinner();
	}

	render(width: number): string[] {
		const worker = this.team.getViews().find((view) => view.id === this.workerId);
		if (!worker) return ["", this.theme.fg("muted", `Worker ${this.workerId} no longer exists.`)];
		const icon = worker.status === "running" ? this.spinner.render(1)[0] : this.theme.fg("muted", "◯");
		const back = keyText("app.interrupt");
		return [
			"",
			renderActivityRow(width, `${icon} ${renderWorkerName(worker, this.theme)}`, this.theme.fg("dim", worker.id)),
			...wrapTextWithAnsi(this.theme.fg("muted", formatWorkerStats(worker)), width),
			this.theme.fg(
				"dim",
				`Messages you send go to this worker${back ? ` · ${back} returns to main` : ""} · /commands still run in main`,
			),
			this.theme.fg("border", "─".repeat(width)),
			...this.renderTranscript(worker, width),
		];
	}

	invalidate(): void {
		this.transcript = undefined;
		this.spinner.invalidate();
	}

	dispose(): void {
		this.unsubscribe();
		this.spinner.stop();
	}

	private updateSpinner(): void {
		const running = this.team.getViews().find((view) => view.id === this.workerId)?.status === "running";
		if (running === this.isRunning) return;
		this.isRunning = running;
		if (running) this.spinner.start();
		else this.spinner.stop();
	}

	private renderTranscript(worker: WorkerView, width: number): string[] {
		if (this.transcript?.width === width) return this.transcript.lines;
		const lines: string[] = [];
		for (let index = 0; index < worker.runs.length; index++) {
			const run = worker.runs[index];
			if (lines.length > 0) lines.push("");
			const color = run.status === "failed" || run.status === "aborted" ? "error" : "accent";
			lines.push(this.theme.fg(color, `── Run ${index + 1} • ${run.status} ──`));
			if (!run.messages.some((message) => message.role === "user")) {
				lines.push(this.theme.fg("accent", "Task"));
				this.addMarkdown(lines, run.task, width);
			}
			for (const message of run.messages) this.renderMessage(lines, message, width);
			if (run.errorMessage)
				this.addMarkdown(lines, run.errorMessage, width, { color: (text) => this.theme.fg("error", text) });
			if (run.terminationSignal) lines.push(this.theme.fg("error", `Signal: ${run.terminationSignal}`));
			if (run.stderr.trim())
				this.addMarkdown(lines, run.stderr, width, { color: (text) => this.theme.fg("error", text) });
		}
		if (!lines.length) lines.push(this.theme.fg("muted", "No worker messages yet."));
		this.transcript = { width, lines };
		return lines;
	}

	private renderMessage(lines: string[], message: Message, width: number): void {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "[Image attached]")).join("\n");
			lines.push(this.theme.fg("accent", "User"));
			this.addMarkdown(lines, text, width);
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text" && part.text.trim()) {
					lines.push(this.theme.fg("success", "Assistant"));
					this.addMarkdown(lines, part.text, width);
				} else if (part.type === "thinking" && part.thinking.trim()) {
					lines.push(this.theme.fg("thinkingText", "Thinking"));
					this.addMarkdown(lines, part.thinking, width, {
						color: (text) => this.theme.fg("thinkingText", text),
						italic: true,
					});
				} else if (part.type === "toolCall") {
					lines.push(this.theme.fg("muted", `→ ${part.name}`));
					this.addMarkdown(lines, `\`\`\`json\n${JSON.stringify(part.arguments, null, 2)}\n\`\`\``, width);
				}
			}
		} else if (message.role === "toolResult") {
			lines.push(this.theme.fg(message.isError ? "error" : "toolOutput", `← ${message.toolName}`));
			const text = message.content.map((part) => (part.type === "text" ? part.text : "[Image result]")).join("\n");
			this.addMarkdown(lines, text, width);
		}
	}

	private addMarkdown(
		lines: string[],
		text: string,
		width: number,
		style?: { color?: (text: string) => string; italic?: boolean },
	): void {
		lines.push(...new Markdown(text.trim(), 0, 0, getMarkdownTheme(), style).render(width));
	}
}
