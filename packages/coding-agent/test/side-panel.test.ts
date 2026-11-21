import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type ChangedFile,
	type ChangesSnapshot,
	type DiffRow,
	loadChanges,
	parseNumstat,
	parseUnifiedDiff,
	summarizeChanges,
} from "../src/modes/interactive/components/git-changes.ts";
import type { GitRunner } from "../src/modes/interactive/components/git-runner.ts";
import type { BaselineScope } from "../src/modes/interactive/components/session-baseline.ts";
import { SidePanel } from "../src/modes/interactive/components/side-panel.ts";
import { sidePanelWidthFor } from "../src/modes/interactive/components/side-panel-layout.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function file(path: string, added: number, removed: number, overrides: Partial<ChangedFile> = {}): ChangedFile {
	return { path, label: path, added, removed, isUntracked: false, content: "text", ...overrides };
}

/** A snapshot of `files`, with `omitted` more changed files that the list cap left out. */
function ready(files: ChangedFile[], omitted = 0, scope: BaselineScope = "session"): ChangesSnapshot {
	const totals = summarizeChanges(files);
	return {
		status: "ready",
		root: "/repo",
		base: "b4se",
		scope,
		files,
		totals: { ...totals, files: files.length + omitted },
	};
}

function createPanel(height = 30): SidePanel {
	return new SidePanel({ getHeight: () => height, getCloseHint: () => "/diff" });
}

function plain(panel: SidePanel, width: number): string[] {
	return panel.render(width).map(stripAnsi);
}

function section(lines: string[]): Component {
	return { render: () => lines, invalidate: () => {} };
}

const sampleRows: DiffRow[] = [
	{ kind: "hunk", text: "@@ -8,4 +8,5 @@ function load() {" },
	{ kind: "context", oldNumber: 8, newNumber: 8, text: "const a = 1;" },
	{ kind: "removed", oldNumber: 9, newNumber: undefined, text: "const b = 2;" },
	{ kind: "added", oldNumber: undefined, newNumber: 9, text: "const b = 3;" },
	{ kind: "added", oldNumber: undefined, newNumber: 10, text: "const c = 4;" },
	{ kind: "context", oldNumber: 10, newNumber: 11, text: "return a;" },
];

describe("SidePanel header", () => {
	it("shows the totals with the close hint right-aligned", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("src/a.ts", 30, 4), file("src/b.ts", 0, 0, { content: "binary" })]));

		const header = panel.render(60)[0]!;

		expect(stripAnsi(header)).toBe(`│ 2 files changed +30 -4${" ".repeat(21)}/diff to close `);
		expect(header).toContain(theme.getFgAnsi("toolDiffAdded"));
		expect(header).toContain(theme.getFgAnsi("toolDiffRemoved"));
		expect(header).toContain(`${theme.getFgAnsi("muted")} files changed`);
		expect(header).toContain(theme.getFgAnsi("borderAccent"));
	});

	it("shows the scope beside the counts when there is room, and drops it before the close hint", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("src/a.ts", 30, 4), file("src/b.ts", 0, 0, { content: "binary" })]));

		const wide = panel.render(70)[0]!;
		expect(stripAnsi(wide)).toBe(`│ 2 files changed +30 -4 since session start${" ".repeat(11)}/diff to close `);
		expect(wide).toContain(`${theme.getFgAnsi("muted")}since session start`);

		expect(plain(panel, 60)[0]).not.toContain("since session start");
		expect(plain(panel, 60)[0]).toContain("/diff to close");
	});

	it("says since last commit when the session's starting state could not be captured", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0)], 0, "commit"));

		expect(plain(panel, 70)[0]).toContain("1 file changed +1 -0 since last commit");

		panel.setChanges(ready([], 0, "commit"));
		expect(plain(panel, 70)[0]).toContain("No changes since last commit");
	});

	it("uses the singular for one file and drops the hint when it does not fit", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 1)]));

		expect(plain(panel, 60)[0]).toContain("1 file changed +1 -1");
		expect(plain(panel, 26)[0]).toBe("│ 1 file changed +1 -1".padEnd(26));
	});

	it.each([
		["loading", undefined, "Loading changes…"],
		["not a repository", { status: "no-repo" } as const, "Not a git repository"],
		["no changes", ready([]), "No changes"],
		["git error", { status: "error", message: "git is not installed" } as const, "git: git is not installed"],
	])("shows one muted message line for %s", (_name, snapshot, message) => {
		const panel = createPanel(6);
		if (snapshot) panel.setChanges(snapshot);

		const lines = plain(panel, 60);

		expect(lines[0]).toContain(message);
		expect(lines[0]).toContain("/diff to close");
		expect(lines.slice(1).every((line) => line.trim() === "│")).toBe(true);
	});
});

