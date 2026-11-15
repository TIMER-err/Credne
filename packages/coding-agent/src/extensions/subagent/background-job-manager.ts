// Queues child process jobs and keeps ownership until their runners actually settle.
import { randomUUID } from "node:crypto";

export type BackgroundJobState<TResult> =
	| { status: "queued" }
	| { status: "running" }
	| { status: "completed"; result: TResult }
	| { status: "failed"; error: string }
	| { status: "cancelled"; result?: TResult };

export interface BackgroundJob<TInput, TResult> {
	id: string;
	input: TInput;
	state: BackgroundJobState<TResult>;
}

export type CancelStatus = "cancelled" | "not_found" | "already_done";

interface JobEntry<TInput, TResult> {
	job: BackgroundJob<TInput, TResult>;
	controller: AbortController;
	settlement?: Promise<void>;
}

/** Runs a FIFO session queue with at most four active child process runners. */
export class BackgroundJobManager<TInput, TResult> {
	private readonly entries = new Map<string, JobEntry<TInput, TResult>>();
	private readonly run: (input: TInput, signal: AbortSignal) => Promise<TResult>;
	private readonly onComplete: (job: BackgroundJob<TInput, TResult>) => void | Promise<void>;
	private isShutdown = false;

	constructor(
		run: (input: TInput, signal: AbortSignal) => Promise<TResult>,
		onComplete: (job: BackgroundJob<TInput, TResult>) => void | Promise<void>,
	) {
		this.run = run;
		this.onComplete = onComplete;
	}

	/** Enqueues work and returns its session unique identifier. */
	enqueue(input: TInput): string {
		if (this.isShutdown) throw new Error("Background job manager is shut down");
		const id = randomUUID();
		this.entries.set(id, { job: { id, input, state: { status: "queued" } }, controller: new AbortController() });
		this.drain();
		return id;
	}

	/** Returns snapshots whose state does not change when a job transitions. */
	list(): BackgroundJob<TInput, TResult>[] {
		return [...this.entries.values()].map(({ job }) => this.snapshot(job));
	}

	/** Cancels queued work or waits until a running child process relinquishes its slot. */
	async cancel(id: string): Promise<CancelStatus> {
		const entry = this.entries.get(id);
		if (!entry) return "not_found";
		if (entry.job.state.status === "queued") {
			entry.job.state = { status: "cancelled" };
			this.notify(entry.job);
			return "cancelled";
		}
		if (entry.job.state.status !== "running") return "already_done";
		entry.controller.abort();
		await entry.settlement;
		return "cancelled";
	}

	/** Drops queued work and waits for aborted runners while suppressing result delivery. */
	async shutdown(): Promise<void> {
		this.isShutdown = true;
		for (const entry of this.entries.values()) {
			if (entry.job.state.status === "queued") entry.job.state = { status: "cancelled" };
			if (entry.job.state.status === "running") entry.controller.abort();
		}
		await Promise.all([...this.entries.values()].map((entry) => entry.settlement));
	}

	private drain(): void {
		if (this.isShutdown) return;
		let running = [...this.entries.values()].filter((entry) => entry.job.state.status === "running").length;
		for (const entry of this.entries.values()) {
			if (running >= 4) return;
			if (entry.job.state.status !== "queued") continue;
			entry.job.state = { status: "running" };
			running++;
			entry.settlement = Promise.resolve().then(() => this.execute(entry));
		}
	}

	private async execute(entry: JobEntry<TInput, TResult>): Promise<void> {
		try {
			if (!entry.controller.signal.aborted) {
				const result = await this.run(entry.job.input, entry.controller.signal);
				entry.job.state = { status: "completed", result };
			}
		} catch (error) {
			entry.job.state = { status: "failed", error: error instanceof Error ? error.message : String(error) };
		}
		if (entry.controller.signal.aborted) {
			entry.job.state =
				entry.job.state.status === "completed"
					? { status: "cancelled", result: entry.job.state.result }
					: { status: "cancelled" };
		}
		this.drain();
		this.notify(entry.job);
	}

	private notify(job: BackgroundJob<TInput, TResult>): void {
		if (this.isShutdown) return;
		try {
			void Promise.resolve(this.onComplete(this.snapshot(job))).catch(() => {});
		} catch {
			// Delivery belongs to the consumer and cannot prevent the queue from advancing.
		}
	}

	private snapshot(job: BackgroundJob<TInput, TResult>): BackgroundJob<TInput, TResult> {
		return { ...job, state: { ...job.state } };
	}
}
