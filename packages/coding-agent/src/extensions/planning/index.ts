// Coordinates persisted plans and background workers with automatic task completion.
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { type AgentConfig, discoverBundledAgents } from "../subagent/agents.ts";
import { captureSubagentContext, listSubagentContext, turnSchema } from "../subagent/context.ts";
import { createSubagentDispatch, reasoningEffortSchema } from "../subagent/dispatch.ts";
import { type DispatchDefaults, getFinalOutput, type SingleResult } from "../subagent/runner.ts";
import { getWorkerTeam, type WorkerTeam } from "../subagent/team.ts";
import {
	completeTask,
	createPlan,
	failTask,
	type Plan,
	reopenTask,
	reviewTask,
	revisePlan,
	selectReadyTasks,
	startTasks,
	type TaskSpec,
} from "./graph.ts";
import { planSchema, taskSpecSchema } from "./schema.ts";

const toolNames = [
	"create_plan",
	"revise_plan",
	"get_plan",
	"assign_tasks",
	"review_task",
	"cancel_tasks",
	"get_subagent_context",
	"checkpoint_context",
];
const revisionSchema = Type.Integer({ minimum: 1 });
const taskIdsSchema = Type.Array(Type.String(), { minItems: 1, maxItems: 4, uniqueItems: true });
const planningGuidance = `For nontrivial implementation work, create a plan before implementation. Start from the objective, constraints, and explicit assumptions. Divide by modular components with contracts, owned paths, dependencies, order, and acceptance criteria. Creating or revising a plan never starts workers. Mark meaningful stages you complete yourself, such as documentation reviewed or design agreed, with checkpoint_context so later workers can inherit that context boundary. Task results and optional review decisions become checkpoints automatically. Before assigning work, assess which ready tasks can run together. Use the same order for tasks that may run concurrently, dependencies for required outputs, and a phase containing only one task for exclusive execution. Ownership must be disjoint. Assign selected task IDs through assign_tasks, continue coordinating while they run, and revise the full active plan when evidence changes the design. Do not edit paths owned by running workers yourself. Successful workers complete tasks directly and release satisfied dependencies. Groups complete automatically after their children and prerequisites complete. Use review_task only when an optional review is useful, to record evidence or reopen completed work if a problem is found. This is an execution workflow and does not require a separate user approval or read only mode.`;

interface WorkerJob {
	id: string;
	team: WorkerTeam;
	result: Promise<SingleResult>;
}

