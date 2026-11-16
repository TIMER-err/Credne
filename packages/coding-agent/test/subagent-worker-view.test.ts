import { stripVTControlCharacters } from "node:util";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionMainView, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { emptyUsage } from "../src/extensions/subagent/runner.ts";
import type { WorkerView } from "../src/extensions/subagent/team.ts";
import { showWorkerView, type WorkerViewTeam } from "../src/extensions/subagent/worker-view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

function setup(status: WorkerView["status"]) {
	const worker: WorkerView = {
		id: "worker-1",
		color: "syntaxString",
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
	const team: WorkerViewTeam = {
		getViews: () => [worker],
		subscribe: () => () => {},
		send: vi.fn(async () => "delivered"),
		continue: vi.fn(async () => "queued"),
	};
	let view: ExtensionMainView | undefined;
	const notify = vi.fn();
	const ui = {
		setMainView: (next: ExtensionMainView | undefined) => {
			view = next;
		},
		notify,
	} as unknown as ExtensionUIContext; // Only the two members showWorkerView uses.
	showWorkerView(ui, team, worker.id);
	if (!view) throw new Error("showWorkerView did not set a main view");
	return { view, team, notify };
}

describe("worker main view", () => {
	it("labels the view with the worker name and renders its transcript", () => {
		const { view } = setup("completed");
		expect(view.label).toBe("explorer");
		// The main view takes the worker's color for the input box border and badge.
		expect(view.color).toBe("syntaxString");
		const component = view.component(new TuiMainScreen(new VirtualTerminal()), theme);
		try {
			const lines = component.render(80).map(stripVTControlCharacters);
			expect(lines[1]).toMatch(/^◯ explorer\s+worker-1$/);
			expect(lines).toContain("No worker messages yet.");
			// The title carries the worker's color.
			expect(component.render(80)[1]).toContain(theme.fg("syntaxString", theme.bold("explorer")));
		} finally {
			component.dispose?.();
		}
	});

	it("sends input box text to a settled worker and continues an interrupted one", async () => {
		const settled = setup("completed");
		settled.view.onSubmit("look again");
		await vi.waitFor(() => expect(settled.team.send).toHaveBeenCalledWith("worker-1", "look again"));

		const interrupted = setup("interrupted");
		interrupted.view.onSubmit("resume");
		await vi.waitFor(() => expect(interrupted.team.continue).toHaveBeenCalledWith("worker-1", "resume"));
		expect(interrupted.team.send).not.toHaveBeenCalled();
	});

	it("does not send to a cancelled worker", async () => {
		const { view, team, notify } = setup("cancelled");
		view.onSubmit("hello");
		await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("explorer has been cancelled.", "warning"));
		expect(team.send).not.toHaveBeenCalled();
	});
});
