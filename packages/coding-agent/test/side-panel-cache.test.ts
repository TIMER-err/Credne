import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ChangedFile,
	type ChangesSnapshot,
	type DiffRow,
	summarizeChanges,
} from "../src/modes/interactive/components/git-changes.ts";
import { SidePanel } from "../src/modes/interactive/components/side-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const highlightSpy = vi.hoisted(() => vi.fn<(code: string, lang?: string) => string[]>());

vi.mock("../src/modes/interactive/theme/theme.ts", async (importOriginal) => {
	const original = await importOriginal<{ highlightCode: (code: string, lang?: string) => string[] }>();
	highlightSpy.mockImplementation(original.highlightCode);
	return { ...original, highlightCode: highlightSpy };
});

beforeAll(() => initTheme("dark"));

const file: ChangedFile = {
	path: "src/a.ts",
	label: "src/a.ts",
	added: 60,
	removed: 0,
	isUntracked: false,
	content: "text",
};
const snapshot: ChangesSnapshot = {
	status: "ready",
	root: "/repo",
	base: "b4se",
	scope: "session",
	files: [file],
	totals: summarizeChanges([file]),
};
const rows: DiffRow[] = Array.from({ length: 60 }, (_, index) => ({
	kind: "added",
	oldNumber: undefined,
	newNumber: index + 1,
	text: `const value${index} = ${index};`,
}));

/** A 20-row panel leaves 13 code rows below its index and per-file heading. */
function createPanel(): SidePanel {
	const panel = new SidePanel({ getHeight: () => 20, getCloseHint: () => "/diff", resize: () => {} });
	panel.setChanges(snapshot);
	panel.setDiff("src/a.ts", { status: "ready", rows });
	return panel;
}

describe("SidePanel diff row cache", () => {
	it("highlights each visible row once, and only the row that scrolls into view afterwards", () => {
		highlightSpy.mockClear();
		const panel = createPanel();

		panel.render(60);
		expect(highlightSpy).toHaveBeenCalledTimes(13);

		panel.render(60);
		expect(highlightSpy).toHaveBeenCalledTimes(13);

		panel.scrollDiff(1);
		panel.render(60);
		expect(highlightSpy).toHaveBeenCalledTimes(14);

		panel.scrollDiff(-1);
		panel.render(60);
		expect(highlightSpy).toHaveBeenCalledTimes(14);
	});

	it("renders the rows again for a new width, a new diff, a theme change, and a new selection", () => {
		highlightSpy.mockClear();
		const panel = createPanel();
		panel.render(60);
		expect(highlightSpy).toHaveBeenCalledTimes(13);

		panel.render(70);
		expect(highlightSpy).toHaveBeenCalledTimes(26);

		panel.invalidate();
		panel.render(70);
		expect(highlightSpy).toHaveBeenCalledTimes(39);

		panel.setDiff("src/a.ts", { status: "ready", rows });
		panel.render(70);
		expect(highlightSpy).toHaveBeenCalledTimes(52);
	});

	it("retains syntax highlighting across file and separator hover, leave and resize drag", () => {
		highlightSpy.mockClear();
		const panel = createPanel();
		panel.render(60);
		const move: TuiMouseEvent = {
			type: "move",
			button: "none",
			x: 5,
			y: 2,
			screenX: 5,
			screenY: 2,
			width: 60,
			height: 20,
			shift: false,
			alt: false,
			ctrl: false,
		};

		const events: TuiMouseEvent[] = [
			move,
			{ ...move, type: "leave" },
			{ ...move, x: 0, screenX: 0 },
			{ ...move, type: "press", button: "left", x: 0, screenX: 0 },
			{ ...move, type: "drag", button: "left", x: -5, screenX: -5 },
			{ ...move, type: "release", button: "left", x: -5, screenX: -5 },
		];
		for (const event of events) {
			panel.handleMouse(event);
			panel.render(60);
			expect(highlightSpy).toHaveBeenCalledTimes(13);
		}
	});

	it("does not highlight when the panel is not rendered", () => {
		highlightSpy.mockClear();
		createPanel();

		expect(highlightSpy).not.toHaveBeenCalled();
	});
});
