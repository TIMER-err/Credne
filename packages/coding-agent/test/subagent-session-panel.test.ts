import { stripVTControlCharacters } from "node:util";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { emptyUsage } from "../src/extensions/subagent/runner.ts";
import { SubagentSessionPanel } from "../src/extensions/subagent/session-panel.ts";
import type { WorkerView } from "../src/extensions/subagent/team.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("subagent session selection layout", () => {
	it.each<WorkerView["status"]>(["completed", "running", "failed"])(
		"replaces the %s icon without shifting the row",
		(status) => {
			const worker: WorkerView = {
				id: "worker-1",
				color: "syntaxKeyword",
				name: "explorer",
				task: "Locate renderer",
				status,
				agentType: "explorer",
				inboxCount: 0,
				assignmentCount: 0,
				usage: emptyUsage(),
				elapsedMs: 0,
				runs: [],
			};
			const panel = new SubagentSessionPanel(
				new TuiMainScreen(new VirtualTerminal()),
				theme,
				new KeybindingsManager(),
				{
					getViews: () => [worker],
					subscribe: () => () => {},
				},
				vi.fn(),
			);
			try {
				for (const width of [20, 80]) {
					const before = panel.render(width).map(stripVTControlCharacters);
					expect(before[3].startsWith("› main")).toBe(true);
					expect(before[4].indexOf("explorer")).toBe(before[3].indexOf("main"));
					panel.handleInput("\x1b[B");
					const selected = panel.render(width).map(stripVTControlCharacters);
					expect(selected[3].trimEnd()).toBe(before[3].replace("›", "●").trimEnd());
					expect(selected[4].trimEnd()).toBe(`›${before[4].slice(1)}`.trimEnd());
					panel.handleInput("\x1b[A");
					expect(panel.render(width).map(stripVTControlCharacters)).toEqual(before);
				}
			} finally {
				panel.dispose();
			}
		},
	);

	it("returns the chosen session so it can be shown in the main view", () => {
		const done = vi.fn();
		const panel = new SubagentSessionPanel(
			new TuiMainScreen(new VirtualTerminal()),
			theme,
			new KeybindingsManager(),
			{
				getViews: () => [
					{
						id: "worker-1",
						color: "syntaxKeyword",
						name: "explorer",
						task: "Locate renderer",
						status: "completed",
						agentType: "explorer",
						inboxCount: 0,
						assignmentCount: 0,
						usage: emptyUsage(),
						elapsedMs: 0,
						runs: [],
					},
				],
				subscribe: () => () => {},
			},
			done,
		);
		try {
			panel.handleInput("\r");
			expect(done).toHaveBeenLastCalledWith({ kind: "main" });
			panel.handleInput("\x1b[B");
			panel.handleInput("\r");
			expect(done).toHaveBeenLastCalledWith({ kind: "worker", workerId: "worker-1" });
			panel.handleInput("\x1b");
			expect(done).toHaveBeenLastCalledWith({ kind: "closed" });
		} finally {
			panel.dispose();
		}
	});
});
