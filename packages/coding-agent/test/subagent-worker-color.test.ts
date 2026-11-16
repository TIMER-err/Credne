import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { SubagentConfig } from "../src/extensions/subagent/runner.ts";
import { type SpawnInput, WorkerTeam } from "../src/extensions/subagent/team.ts";
import { workerColorAt, workerPalette } from "../src/extensions/subagent/worker-color.ts";
import { getThemeByName, initTheme } from "../src/modes/interactive/theme/theme.ts";

// Workers run as child processes; a fake session that settles only when aborted keeps these tests in-process.
vi.mock("../src/extensions/subagent/runner.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createWorkerSession: () => ({
		run: (_task: string, _step: number | undefined, signal: AbortSignal | undefined) =>
			new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		send: async () => false,
		dispose: async () => {},
	}),
}));

beforeAll(() => initTheme("dark"));

describe("worker palette", () => {
	it("cycles in order when workers outnumber colors", () => {
		for (let index = 0; index < workerPalette.length * 2 + 1; index++) {
			expect(workerColorAt(index)).toBe(workerPalette[index % workerPalette.length]);
		}
		expect(workerColorAt(workerPalette.length)).toBe(workerColorAt(0));
	});

	it("has no repeated token and avoids the tokens that carry a status", () => {
		expect(new Set(workerPalette).size).toBe(workerPalette.length);
		for (const status of ["accent", "success", "error", "warning", "muted", "dim", "text"]) {
			expect(workerPalette as readonly string[]).not.toContain(status);
		}
	});

	it.each(["dark", "light"])("gives every color a different value in the %s theme", (name) => {
		const theme = getThemeByName(name);
		if (!theme) throw new Error(`Missing theme ${name}`);
		const values = workerPalette.map((token) => JSON.stringify(theme.colors[token]));
		expect(new Set(values).size).toBe(workerPalette.length);
	});
});

describe("worker team colors", () => {
	let team: WorkerTeam | undefined;
	const config: SubagentConfig = { name: "worker", source: "builtin", systemPrompt: "You are a worker." };

	function spawn(name: string): string {
		const input: SpawnInput = {
			name,
			task: "Locate renderer",
			defaults: { model: "fixture/model", thinkingLevel: "off", context: { mode: "fresh", sessionId: "parent" } },
			resolved: { agent: config, available: [config], cwd: process.cwd() },
		};
		return team!.spawn(input).id;
	}

	function colors(): string[] {
		return team!.getViews().map((view) => view.color);
	}

	afterEach(async () => {
		await team?.dispose();
		team = undefined;
	});

	it("assigns colors in spawn order and cycles through the palette", () => {
		team = new WorkerTeam({ sendMessage: () => {} } as unknown as ExtensionAPI);
		for (let index = 0; index < workerPalette.length + 2; index++) spawn(`agent${index}`);
		expect(colors()).toEqual(Array.from({ length: workerPalette.length + 2 }, (_, index) => workerColorAt(index)));
	});

	it("keeps a worker's color when another worker is cancelled and gives the next spawn a fresh one", async () => {
		team = new WorkerTeam({ sendMessage: () => {} } as unknown as ExtensionAPI);
		const first = spawn("first");
		spawn("second");
		await team.cancel(first);
		const third = spawn("third");
		const byId = new Map(team.getViews().map((view) => [view.id, view.color]));
		expect(byId.get(first)).toBe(workerColorAt(0));
		expect(byId.get(third)).toBe(workerColorAt(2));
		expect(colors()).toEqual([workerColorAt(0), workerColorAt(1), workerColorAt(2)]);
	});
	it("looks a worker's identity up by ID and counts workers without building views", async () => {
		team = new WorkerTeam({ sendMessage: () => {} } as unknown as ExtensionAPI);
		const first = spawn("first");
		const second = spawn("second");
		expect(team.count()).toBe(2);
		expect(team.getIdentity(second)).toEqual({ id: second, name: "second", color: workerColorAt(1) });
		expect(team.getIdentity("unknown")).toBeUndefined();
		await team.cancel(first);
		// A cancelled worker keeps its place and its color.
		expect(team.count()).toBe(2);
		expect(team.getIdentity(first)?.color).toBe(workerColorAt(0));
		await team.dispose();
		expect(team.count()).toBe(0);
		expect(team.getIdentity(second)).toBeUndefined();
	});
});
