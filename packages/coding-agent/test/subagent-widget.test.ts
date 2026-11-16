import { stripVTControlCharacters } from "node:util";
import { setKeybindings, type TUI, TuiAltScreen, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { emptyUsage } from "../src/extensions/subagent/runner.ts";
import type { WorkerView } from "../src/extensions/subagent/team.ts";
import { hasHiddenWorkers, SubagentSection, SubagentWidget, WorkerSpinner } from "../src/extensions/subagent/widget.ts";
import { workerColorAt } from "../src/extensions/subagent/worker-color.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => setKeybindings(new KeybindingsManager()));

function createWorkers(count: number): WorkerView[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `worker-${index + 1}`,
		color: workerColorAt(index),
		name: `agent${index + 1}`,
		task: "Locate renderer",
		status: "completed",
		agentType: "explorer",
		inboxCount: 0,
		assignmentCount: 0,
		usage: emptyUsage(),
		elapsedMs: 0,
		runs: [],
	}));
}

function createWidget(count: number, tui: TUI = new TuiMainScreen(new VirtualTerminal())) {
	setKeybindings(new KeybindingsManager());
	let workers = createWorkers(count);
	const editor = { focused: false, render: () => [], invalidate: () => {}, handleInput: vi.fn() };
	tui.setFocus(editor);
	let update = () => {};
	const openSession = vi.fn();
	const widget = new SubagentWidget(
		{
			getViews: () => workers,
			subscribe: (listener) => {
				update = listener;
				return () => {};
			},
		},
		tui,
		theme,
		openSession,
		new WorkerSpinner(tui, theme),
	);
	const activate = () =>
		widget.activate((data) => {
			tui.setFocus(editor);
			if (data !== undefined) editor.handleInput(data);
		});
	return {
		widget,
		editor,
		openSession,
		activate,
		clearWorkers: () => {
			workers = [];
			update();
		},
	};
}

