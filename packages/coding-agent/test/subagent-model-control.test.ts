// Covers main-only model changes against retained worker processes and conversations.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createSubagentDispatch } from "../src/extensions/subagent/dispatch.ts";
import type { SingleResult, SubagentConfig } from "../src/extensions/subagent/runner.ts";
import { getWorkerTeam, registerTeamTools, type WorkerTeam } from "../src/extensions/subagent/team.ts";
import { workerTools } from "../src/extensions/subagent/worker-tools.ts";

const fixture = fileURLToPath(new URL("./fixtures/subagent-model-worker.mjs", import.meta.url));
const agent: SubagentConfig = { name: "worker", source: "builtin", systemPrompt: "You are a worker." };

interface LogEntry {
	type: string;
	pid: number;
	model: { provider: string; id: string };
	thinkingLevel: string;
	history: string[];
}

function model(id: string, provider = "fixture", reasoning = true): Model<Api> {
	return {
		id,
		provider,
		name: id,
		api: "openai-completions",
		baseUrl: "https://fixture.invalid/v1",
		reasoning,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
}

function registeredTools() {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		on: vi.fn(),
		appendEntry: vi.fn(),
		getThinkingLevel: () => "low",
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	return { pi, tools, dispatch: createSubagentDispatch(pi) };
}

function toolNamed(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
	const tool = tools.get(name);
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	return tool;
}

describe("change_agent_model", () => {
	let directory: string;
	let originalScript: string;
	let team: WorkerTeam;
	let ctx: ExtensionToolContext;
	let tools: Map<string, ToolDefinition>;
	let log: string;

	function entries(): LogEntry[] {
		if (!existsSync(log)) return [];
		return readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as LogEntry);
	}

	function task(extra: Record<string, string> = {}): string {
		return JSON.stringify({ log, ...extra });
	}

	function spawn(extra: Record<string, string> = {}) {
		return team.spawn({
			name: "worker",
			task: task(extra),
			defaults: { model: "fixture/old", thinkingLevel: "high", context: { mode: "fresh", sessionId: "parent" } },
			resolved: { agent, available: [agent], cwd: directory },
		});
	}

	function change(agentId: string, selection: Record<string, string> = { model: "new" }) {
		return toolNamed(tools, "change_agent_model").execute(
			"change",
			{ agentId, ...selection },
			undefined,
			undefined,
			ctx,
		);
	}

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-worker-model-"));
		log = join(directory, "commands.jsonl");
		originalScript = process.argv[1];
		process.argv[1] = fixture;
		const models = [
			model("old"),
			model("new"),
			model("newer"),
			model("plain", "fixture", false),
			model("model-error"),
			model("effort-error"),
			model("namespace/model", "other"),
		];
		const registered = registeredTools();
		tools = registered.tools;
		ctx = {
			cwd: directory,
			hasUI: false,
			model: models[0],
			thinkingLevel: "low",
			sessionManager: { getSessionId: () => "parent" },
			modelRegistry: {
				getAvailable: () => models,
				getAll: () => models,
				find: (provider: string, id: string) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
			},
		} as unknown as ExtensionToolContext;
		registerTeamTools(registered.pi, undefined, registered.dispatch);
		team = getWorkerTeam(registered.pi, ctx);
	});

	afterEach(async () => {
		await team.dispose();
		process.argv[1] = originalScript;
		rmSync(directory, { recursive: true, force: true });
	});

	it("changes the retained process without losing its conversation or rewriting historical run models", async () => {
		const worker = spawn();
		const initial = await worker.result;
		const originalPid = entries()[0].pid;
		expect(initial.model).toBe("fixture/old");
		const changed = await change(worker.id, { model: "other/namespace/model", reasoningEffort: "xhigh" });
		expect(changed.details).toEqual({ agentId: worker.id, model: "other/namespace/model", reasoningEffort: "xhigh" });
		expect(team.list()[0]).toMatchObject({
			status: "completed",
			model: "other/namespace/model",
			reasoningEffort: "xhigh",
		});
		expect(team.getViews()[0]).toMatchObject({ model: "other/namespace/model", reasoningEffort: "xhigh" });
		expect(initial.model).toBe("fixture/old");
		expect(entries().filter((entry) => entry.type === "prompt")).toHaveLength(1);

		await team.continue(worker.id, task());
		await vi.waitFor(() => expect(team.list()[0].status).toBe("completed"));
		const next = entries()
			.filter((entry) => entry.type === "prompt")
			.at(-1)!;
		expect(next).toMatchObject({
			pid: originalPid,
			model: { provider: "other", id: "namespace/model" },
			thinkingLevel: "xhigh",
		});
		expect(next.history).toHaveLength(2);
		expect(next.history[0]).toBe(initial.task);
		expect(new Set(entries().map((entry) => entry.pid))).toEqual(new Set([originalPid]));
		expect(team.getViews()[0].runs.map((run) => run.model)).toEqual(["fixture/old", "other/namespace/model"]);
	});

	it("keeps model changes local when two workers were spawned with the same defaults object", async () => {
		const defaults = {
			model: "fixture/old",
			thinkingLevel: "high" as const,
			context: { mode: "fresh" as const, sessionId: "parent" },
		};
		const first = team.spawn({
			name: "worker",
			task: task(),
			defaults,
			resolved: { agent, available: [agent], cwd: directory },
		});
		const second = team.spawn({
			name: "worker",
			task: task(),
			defaults,
			resolved: { agent, available: [agent], cwd: directory },
		});
		await Promise.all([first.result, second.result]);
		await change(first.id);
		expect(team.list().map((worker) => worker.model)).toEqual(["fixture/new", "fixture/old"]);
		expect(defaults.model).toBe("fixture/old");
	});

	it("changes an interrupted worker before its first process starts", async () => {
		const active = Array.from({ length: 4 }, () => spawn({ releaseFile: join(directory, "hold") }));
		const queued = spawn();
		await team.interrupt(queued.id);
		await queued.result;
		await change(queued.id);
		expect(entries().every((entry) => entry.type !== "set_model")).toBe(true);
		await Promise.all(active.map((worker) => team.cancel(worker.id)));
		await team.continue(queued.id, task());
		await vi.waitFor(() => expect(team.list().find((worker) => worker.id === queued.id)?.status).toBe("completed"));
		expect(
			entries()
				.filter((entry) => entry.type === "prompt")
				.at(-1)?.model.id,
		).toBe("new");
	});

	it("preserves omitted effort instead of inheriting main's effort, and clamps it when needed", async () => {
		const worker = spawn();
		await worker.result;
		await change(worker.id);
		expect(team.list()[0].reasoningEffort).toBe("high");
		await change(worker.id, { model: "plain" });
		expect(team.list()[0]).toMatchObject({ model: "fixture/plain", reasoningEffort: "off" });
	});

	it.each([
		[{ model: "missing" }, /Unknown subagent model.*search_models/],
		[{ model: "ne" }, /Ambiguous subagent model.*search_models/],
		[{ model: "plain", reasoningEffort: "high" }, /does not support reasoning effort high/],
	] as const)("validates model and effort before sending any configuration command: %j", async (selection, error) => {
		const worker = spawn();
		await worker.result;
		await expect(change(worker.id, selection)).rejects.toThrow(error);
		expect(entries().map((entry) => entry.type)).toEqual(["prompt"]);
		expect(team.list()[0]).toMatchObject({ model: "fixture/old", reasoningEffort: "high" });
	});

	it("rejects running and queued workers actionably, and rejects unknown or cancelled workers", async () => {
		const workers = Array.from({ length: 5 }, () => spawn({ releaseFile: join(directory, "hold") }));
		expect(team.list()[4].status).toBe("queued");
		await expect(change(workers[4].id)).rejects.toThrow(/interrupt_agent.*change_agent_model/);
		await vi.waitFor(() => expect(team.list()[0].status).toBe("running"));
		await expect(change(workers[0].id)).rejects.toThrow(/interrupt_agent.*change_agent_model/);
		await expect(change("unknown")).rejects.toThrow(/Unknown worker/);
		await team.cancel(workers[4].id);
		await expect(change(workers[4].id)).rejects.toThrow(/cancelled.*spawn a new worker/);
	});

	it("preserves interrupted messages and queued assignments when changing the model", async () => {
		const worker = spawn({ releaseFile: join(directory, "hold") });
		await vi.waitFor(() => expect(entries().filter((entry) => entry.type === "prompt")).toHaveLength(1));
		const assignment = team.assign(worker.id, { task: task({ assignment: "queued" }) });
		await team.interrupt(worker.id);
		await worker.result;
		expect(await team.send(worker.id, "pending message")).toBe("queued_until_continue");
		await change(worker.id);
		expect(team.list()[0]).toMatchObject({
			status: "interrupted",
			inboxCount: 1,
			assignmentCount: 1,
			model: "fixture/new",
		});
		expect(entries().filter((entry) => entry.type === "prompt")).toHaveLength(1);
		await team.continue(worker.id, task());
		await assignment.result;
		const prompts = entries().filter((entry) => entry.type === "prompt");
		expect(prompts).toHaveLength(3);
		expect(prompts[1].history[1]).toContain("pending message");
		expect(prompts.slice(1).map((entry) => entry.model.id)).toEqual(["new", "new"]);
		expect(team.list()[0].model).toBe("fixture/new");
	});

	it("retains old configuration when set_model fails and reports actual model and effort after partial failure", async () => {
		const worker = spawn();
		await worker.result;
		await expect(change(worker.id, { model: "model-error" })).rejects.toThrow("Fixture rejected model");
		expect(team.list()[0]).toMatchObject({ model: "fixture/old", reasoningEffort: "high" });
		await expect(change(worker.id, { model: "effort-error", reasoningEffort: "xhigh" })).rejects.toThrow(
			"Fixture rejected effort",
		);
		expect(team.list()[0]).toMatchObject({ model: "fixture/effort-error", reasoningEffort: "minimal" });
		expect(team.getViews()[0].model).toBe("fixture/effort-error");
		await team.continue(worker.id, task());
		await vi.waitFor(() => expect(team.list()[0].status).toBe("completed"));
		expect(
			entries()
				.filter((entry) => entry.type === "prompt")
				.at(-1),
		).toMatchObject({ model: { id: "effort-error" }, thinkingLevel: "minimal" });
	});

	it.each(["send", "assign", "continue"] as const)(
		"waits for an in-flight model change before %s reactivates the worker",
		async (operation) => {
			const release = join(directory, "configuration-ready");
			const worker = spawn({ configurationReleaseFile: release });
			await worker.result;
			const changing = change(worker.id);
			await vi.waitFor(() => expect(entries().some((entry) => entry.type === "set_model")).toBe(true));
			await expect(change(worker.id)).rejects.toThrow(/model change in progress/);
			if (operation === "send") await team.send(worker.id, "next message");
			else if (operation === "assign") team.assign(worker.id, { task: task() });
			else await team.continue(worker.id, task());
			expect(entries().filter((entry) => entry.type === "prompt")).toHaveLength(1);
			writeFileSync(release, "");
			await changing;
			await vi.waitFor(() => expect(team.list()[0].status).toBe("completed"));
			expect(
				entries()
					.filter((entry) => entry.type === "prompt")
					.at(-1),
			).toMatchObject({ model: { id: "new" }, thinkingLevel: "high" });
		},
	);

	it("publishes cumulative streaming text, thinking and tool arguments without counting usage before message_end", async () => {
		const releaseFile = join(directory, "finish-stream");
		const snapshots: SingleResult[] = [];
		const unsubscribe = team.subscribe(() => {
			const run = team.getViews()[0]?.runs[0];
			if (run) snapshots.push(structuredClone(run));
		});
		const worker = spawn({ streaming: "yes", releaseFile });
		await vi.waitFor(() =>
			expect(team.getViews()[0]?.runs[0].streamingMessage?.content[2]).toMatchObject({
				type: "toolCall",
				arguments: { path: "final.ts" },
			}),
		);
		const partial = team.getViews()[0].runs[0];
		expect(partial.usage.turns).toBe(0);
		expect(partial.usage.input).toBe(0);
		expect(partial.messages.some((message) => message.role === "assistant")).toBe(false);
		expect(partial.streamingMessage?.content).toEqual([
			{ type: "thinking", thinking: "Finished reasoning" },
			{ type: "text", text: "Finished text" },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "final.ts" } },
		]);
		expect(
			snapshots.some(
				(snapshot) =>
					snapshot.streamingMessage?.content[0]?.type === "thinking" &&
					snapshot.streamingMessage.content[0].thinking === "Reasoning",
			),
		).toBe(true);
		expect(
			snapshots.some(
				(snapshot) =>
					snapshot.streamingMessage?.content[1]?.type === "text" &&
					snapshot.streamingMessage.content[1].text === "partial",
			),
		).toBe(true);
		expect(
			snapshots.some(
				(snapshot) =>
					snapshot.streamingMessage?.content[2]?.type === "toolCall" &&
					snapshot.streamingMessage.content[2].arguments.path === "src/file.ts",
			),
		).toBe(true);
		writeFileSync(releaseFile, "");
		const result = await worker.result;
		unsubscribe();
		expect(result.streamingMessage).toBeUndefined();
		expect(result.usage).toMatchObject({ input: 10, output: 5, turns: 1 });
		expect(result.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(result.messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: "Final authoritative response" }],
		});
		await team.continue(worker.id, task());
		await vi.waitFor(() => expect(team.list()[0].status).toBe("completed"));
		expect(team.getViews()[0].runs[1].streamingMessage).toBeUndefined();
	});

	it("registers the tool only for main and excludes it from custom worker tool declarations", () => {
		const worker = registeredTools();
		registerTeamTools(worker.pi, async () => [], worker.dispatch);
		expect(worker.tools.has("change_agent_model")).toBe(false);
		expect(tools.has("change_agent_model")).toBe(true);
		expect(workerTools(["read", "change_agent_model"])).toEqual(["list_agents", "read", "send_agent_message"]);
	});
});
