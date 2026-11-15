// Coordinates persistent workers through a shared session queue and authenticated message routing.
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import { type BackgroundJob, BackgroundJobManager } from "./background-job-manager.ts";
import { PrefixWarmup } from "./prefix-warmup.ts";
import {
	aggregateUsage,
	createWorkerSession,
	type DispatchDefaults,
	emptyUsage,
	type OnUpdateCallback,
	type ResolvedAgent,
	type SingleResult,
	type SubagentDetails,
	type WorkerSession,
} from "./runner.ts";
import type { RequestParent, WorkerRequest } from "./worker-channel.ts";

export interface SpawnInput {
	name: string;
	task: string;
	defaults: DispatchDefaults;
	resolved: ResolvedAgent;
	step?: number;
	onUpdate?: OnUpdateCallback;
	makeDetails?: (results: SingleResult[]) => SubagentDetails;
	onResult?: (result: SingleResult, workerId: string) => void | Promise<void>;
	beforeResume?: () => void;
}

export interface WorkerSummary {
	id: string;
	name: string;
	task: string;
	status: "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
	inboxCount: number;
}

interface Worker {
	id: string;
	input: SpawnInput;
	session: WorkerSession;
	status: WorkerSummary["status"];
	inbox: string[];
	run?: WorkerRun;
	cancellation?: Promise<void>;
	hasStarted: boolean;
}

interface WorkerRun {
	worker: Worker;
	task: string;
	queueId?: string;
	resolve: (result: SingleResult) => void;
	result: Promise<SingleResult>;
	isInitial: boolean;
}

interface TeamOwner {
	team?: WorkerTeam;
	sessionId?: string;
}

const owners = new WeakMap<ReadonlySessionManager, TeamOwner>();
const registeredTools = new WeakSet<ExtensionAPI>();

/** Returns the shared worker team for the current parent session. */
export function getWorkerTeam(pi: ExtensionAPI, ctx: ExtensionContext): WorkerTeam {
	const owner = getOwner(pi, ctx);
	const sessionId = ctx.sessionManager.getSessionId();
	if (!owner.team || owner.sessionId !== sessionId) {
		void owner.team?.dispose();
		owner.sessionId = sessionId;
		owner.team = new WorkerTeam(pi);
	}
	return owner.team;
}

