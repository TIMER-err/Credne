import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	Container,
	type OverlayHandle,
	Text,
	type TUI,
	type WheelScrollLines,
} from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager, type TuiMode } from "../src/core/settings-manager.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import type { GitOutput, GitRunner } from "../src/modes/interactive/components/git-runner.ts";
import type { SidePanel } from "../src/modes/interactive/components/side-panel.ts";
import {
	reserveFullscreenColumns,
	reserveRegularColumns,
	type TranscriptReservation,
} from "../src/modes/interactive/components/side-panel-layout.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { SidePanelController, type SidePanelHost } from "../src/modes/interactive/side-panel-controller.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

// A directory outside any repository, so the real git runner reaches the "Not a git repository" state.
const plainDirectory = mkdtempSync(join(tmpdir(), "pi-side-panel-"));
const dockLine = "E".repeat(110);

beforeAll(() => initTheme("dark"));
afterAll(() => rmSync(plainDirectory, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

type StatusMock = ReturnType<typeof vi.fn<(message: string) => void>>;

function createHost(
	ui: TUI,
	reserve: (getWidth: () => number) => TranscriptReservation,
): SidePanelHost & { showStatus: StatusMock } {
	const session = SessionManager.inMemory(plainDirectory);
	const settings = SettingsManager.inMemory();
	return {
		ui,
		getSessionManager: () => session,
		getSettingsManager: () => settings,
		getCloseHint: () => "/diff",
		showStatus: vi.fn<(message: string) => void>(),
		reserveTranscriptColumns: reserve,
	};
}

/** The pieces of the interactive layout: a long transcript, a one-line input, and a footer. */
function createParts(): { transcript: Component; editor: Component; footer: Component } {
	return {
		transcript: new Text("x".repeat(300), 0, 0),
		editor: new Text(dockLine, 0, 0),
		footer: new Text("FOOTER", 0, 0),
	};
}

function createRegular(columns = 120, rows = 12) {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = createInteractiveTui({ tuiMode: "regular", showHardwareCursor: false, logDirectory: "/tmp", terminal });
	const parts = createParts();
	const children = [parts.transcript, parts.editor, parts.footer];
	for (const child of children) tui.addChild(child);
	const host = createHost(tui, (getWidth) =>
		reserveRegularColumns(tui, { transcript: [parts.transcript], dock: [parts.editor, parts.footer] }, getWidth),
	);
	return { terminal, tui, parts, children, host, controller: new SidePanelController(host) };
}

function createFullscreen(columns = 120, rows = 12, transcript: Component = createParts().transcript) {
	const terminal = new VirtualTerminal(columns, rows);
	const tui = createInteractiveTui({
		tuiMode: "fullscreen",
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
	});
	const viewport = createChatViewport({
		document: transcript,
		pendingMessages: new Container(),
		status: new Container(),
		editor: new Text(dockLine, 0, 0),
		footer: new Text("FOOTER", 0, 0),
	});
	tui.setLayoutRoot(viewport.root);
	const host = createHost(tui, (getWidth) => reserveFullscreenColumns(viewport, getWidth));
	return { terminal, tui, viewport, host, controller: new SidePanelController(host) };
}

async function screen(terminal: VirtualTerminal): Promise<string[]> {
	await terminal.waitForRender();
	return terminal.getViewport();
}

/** Wait for the closed layout: the transcript at the full width. */
async function expectClosed(terminal: VirtualTerminal, contentWidth: number): Promise<void> {
	await vi.waitFor(async () => {
		const rows = await screen(terminal);
		expect(rows[0]).toBe("x".repeat(contentWidth));
		expect(rows.some((row) => row.includes("│"))).toBe(false);
	});
}

/**
 * Wait for the open layout: the transcript narrowed to `contentWidth` with the panel beside it, and the input line
 * and footer at the full width below the panel.
 */
async function expectOpen(terminal: VirtualTerminal, contentWidth: number, panelText: string): Promise<void> {
	await vi.waitFor(async () => {
		const rows = await screen(terminal);
		expect(rows[0]!.startsWith(`${"x".repeat(contentWidth)}│`)).toBe(true);
		expect(rows.join("\n")).toContain(panelText);
		const dockRow = rows.findIndex((row) => row.trimEnd() === dockLine);
		expect(dockRow).toBeGreaterThan(0);
		expect(rows.at(-1)?.trimEnd()).toBe("FOOTER");
		const borderRows = rows.flatMap((row, index) => (row.includes("│") ? [index] : []));
		expect(Math.max(...borderRows)).toBe(dockRow - 1);
	});
}

describe("SidePanelController in regular mode", () => {
	it("narrows only the transcript, stops the panel above the input, and restores everything on close", async () => {
		const { terminal, tui, children, controller } = createRegular();
		tui.start();
		try {
			await expectClosed(terminal, 120);
			expect(tui.children).toEqual(children);

			controller.open();
			expect(controller.isOpen).toBe(true);
			expect(tui.children).not.toEqual(children);
			await expectOpen(terminal, 72, "Not a git repository");
			expect((await screen(terminal))[0]).toContain("/diff to close");

			controller.close();
			expect(controller.isOpen).toBe(false);
			expect(tui.hasOverlayEntries).toBe(false);
			expect(tui.children).toEqual(children);
			await expectClosed(terminal, 120);
		} finally {
			controller.close();
			tui.stop();
		}
	});

	it("follows terminal resizes and hides on a terminal narrower than 100 columns", async () => {
		const { terminal, tui, controller } = createRegular();
		tui.start();
		try {
			controller.open();
			await expectOpen(terminal, 72, "Not a git repository");

			terminal.resize(200, 12);
			await expectOpen(terminal, 120, "Not a git repository");

			terminal.resize(90, 12);
			await expectClosed(terminal, 90);
			expect(controller.isOpen).toBe(true);

			terminal.resize(150, 12);
			await expectOpen(terminal, 90, "Not a git repository");
		} finally {
			controller.close();
			tui.stop();
		}
	});

	it("refuses to open on a terminal narrower than 100 columns and says why", () => {
		const { tui, children, host, controller } = createRegular(80);
		tui.start();
		try {
			controller.open();

			expect(controller.isOpen).toBe(false);
			expect(tui.hasOverlayEntries).toBe(false);
			expect(tui.children).toEqual(children);
			expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining("100 columns"));
		} finally {
			tui.stop();
		}
	});

	it("keeps keyboard focus on the input component", () => {
		const { terminal, tui, parts, controller } = createRegular();
		const input = Object.assign(parts.editor, { handleInput: vi.fn() });
		tui.setFocus(input);
		tui.start();
		try {
			controller.open();
			terminal.sendInput("a");

			expect(tui.getFocusedComponent()).toBe(input);
			expect(input.handleInput).toHaveBeenCalledWith("a");
		} finally {
			controller.close();
			tui.stop();
		}
	});

	it("closes for suspend and opens again on resume", () => {
		const { tui, children, controller } = createRegular();
		tui.start();
		try {
			expect(controller.suspend()()).toBeUndefined();
			expect(controller.isOpen).toBe(false);

			controller.open();
			const resume = controller.suspend();
			expect(controller.isOpen).toBe(false);
			expect(tui.hasOverlayEntries).toBe(false);
			expect(tui.children).toEqual(children);
			resume();
			expect(controller.isOpen).toBe(true);
			expect(tui.hasOverlayEntries).toBe(true);
		} finally {
			controller.close();
			tui.stop();
		}
	});
});

describe("SidePanelController in fullscreen mode", () => {
	it("narrows only the transcript row, stops the panel above the input, and restores the layout on close", async () => {
		const { terminal, tui, viewport, controller } = createFullscreen();
		tui.start();
		try {
			await expectClosed(terminal, 120);
			expect((viewport.root as Container).children[0]).toBe(viewport.transcript);

			controller.open();
			expect((viewport.root as Container).children[0]).not.toBe(viewport.transcript);
			await expectOpen(terminal, 72, "Not a git repository");

			terminal.resize(200, 12);
			await expectOpen(terminal, 120, "Not a git repository");

			controller.close();
			expect((viewport.root as Container).children[0]).toBe(viewport.transcript);
			terminal.resize(120, 12);
			await expectClosed(terminal, 120);
		} finally {
			controller.close();
			tui.stop();
		}
	});

	it("captures divider drags outside the panel and preserves the dock and preferred width", async () => {
		const { terminal, tui, controller } = createFullscreen(120, 16);
		tui.start();
		try {
			controller.open();
			await expectOpen(terminal, 72, "Not a git repository");
			terminal.sendInput("\x1b[<0;73;3M");
			terminal.sendInput("\x1b[<32;51;3M");
			await expectOpen(terminal, 50, "Not a git repository");
			terminal.sendInput("\x1b[<0;51;3m");
			await expectOpen(terminal, 50, "Not a git repository");
			terminal.sendInput("\x1b[<0;51;3M");
			terminal.sendInput("\x1b[<32;1;3M");
			terminal.sendInput("\x1b[<0;1;3m");
			await expectOpen(terminal, 40, "Not a git repository");
			controller.close();
			controller.open();
			await expectOpen(terminal, 40, "Not a git repository");
			terminal.resize(111, 16);
			await expectOpen(terminal, 40, "Not a git repository");
		} finally {
			controller.close();
			tui.stop();
		}
	});

	it("jumps from the file index to the clicked file through terminal mouse events", async () => {
		const { terminal, tui, host } = createFullscreen(120, 30);
		const { run } = createRepositoryRunner();
		const session = SessionManager.inMemory(repositoryDirectory);
		const controller = new SidePanelController({ ...host, getSessionManager: () => session }, run);
		tui.start();
		try {
			controller.open();
			await vi.waitFor(async () => expect((await screen(terminal)).join("\n")).toContain("new"));
			terminal.sendInput("\x1b[<0;80;4M");
			terminal.sendInput("\x1b[<0;80;4m");
			await vi.waitFor(async () => {
				const rows = await screen(terminal);
				const diffStart = rows.findIndex((row) => row.includes("──"));
				expect(rows[diffStart + 1]).toContain("b.ts");
			});
		} finally {
			controller.close();
			tui.stop();
		}
	});

	it("gives wheel events over the panel to the panel and wheel events elsewhere to the transcript", async () => {
		const lines = Array.from({ length: 60 }, (_, index) => `row ${index + 1}`).join("\n");
		const { terminal, tui, controller } = createFullscreen(120, 12, new Text(lines, 0, 0));
		tui.start();
		try {
			controller.open();
			await vi.waitFor(async () => {
				const rows = await screen(terminal);
				expect(rows.join("\n")).toContain("Not a git repository");
			});
			const firstRow = async () => (await screen(terminal))[0]!;
			const before = await firstRow();

			// Column 100 is inside the panel (columns 73-120): the wheel does not move the transcript.
			terminal.sendInput("\x1b[<64;100;3M");
			expect(await firstRow()).toBe(before);

			terminal.sendInput("\x1b[<64;10;3M");
			await vi.waitFor(async () => expect(await firstRow()).not.toBe(before));
		} finally {
			controller.close();
			tui.stop();
		}
	});
});

describe("SidePanelController sections", () => {
	it("creates a section once, shows it above the changes by order, and disposes it on replace, removal and clear", async () => {
		const { terminal, tui, controller } = createRegular(120, 16);
		tui.start();
		const created: string[] = [];
		const disposed: string[] = [];
		const factory = (name: string) => () => {
			created.push(name);
			return { render: () => [`section ${name}`], invalidate: () => {}, dispose: () => disposed.push(name) };
		};
		try {
			controller.setSection("late", factory("late"), 2);
			controller.setSection("early", factory("early"), -1);
			controller.open();
			await vi.waitFor(async () => {
				const rows = await screen(terminal);
				const early = rows.findIndex((row) => row.includes("section early"));
				const late = rows.findIndex((row) => row.includes("section late"));
				const changes = rows.findIndex((row) => row.includes("Not a git repository"));
				expect(early).toBeGreaterThanOrEqual(0);
				expect(late).toBeGreaterThan(early);
				expect(changes).toBeGreaterThan(late);
			});
			expect(created).toEqual(["late", "early"]);

			controller.setSection("late", factory("late-2"), 2);
			expect(disposed).toEqual(["late"]);
			controller.setSection("early", undefined);
			expect(disposed).toEqual(["late", "early"]);
			await vi.waitFor(async () => {
				const rows = await screen(terminal);
				expect(rows.some((row) => row.includes("section late-2"))).toBe(true);
				expect(rows.some((row) => row.includes("section early"))).toBe(false);
			});

			controller.clearSections();
			expect(disposed).toEqual(["late", "early", "late-2"]);
		} finally {
			controller.close();
			tui.stop();
		}
	});

	it("keeps sections across close and open", async () => {
		const { terminal, tui, controller } = createRegular(120, 16);
		tui.start();
		const dispose = vi.fn();
		try {
			controller.setSection("a", () => ({ render: () => ["kept section"], invalidate: () => {}, dispose }));
			controller.open();
			controller.close();
			controller.open();

			await vi.waitFor(async () => {
				expect((await screen(terminal)).some((row) => row.includes("kept section"))).toBe(true);
			});
			expect(dispose).not.toHaveBeenCalled();
		} finally {
			controller.close();
			tui.stop();
		}
	});
});

describe("InteractiveMode renderer switch with the panel open", () => {
	it("closes the panel for the switch and opens it again on the new renderer, in both directions", async () => {
		const terminal = new VirtualTerminal(120, 12);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const parts = createParts();
		const viewport = createChatViewport({
			document: parts.transcript,
			pendingMessages: new Container(),
			status: new Container(),
			editor: parts.editor,
			footer: parts.footer,
		});

		type SwitchContext = {
			runtimeHost: {
				session: {
					settingsManager: {
						getFullscreenCopyOnSelect: () => boolean;
						getFullscreenWheelScrollLines: () => WheelScrollLines;
					};
				};
			};
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			fullscreenLayoutRoot: Component;
			sidePanel: SidePanelController;
			options: { tuiMode?: TuiMode };
			themeController: { rebindTui: () => void };
			extensionTerminalInputSubscriptions: Set<never>;
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: {
				session: {
					settingsManager: { getFullscreenCopyOnSelect: () => true, getFullscreenWheelScrollLines: () => "auto" },
				},
			},
			renderer,
			ui: undefined as unknown as TUI,
			fullscreenLayoutRoot: viewport.root,
			sidePanel: undefined as unknown as SidePanelController,
			options: { tuiMode: "regular" as TuiMode },
			themeController: { rebindTui: () => {} },
			extensionTerminalInputSubscriptions: new Set<never>(),
		}) as SwitchContext;
		const stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const controller = new SidePanelController(
			createHost(stableUi, (getWidth) =>
				context.renderer.mode === "fullscreen"
					? reserveFullscreenColumns(viewport, getWidth)
					: reserveRegularColumns(
							context.renderer,
							{ transcript: [parts.transcript], dock: [parts.editor, parts.footer] },
							getWidth,
						),
			),
		);
		context.sidePanel = controller;
		const { switchTuiMode } = InteractiveMode.prototype as unknown as {
			switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		for (const child of [parts.transcript, parts.editor, parts.footer]) renderer.addChild(child);
		renderer.start();
		try {
			controller.open();
			await expectOpen(terminal, 72, "Not a git repository");

			expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
			expect(stableUi.mode).toBe("fullscreen");
			expect(controller.isOpen).toBe(true);
			await expectOpen(terminal, 72, "Not a git repository");

			expect(switchTuiMode.call(context, "regular", false)).toBe(true);
			expect(stableUi.mode).toBe("regular");
			expect(controller.isOpen).toBe(true);
			await expectOpen(terminal, 72, "Not a git repository");

			controller.close();
			await expectClosed(terminal, 120);
			expect(context.renderer.children).toEqual([parts.transcript, parts.editor, parts.footer]);
		} finally {
			controller.close();
			context.renderer.stop();
		}
	});
});

const unifiedDiff = ["@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\n");
const baselineCommitId = "a".repeat(40);

/** A directory that findGitPaths takes for a repository, so the controller tests can use a fake git. */
const repositoryDirectory = mkdtempSync(join(tmpdir(), "pi-side-panel-repository-"));
mkdirSync(join(repositoryDirectory, ".git"));
writeFileSync(join(repositoryDirectory, ".git", "HEAD"), "ref: refs/heads/main\n");
afterAll(() => rmSync(repositoryDirectory, { recursive: true, force: true }));

/**
 * A git runner that answers like a repository with a clean tree and three changed files, and counts its calls.
 * `gate` holds back the file list, `baselineGate` the baseline's `git stash create`.
 */
function createRepositoryRunner(options: { gate?: Promise<void>; baselineGate?: Promise<void> } = {}) {
	let running = 0;
	const state = { maxRunning: 0, diffSignals: [] as AbortSignal[] };
	const run = vi.fn<GitRunner>(async (args, _cwd, signal): Promise<GitOutput> => {
		running++;
		state.maxRunning = Math.max(state.maxRunning, running);
		try {
			const ok = (stdout: string): GitOutput => ({ status: "ok", stdout, isTruncated: false });
			if (args[0] === "stash") {
				await options.baselineGate;
				return ok("");
			}
			if (args[0] === "rev-parse") return ok(`${baselineCommitId}\n`);
			if (args[0] === "ls-files") return ok("");
			if (args.includes("--numstat")) {
				await options.gate;
				return ok("1\t1\ta.ts\0" + "1\t1\tb.ts\0" + "1\t1\tc.ts\0");
			}
			state.diffSignals.push(signal);
			return ok(unifiedDiff);
		} finally {
			running--;
		}
	});
	return { run, state };
}

function createFakeUi() {
	const handle = { hide: vi.fn() } as unknown as OverlayHandle;
	const requestRender = vi.fn();
	const ui = {
		terminal: { columns: 120, rows: 20 },
		showOverlay: vi.fn(() => handle),
		requestRender,
	} as unknown as TUI;
	return { ui, handle, requestRender };
}

function createFakeHost(ui: TUI, cwd = repositoryDirectory) {
	const reservation = { getRows: () => 10, release: vi.fn() };
	const session = SessionManager.inMemory(cwd);
	const settings = SettingsManager.inMemory();
	const host: SidePanelHost = {
		ui,
		getSessionManager: () => session,
		getSettingsManager: () => settings,
		getCloseHint: () => "/diff",
		showStatus: vi.fn(),
		reserveTranscriptColumns: vi.fn(() => reservation),
	};
	return { host, reservation, session, settings };
}

/** Let the controller's awaited git steps finish. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}

/** Git calls of one capture: stash create, HEAD, untracked files, and a reference retaining the snapshot. */
const baselineGitCalls = 4;
/** Git calls of one refresh: the file lists and each of the three files' diffs. */
const refreshGitCalls = 5;

function gitCommands(run: ReturnType<typeof createRepositoryRunner>["run"]): string[] {
	return run.mock.calls.map(([args]) => (args.includes("--numstat") ? "numstat" : args[0]!));
}

describe("SidePanelController persistence", () => {
	it("restores enabled state and width, and does not disable them for suspend or shutdown", async () => {
		const { ui } = createFakeUi();
		const { host, settings } = createFakeHost(ui, plainDirectory);
		settings.setSidePanelEnabled(true);
		settings.setSidePanelWidth(64);
		const controller = new SidePanelController(host);
		controller.beginSession();
		expect(controller.isOpen).toBe(true);
		expect(vi.mocked(ui.showOverlay).mock.calls[0]?.[1]?.width).toBe(64);
		const resume = controller.suspend();
		expect(controller.isOpen).toBe(false);
		expect(settings.getSidePanelEnabled()).toBe(true);
		resume();
		controller.stop();
		expect(settings.getSidePanelEnabled()).toBe(true);
		await settings.flush();
		const restartedSettings = SettingsManager.inMemory(settings.getGlobalSettings());
		const restarted = new SidePanelController({ ...host, getSettingsManager: () => restartedSettings });
		restarted.beginSession();
		expect(restarted.isOpen).toBe(true);
		expect(vi.mocked(ui.showOverlay).mock.calls.at(-1)?.[1]?.width).toBe(64);
		restarted.close();
		expect(restartedSettings.getSidePanelEnabled()).toBe(false);
	});

	it("persists divider drags and restores the preferred width after a restart", async () => {
		const { terminal, tui, host } = createFullscreen(120, 16);
		const settings = SettingsManager.inMemory();
		const controller = new SidePanelController({ ...host, getSettingsManager: () => settings });
		tui.start();
		try {
			controller.open();
			await expectOpen(terminal, 72, "Not a git repository");
			terminal.sendInput("\x1b[<0;73;3M");
			terminal.sendInput("\x1b[<32;51;3M");
			terminal.sendInput("\x1b[<0;51;3m");
			await expectOpen(terminal, 50, "Not a git repository");
			expect(settings.getSidePanelWidth()).toBe(70);
			controller.stop();
			await settings.flush();
			const restarted = new SidePanelController({
				...host,
				getSettingsManager: () => settings,
			});
			restarted.beginSession();
			await expectOpen(terminal, 50, "Not a git repository");
			restarted.stop();
		} finally {
			controller.stop();
			tui.stop();
		}
	});

	it("keeps the enabled preference when restored on a narrow terminal and appears when it grows", async () => {
		const { terminal, tui, host } = createFullscreen(80);
		const settings = SettingsManager.inMemory({ sidePanel: { enabled: true } });
		const controller = new SidePanelController({ ...host, getSettingsManager: () => settings });
		tui.start();
		try {
			controller.beginSession();
			await expectClosed(terminal, 80);
			expect(settings.getSidePanelEnabled()).toBe(true);
			terminal.resize(120, 12);
			await expectOpen(terminal, 72, "Not a git repository");
		} finally {
			controller.stop();
			tui.stop();
		}
	});

	it("keeps the panel disabled on a new session when the saved preference is disabled", () => {
		const { ui } = createFakeUi();
		const { host } = createFakeHost(ui, plainDirectory);
		const controller = new SidePanelController(host);
		controller.beginSession();
		expect(controller.isOpen).toBe(false);
		expect(ui.showOverlay).not.toHaveBeenCalled();
	});

	it.each(["changes", "diff"] as const)("drops an in-flight %s result when switching sessions", async (kind) => {
		const { ui } = createFakeUi();
		const { host, session } = createFakeHost(ui);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { run } = createRepositoryRunner();
		const defaults = run.getMockImplementation()!;
		let held = false;
		run.mockImplementation(async (...args) => {
			if (!held && args[0].includes(kind === "changes" ? "--numstat" : "-U3")) {
				held = true;
				await gate;
			}
			return defaults(...args);
		});
		const controller = new SidePanelController(host, run);
		controller.beginSession();
		controller.open();
		await settle();
		expect(held).toBe(true);
		const oldPanel = vi.mocked(ui.showOverlay).mock.calls[0]![0] as SidePanel;
		const oldChanges = vi.spyOn(oldPanel, "setChanges");
		const oldDiff = vi.spyOn(oldPanel, "setDiff");
		session.newSession();
		controller.beginSession();
		const newPanel = vi.mocked(ui.showOverlay).mock.calls[1]![0] as SidePanel;
		expect(newPanel).not.toBe(oldPanel);
		const newChanges = vi.spyOn(newPanel, "setChanges");
		release();
		await settle();
		expect(oldChanges).not.toHaveBeenCalled();
		expect(oldDiff).not.toHaveBeenCalled();
		expect(newChanges).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
		controller.stop();
	});
});

describe("SidePanelController cost", () => {
	it("does no work while closed: no git, no timers, no rendering of sections, no layout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { run } = createRepositoryRunner();
		const { ui, requestRender } = createFakeUi();
		const { host } = createFakeHost(ui);
		const controller = new SidePanelController(host, run);
		const render = vi.fn(() => ["section"]);

		controller.handleAgentEvent("agent_end");
		controller.handleAgentEvent("tool_execution_end");
		controller.scheduleRefresh();
		controller.selectFile(1);
		controller.scrollDiffPage(1);
		controller.setSection("a", () => ({ render, invalidate: () => {} }));
		controller.setSection("a", undefined);
		controller.clearSections();
		await vi.advanceTimersByTimeAsync(5000);

		expect(run).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
		expect(host.reserveTranscriptColumns).not.toHaveBeenCalled();
		expect(ui.showOverlay).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("captures the baseline once per session while closed, and runs no other git", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { run } = createRepositoryRunner();
		const { ui, requestRender } = createFakeUi();
		const { host, session } = createFakeHost(ui);
		const controller = new SidePanelController(host, run);

		controller.beginSession();
		await settle();
		expect(gitCommands(run).sort()).toEqual(["ls-files", "rev-parse", "stash", "update-ref"]);

		controller.handleAgentEvent("agent_end");
		controller.handleAgentEvent("tool_execution_end");
		await vi.advanceTimersByTimeAsync(60_000);
		await settle();
		expect(run).toHaveBeenCalledTimes(baselineGitCalls);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);

		// A new session captures its own starting state.
		session.newSession();
		controller.beginSession();
		await settle();
		expect(run).toHaveBeenCalledTimes(2 * baselineGitCalls);
	});

	it("spawns no git for a session outside a repository, not even to look", async () => {
		const { run } = createRepositoryRunner();
		const { ui } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui, plainDirectory).host, run);

		controller.beginSession();
		await settle();

		expect(run).not.toHaveBeenCalled();
	});

	it("runs git on open and after agent_end or tool_execution_end, merged by the debounce, and never otherwise", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { run } = createRepositoryRunner();
		const { ui } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui).host, run);
		controller.beginSession();
		await settle();
		run.mockClear();

		controller.open();
		await settle();
		expect(run).toHaveBeenCalledTimes(refreshGitCalls);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(run).toHaveBeenCalledTimes(refreshGitCalls);

		controller.handleAgentEvent("message_update");
		controller.handleAgentEvent("turn_start");
		expect(vi.getTimerCount()).toBe(0);

		for (const type of ["tool_execution_end", "tool_execution_end", "agent_end"]) {
			controller.handleAgentEvent(type);
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(run).toHaveBeenCalledTimes(refreshGitCalls);
		await vi.advanceTimersByTimeAsync(300);
		await settle();
		expect(run).toHaveBeenCalledTimes(2 * refreshGitCalls);

		controller.close();
		controller.handleAgentEvent("agent_end");
		await vi.advanceTimersByTimeAsync(5000);
		await settle();
		expect(run).toHaveBeenCalledTimes(2 * refreshGitCalls);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("diffs against the baseline that was captured, not against HEAD", async () => {
		const { run } = createRepositoryRunner();
		const { ui } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui).host, run);
		controller.beginSession();
		await settle();

		controller.open();
		await settle();

		const numstat = run.mock.calls.find(([args]) => args.includes("--numstat"))!;
		const fileDiff = run.mock.calls.find(([args]) => args.includes("-U3"))!;
		expect(numstat[0]).toContain(baselineCommitId);
		expect(numstat[0]).not.toContain("HEAD");
		expect(fileDiff[0].slice(-3)).toEqual([baselineCommitId, "--", "a.ts"]);
		controller.close();
	});

	it("waits for the baseline when the panel is opened before it is captured", async () => {
		let release = () => {};
		const baselineGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { run } = createRepositoryRunner({ baselineGate });
		const { ui } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui).host, run);

		controller.beginSession();
		controller.open();
		await settle();
		expect(gitCommands(run).sort()).toEqual(["ls-files", "rev-parse", "stash"]);

		release();
		await settle();

		expect(gitCommands(run).sort()).toEqual(
			["diff", "diff", "diff", "ls-files", "ls-files", "numstat", "rev-parse", "stash", "update-ref"].sort(),
		);
		controller.close();
	});

	it("captures the baseline by itself when the panel opens before any session began", async () => {
		const { run } = createRepositoryRunner();
		const { ui } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui).host, run);

		controller.open();
		await settle();

		expect(run).toHaveBeenCalledTimes(baselineGitCalls + refreshGitCalls);
		controller.close();
	});

	it("measures a new session from its own baseline, and refreshes an open panel", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { run } = createRepositoryRunner();
		const { ui } = createFakeUi();
		const { host, session } = createFakeHost(ui);
		const controller = new SidePanelController(host, run);
		controller.beginSession();
		controller.open();
		await settle();
		run.mockClear();

		session.newSession();
		controller.beginSession();
		await vi.advanceTimersByTimeAsync(300);
		await settle();

		expect(run).toHaveBeenCalledTimes(baselineGitCalls + refreshGitCalls);
		controller.close();
	});

	it("starts no git while a refresh is still running, then refreshes once more", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { run, state } = createRepositoryRunner({ gate });
		const { ui } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui).host, run);
		controller.beginSession();
		await settle();
		run.mockClear();
		state.maxRunning = 0;

		controller.open();
		await settle();
		// The changed files and the untracked files were requested, and the file list is waiting on the gate.
		expect(run).toHaveBeenCalledTimes(2);

		controller.handleAgentEvent("agent_end");
		controller.handleAgentEvent("tool_execution_end");
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(2);

		release();
		await settle();
		expect(gitCommands(run).filter((command) => command === "numstat")).toHaveLength(2);
		expect(gitCommands(run).filter((command) => command === "diff")).toHaveLength(3);
		expect(run).toHaveBeenCalledTimes(7);
		expect(state.maxRunning).toBeLessThanOrEqual(2);
		controller.close();
	});

	it("drops the result of a load that is in flight when the panel closes, and runs nothing after", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { run } = createRepositoryRunner({ gate });
		const { ui, requestRender } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui).host, run);
		controller.beginSession();
		await settle();
		run.mockClear();

		controller.open();
		await settle();
		expect(run).toHaveBeenCalledTimes(2);
		controller.close();
		const rendersAfterClose = requestRender.mock.calls.length;

		release();
		await settle();

		expect(run).toHaveBeenCalledTimes(2);
		expect(requestRender).toHaveBeenCalledTimes(rendersAfterClose);
		expect(controller.isOpen).toBe(false);
	});

	it("loads every file once and reuses its diff when selection moves", async () => {
		const { run, state } = createRepositoryRunner();
		const { ui } = createFakeUi();
		const controller = new SidePanelController(createFakeHost(ui).host, run);
		controller.beginSession();

		controller.open();
		await settle();
		expect(state.diffSignals).toHaveLength(3);
		expect(run.mock.calls.filter(([args]) => args.includes("-U3")).map(([args]) => args.at(-1))).toEqual([
			"a.ts",
			"b.ts",
			"c.ts",
		]);

		controller.selectFile(1);
		controller.selectFile(1);
		await settle();

		expect(state.diffSignals.map((signal) => signal.aborted)).toEqual([false, false, false]);
		controller.close();
	});
});