describe("inline subagent selection", () => {
	it("navigates all workers in place, including hidden idle rows, and opens only on Enter", () => {
		const { widget, editor, openSession, activate } = createWidget(8);
		try {
			const idleRow = widget.render(80).map(stripVTControlCharacters)[1];
			expect(idleRow.startsWith("◯ agent1")).toBe(true);
			expect(idleRow.indexOf("agent1")).toBe(widget.render(80).map(stripVTControlCharacters)[0].indexOf("main"));
			activate();
			expect(editor.focused).toBe(false);
			expect(widget.render(80).map(stripVTControlCharacters)[0].startsWith("› main")).toBe(true);
			expect(widget.render(80)[0].startsWith("\x1b[7m› main")).toBe(true);
			widget.handleInput("\x1b[B");
			expect(widget.render(80)[0]).not.toContain("\x1b[7m");
			expect(widget.render(80)[1].startsWith("\x1b[7m› agent1")).toBe(true);
			expect(widget.render(80).map(stripVTControlCharacters)[0].startsWith("● main")).toBe(true);
			expect(widget.render(80).map(stripVTControlCharacters)[1]).toBe(idleRow.replace("◯", "›"));
			for (let index = 2; index <= 8; index++) {
				widget.handleInput("\x1b[B");
				const lines = widget.render(80).map(stripVTControlCharacters);
				expect(lines.some((line) => line.startsWith(`› agent${index}`))).toBe(true);
				expect(lines.length).toBeLessThanOrEqual(6);
			}
			expect(openSession).not.toHaveBeenCalled();
			widget.handleInput("\x1b[B");
			widget.handleInput("\x1b[A");
			widget.handleInput("\r");
			expect(openSession).toHaveBeenCalledExactlyOnceWith("worker-7");
			expect(editor.focused).toBe(true);
			expect(widget.focused).toBe(false);
		} finally {
			widget.dispose();
		}
	});

	it("returns to the prompt on Up, Escape, main confirmation, typing, or team removal", () => {
		const { widget, editor, openSession, activate, clearWorkers } = createWidget(1);
		try {
			for (const key of ["\x1b[A", "\x1b", "\r"]) {
				activate();
				widget.handleInput(key);
				expect(editor.focused).toBe(true);
				expect(widget.focused).toBe(false);
			}
			expect(editor.handleInput).not.toHaveBeenCalled();
			// Confirming main switches the main view back to the main session.
			expect(openSession).toHaveBeenCalledExactlyOnceWith(undefined);
			openSession.mockClear();
			activate();
			widget.handleInput("\x1b[B");
			widget.handleInput("h");
			expect(editor.focused).toBe(true);
			expect(editor.handleInput).toHaveBeenCalledExactlyOnceWith("h");
			expect(openSession).not.toHaveBeenCalled();

			setKeybindings(new KeybindingsManager({ "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+q" }));
			activate();
			widget.handleInput("\x0e");
			expect(widget.render(80).map(stripVTControlCharacters)[1].startsWith("› agent1")).toBe(true);
			widget.handleInput("\x11");
			expect(editor.focused).toBe(true);

			activate();
			clearWorkers();
			expect(editor.focused).toBe(true);
			expect(widget.render(80)).toEqual([]);
			activate();
			expect(editor.focused).toBe(true);
			expect(widget.focused).toBe(false);
		} finally {
			widget.dispose();
		}
	});

	it("opens a worker and returns to main through terminal mouse presses and releases", async () => {
		const terminal = new VirtualTerminal(100, 24);
		const tui = new TuiAltScreen(terminal);
		const { widget, openSession } = createWidget(2, tui);
		tui.setLayoutRoot(widget);
		tui.start();
		try {
			await terminal.waitForRender();
			const rows = terminal.getViewport();
			const mainRow = rows.findIndex((row) => row.includes("main"));
			const workerRow = rows.findIndex((row) => row.includes("agent1"));
			expect(mainRow).toBeGreaterThanOrEqual(0);
			expect(workerRow).toBeGreaterThan(mainRow);
			terminal.sendInput(`\x1b[<0;4;${workerRow + 1}M`);
			terminal.sendInput(`\x1b[<0;4;${workerRow + 1}m`);
			expect(openSession).toHaveBeenLastCalledWith("worker-1");
			terminal.sendInput(`\x1b[<0;4;${mainRow + 1}M`);
			terminal.sendInput(`\x1b[<0;4;${mainRow + 1}m`);
			expect(openSession).toHaveBeenLastCalledWith(undefined);
		} finally {
			widget.dispose();
			tui.stop();
		}
	});

	it("highlights and opens clicked agents, including main, and restores editor focus", () => {
		const { widget, editor, openSession, activate } = createWidget(3);
		const click = (row: number, type: "click" | "move" | "leave" = "click") =>
			widget.handleMouse({
				type,
				button: "left",
				x: 4,
				y: row,
				screenX: 4,
				screenY: row,
				width: 80,
				height: 4,
				shift: false,
				alt: false,
				ctrl: false,
			});
		try {
			widget.render(80);
			expect(click(1, "move")).toEqual({ handled: true, render: true });
			expect(widget.render(80)[1].startsWith("\x1b[7m◯ agent1")).toBe(true);
			expect(click(1, "move")).toEqual({ handled: true, render: false });
			expect(click(1, "leave")).toEqual({ handled: true, render: true });
			expect(widget.render(80)[1]).not.toContain("\x1b[7m");
			expect(click(0, "move")).toEqual({ handled: true, render: true });
			expect(widget.render(80)[0].startsWith("\x1b[7m● main")).toBe(true);
			expect(click(0)).toEqual({ handled: true });
			expect(openSession).toHaveBeenLastCalledWith(undefined);
			expect(click(0, "leave")).toEqual({ handled: true, render: true });
			expect(widget.render(80)[0]).not.toContain("\x1b[7m");
			expect(click(2)).toEqual({ handled: true });
			expect(openSession).toHaveBeenLastCalledWith("worker-2");
			activate();
			widget.render(80);
			click(3);
			expect(openSession).toHaveBeenLastCalledWith("worker-3");
			expect(editor.focused).toBe(true);
			expect(widget.focused).toBe(false);
			activate();
			widget.render(80);
			click(0);
			expect(openSession).toHaveBeenLastCalledWith(undefined);
			expect(editor.focused).toBe(true);
			expect(widget.focused).toBe(false);
		} finally {
			widget.dispose();
		}
	});
});