describe("SidePanel file list", () => {
	it("shows paths in muted text with colored counts and omits zero parts", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("src/a.ts", 12, 3), file("src/b.ts", 7, 0), file("src/c.ts", 0, 2)]));

		const lines = panel.render(50);
		const rows = lines.slice(2, 5);

		expect(rows.map((row) => stripAnsi(row).trimEnd())).toEqual([
			`│ src/a.ts${" ".repeat(50 - 2 - 8 - 6 - 1)}+12 -3`,
			`│ src/b.ts${" ".repeat(50 - 2 - 8 - 2 - 1)}+7`,
			`│ src/c.ts${" ".repeat(50 - 2 - 8 - 2 - 1)}-2`,
		]);
		expect(rows[1]).toContain(`${theme.getFgAnsi("muted")}src/b.ts`);
		expect(rows[1]).toContain(`${theme.getFgAnsi("toolDiffAdded")}+7`);
		expect(rows[2]).toContain(`${theme.getFgAnsi("toolDiffRemoved")}-2`);
	});

	it("highlights only the selected row", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0), file("b.ts", 1, 0)]));

		const [first, second] = panel.render(50).slice(2, 4);
		expect(first).toContain(theme.getBgAnsi("selectedBg"));
		expect(second).not.toContain(theme.getBgAnsi("selectedBg"));

		expect(panel.selectFile(1)).toBe(true);
		const [moved, selected] = panel.render(50).slice(2, 4);
		expect(moved).not.toContain(theme.getBgAnsi("selectedBg"));
		expect(selected).toContain(theme.getBgAnsi("selectedBg"));
	});

	it("labels binary and large files instead of counts, and cuts long paths from the left", () => {
		const panel = createPanel();
		panel.setChanges(
			ready([
				file("assets/logo.png", 0, 0, { content: "binary" }),
				file("dump.sql", 0, 0, { isUntracked: true, content: "large" }),
				file("packages/coding-agent/src/modes/interactive/components/side-panel.ts", 5, 1),
			]),
		);

		const rows = plain(panel, 40).slice(2, 5);

		expect(rows[0]).toContain("binary");
		expect(rows[1]).toContain("large");
		expect(rows[2]).toContain("…");
		expect(rows[2]).toContain("side-panel.ts");
		expect(rows[2]).toContain("+5 -1");
	});

	it("shows at most eight rows and counts the files below and above", () => {
		const panel = createPanel(40);
		panel.setChanges(
			ready(Array.from({ length: 12 }, (_, index) => file(`f${String(index).padStart(2, "0")}.ts`, 1, 0))),
		);

		const top = plain(panel, 50);
		expect(top.slice(2, 12).filter((line) => /f\d\d\.ts/.test(line))).toHaveLength(8);
		expect(top.some((line) => line.includes("↓ 4 more below"))).toBe(true);
		expect(top.some((line) => line.includes("more above"))).toBe(false);

		panel.selectFile(11);
		const bottom = plain(panel, 50);
		expect(bottom.slice(2, 12).filter((line) => /f\d\d\.ts/.test(line))).toHaveLength(8);
		expect(bottom.some((line) => line.includes("↑ 4 more above"))).toBe(true);
		expect(bottom.some((line) => line.includes("more below"))).toBe(false);
		expect(bottom.some((line) => line.includes("f11.ts"))).toBe(true);
		expect(bottom.some((line) => line.includes("f03.ts"))).toBe(false);
	});

	it("counts files beyond the list cap in the header and ends the list with how many are not listed", () => {
		const panel = createPanel(40);
		panel.setChanges(
			ready(
				Array.from({ length: 10 }, (_, index) => file(`f${index}.ts`, 1, 0)),
				30,
			),
		);

		const top = plain(panel, 60);
		expect(top[0]).toContain("40 files changed +10 -0");
		expect(top.some((line) => line.includes("↓ 2 more below"))).toBe(true);
		expect(top.some((line) => line.includes("+30 more not listed"))).toBe(true);

		panel.selectFile(9);
		const bottom = plain(panel, 60);
		expect(bottom.some((line) => line.includes("+30 more not listed"))).toBe(true);
		expect(bottom.some((line) => line.includes("more below"))).toBe(false);
	});
});

