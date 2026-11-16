import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ReadonlySessionManager } from "../src/core/session-manager.ts";
import type { SubagentUsageSnapshot } from "../src/core/session-usage.ts";
import { PrefixWarmup } from "../src/extensions/subagent/prefix-warmup.ts";
import {
	aggregateUsage,
	cacheHitRate,
	type OnUpdateCallback,
	type SubagentConfig,
} from "../src/extensions/subagent/runner.ts";
import { WorkerTeam } from "../src/extensions/subagent/team.ts";

const workerFixture = fileURLToPath(new URL("./fixtures/subagent-cache-worker.mjs", import.meta.url));

async function flushPromises(): Promise<void> {
	for (let count = 0; count < 8; count++) await Promise.resolve();
}

describe("subagent prefix admission", () => {
	afterEach(() => vi.useRealTimers());

	it("retains a warm prefix for later siblings and expires it conservatively", async () => {
		vi.useFakeTimers();
		const warmup = new PrefixWarmup();
		const release = await warmup.enter("prefix", undefined);
		release?.(true);
		expect(await warmup.enter("prefix", undefined)).toBeUndefined();
		vi.advanceTimersByTime(300001);
		expect(await warmup.enter("prefix", undefined)).toBeTypeOf("function");
	});

	it("elects another writer when the first response arrives after its cache lifetime", async () => {
		vi.useFakeTimers();
		const warmup = new PrefixWarmup();
		const release = await warmup.enter("prefix", undefined);
		const waiting = warmup.enter("prefix", undefined);
		vi.advanceTimersByTime(300001);
		release?.(true);
		expect(await waiting).toBeTypeOf("function");
	});

	it("shares a system prefix across cutoffs without releasing another cutoff's siblings", async () => {
		const warmup = new PrefixWarmup();
		const first = await warmup.enter("cutoff-a", undefined, "system");
		const otherLeader = warmup.enter("cutoff-b", undefined, "system");
		let hasOtherFollowerEntered = false;
		const otherFollower = warmup.enter("cutoff-b", undefined, "system").then((admission) => {
			hasOtherFollowerEntered = true;
			return admission;
		});
		first?.(true);
		const releaseOther = await otherLeader;
		await flushPromises();
		expect(releaseOther).toBeTypeOf("function");
		expect(hasOtherFollowerEntered).toBe(false);
		releaseOther?.(true);
		expect(await otherFollower).toBeUndefined();
	});
});

interface FixtureScenario {
	key?: string;
	retryKey?: string;
	releaseFile?: string;
	fail?: boolean;
	usage?: { input: number; cacheRead: number; cacheWrite: number }[];
	warmBefore?: { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }[];
	warmAfter?: { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }[];
	warmDuringWait?: { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }[];
	idleWarmAfter?: { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }[];
	extraEntries?: Array<"toolResult" | "branch_summary" | "compaction" | "usage">;
}

interface LogEntry {
	worker: string;
	step: "waiting" | "request" | "retry" | "ready";
	key?: string;
	argv?: string[];
	agentType?: string;
}