/** Registers the default planning workflow for the main agent. */
export default function planningExtension(pi: ExtensionAPI): void {
	const dispatch = createSubagentDispatch(pi);
	let plan: Plan | undefined;
	let generation = 0;
	let isTransitioning = false;
	const jobs = new Map<string, WorkerJob>();
	const isWorker = () => pi.getFlag("planning-worker") === true;

	pi.registerFlag("planning-worker", {
		type: "boolean",
		default: false,
		description: "Internal planning worker session",
	});
	pi.registerFlag("planning-model", {
		type: "string",
		description: "Default planning worker model ID or unique name",
	});

	function requireMain(): void {
		if (isWorker()) throw new Error("Planning workers cannot invoke planning tools");
		if (isTransitioning) throw new Error("Session transition in progress");
	}

	function requirePlan(revision?: number): Plan {
		requireMain();
		if (!plan) throw new Error("Create a plan first");
		if (revision !== undefined && revision !== plan.revision)
			throw new Error(
				`Stale revision ${revision}; current revision is ${plan.revision}. Get the current plan and retry.`,
			);
		return plan;
	}

	function snapshot(taskId?: string) {
		const selected = taskId ? requirePlan().tasks.find((task) => task.spec.id === taskId) : undefined;
		if (taskId && !selected) throw new Error(`Unknown task ${taskId}`);
		const details = {
			plan: selected ? { ...plan, tasks: [selected] } : plan,
			readyTaskIds: plan ? selectReadyTasks(plan).map((task) => task.spec.id) : [],
			workers: [...jobs].map(([taskId, job]) => ({ taskId, workerId: job.id })),
		};
		return { content: [{ type: "text" as const, text: bounded(JSON.stringify(details, null, 2)) }], details };
	}

	function save(next: Plan, ctx: ExtensionContext): void {
		plan = next;
		pi.appendEntry("planning-state", next);
		if (ctx.hasUI)
			ctx.ui.setWidget("planning", [
				`Tasks: ${next.tasks.filter((task) => task.state.status === "done").length} completed, ${next.tasks.filter((task) => task.state.status === "running").length} running, revision ${next.revision}`,
			]);
	}

	async function drainWorkers(): Promise<void> {
		generation++;
		const stopping = [...jobs.values()];
		await Promise.all(stopping.map((job) => job.team.cancel(job.id)));
		jobs.clear();
	}

	async function stopWorkers(_event: unknown, ctx: ExtensionContext): Promise<void> {
		isTransitioning = true;
		try {
			await drainWorkers();
			if (!plan) return;
			let stopped = plan;
			for (const task of stopped.tasks) {
				if (task.state.status === "running")
					stopped = failTask(
						stopped,
						task.spec.id,
						"Worker stopped for session transition; inspect files before retrying",
					);
			}
			if (stopped !== plan) save(stopped, ctx);
		} finally {
			isTransitioning = false;
		}
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		isTransitioning = true;
		try {
			// Replacement context already belongs to the new branch; never persist the previous plan here.
			await drainWorkers();
			plan = undefined;
		} finally {
			isTransitioning = false;
		}
		if (ctx.hasUI) ctx.ui.setWidget("planning", undefined);
		// A worker has no plan of its own; its tool allowlist leaves the planning tools undeclared.
		if (isWorker()) return;
		const entry = ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === "planning-state");
		if (!entry || entry.type !== "custom") return;
		// Session entries are a disk input boundary and must pass the persisted schema.
		if (!Value.Check(planSchema, entry.data)) {
			if (ctx.hasUI) ctx.ui.notify("Ignored invalid persisted planning state", "warning");
			return;
		}
		let restored: Plan = entry.data;
		// Validate graph invariants as well as the serialized shape before trusting disk state.
		try {
			createPlan(
				restored.objective,
				restored.tasks.filter((task) => task.state.status !== "superseded").map((task) => task.spec),
				restored.reason,
			);
			for (const task of restored.tasks) {
				if (task.state.status === "running")
					restored = failTask(
						restored,
						task.spec.id,
						"Worker interrupted by session transition or restart; review files before retrying",
					);
			}
			save(restored, ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Ignored invalid planning graph: ${String(error)}`, "warning");
		}
	}

	function launch(
		spec: TaskSpec,
		agent: AgentConfig,
		defaults: DispatchDefaults,
		execution: "background" | "foreground",
		ctx: ExtensionContext,
	): WorkerJob {
		const assignedPlan = requirePlan();
		const workerGeneration = generation;
		let hasReturned = false;
		const team = getWorkerTeam(pi, ctx);
		const worker = team.spawn({
			name: spec.id,
			task: renderAssignment(assignedPlan, spec),
			defaults,
			resolved: { agent, available: [agent], cwd: ctx.cwd },
			beforeResume() {
				const current = requirePlan();
				const task = current.tasks.find((task) => task.spec.id === spec.id);
				if (
					workerGeneration !== generation ||
					jobs.get(spec.id)?.id !== worker.id ||
					!task ||
					JSON.stringify(task.spec) !== JSON.stringify(spec) ||
					task.state.status === "superseded"
				)
					throw new Error("This worker assignment is no longer current. Assign a ready task again.");
				const reopened =
					task.state.status === "done"
						? reopenTask(current, spec.id, "Main agent requested further worker discussion or implementation")
						: current;
				save(startTasks(reopened, [spec.id]), ctx);
			},
			onResult(result, workerId) {
				if (workerGeneration !== generation || !plan || jobs.get(spec.id)?.id !== workerId) return;
				if (plan.tasks.find((task) => task.spec.id === spec.id)?.state.status !== "running") return;
				const output =
					getFinalOutput(result.messages) || result.errorMessage || result.stderr || "Worker returned no output";
				const triggerTurn = execution === "background" || hasReturned;
				hasReturned = true;
				save(
					result.status !== "completed" ? failTask(plan, spec.id, output) : completeTask(plan, spec.id, output),
					ctx,
				);
				pi.sendMessage(
					{
						customType: "planning-result",
						content: `${bounded(
							`Task ${spec.id}, worker ${workerId}: ${result.status}.\n${output}`,
						)}\nUsage: ${JSON.stringify(result.usage)}`,
						display: true,
						details: { taskId: spec.id, workerId, result },
					},
					{ triggerTurn, deliverAs: "followUp" },
				);
			},
		});
		const job = { id: worker.id, team, result: worker.result };
		jobs.set(spec.id, job);
		return job;
	}

	pi.registerTool({
		name: "create_plan",
		label: "Create plan",
		description:
			"Record a modular implementation plan without starting workers. Assign ready task IDs separately; same order tasks may run concurrently when dependencies and ownership permit.",
		parameters: Type.Object({ objective: Type.String(), tasks: Type.Array(taskSpecSchema, { minItems: 1 }) }),
		executionMode: "sequential",
		async execute(_id, args, _signal, _update, ctx) {
			requireMain();
			if (plan?.tasks.some((task) => task.state.status !== "done" && task.state.status !== "superseded"))
				throw new Error("An unfinished plan already exists; revise it instead");
			const next = createPlan(args.objective, args.tasks, "Initial implementation plan");
			await drainWorkers();
			save(next, ctx);
			return snapshot();
		},
	});
	pi.registerTool({
		name: "revise_plan",
		label: "Revise plan",
		description: "Replace the full active task specification based on evidence; preserve unaffected running tasks.",
		parameters: Type.Object({
			revision: revisionSchema,
			reason: Type.String({ minLength: 1 }),
			tasks: Type.Array(taskSpecSchema, { minItems: 1 }),
		}),
		executionMode: "sequential",
		async execute(_id, args, _signal, _update, ctx) {
			save(revisePlan(requirePlan(args.revision), args.tasks, args.reason), ctx);
			return snapshot();
		},
	});
	pi.registerTool({
		name: "get_plan",
		label: "Get plan",
		description:
			"Inspect current task states, revision, outputs, and ready task IDs. Select taskId to inspect a specific result.",
		parameters: Type.Object({ taskId: Type.Optional(Type.String()) }),
		async execute(_id, args) {
			requireMain();
			return snapshot(args.taskId);
		},
	});
	pi.registerTool({
		name: "checkpoint_context",
		label: "Mark context milestone",
		description:
			"Mark a meaningful stage you completed yourself, such as documentation reviewed or design agreed. Its context becomes selectable through get_subagent_context after this tool batch completes. This records a context boundary and does not complete a planning task.",
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 120 }),
			description: Type.Optional(Type.String({ maxLength: 2000 })),
		}),
		executionMode: "sequential",
		async execute(_id, args) {
			requireMain();
			if (!args.name.trim()) throw new Error("A context milestone requires a meaningful name");
			return {
				content: [
					{ type: "text", text: `Step complete: ${args.name}${args.description ? `\n${args.description}` : ""}` },
				],
				details: args,
			};
		},
	});
	pi.registerTool({
		name: "get_subagent_context",
		label: "Get subagent context",
		description:
			"List numbered context checkpoints on the current branch, including completed stages, worker results, and task reviews. Use turn: 0 for fresh context, -1 for latest safe history, or a listed checkpoint number as the cutoff.",
		parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			requireMain();
			const details = listSubagentContext(ctx);
			return { content: [{ type: "text", text: bounded(JSON.stringify(details, null, 2)) }], details };
		},
	});
	pi.registerTool({
		name: "assign_tasks",
		label: "Assign tasks",
		description:
			"Assign 1 to 4 ready task IDs at the current revision. background defaults to true and returns worker IDs immediately; background: false waits for every first run result and returns outputs, status, and usage. Creation and revision never spawn workers. Model, reasoningEffort, and turn apply to this batch. turn: 0 starts fresh, -1 copies latest safe history, and a positive number copies through that checkpoint from get_subagent_context. Use separate calls for different controls. Coordinate returned IDs with send_agent_message, interrupt_agent, continue_agent, and steer_agent.",
		parameters: Type.Object({
			revision: revisionSchema,
			taskIds: taskIdsSchema,
			background: Type.Optional(
				Type.Boolean({
					default: true,
					description: "Return immediately when true; wait for all first run results when false.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model ID or unique name on the current account. Discover IDs with search_models. An explicit provider/model ID selects that route.",
				}),
			),
			reasoningEffort: Type.Optional(reasoningEffortSchema),
			turn: Type.Optional(turnSchema),
		}),
		executionMode: "sequential",
		async execute(_id, args, signal, _update, ctx) {
			const current = requirePlan(args.revision);
			if (signal?.aborted) throw new Error("Task assignment aborted before starting");
			const configuredModel = args.model ?? pi.getFlag("planning-model");
			// CLI flags are an external configuration boundary.
			if (configuredModel !== undefined && typeof configuredModel !== "string")
				throw new Error("Planning model must be a model ID or name");
			const agent = discoverBundledAgents().find((candidate) => candidate.name === "worker");
			if (!agent) throw new Error("The worker agent profile is unavailable.");
			const resolved = dispatch.resolve(
				{ model: configuredModel, reasoningEffort: args.reasoningEffort },
				ctx,
				agent.model,
			);
			const context = captureSubagentContext(args.turn, ctx);
			const background = args.background ?? true;
			const next = startTasks(current, args.taskIds);
			save(next, ctx);
			const dispatched = args.taskIds.map((id) => ({
				taskId: id,
				job: launch(
					next.tasks.find((task) => task.spec.id === id)!.spec,
					agent,
					{ ...resolved, context, extraArgs: ["--planning-worker", "--subagent-worker"] },
					background ? "background" : "foreground",
					ctx,
				),
			}));
			const workers = dispatched.map(({ taskId, job }) => ({ taskId, workerId: job.id }));
			const completed = background
				? undefined
				: await waitForWorkers(
						dispatched.map(({ job }) => job),
						signal,
					);
			const results = completed?.map((result, index) => ({
				...workers[index],
				status: result.status,
				output: getFinalOutput(result.messages),
				usage: result.usage,
				errorMessage: result.errorMessage,
			}));
			const result = snapshot();
			const assignment = { workers, ...resolved, turn: args.turn ?? 0, background };
			return {
				content: [...result.content, { type: "text", text: bounded(JSON.stringify({ ...assignment, results })) }],
				details: { ...result.details, assignment, results },
			};
		},
	});
	pi.registerTool({
		name: "review_task",
		label: "Review task",
		description:
			"Optionally review completed work. Accept records verification evidence; reject reopens affected work unless it would invalidate running tasks. Successful workers and groups complete without this operation.",
		parameters: Type.Object({
			revision: revisionSchema,
			taskId: Type.String(),
			verdict: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
			evidence: Type.String({ minLength: 1 }),
		}),
		executionMode: "sequential",
		async execute(_id, args, _signal, _update, ctx) {
			save(reviewTask(requirePlan(args.revision), args.taskId, args.verdict, args.evidence), ctx);
			return snapshot();
		},
	});
	pi.registerTool({
		name: "cancel_tasks",
		label: "Cancel tasks",
		description: "Abort selected workers and wait until they stop before making their tasks retryable.",
		parameters: Type.Object({ revision: revisionSchema, taskIds: taskIdsSchema }),
		executionMode: "sequential",
		async execute(_id, args) {
			requirePlan(args.revision);
			const selected = args.taskIds.map((id) => {
				const job = jobs.get(id);
				if (!job || plan?.tasks.find((task) => task.spec.id === id)?.state.status !== "running")
					throw new Error(`No running worker for ${id}`);
				return job;
			});
			await Promise.all(selected.map((job) => job.team.cancel(job.id)));
			return snapshot();
		},
	});
	pi.on("tool_call", async (event) => {
		if (isWorker() && toolNames.includes(event.toolName))
			return { block: true, reason: "Planning workers cannot invoke planning tools" };
	});
	pi.on("before_agent_start", async (event) => {
		if (!pi.getActiveTools().includes("create_plan")) return;
		// A named section rather than a replaced prompt: a replaced prompt is rebuilt at the head of
		// every request, so later prompt and tool changes could not be appended and would discard
		// the provider's prompt cache. Workers never get here: their tools leave create_plan out.
		event.systemPromptOptions.sections.planning = planningGuidance;
		if (!plan) return;
		const current = `Current plan revision ${plan.revision}: ${plan.objective}. ${plan.tasks
			.filter((task) => task.state.status !== "superseded")
			.map((task) => `${task.spec.id}: ${task.state.status}`)
			.join(", ")}. Use get_plan to inspect details before mutating.`;
		return { message: { customType: "planning-context", content: current, display: false } };
	});
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_before_switch", stopWorkers);
	pi.on("session_before_fork", stopWorkers);
	pi.on("session_before_tree", stopWorkers);
	pi.on("session_shutdown", stopWorkers);
}

async function waitForWorkers(jobs: WorkerJob[], signal: AbortSignal | undefined): Promise<SingleResult[]> {
	let cancellation: Promise<void> | undefined;
	const cancel = () => {
		cancellation ??= Promise.all(jobs.map((job) => job.team.cancel(job.id))).then(() => {});
		void cancellation.catch(() => {});
	};
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
	try {
		return await Promise.all(jobs.map((job) => job.result));
	} finally {
		signal?.removeEventListener("abort", cancel);
		await cancellation;
	}
}

/**
 * The first message of a plan worker: the planning rules it follows, then the objective, its task,
 * the groups the task belongs to (nearest first) and the results of the tasks it depends on. The
 * worker's system prompt is the `worker` agent prompt, like any worker's.
 */
function renderAssignment(plan: Plan, spec: TaskSpec): string {
	// The plan graph was validated on creation: parents and dependencies exist and form no cycle.
	const byId = new Map(plan.tasks.map((task) => [task.spec.id, task]));
	const ancestors: { id: string; name: string; description: string }[] = [];
	for (let parentId = spec.parentId; parentId !== undefined; ) {
		const parent = byId.get(parentId)!.spec;
		ancestors.push({ id: parent.id, name: parent.name, description: parent.description });
		parentId = parent.parentId;
	}
	const dependencies = spec.dependsOn.map((id) => {
		const { spec: dependency, state } = byId.get(id)!;
		return {
			id,
			name: dependency.name,
			...(state.status === "done" ? { output: state.output } : { status: state.status }),
		};
	});
	const { dependsOn: _dependsOn, parentId: _parentId, ...task } = spec;
	return `Planned task. Own only the task's paths and meet its acceptance criteria. Do not commit.\n${JSON.stringify(
		{ objective: plan.objective, task, ancestors, dependencies },
		null,
		2,
	)}`;
}

function bounded(text: string): string {
	const result = truncateHead(text, { maxLines: 160, maxBytes: 12000 });
	return (
		result.content + (result.truncated ? "\n[Output truncated; full output is persisted in planning state.]" : "")
	);
}