describe("SidePanel render cache", () => {
	it("returns the same array while nothing it shows changed, and a new one after each kind of change", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 2, 1), file("b.ts", 1, 0)]));
		panel.setDiff("a.ts", {
			status: "ready",
			rows: Array.from({ length: 60 }, (_, index) => ({
				kind: "context",
				oldNumber: index + 1,
				newNumber: index + 1,
				text: `line ${index}`,
			})),
		});

		const first = panel.render(60);
		expect(panel.render(60)).toBe(first);

		expect(panel.render(70)).not.toBe(first);
		const wide = panel.render(70);
		expect(panel.render(70)).toBe(wide);

		panel.scrollDiff(3);
		const scrolled = panel.render(70);
		expect(scrolled).not.toBe(wide);
		expect(panel.render(70)).toBe(scrolled);

		panel.selectFile(1);
		const selected = panel.render(70);
		expect(selected).not.toBe(scrolled);

		panel.setChanges(ready([file("a.ts", 2, 1), file("b.ts", 5, 0)]));
		expect(panel.render(70)).not.toBe(selected);

		panel.invalidate();
		expect(panel.render(70)).not.toBe(selected);
	});

	it("does not rebuild when a section renders the same lines, and rebuilds when it changes", () => {
		let text = "one";
		let renders = 0;
		const panel = createPanel();
		panel.setSections([
			{
				key: "a",
				order: 0,
				component: {
					render: () => {
						renders++;
						return [text];
					},
					invalidate: () => {},
				},
			},
		]);
		panel.setChanges(ready([file("a.ts", 1, 0)]));

		const first = panel.render(60);
		expect(panel.render(60)).toBe(first);
		// Sections render on every frame, which is how a change is noticed.
		expect(renders).toBe(2);

		text = "two";
		const changed = panel.render(60);
		expect(changed).not.toBe(first);
		expect(stripAnsi(changed[0]!)).toContain("two");
	});

	it("follows the height", () => {
		let height = 20;
		const panel = new SidePanel({ getHeight: () => height, getCloseHint: () => "/diff" });
		panel.setChanges(ready([file("a.ts", 1, 0)]));

		expect(panel.render(60)).toHaveLength(20);
		height = 12;
		expect(panel.render(60)).toHaveLength(12);
	});
});

describe("SidePanel selection", () => {
	it("does not wrap and reports whether it moved", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0), file("b.ts", 1, 0)]));

		expect(panel.selectFile(-1)).toBe(false);
		expect(panel.getSelectedFile()?.path).toBe("a.ts");
		expect(panel.selectFile(1)).toBe(true);
		expect(panel.selectFile(1)).toBe(false);
		expect(panel.getSelectedFile()?.path).toBe("b.ts");
	});

	it("keeps the selection on the same file after a refresh, and keeps its diff", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0), file("b.ts", 1, 0)]));
		panel.selectFile(1);
		panel.setDiff("b.ts", { status: "ready", rows: sampleRows });

		panel.setChanges(ready([file("0.ts", 1, 0), file("a.ts", 1, 0), file("b.ts", 2, 0)]));

		expect(panel.getSelectedFile()?.path).toBe("b.ts");
		const inserted = plain(panel, 60);
		expect(inserted[inserted.findIndex((line) => line.includes("──")) + 1]).toContain("b.ts");
		expect(inserted.some((line) => line.includes("const b = 3;"))).toBe(true);
		panel.setChanges(ready([file("b.ts", 2, 0)]));
		const removed = plain(panel, 60);
		expect(removed[removed.findIndex((line) => line.includes("──")) + 1]).toContain("b.ts");
	});

	it("falls back to a nearby file and shows the diff as loading when the selected file is gone", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0), file("b.ts", 1, 0), file("c.ts", 1, 0)]));
		panel.selectFile(2);
		panel.setDiff("c.ts", { status: "ready", rows: sampleRows });

		panel.setChanges(ready([file("a.ts", 1, 0), file("b.ts", 1, 0)]));

		expect(panel.getSelectedFile()?.path).toBe("b.ts");
		expect(plain(panel, 60).some((line) => line.includes("Loading diff…"))).toBe(true);
	});

	it("retains diffs for other files without moving the selected file's viewport", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0), file("b.ts", 1, 0)]));
		panel.selectFile(1);

		panel.setDiff("a.ts", { status: "ready", rows: sampleRows });

		expect(plain(panel, 60).some((line) => line.includes("const b = 3;"))).toBe(false);
		panel.selectFile(-1);
		expect(plain(panel, 60).some((line) => line.includes("const b = 3;"))).toBe(true);
	});

	it("shows a diff error as a muted line", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0)]));
		panel.setDiff("a.ts", { status: "error", message: "Diff too large to show" });

		expect(plain(panel, 60).some((line) => line.includes("Diff too large to show"))).toBe(true);
	});
});

