// The task list above the input box and the Tasks section of the side panel.
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { ActivitySpinner, renderActivityRow } from "../../modes/interactive/components/activity-row.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ThemeColor } from "../../modes/interactive/theme/theme-tokens.ts";
import type { WorkerIdentity } from "../subagent/team.ts";
import type { Plan, Task } from "./graph.ts";

/**
 * Creates the spinner on first use, so the widget and the section animate from one timer. Exactly one
 * of them is visible at a time (the panel replaces the widget), so one running spinner serves both.
 * It is stopped when the plan has no running task.
 */
export function sharedTaskSpinner(plan: Plan): (tui: TUI, theme: Theme) => ActivitySpinner {
	let spinner: ActivitySpinner | undefined;
	return (tui, theme) => {
		if (spinner) return spinner;
		spinner = new ActivitySpinner(
			tui,
			(text) => theme.fg("accent", text),
			(text) => text,
			"",
		);
		if (!plan.tasks.some((task) => task.state.status === "running")) spinner.stop();
		return spinner;
	};
}

export class PlanningWidget implements Component {
	private readonly plan: Plan;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly spinner: ActivitySpinner;
	/** Read at render time: the side panel lists every task, so the widget steps aside while it is open. */
	private readonly isSidePanelOpen: () => boolean;

	/** The widget stops the spinner when disposed; the section only reads its frames. */
	constructor(plan: Plan, tui: TUI, theme: Theme, spinner: ActivitySpinner, isSidePanelOpen: () => boolean) {
		this.plan = plan;
		this.tui = tui;
		this.theme = theme;
		this.spinner = spinner;
		this.isSidePanelOpen = isSidePanelOpen;
	}

	render(width: number): string[] {
		if (this.isSidePanelOpen()) return [];
		const theme = this.theme;
		const plan = this.plan;
		const tasks = visibleTasks(plan);
		const done = tasks.filter((task) => task.state.status === "done").length;
		const running = tasks.filter((task) => task.state.status === "running").length;
		const queued = tasks.filter((task) => task.state.status === "queued").length;
		const summary = [`${done}/${tasks.length} done`];
		if (running) summary.push(`${running} running`);
		if (queued) summary.push(`${queued} queued`);
		summary.push(`rev ${plan.revision}`);
		const lines = [renderActivityRow(width, renderTasksTitle(plan, theme), theme.fg("muted", summary.join(" • ")))];
		const maxRows = Math.max(3, Math.min(10, Math.floor(this.tui.terminal.rows / 4)));
		const needsSummary = tasks.length > maxRows - 1;
		const priority = { running: 0, queued: 1, pending: 2, failed: 2, done: 3, superseded: 4 };
		const displayed = new Set(
			[...tasks]
				.sort((left, right) => priority[left.state.status] - priority[right.state.status])
				.slice(0, maxRows - 1 - Number(needsSummary))
				.map((task) => task.spec.id),
		);
		for (const task of tasks) {
			if (!displayed.has(task.spec.id)) continue;
			const { spec, state } = task;
			lines.push(
				renderActivityRow(
					width,
					renderTaskLabel(task, theme, this.spinner),
					theme.fg(taskStatusColor(task), `${state.status} • ${spec.id} • order ${spec.order}`),
				),
			);
		}
		const hidden = tasks.length - displayed.size;
		if (hidden)
			lines.push(truncateToWidth(theme.fg("muted", `… ${hidden} more task${hidden === 1 ? "" : "s"}`), width));
		return lines;
	}

	invalidate(): void {
		this.spinner.invalidate();
	}

	dispose(): void {
		this.spinner.stop();
	}
}

/**
 * Every task of the plan, each with the subagent it is assigned to. It has no timer or subscription:
 * the plan is replaced as a whole on every change, and the widget's spinner supplies the frames.
 */
export class PlanningSection implements Component {
	private readonly plan: Plan;
	private readonly theme: Theme;
	private readonly spinner: ActivitySpinner;
	private readonly workerOf: (taskId: string) => WorkerIdentity | undefined;

	constructor(
		plan: Plan,
		theme: Theme,
		spinner: ActivitySpinner,
		workerOf: (taskId: string) => WorkerIdentity | undefined,
	) {
		this.plan = plan;
		this.theme = theme;
		this.spinner = spinner;
		this.workerOf = workerOf;
	}

	render(width: number): string[] {
		const plan = this.plan;
		const theme = this.theme;
		const tasks = visibleTasks(plan);
		const done = tasks.filter((task) => task.state.status === "done").length;
		return [
			renderActivityRow(width, renderTasksTitle(plan, theme), theme.fg("muted", `${done}/${tasks.length} done`)),
			...tasks.map((task) => {
				const worker = this.workerOf(task.spec.id);
				return renderActivityRow(
					width,
					renderTaskLabel(task, theme, this.spinner),
					worker ? renderWorkerTag(worker, theme) : "",
				);
			}),
		];
	}

	invalidate(): void {}
}

/** The tasks of the current revision; superseded ones stay in the plan only as history. */
function visibleTasks(plan: Plan): Task[] {
	return plan.tasks.filter((task) => task.state.status !== "superseded");
}

/** "Tasks" and the objective: the left side of both headers. */
function renderTasksTitle(plan: Plan, theme: Theme): string {
	return `${theme.bold("Tasks")}  ${theme.fg("muted", plan.objective.replace(/\s+/g, " "))}`;
}

function taskStatusColor(task: Task): ThemeColor {
	if (task.state.status === "failed") return "error";
	return task.state.status === "done" ? "success" : "muted";
}

/** A task's status icon (a spinner frame while running) and bold name. */
function renderTaskLabel(task: Task, theme: Theme, spinner: ActivitySpinner): string {
	const { status } = task.state;
	const symbol = status === "done" ? "✓" : status === "failed" ? "×" : "☐";
	const icon = status === "running" ? spinner.render(1)[0] : theme.fg(taskStatusColor(task), symbol);
	return `${icon} ${theme.bold(task.spec.name.replace(/\s+/g, " "))}`;
}

/** The assigned subagent: a dot and its name in its color, then its short id. */
function renderWorkerTag(worker: WorkerIdentity, theme: Theme): string {
	return `${theme.fg(worker.color, `● ${worker.name}`)} ${theme.fg("muted", worker.id.slice(0, 8))}`;
}