function getOwner(pi: ExtensionAPI, ctx: ExtensionContext): TeamOwner {
	const cached = owners.get(ctx.sessionManager);
	if (cached) return cached;
	const owner: TeamOwner = {};
	owners.set(ctx.sessionManager, owner);
	const reset = async () => {
		const previous = owner.team;
		owner.team = undefined;
		owner.sessionId = undefined;
		await previous?.dispose();
	};
	pi.on("session_shutdown", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_before_tree", reset);
	return owner;
}
/** Owns worker identities, retained sessions, and all queued runs for one parent session. */
export class WorkerTeam {
	private readonly pi: ExtensionAPI;
	private readonly workers = new Map<string, Worker>();
	private readonly jobs: BackgroundJobManager<WorkerRun, SingleResult>;
	private readonly warmup = new PrefixWarmup();
	private isDisposed = false;
	private disposal?: Promise<void>;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.jobs = new BackgroundJobManager(
			(run, signal) => this.execute(run, signal),
			(job) => this.settle(job),
		);
	}

	/** Creates a stable worker identity and queues its first run. */
	spawn(input: SpawnInput): { id: string; result: Promise<SingleResult> } {
		this.assertActive();
		const id = randomUUID();
		const worker: Worker = {
			id,
			input,
			status: "queued",
			inbox: [],
			hasStarted: false,
			session: createWorkerSession(
				input.defaults,
				input.resolved,
				input.name,
				{
					id,
					request: (request) => this.request(id, request),
				},
				this.warmup,
			),
		};
		this.workers.set(id, worker);
		return { id, result: this.enqueue(worker, input.task) };
	}

	/** Lists workers with their stable identities and pending message counts. */
	list(): WorkerSummary[] {
		return [...this.workers.values()].map((worker) => ({
			id: worker.id,
			name: worker.input.name,
			task: worker.input.task.slice(0, 500),
			status: worker.status,
			inboxCount: worker.inbox.length,
		}));
	}

	/** Permanently cancels a worker and releases its retained session. */
	async cancel(id: string): Promise<string> {
		const worker = this.getWorker(id);
		if (this.disposal) {
			await this.disposal;
			return "cancelled";
		}
		if (worker.status === "cancelled") {
			await worker.cancellation;
			return "already_cancelled";
		}
		worker.status = "cancelled";
		worker.inbox.length = 0;
		worker.cancellation = this.cancelWorker(worker);
		await worker.cancellation;
		return "cancelled";
	}

	/** Pauses a worker while retaining its conversation and pending messages. */
	async interrupt(id: string): Promise<string> {
		const worker = this.getWorker(id);
		if (worker.status === "cancelled") return "cancelled";
		worker.status = "interrupted";
		const run = worker.run;
		if (run?.queueId) {
			await this.jobs.cancel(run.queueId);
			await run.result;
		}
		return "interrupted";
	}

	/** Resumes a settled worker with an explicit prompt through the shared queue. */
	async continue(id: string, prompt: string): Promise<string> {
		this.assertActive();
		if (!prompt.trim()) throw new Error("A continuation prompt is required");
		const worker = this.getWorker(id);
		if (worker.status === "cancelled") return "cancelled";
		if (worker.run) return "already_active";
		worker.input.beforeResume?.();
		this.enqueue(worker, prompt);
		return worker.status;
	}

	/** Adds an instruction to the active run without interrupting it. */
	async steer(id: string, prompt: string): Promise<string> {
		this.assertActive();
		if (!prompt.trim()) throw new Error("A steering prompt is required");
		const worker = this.getWorker(id);
		if (worker.status !== "running") return "not_running";
		return (await worker.session.send(`Message from main:\n${prompt}`, "steer")) ? "delivered" : "not_running";
	}

	/** Delivers a message while preserving the coordinator authenticated sender. */
	async send(to: string, message: string, from = "main"): Promise<string> {
		this.assertActive();
		const sender = from === "main" ? "main" : `${this.getWorker(from).input.name} (${from})`;
		if (to === from) throw new Error("Cannot send a message to yourself");
		if (to === "main") {
			this.pi.sendMessage(
				{
					customType: "agent-message",
					content: `Message from ${sender}:\n${message}`,
					display: true,
					details: { sender: from },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return "delivered";
		}
		const worker = this.getWorker(to);
		if (worker.status === "cancelled") return "cancelled";
		const content = `Message from ${sender}:\n${message}`;
		if (worker.status === "running" && (await worker.session.send(content, "followUp"))) return "delivered";
		this.assertActive();
		if (this.getWorker(to).status === "cancelled") return "cancelled";
		worker.inbox.push(content);
		if (worker.status === "interrupted") return "queued_until_continue";
		if (worker.run) return "queued";
		try {
			worker.input.beforeResume?.();
			this.enqueue(worker, "Process the pending messages.");
			return "queued";
		} catch (error) {
			return `retained_until_continue: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** Stops all work and suppresses callbacks belonging to the previous parent session. */
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.isDisposed = true;
		this.warmup.dispose();
		for (const worker of this.workers.values()) {
			worker.status = "cancelled";
		}
		this.disposal = this.disposeWorkers();
		return this.disposal;
	}

	/** Releases all worker sessions and queued work. */
	shutdown(): Promise<void> {
		return this.dispose();
	}

	private async cancelWorker(worker: Worker): Promise<void> {
		const run = worker.run;
		if (run?.queueId) {
			await this.jobs.cancel(run.queueId);
			await run.result;
		}
		await worker.session.dispose();
	}

	private async disposeWorkers(): Promise<void> {
		await this.jobs.shutdown();
		for (const worker of this.workers.values()) {
			if (worker.run)
				worker.run.resolve(this.emptyResult(worker, worker.run.task, "aborted", "Parent session changed"));
		}
		await Promise.all([...this.workers.values()].map((worker) => worker.cancellation ?? worker.session.dispose()));
	}

	private enqueue(worker: Worker, task: string): Promise<SingleResult> {
		let resolveResult!: (result: SingleResult) => void;
		const result = new Promise<SingleResult>((resolve) => {
			resolveResult = resolve;
		});
		const run: WorkerRun = { worker, task, result, resolve: resolveResult, isInitial: !worker.hasStarted };
		worker.hasStarted = true;
		worker.status = "queued";
		worker.run = run;
		run.queueId = this.jobs.enqueue(run);
		return result;
	}

	private async execute(run: WorkerRun, signal: AbortSignal): Promise<SingleResult> {
		const { worker } = run;
		worker.status = "running";
		const pending = worker.inbox.splice(0);
		const task = pending.length ? `${run.task}\n\n${pending.join("\n\n")}` : run.task;
		const details: (results: SingleResult[]) => SubagentDetails =
			(run.isInitial ? worker.input.makeDetails : undefined) ??
			((results) => ({
				mode: "single",
				results,
				usage: aggregateUsage(results),
				isError: results.some((result) => result.status === "failed" || result.status === "aborted"),
			}));
		return worker.session.run(
			task,
			worker.input.step,
			signal,
			run.isInitial ? worker.input.onUpdate : undefined,
			details,
		);
	}

	private async settle(job: BackgroundJob<WorkerRun, SingleResult>): Promise<void> {
		const { worker } = job.input;
		const result =
			job.state.status === "completed" || job.state.status === "cancelled" ? job.state.result : undefined;
		const settled =
			result ??
			this.emptyResult(
				worker,
				job.input.task,
				job.state.status === "failed" ? "failed" : "aborted",
				job.state.status === "failed" ? job.state.error : "Worker run interrupted",
			);
		settled.workerId = worker.id;
		if (worker.status !== "cancelled" && worker.status !== "interrupted") {
			worker.status =
				settled.status === "aborted" ? "interrupted" : settled.status === "failed" ? "failed" : "completed";
		}
		if (this.isDisposed) {
			job.input.resolve(settled);
			return;
		}
		try {
			await worker.input.onResult?.(settled, worker.id);
		} catch {
			/* Result delivery cannot stall the shared queue. */
		}
		worker.run = undefined;
		job.input.resolve(settled);
		if (
			this.isDisposed ||
			worker.run ||
			worker.status === "cancelled" ||
			worker.status === "interrupted" ||
			!worker.inbox.length
		)
			return;
		try {
			worker.input.beforeResume?.();
			this.enqueue(worker, "Process the pending messages.");
		} catch {
			/* Preserve messages until the owner permits continuation. */
		}
	}

	private request(from: string, request: WorkerRequest): Promise<unknown> {
		this.assertActive();
		if (request.type === "list")
			return Promise.resolve([{ id: "main", name: "main", status: "parent" }, ...this.list()]);
		if (request.type !== "send") throw new Error("Cache coordination belongs to the worker process");
		return this.send(request.to, request.message, from);
	}

	private getWorker(id: string): Worker {
		const worker = this.workers.get(id);
		if (!worker) throw new Error(`Unknown worker: ${id}`);
		return worker;
	}

	private assertActive(): void {
		if (this.isDisposed) throw new Error("Worker team belongs to a closed parent session");
	}

	private emptyResult(worker: Worker, task: string, status: "aborted" | "failed", errorMessage: string): SingleResult {
		return {
			agent: worker.input.name,
			agentSource: worker.input.resolved.agent?.source ?? "unknown",
			workerId: worker.id,
			task,
			status,
			exitCode: null,
			messages: [],
			stderr: "",
			errorMessage,
			step: worker.input.step,
			usage: emptyUsage(),
		};
	}
}

/**
 * Registers the coordination tools once for an extension API. In a worker, listing and messaging
 * go to main's coordinator through `requestParent`, and the controls that only main may use are
 * not registered.
 */
export function registerTeamTools(pi: ExtensionAPI, requestParent: RequestParent | undefined): void {
	if (registeredTools.has(pi)) return;
	registeredTools.add(pi);

	pi.registerTool({
		name: "list_agents",
		label: "List agents",
		description:
			"List the workers of the current parent session with their IDs and states. Called by a worker, the list also names main.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _update, ctx) {
			const agents = requestParent ? await requestParent({ type: "list" }, signal) : getWorkerTeam(pi, ctx).list();
			return { content: [{ type: "text", text: JSON.stringify(agents) }], details: { agents } };
		},
	});
	pi.registerTool({
		name: "send_agent_message",
		label: "Send agent message",
		description:
			'Send a message to a worker by its ID from list_agents. A worker can also send to "main". Active workers receive it during their run. Settled workers resume through the shared queue. Interrupted workers retain it until continue_agent.',
		executionMode: "sequential",
		parameters: Type.Object({ to: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			const status = requestParent
				? JSON.stringify(await requestParent({ type: "send", ...params }, signal))
				: await getWorkerTeam(pi, ctx).send(params.to, params.message);
			return { content: [{ type: "text", text: status }], details: { status } };
		},
	});
	if (requestParent) return;
	pi.registerTool({
		name: "interrupt_agent",
		label: "Interrupt agent",
		description:
			"Pause a worker and wait for its active run to settle. Retain its conversation and pending messages for an explicit continue_agent prompt.",
		executionMode: "sequential",
		parameters: Type.Object({ agentId: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const status = await getWorkerTeam(pi, ctx).interrupt(params.agentId);
			return { content: [{ type: "text", text: status }], details: { status } };
		},
	});
	for (const name of ["continue_agent", "steer_agent"] as const) {
		pi.registerTool({
			name,
			label: name,
			description:
				name === "continue_agent"
					? "Resume a settled or interrupted worker with a required prompt, retaining its conversation, model, and effort. The run uses the shared worker queue."
					: "Steer a running worker with a required prompt at its next message boundary. Does not start or resume an idle worker.",
			executionMode: "sequential",
			parameters: Type.Object({ agentId: Type.String(), prompt: Type.String({ minLength: 1 }) }),
			async execute(_id, params, _signal, _update, ctx) {
				const team = getWorkerTeam(pi, ctx);
				const status =
					name === "continue_agent"
						? await team.continue(params.agentId, params.prompt)
						: await team.steer(params.agentId, params.prompt);
				return { content: [{ type: "text", text: status }], details: { status } };
			},
		});
	}
}