describe("SidePanel diff", () => {
	function panelWithDiff(width = 60, height = 30): { panel: SidePanel; lines: string[] } {
		const panel = createPanel(height);
		panel.setChanges(ready([file("src/a.ts", 2, 1)]));
		panel.setDiff("src/a.ts", { status: "ready", rows: sampleRows });
		return { panel, lines: panel.render(width) };
	}

	it("shows a gutter with line numbers and a marker per row", () => {
		const { lines } = panelWithDiff();
		const diffLines = lines
			.map(stripAnsi)
			.filter((line) => /\b(const|return) /.test(line) && !line.includes("src/a.ts"));

		expect(diffLines.map((line) => line.trimEnd())).toEqual([
			"│  8   const a = 1;",
			"│  9 - const b = 2;",
			"│  9 + const b = 3;",
			"│ 10 + const c = 4;",
			"│ 11   return a;",
		]);
	});

	it("fills added and removed rows with the tool backgrounds to the full width, not context rows", () => {
		const { lines } = panelWithDiff(60);
		const added = lines.find((line) => stripAnsi(line).includes("const b = 3;"))!;
		const removed = lines.find((line) => stripAnsi(line).includes("const b = 2;"))!;
		const context = lines.find((line) => stripAnsi(line).includes("return a;"))!;

		expect(added.startsWith(theme.getFgAnsi("borderAccent"))).toBe(true);
		expect(added).toContain(theme.getBgAnsi("toolSuccessBg"));
		expect(visibleWidth(added)).toBe(60);
		expect(removed).toContain(theme.getBgAnsi("toolErrorBg"));
		expect(removed).toContain(`${theme.getFgAnsi("toolDiffRemoved")}-`);
		expect(context).not.toContain(theme.getBgAnsi("toolSuccessBg"));
		expect(context).not.toContain(theme.getBgAnsi("toolErrorBg"));
		expect(added.endsWith("\x1b[49m")).toBe(true);
	});

	it("keeps the background across a truncated line", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.txt", 1, 0)]));
		panel.setDiff("a.txt", {
			status: "ready",
			rows: [{ kind: "added", oldNumber: undefined, newNumber: 1, text: "x".repeat(200) }],
		});

		const row = panel.render(40).find((line) => stripAnsi(line).includes("xxxx"))!;
		const afterEllipsis = row.slice(row.lastIndexOf("…"));

		expect(visibleWidth(row)).toBe(40);
		expect(afterEllipsis).toContain(theme.getBgAnsi("toolSuccessBg"));
	});

	it("scrolls by lines, by pages, and with the mouse wheel, within the diff", () => {
		const rows: DiffRow[] = Array.from({ length: 40 }, (_, index) => ({
			kind: "context",
			oldNumber: index + 1,
			newNumber: index + 1,
			text: `line ${index + 1}`,
		}));
		const panel = createPanel(16);
		panel.setChanges(ready([file("a.txt", 0, 0)]));
		panel.setDiff("a.txt", { status: "ready", rows });
		const firstVisible = () =>
			plain(panel, 60)
				.find((line) => /line \d+/.test(line))!
				.trimEnd();

		expect(firstVisible()).toBe("│  1   line 1");
		panel.scrollDiff(6);
		expect(firstVisible()).toBe("│  4   line 4");
		panel.scrollDiff(-10);
		expect(firstVisible()).toBe("│  1   line 1");
		panel.scrollDiffPage(1);
		const afterPage = firstVisible();
		expect(afterPage).not.toBe("│  1   line 1");
		panel.scrollDiff(1000);
		const last = plain(panel, 60)
			.filter((line) => /line \d+/.test(line))
			.at(-1)!
			.trimEnd();
		expect(last).toBe("│ 40   line 40");

		const wheel: TuiMouseEvent = {
			type: "wheel",
			button: "none",
			x: 5,
			y: 5,
			screenX: 5,
			screenY: 5,
			width: 60,
			height: 16,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: -2,
		};
		const before = firstVisible();
		expect(panel.handleMouse(wheel)).toEqual({ handled: true });
		expect(firstVisible()).not.toBe(before);
		expect(panel.handleMouse({ ...wheel, type: "move" })).toBeUndefined();
	});

	it("resets the scroll position when another file is selected", () => {
		const rows: DiffRow[] = Array.from({ length: 40 }, (_, index) => ({
			kind: "context",
			oldNumber: index + 1,
			newNumber: index + 1,
			text: `line ${index + 1}`,
		}));
		const panel = createPanel(16);
		panel.setChanges(ready([file("a.txt", 0, 0), file("b.txt", 0, 0)]));
		panel.setDiff("a.txt", { status: "ready", rows });
		plain(panel, 60);
		panel.scrollDiff(10);

		panel.selectFile(1);
		panel.setDiff("b.txt", { status: "ready", rows });

		expect(
			plain(panel, 60)
				.find((line) => /line \d+/.test(line))!
				.trimEnd(),
		).toBe("│  1   line 1");
	});
});

