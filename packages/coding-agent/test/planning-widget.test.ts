import { stripVTControlCharacters } from "node:util";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createPlan, type Plan } from "../src/extensions/planning/graph.ts";
import { PlanningSection, PlanningWidget, sharedTaskSpinner } from "../src/extensions/planning/widget.ts";
import type { WorkerIdentity } from "../src/extensions/subagent/team.ts";
import { workerColorAt } from "../src/extensions/subagent/worker-color.ts";
import type { ActivitySpinner } from "../src/modes/interactive/components/activity-row.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const spinners: ActivitySpinner[] = [];

afterEach(() => {
	for (const spinner of spinners.splice(0)) spinner.stop();
	vi.useRealTimers();
});

type WorkerLookup = (taskId: string) => WorkerIdentity | undefined;

function createIdentity(id: string, name: string, spawnIndex: number): WorkerIdentity {
	return { id, name, color: workerColorAt(spawnIndex) };
}

/** A plan with a done, a running, a failed, a pending and a superseded task, in that order. */
function createMixedPlan(): Plan {
	const plan = createPlan(
		"Ship   the\nparser",
		["Fix parser", "Write tests", "Handle errors", "Update docs", "Old idea"].map((name, index) => ({
			name,
			description: name,
			order: index + 1,
		})),
		"Initial plan",
	);
	plan.tasks[0].state = { status: "done", output: "fixed" };
	plan.tasks[1].state = { status: "running" };
	plan.tasks[2].state = { status: "failed", error: "boom" };
	plan.tasks[4].state = { status: "superseded", reason: "replaced" };
	return plan;
}

function createLongPlan(count: number): Plan {
	return createPlan(
		"Many tasks",
		Array.from({ length: count }, (_, index) => ({
			name: `Task number ${index + 1}`,
			description: "Do it",
			order: index + 1,
		})),
		"Initial plan",
	);
}

function createSpinner(plan: Plan, tui: TuiMainScreen): ActivitySpinner {
	const spinner = sharedTaskSpinner(plan)(tui, theme);
	spinners.push(spinner);
	return spinner;
}

function createSection(plan: Plan, workerOf: WorkerLookup = () => undefined): PlanningSection {
	return new PlanningSection(plan, theme, createSpinner(plan, new TuiMainScreen(new VirtualTerminal())), workerOf);
}

function createWidget(plan: Plan, isSidePanelOpen: () => boolean): PlanningWidget {
	const tui = new TuiMainScreen(new VirtualTerminal());
	return new PlanningWidget(plan, tui, theme, createSpinner(plan, tui), isSidePanelOpen);
}

describe("planning side panel section", () => {
	it("shows the objective, a done count and one row per current task", () => {
		const lines = createSection(createMixedPlan()).render(80).map(stripVTControlCharacters);
		expect(lines[0]).toMatch(/^Tasks {2}Ship the parser\s+1\/4 done$/);
		expect(lines).toHaveLength(5);
		expect(lines[1]).toBe("✓ Fix parser");
		expect(lines[3]).toBe("× Handle errors");
		expect(lines[4]).toBe("☐ Update docs");
		expect(lines.join("\n")).not.toContain("Old idea");
	});

	it("names the assigned subagent in its own color with a muted short id", () => {
		const worker = createIdentity("0a1b2c3d-4e5f-6789-abcd-ef0123456789", "explorer", 2);
		const lines = createSection(createMixedPlan(), (taskId) => (taskId === "2" ? worker : undefined)).render(80);
		expect(lines[2]).toContain(theme.fg(workerColorAt(2), "● explorer"));
		expect(lines[2]).toContain(theme.fg("muted", "0a1b2c3d"));
		expect(stripVTControlCharacters(lines[2])).toMatch(/^.+ Write tests\s+● explorer 0a1b2c3d$/);
		expect(lines.filter((line) => line.includes("●"))).toHaveLength(1);
	});

	it("gives different workers their own colors", () => {
		const workers = new Map([
			["1", createIdentity("worker-a", "alpha", 0)],
			["2", createIdentity("worker-b", "beta", 1)],
		]);
		const lines = createSection(createMixedPlan(), (taskId) => workers.get(taskId)).render(80);
		expect(lines[1]).toContain(theme.fg(workerColorAt(0), "● alpha"));
		expect(lines[2]).toContain(theme.fg(workerColorAt(1), "● beta"));
		expect(workerColorAt(0)).not.toBe(workerColorAt(1));
	});

	it("lists every task without a row cap", () => {
		expect(createSection(createLongPlan(30)).render(80)).toHaveLength(31);
	});

	it("truncates every row to the panel width", () => {
		const plan = createMixedPlan();
		plan.tasks[0].spec.name = "A very long task name that cannot fit in a narrow side panel";
		const section = createSection(plan, (taskId) => createIdentity(`id-${taskId}-long`, "a-long-worker-name", 0));
		for (const width of [1, 10, 23, 24, 30, 40, 80]) {
			for (const line of section.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("looks workers up per task on every render", () => {
		const workerOf = vi.fn<WorkerLookup>(() => undefined);
		const section = createSection(createMixedPlan(), workerOf);
		section.render(80);
		section.render(80);
		// Four current tasks, two renders.
		expect(workerOf).toHaveBeenCalledTimes(8);
	});
});

describe("planning widget above the input box", () => {
	it("renders nothing while the side panel is open and the compact list otherwise", () => {
		let isOpen = true;
		const widget = createWidget(createMixedPlan(), () => isOpen);
		expect(widget.render(80)).toEqual([]);
		isOpen = false;
		const lines = widget.render(80).map(stripVTControlCharacters);
		expect(lines[0]).toMatch(/^Tasks {2}Ship the parser\s+1\/4 done • 1 running • rev 1$/);
		expect(lines.some((line) => line.startsWith("✓ Fix parser"))).toBe(true);
		isOpen = true;
		expect(widget.render(80)).toEqual([]);
	});

	it("keeps its row cap so the panel is the place for the full list", () => {
		const lines = createWidget(createLongPlan(30), () => false)
			.render(80)
			.map(stripVTControlCharacters);
		expect(lines.length).toBeLessThan(31);
		expect(lines.at(-1)).toMatch(/^… \d+ more tasks$/);
	});

	it("stops the shared spinner when disposed", () => {
		vi.useFakeTimers();
		const plan = createMixedPlan();
		const widget = createWidget(plan, () => false);
		expect(vi.getTimerCount()).toBe(1);
		widget.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("shared task spinner", () => {
	it("is one timer for the widget and the section, and none without a running task", () => {
		vi.useFakeTimers();
		const tui = new TuiMainScreen(new VirtualTerminal());
		const running = sharedTaskSpinner(createMixedPlan());
		const first = running(tui, theme);
		const second = running(tui, theme);
		spinners.push(first);
		expect(second).toBe(first);
		expect(vi.getTimerCount()).toBe(1);
		first.stop();
		expect(vi.getTimerCount()).toBe(0);
		const idle = sharedTaskSpinner(createLongPlan(3))(tui, theme);
		spinners.push(idle);
		expect(vi.getTimerCount()).toBe(0);
	});
});