describe("worker colors", () => {
	it("renders each worker's name in its own color", () => {
		const { widget } = createWidget(2);
		try {
			const rows = widget.render(80);
			expect(rows[1]).toContain(theme.fg(workerColorAt(0), theme.bold("agent1")));
			expect(rows[2]).toContain(theme.fg(workerColorAt(1), theme.bold("agent2")));
			expect(workerColorAt(0)).not.toBe(workerColorAt(1));
		} finally {
			widget.dispose();
		}
	});
});

describe("hasHiddenWorkers", () => {
	it.each([
		{ workers: 3, rows: 24, hidden: false },
		{ workers: 4, rows: 24, hidden: true },
		// A short terminal shrinks the widget to two worker rows.
		{ workers: 2, rows: 8, hidden: false },
		{ workers: 3, rows: 8, hidden: true },
	])("is $hidden for $workers workers on $rows rows", ({ workers, rows, hidden }) => {
		expect(hasHiddenWorkers(workers, rows)).toBe(hidden);
	});

	it("agrees with the hidden count the collapsed widget prints", () => {
		for (const count of [1, 3, 4, 8]) {
			const { widget } = createWidget(count);
			try {
				const printsHidden = widget.render(80).some((line) => stripVTControlCharacters(line).includes("hidden"));
				expect(printsHidden).toBe(hasHiddenWorkers(count, 24));
			} finally {
				widget.dispose();
			}
		}
	});
});

describe("agents side panel section", () => {
	function createSection(initial: WorkerView[], terminalRows = 24) {
		let workers = initial;
		const tui = new TuiMainScreen(new VirtualTerminal(80, terminalRows));
		const spinner = new WorkerSpinner(tui, theme);
		const team = {
			count: vi.fn(() => workers.length),
			getViews: vi.fn(() => workers),
		};
		return {
			section: new SubagentSection(team, tui, theme, spinner),
			team,
			setWorkers: (next: WorkerView[]) => {
				workers = next;
			},
		};
	}

	it("renders nothing, without building views, while the widget below the input box shows every worker", () => {
		const { section, team } = createSection(createWorkers(3));
		expect(section.render(60)).toEqual([]);
		expect(team.count).toHaveBeenCalledOnce();
		expect(team.getViews).not.toHaveBeenCalled();
	});

	it("lists every worker under an Agents header once the widget has to hide some", () => {
		const { section } = createSection(createWorkers(8));
		const lines = section.render(80);
		expect(lines).toHaveLength(9);
		expect(stripVTControlCharacters(lines[0])).toMatch(/^Agents\s+8 total$/);
		for (let index = 0; index < 8; index++) {
			expect(lines[index + 1]).toContain(theme.fg(workerColorAt(index), theme.bold(`agent${index + 1}`)));
		}
	});

	it("uses the short terminal's smaller widget as the overflow rule", () => {
		const { section } = createSection(createWorkers(3), 8);
		expect(section.render(60)).toHaveLength(4);
	});

	it("truncates every row to the panel width", () => {
		const { section } = createSection(createWorkers(5));
		for (const width of [10, 24, 30, 40]) {
			for (const line of section.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("reads the team on every render", () => {
		const { section, setWorkers } = createSection(createWorkers(3));
		expect(section.render(60)).toEqual([]);
		setWorkers(createWorkers(5));
		expect(section.render(60)).toHaveLength(6);
		setWorkers([]);
		expect(section.render(60)).toEqual([]);
	});
});