describe("SidePanel mouse hover", () => {
	function mouse(
		type: TuiMouseEvent["type"],
		x: number,
		y: number,
		overrides: Partial<TuiMouseEvent> = {},
	): TuiMouseEvent {
		return {
			type,
			button: type === "move" || type === "leave" ? "none" : "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 60,
			height: 30,
			shift: false,
			alt: false,
			ctrl: false,
			...overrides,
		};
	}

	it("contrasts hovered files, including the selected file, without changing selection", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0), file("b.ts", 1, 0)]));
		const initial = panel.render(60);

		expect(panel.handleMouse(mouse("move", 5, 3))).toEqual({ handled: true, render: true });
		const hovered = panel.render(60);
		expect(hovered[2]).toBe(initial[2]);
		expect(hovered[3]).toContain("\x1b[7m");
		expect(hovered[3]).toContain(theme.getBgAnsi("selectedBg"));
		expect(hovered.map(visibleWidth)).toEqual(Array(30).fill(60));
		expect(panel.getSelectedFile()?.path).toBe("a.ts");

		expect(panel.handleMouse(mouse("move", 55, 3))).toEqual({ handled: true, render: false });
		expect(panel.render(60)).toBe(hovered);

		panel.handleMouse(mouse("move", 5, 2));
		const selectedHover = panel.render(60);
		expect(selectedHover[2]).not.toBe(initial[2]);
		expect(selectedHover[2]).toContain("\x1b[7m");
		expect(selectedHover[3]).toBe(initial[3]);
		expect(panel.getSelectedFile()?.path).toBe("a.ts");

		expect(panel.handleMouse(mouse("leave", -1, 2))).toEqual({ handled: true, render: true });
		expect(panel.render(60)).toEqual(initial);
		expect(panel.handleMouse(mouse("leave", -1, 2))).toBeUndefined();
	});

	it("clears file hover over non-file rows and keeps the render cached afterwards", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0)]));
		const initial = panel.render(60);
		panel.handleMouse(mouse("move", 5, 2));
		panel.render(60);

		expect(panel.handleMouse(mouse("move", 5, 1))).toEqual({ handled: true, render: true });
		const cleared = panel.render(60);
		expect(cleared).toEqual(initial);
		expect(panel.handleMouse(mouse("move", 20, 1))).toBeUndefined();
		expect(panel.render(60)).toBe(cleared);
	});

	it("keeps hover on the screen row when the file index scrolls", () => {
		const panel = createPanel(24);
		panel.setChanges(ready(Array.from({ length: 20 }, (_, index) => file(`file${index}.txt`, 1, 0))));
		panel.render(60);
		panel.handleMouse(mouse("move", 5, 3));
		expect(stripAnsi(panel.render(60)[3]!)).toContain("file0.txt");

		panel.handleMouse(mouse("wheel", 5, 3, { wheelDelta: 8 }));
		const scrolled = panel.render(60);
		expect(stripAnsi(scrolled[3]!)).toContain("file8.txt");
		expect(scrolled[3]).toContain("\x1b[7m");
		expect(scrolled[4]).not.toContain("\x1b[7m");
		expect(panel.getSelectedFile()?.path).toBe("file0.txt");
	});

	it("highlights the separator across sections, changes and blank rows, then clears on leave", () => {
		const panel = new SidePanel({ getHeight: () => 30, getCloseHint: () => "/diff", resize: () => {} });
		panel.setSections([{ key: "section", order: 0, component: section(["extension"]) }]);
		panel.setChanges(ready([file("a.ts", 1, 0)]));
		const initial = panel.render(60);
		const border = theme.fg("borderAccent", "│");
		const activeBorder = theme.inverse(theme.fg("borderAccent", "┃"));

		expect(panel.handleMouse(mouse("move", 0, 3))).toEqual({ handled: true, render: true });
		const hovered = panel.render(60);
		expect(hovered.every((line) => line.startsWith(activeBorder))).toBe(true);
		expect(hovered.map((line) => line.slice(activeBorder.length))).toEqual(
			initial.map((line) => line.slice(border.length)),
		);
		expect(hovered.map(visibleWidth)).toEqual(Array(30).fill(60));
		expect(panel.handleMouse(mouse("move", 0, 20))).toEqual({ handled: true, render: false });
		expect(panel.render(60)).toBe(hovered);

		panel.handleMouse(mouse("leave", -1, 20));
		expect(panel.render(60)).toEqual(initial);
	});

	it("keeps the separator highlighted during a captured resize outside the panel", () => {
		const resized: number[] = [];
		const panel = new SidePanel({
			getHeight: () => 30,
			getCloseHint: () => "/diff",
			resize: (screenX) => resized.push(screenX),
		});
		panel.setChanges(ready([file("a.ts", 1, 0)]));
		const initial = panel.render(60);

		expect(panel.handleMouse(mouse("press", 0, 2))).toEqual({ handled: true, capture: true, render: true });
		const pressed = panel.render(60);
		expect(pressed.every((line) => stripAnsi(line).startsWith("┃"))).toBe(true);
		panel.handleMouse(mouse("leave", -10, 2));
		panel.handleMouse(mouse("drag", -10, 2, { screenX: 90 }));
		expect(panel.render(60)).toBe(pressed);
		expect(resized).toEqual([90]);

		panel.handleMouse(mouse("release", -10, 2, { screenX: 90 }));
		expect(resized).toEqual([90, 90]);
		expect(panel.render(60)).toEqual(initial);
	});

	it("does not advertise a separator that cannot be resized", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.ts", 1, 0)]));
		const initial = panel.render(60);

		expect(panel.handleMouse(mouse("move", 0, 2))).toBeUndefined();
		expect(panel.render(60)).toBe(initial);
	});
});