describe("subagent cache runtime", () => {
	let tempDir: string;
	let team: WorkerTeam;
	let originalScript: string;
	let snapshots: SubagentUsageSnapshot[];

	const config: SubagentConfig = { name: "worker", source: "builtin", systemPrompt: "You are a worker." };

	function spawn(scenario: FixtureScenario = {}, name = "worker", onUpdate?: OnUpdateCallback) {
		return team.spawn({
			name,
			task: JSON.stringify({ log: join(tempDir, "log.jsonl"), ...scenario }),
			defaults: { model: "fixture/model", thinkingLevel: "off", context: { mode: "fresh", sessionId: "parent" } },
			resolved: { agent: config, available: [config], cwd: tempDir },
			onUpdate,
		});
	}

	function readLog(): LogEntry[] {
		const log = join(tempDir, "log.jsonl");
		if (!existsSync(log)) return [];
		return readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as LogEntry);
	}

	async function waitForStep(step: LogEntry["step"], count: number): Promise<void> {
		await vi.waitFor(() => expect(readLog().filter((entry) => entry.step === step)).toHaveLength(count), {
			timeout: 5000,
			interval: 10,
		});
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-cache-runtime-"));
		snapshots = [];
		team = new WorkerTeam({
			sendMessage: () => {},
			appendEntry: (type: string, data: SubagentUsageSnapshot) => {
				expect(type).toBe("subagent-usage");
				snapshots.push(data);
			},
		} as unknown as ExtensionAPI);
		originalScript = process.argv[1];
		process.argv[1] = workerFixture;
	});

	it("counts active cache refreshes without changing assistant turns, first rate or context size", async () => {
		const updates: number[] = [];
		const worker = spawn(
			{
				usage: [{ input: 1, cacheRead: 2, cacheWrite: 0 }],
				warmBefore: [{ input: 7, cacheRead: 0, cacheWrite: 0, output: 2, cost: 0.2 }],
				warmAfter: [{ input: 0, cacheRead: 10, cacheWrite: 0, output: 3, cost: 0.3 }],
			},
			"worker",
			(update) => {
				if (update.details) updates.push(update.details.usage.cost);
			},
		);
		const result = await worker.result;
		expect(result.usage).toEqual({
			input: 8,
			output: 6,
			cacheRead: 12,
			cacheWrite: 0,
			cacheHitRate: 0.6,
			firstCacheHitRate: 2 / 3,
			cost: 0.5,
			contextTokens: 4,
			turns: 1,
		});
		expect(updates).toContain(0.5);
	});

	afterEach(async () => {
		await team.dispose();
		process.argv[1] = originalScript;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists lifetime snapshots for two workers, later runs and idle cache refreshes", async () => {
		const first = spawn({
			usage: [{ input: 3, cacheRead: 2, cacheWrite: 0 }],
			extraEntries: ["toolResult", "branch_summary", "compaction", "usage"],
			idleWarmAfter: [{ input: 0, cacheRead: 4, cacheWrite: 0, output: 0, cost: 0.4 }],
		});
		const second = spawn({ usage: [{ input: 5, cacheRead: 0, cacheWrite: 0 }] });
		await Promise.all([first.result, second.result]);
		await vi.waitFor(() => expect(snapshots.findLast((entry) => entry.workerId === first.id)?.usage.cost).toBe(1.4));
		expect(snapshots.findLast((entry) => entry.workerId === first.id)?.usage).toMatchObject({
			input: 11,
			output: 5,
			cacheRead: 6,
			cost: 1.4,
		});
		expect(snapshots.findLast((entry) => entry.workerId === second.id)?.usage.input).toBe(5);
		expect(
			await team.continue(
				first.id,
				JSON.stringify({ log: join(tempDir, "log.jsonl"), usage: [{ input: 7, cacheRead: 0, cacheWrite: 0 }] }),
			),
		).toBe("queued");
		await vi.waitFor(() => expect(team.getViews().find((view) => view.id === first.id)?.runs).toHaveLength(2));
		await vi.waitFor(() => expect(snapshots.findLast((entry) => entry.workerId === first.id)?.usage.input).toBe(18));
		expect(snapshots.findLast((entry) => entry.workerId === first.id)?.usage.cost).toBe(1.4);
	});

	it("stops appending to a parent whose session ID changed", async () => {
		await team.dispose();
		let sessionId = "parent";
		team = new WorkerTeam(
			{
				appendEntry: (_type: string, data: SubagentUsageSnapshot) => snapshots.push(data),
			} as unknown as ExtensionAPI,
			{ getSessionId: () => sessionId } as ReadonlySessionManager,
		);
		const releaseFile = join(tempDir, "release");
		const worker = spawn({
			releaseFile,
			warmDuringWait: [{ input: 1, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0.1 }],
			usage: [{ input: 10, cacheRead: 0, cacheWrite: 0 }],
		});
		await vi.waitFor(() => expect(snapshots).toHaveLength(1));
		sessionId = "successor";
		writeFileSync(releaseFile, "");
		expect((await worker.result).status).toBe("completed");
		expect(snapshots).toHaveLength(1);
	});

	it("retains billed usage from failed and cancelled runs", async () => {
		const failed = spawn({ fail: true, usage: [{ input: 8, cacheRead: 0, cacheWrite: 0 }] });
		expect((await failed.result).status).toBe("failed");
		expect(snapshots.findLast((entry) => entry.workerId === failed.id)?.usage.input).toBe(8);

		const cancelled = spawn({
			releaseFile: join(tempDir, "unreleased"),
			warmDuringWait: [{ input: 4, cacheRead: 0, cacheWrite: 0, output: 2, cost: 0.3 }],
		});
		await vi.waitFor(() =>
			expect(snapshots.findLast((entry) => entry.workerId === cancelled.id)?.usage.cost).toBe(0.3),
		);
		await team.cancel(cancelled.id);
		expect((await cancelled.result).status).toBe("aborted");
		expect(snapshots.findLast((entry) => entry.workerId === cancelled.id)?.usage).toMatchObject({
			input: 4,
			output: 2,
			cost: 0.3,
		});
	});

	it("waits through normalized start and releases siblings only at actual provider readiness", async () => {
		const releaseFile = join(tempDir, "ready");
		const leader = spawn({ releaseFile }, "plan-task-a");
		await waitForStep("request", 1);
		const siblings = [spawn({}, "plan-task-b"), spawn({}, "plan-task-c")];
		await waitForStep("waiting", 3);
		expect(readLog().filter((entry) => entry.step === "request")).toHaveLength(1);
		writeFileSync(releaseFile, "");
		const results = await Promise.all([leader.result, ...siblings.map((worker) => worker.result)]);
		expect(results.map((result) => result.status)).toEqual(["completed", "completed", "completed"]);
		const log = readLog();
		const readyIndex = log.findIndex((entry) => entry.step === "ready");
		expect(log.slice(0, readyIndex).filter((entry) => entry.step === "request")).toHaveLength(1);
	});

	it("transfers an aborted leader to one waiting sibling", async () => {
		const readyFile = join(tempDir, "ready");
		const leader = spawn({ releaseFile: join(tempDir, "unreleased") });
		await waitForStep("request", 1);
		const siblings = [spawn({ releaseFile: readyFile }), spawn({ releaseFile: readyFile })];
		await waitForStep("waiting", 3);
		await team.cancel(leader.id);
		expect((await leader.result).status).toBe("aborted");
		await waitForStep("request", 2);
		writeFileSync(readyFile, "");
		expect(
			(await Promise.all(siblings.map((worker) => worker.result))).every((result) => result.status === "completed"),
		).toBe(true);
	});

	it("transfers leadership after failure without starting every waiting sibling", async () => {
		const failedFile = join(tempDir, "fail");
		const readyFile = join(tempDir, "ready");
		const leader = spawn({ releaseFile: failedFile, fail: true });
		await waitForStep("request", 1);
		const siblings = [spawn({ releaseFile: readyFile }), spawn({ releaseFile: readyFile })];
		await waitForStep("waiting", 3);
		writeFileSync(failedFile, "");
		expect((await leader.result).status).toBe("failed");
		await waitForStep("request", 2);
		expect(readLog().filter((entry) => entry.step === "ready")).toHaveLength(0);
		writeFileSync(readyFile, "");
		expect(
			(await Promise.all(siblings.map((worker) => worker.result))).every((result) => result.status === "completed"),
		).toBe(true);
	});

	it("cancels one waiting worker and disposes the remaining pending group", async () => {
		const leader = spawn({ releaseFile: join(tempDir, "unreleased") });
		await waitForStep("request", 1);
		const waiting = spawn();
		const pending = spawn();
		await waitForStep("waiting", 3);
		await team.cancel(waiting.id);
		expect((await waiting.result).status).toBe("aborted");
		await team.dispose();
		expect((await leader.result).status).toBe("aborted");
		expect((await pending.result).status).toBe("aborted");
	});

	it("releases unrelated prefixes independently and preserves the resolved agent type", async () => {
		const first = spawn(
			{ key: "model/account/effort/cutoff-a", releaseFile: join(tempDir, "unreleased") },
			"plan-task-a",
		);
		await waitForStep("request", 1);
		const second = spawn({ key: "model/account/effort/cutoff-b" }, "plan-task-b");
		expect((await second.result).status).toBe("completed");
		const starts = readLog().filter((entry) => entry.step === "waiting");
		expect(starts.map((entry) => entry.agentType)).toEqual(["worker", "worker"]);
		for (const { argv } of starts) {
			expect(argv).toContain("--subagent-worker");
			expect(argv).toContain("--planning-worker");
		}
		await team.cancel(first.id);
	});

	it("reacquires a changed retry prefix and ignores readiness for its previous prefix", async () => {
		const releaseFile = join(tempDir, "ready");
		const leader = spawn({ key: "old", retryKey: "new", releaseFile });
		await waitForStep("retry", 1);
		const sibling = spawn({ key: "new" });
		await waitForStep("waiting", 2);
		expect(readLog().filter((entry) => entry.step === "request")).toHaveLength(1);
		writeFileSync(releaseFile, "");
		expect(
			(await Promise.all([leader.result, sibling.result])).every((result) => result.status === "completed"),
		).toBe(true);
	});

	it("counts exact per worker rates and weights aggregate rates by prompt tokens", async () => {
		const cold = spawn({ key: "cold", usage: [{ input: 1, cacheRead: 0, cacheWrite: 2 }] });
		const warm = spawn({
			key: "warm",
			usage: [
				{ input: 1, cacheRead: 2, cacheWrite: 0 },
				{ input: 1, cacheRead: 9, cacheWrite: 0 },
			],
		});
		const results = await Promise.all([cold.result, warm.result]);
		expect(results[0].usage.cacheHitRate).toBe(0);
		expect(results[1].usage.firstCacheHitRate).toBe(2 / 3);
		expect(results[1].usage.cacheHitRate).toBe(11 / 13);
		expect(aggregateUsage(results).cacheHitRate).toBe(11 / 16);
		expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
	});
});
