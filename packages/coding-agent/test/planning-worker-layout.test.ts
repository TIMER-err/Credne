import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getInitialSystemMessage,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { completeTask, createPlan, startTasks, type TaskSpec } from "../src/extensions/planning/graph.ts";
import planningExtension from "../src/extensions/planning/index.ts";
import { discoverAgents, discoverBundledAgents } from "../src/extensions/subagent/agents.ts";
import { emptyUsage, type SingleResult } from "../src/extensions/subagent/runner.ts";
import { registerTeamTools, type SpawnInput, WorkerTeam } from "../src/extensions/subagent/team.ts";
import {
	registerWorkerPrompt,
	WORKER_CONVERSATION_ENV,
	WORKER_FLAG,
} from "../src/extensions/subagent/worker-prompt.ts";
import { workerTools } from "../src/extensions/subagent/worker-tools.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("planned worker request layout", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses the bundled worker body and puts planning rules, ancestors and dependency results in its assignment", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-planning-layout-"));
		directories.push(cwd);
		const agentDirectory = join(cwd, "user-agent");
		mkdirSync(join(agentDirectory, "agents"), { recursive: true });
		writeFileSync(
			join(agentDirectory, "agents", "worker.md"),
			"---\nname: worker\ndescription: User override\ntools: read\n---\nUser worker override",
		);
		vi.stubEnv(ENV_AGENT_DIR, agentDirectory);
		vi.stubEnv(WORKER_CONVERSATION_ENV, "");
		expect(discoverAgents(cwd, "user").agents.find((agent) => agent.name === "worker")?.source).toBe("user");
		const group: TaskSpec = {
			id: "catalog",
			name: "Product catalog",
			order: 2,
			component: "catalog",
			description: "Add catalog search",
			paths: ["src/catalog"],
			dependsOn: [],
			acceptance: ["Catalog search works"],
		};
		const dependency: TaskSpec = {
			id: "schema",
			name: "Search schema",
			order: 1,
			component: "schema",
			description: "Define the search result",
			paths: ["src/schema"],
			dependsOn: [],
			acceptance: ["Schema is defined"],
		};
		const task: TaskSpec = {
			id: "api",
			name: "Search API",
			order: 2,
			component: "api",
			description: "Implement product search",
			paths: ["src/catalog/api"],
			parentId: group.id,
			dependsOn: [dependency.id],
			acceptance: ["API tests pass"],
		};
		const createdPlan = createPlan("Searchable product catalog", [group, dependency, task], "Initial plan");
		const plan = completeTask(
			startTasks(createdPlan, [dependency.id]),
			dependency.id,
			"Schema returns {id, name, price}",
		);
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendCustomEntry("planning-state", plan);
		const spawned: SpawnInput[] = [];
		vi.spyOn(WorkerTeam.prototype, "spawn").mockImplementation((input) => {
			spawned.push(input);
			const result: SingleResult = {
				agent: input.name,
				agentSource: "builtin",
				task: input.task,
				status: "completed",
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
			};
			return { id: "planned-worker", result: Promise.resolve(result) };
		});
		const parent = await createHarness({ cwd, sessionManager, extensionFactories: [planningExtension] });
		harnesses.push(parent);
		await parent.session.bindExtensions({});
		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("assign_tasks", { revision: plan.revision, taskIds: [task.id] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("assigned"),
		]);
		await parent.session.prompt("Assign the API task.");
		expect(spawned).toHaveLength(1);
		const assignment = spawned[0];
		const bundled = discoverBundledAgents().find((agent) => agent.name === "worker")!;
		expect(assignment.resolved.agent).toEqual(bundled);
		expect(assignment.defaults.context.mode).toBe("fresh");
		const [rules, ...json] = assignment.task.split("\n");
		expect(rules).toBe("Planned task. Own only the task's paths and meet its acceptance criteria. Do not commit.");
		expect(JSON.parse(json.join("\n"))).toEqual({
			objective: plan.objective,
			task: {
				id: task.id,
				name: task.name,
				order: task.order,
				component: task.component,
				description: task.description,
				paths: task.paths,
				acceptance: task.acceptance,
			},
			ancestors: [{ id: group.id, name: group.name, description: group.description }],
			dependencies: [{ id: dependency.id, name: dependency.name, output: "Schema returns {id, name, price}" }],
		});
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				registerWorkerPrompt(pi);
				registerTeamTools(pi, async () => []);
			},
			planningExtension,
			createToolSearchExtension(),
		]);
		extensionsResult.runtime.flagValues.set(WORKER_FLAG, true);
		extensionsResult.runtime.flagValues.set("planning-worker", true);
		const tools = workerTools(bundled.tools);
		const child = await createHarness({
			cwd,
			initialActiveToolNames: tools,
			allowedToolNames: tools,
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getSystemPrompt: () => assignment.resolved.agent!.systemPrompt,
				getAgentsFiles: () => ({ agentsFiles: [{ path: join(cwd, "AGENTS.md"), content: "Project rules" }] }),
			},
		});
		harnesses.push(child);
		await child.session.bindExtensions({});
		const requests: TranscriptContext[] = [];
		child.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await child.session.prompt(assignment.task);
		const head = getInitialSystemMessage(requests[0].messages)!;
		const prompt = getSystemMessageText(head);
		expect(prompt.startsWith(bundled.systemPrompt)).toBe(true);
		expect(prompt).toContain("Project rules");
		expect(prompt.endsWith(`<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`)).toBe(true);
		expect(prompt).not.toMatch(/Planned task|User worker override|Searchable product catalog/);
		expect(head.toolsAdded?.map((tool) => tool.name)).toEqual(tools);
		expect(requests[0].messages[1]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: assignment.task }],
		});
	});
});