describe("SidePanel multi-file viewports", () => {
	function mouse(panel: SidePanel, row: number, type: "wheel" | "click", delta = 1) {
		return panel.handleMouse({
			type,
			button: "left",
			x: 5,
			y: row,
			screenX: 5,
			screenY: row,
			width: 80,
			height: 40,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: delta,
		});
	}

	it("shows text after a binary file and gives every file its own header", () => {
		const panel = createPanel(40);
		panel.setChanges(
			ready([file("font.otf", 0, 0, { content: "binary" }), file("slides.js", 1, 0), file("styles.css", 1, 0)]),
		);
		panel.setDiff("font.otf", { status: "ready", rows: [{ kind: "note", text: "Binary file" }] });
		panel.setDiff("slides.js", {
			status: "ready",
			rows: [{ kind: "added", oldNumber: undefined, newNumber: 1, text: "renderSlides();" }],
		});
		panel.setDiff("styles.css", {
			status: "ready",
			rows: [{ kind: "added", oldNumber: undefined, newNumber: 1, text: "body { color: red; }" }],
		});
		const lines = plain(panel, 80);
		const diffStart = lines.findIndex((line) => line.includes("──"));
		const diffs = lines.slice(diffStart).join("\n");
		expect(diffs).toMatch(
			/font\.otf[\s\S]+Binary file[\s\S]+slides\.js[\s\S]+renderSlides\(\);[\s\S]+styles\.css[\s\S]+body \{ color: red; \}/,
		);
	});

	it("scrolls the index independently, keeps reserved heights, and jumps on a file click", () => {
		const panel = createPanel(24);
		panel.setChanges(ready(Array.from({ length: 20 }, (_, index) => file(`file${index}.txt`, 1, 0))));
		for (let index = 0; index < 20; index++) {
			panel.setDiff(`file${index}.txt`, {
				status: "ready",
				rows: [{ kind: "added", oldNumber: undefined, newNumber: 1, text: `content ${index}` }],
			});
		}
		const initial = plain(panel, 80);
		const diffStart = initial.findIndex((line) => line.includes("──"));
		mouse(panel, 4, "wheel", 8);
		const moved = plain(panel, 80);
		expect(moved.findIndex((line) => line.includes("──"))).toBe(diffStart);
		expect(moved.slice(diffStart)).toEqual(initial.slice(diffStart));
		expect(moved[3]).toContain("file8.txt");
		mouse(panel, 3, "click");
		expect(panel.getSelectedFile()?.path).toBe("file8.txt");
		const jumped = plain(panel, 80);
		expect(jumped[diffStart + 1]).toContain("file8.txt");
		mouse(panel, diffStart + 2, "wheel", 5);
		expect(plain(panel, 80)[diffStart + 1]).toContain("file9.txt");
	});

	it("keeps the diff visible below long extension sections and lets those sections scroll", () => {
		const panel = createPanel(24);
		panel.setSections([
			{ key: "agents", order: 0, component: section(Array.from({ length: 30 }, (_, index) => `agent ${index}`)) },
		]);
		panel.setChanges(ready([file("source.txt", 1, 0)]));
		panel.setDiff("source.txt", {
			status: "ready",
			rows: [{ kind: "added", oldNumber: undefined, newNumber: 1, text: "visible text" }],
		});
		expect(plain(panel, 80).join("\n")).toContain("visible text");
		mouse(panel, 1, "wheel", 10);
		const moved = plain(panel, 80);
		expect(moved[0]).toContain("agent 10");
		expect(moved.join("\n")).toContain("visible text");
	});
});

describe("SidePanel with escape characters in git output", () => {
	/** Anything left after the theme's own styling (SGR) sequences are removed would be a raw control sequence. */
	function expectNoRawControls(lines: string[]): void {
		for (const line of lines) {
			const withoutStyling = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(withoutStyling).not.toContain("\x1b");
			expect(withoutStyling).not.toContain("\x07");
		}
	}

	it("shows a path with escape and bell characters as plain text, never as raw control characters", () => {
		const files = parseNumstat("1\t0\tevil\x1b[31m\x07\x1b]0;pwned\x07.ts\0");
		const panel = createPanel();
		panel.setChanges(ready(files));

		const lines = panel.render(60);

		const row = lines.find((line) => stripAnsi(line).includes("evil"))!;
		// Had the ESC survived, stripping styling would have removed "[31m" along with it.
		expect(stripAnsi(row)).toContain("evil [31m ]0;pwned .ts");
		expect(visibleWidth(row)).toBe(60);
		expectNoRawControls(lines);
	});

	it("shows a git error message with escape characters as plain text", async () => {
		const run: GitRunner = async () => ({ status: "failed", reason: "error", message: "bad\x1b[31m\x07 object" });
		const snapshot = await loadChanges(
			{ status: "ready", root: "/repo", base: "b4se", scope: "session", untracked: new Set() },
			new AbortController().signal,
			run,
		);
		const panel = createPanel(6);
		panel.setChanges(snapshot!);

		const lines = panel.render(60);

		expect(stripAnsi(lines[0]!)).toContain("git: bad [31m  object");
		expectNoRawControls(lines);
	});

	it("shows parsed diff text with escape characters without raw control characters", () => {
		const panel = createPanel();
		panel.setChanges(ready([file("a.txt", 1, 0)]));
		panel.setDiff("a.txt", {
			status: "ready",
			rows: parseUnifiedDiff(["@@ -1 +1 @@ ctx\x1b[1m", "+\tindent\x1b[31m\x07", ""].join("\n")),
		});

		const lines = panel.render(40);

		expect(visibleWidth(lines.find((line) => stripAnsi(line).includes("indent"))!)).toBe(40);
		expectNoRawControls(lines);
	});
});

describe("SidePanel sections", () => {
	it("renders sections by ascending order above the changes, separated by blank lines", () => {
		const panel = createPanel();
		panel.setSections([
			{ key: "late", order: 5, component: section(["late one"]) },
			{ key: "empty", order: 3, component: section([]) },
			{ key: "early", order: -1, component: section(["early one", "early two"]) },
		]);
		panel.setChanges(ready([file("a.ts", 1, 0)]));

		const lines = plain(panel, 50).map((line) => line.slice(1).trim());

		expect(lines.slice(0, 7)).toEqual([
			"early one",
			"early two",
			"",
			"late one",
			"",
			expect.stringContaining("1 file changed"),
			"",
		]);
	});

	it("keeps the default order stable for equal orders", () => {
		const panel = createPanel();
		panel.setSections([
			{ key: "a", order: 0, component: section(["first"]) },
			{ key: "b", order: 0, component: section(["second"]) },
		]);

		const lines = plain(panel, 50).map((line) => line.slice(1).trim());

		expect(lines.slice(0, 3)).toEqual(["first", "", "second"]);
	});

	it("shows no separator when no section has lines", () => {
		const panel = createPanel();
		panel.setSections([{ key: "empty", order: 0, component: section([]) }]);
		panel.setChanges(ready([file("a.ts", 1, 0)]));

		expect(plain(panel, 50)[0]).toContain("1 file changed");
	});

	it("renders sections at the panel's inner width and cuts overlong section lines", () => {
		const widths: number[] = [];
		const panel = createPanel();
		panel.setSections([
			{
				key: "wide",
				order: 0,
				component: {
					render: (width) => {
						widths.push(width);
						return ["y".repeat(width + 30)];
					},
					invalidate: () => {},
				},
			},
		]);

		const lines = panel.render(50);

		expect(widths).toEqual([47]);
		expect(visibleWidth(lines[0]!)).toBe(50);
	});

	it("forwards invalidate to the sections", () => {
		let invalidated = 0;
		const panel = createPanel();
		panel.setSections([{ key: "a", order: 0, component: { render: () => [], invalidate: () => invalidated++ } }]);

		panel.invalidate();

		expect(invalidated).toBe(1);
	});

	it("takes rows from the diff, not from the panel height", () => {
		const panel = createPanel(20);
		panel.setSections([{ key: "a", order: 0, component: section(["one", "two", "three"]) }]);
		panel.setChanges(ready([file("a.ts", 1, 0)]));
		panel.setDiff("a.ts", { status: "ready", rows: sampleRows });

		expect(panel.render(50)).toHaveLength(20);
	});
});

describe("SidePanel line widths", () => {
	it.each([40, 41, 57, 90])("renders exactly the terminal height with every line %i columns wide", (width) => {
		const rows: DiffRow[] = [
			{ kind: "hunk", text: "@@ -1,3 +1,3 @@ 日本語のコンテキスト" },
			{ kind: "context", oldNumber: 1, newNumber: 1, text: "日本語のテキスト ".repeat(20) },
			{ kind: "removed", oldNumber: 2, newNumber: undefined, text: "emoji 🎉🎉🎉 ".repeat(15) },
			{ kind: "added", oldNumber: undefined, newNumber: 2, text: "short" },
			{ kind: "added", oldNumber: undefined, newNumber: 3, text: "" },
			{ kind: "note", text: "No newline at end of file" },
		];
		const panel = createPanel(24);
		panel.setSections([{ key: "a", order: 0, component: section(["日本語".repeat(40), "plain"]) }]);
		panel.setChanges(
			ready([
				file("日本語/とても/長い/パス/ファイル名.ts", 100000, 20000),
				file("src/modes/interactive/components/side-panel.ts", 1, 1),
				file("a.png", 0, 0, { content: "binary" }),
			]),
		);
		panel.setDiff("日本語/とても/長い/パス/ファイル名.ts", { status: "ready", rows });

		const lines = panel.render(width);

		expect(lines).toHaveLength(24);
		expect(lines.map(visibleWidth)).toEqual(Array(24).fill(width));
	});

	it("keeps every line the full width in the empty states", () => {
		for (const snapshot of [undefined, { status: "no-repo" } as const, ready([])]) {
			const panel = createPanel(8);
			if (snapshot) panel.setChanges(snapshot);

			expect(panel.render(45).map(visibleWidth)).toEqual(Array(8).fill(45));
		}
	});
});

describe("sidePanelWidthFor", () => {
	it("is 40 percent of the terminal clamped to 40..90 columns, and 0 below 100 columns", () => {
		expect(sidePanelWidthFor(99)).toBe(0);
		expect(sidePanelWidthFor(100)).toBe(40);
		expect(sidePanelWidthFor(150)).toBe(60);
		expect(sidePanelWidthFor(250)).toBe(90);
		expect(sidePanelWidthFor(400)).toBe(90);
	});
});
