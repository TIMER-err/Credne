// Carries a worker's requests to the coordinator in its parent process over authenticated IPC.
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

export const workerRequestSchema = Type.Union([
	Type.Object({ type: Type.Literal("list") }),
	Type.Object({
		type: Type.Literal("cache_wait"),
		key: Type.String({ minLength: 1 }),
		sharedKey: Type.Optional(Type.String({ minLength: 1 })),
	}),
	Type.Object({ type: Type.Literal("cache_ready"), key: Type.String({ minLength: 1 }) }),
	Type.Object({
		type: Type.Literal("send"),
		to: Type.String({ minLength: 1 }),
		message: Type.String({ minLength: 1 }),
	}),
]);

export type WorkerRequest = Static<typeof workerRequestSchema>;

export interface WorkerChannel {
	id: string;
	request(request: WorkerRequest): Promise<unknown>;
}

export const workerEnvelopeSchema = Type.Object({
	type: Type.Literal("pi_worker_request"),
	id: Type.String(),
	request: workerRequestSchema,
});

const responseSchema = Type.Union([
	Type.Object({
		type: Type.Literal("pi_worker_response"),
		id: Type.String(),
		success: Type.Literal(true),
		data: Type.Unknown(),
	}),
	Type.Object({
		type: Type.Literal("pi_worker_response"),
		id: Type.String(),
		success: Type.Literal(false),
		error: Type.String(),
	}),
]);

/** Sends one request from a worker to the coordinator in its parent process. */
export type RequestParent = (request: WorkerRequest, signal: AbortSignal | undefined) => Promise<unknown>;

/** Connects a worker process to its parent over IPC. Returns undefined in the main agent. */
export function connectWorkerChannel(pi: ExtensionAPI): RequestParent | undefined {
	if (!process.env.PI_SUBAGENT_WORKER_ID) return undefined;
	const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
	let sequence = 0;
	const onMessage = (message: unknown) => {
		// The IPC wire is the validation boundary, never trust prompt supplied identity.
		if (!Value.Check(responseSchema, message)) return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.success) request.resolve(message.data);
		else request.reject(new Error(message.error));
	};
	const disconnect = () => {
		for (const request of pending.values()) request.reject(new Error("Worker parent disconnected"));
		pending.clear();
	};
	process.on("message", onMessage);
	process.on("disconnect", disconnect);
	pi.on("session_shutdown", async () => {
		disconnect();
		process.off("message", onMessage);
		process.off("disconnect", disconnect);
	});
	return (body, signal) =>
		new Promise((resolve, reject) => {
			if (!process.connected || !process.send) return reject(new Error("Worker parent is unavailable"));
			if (signal?.aborted) return reject(new Error("Worker request aborted"));
			const id = String(++sequence);
			const abort = () => finish(new Error("Worker request aborted"));
			// A cache writer may spend longer than the ordinary IPC timeout in provider prefill.
			const timer =
				body.type === "cache_wait"
					? undefined
					: setTimeout(() => finish(new Error("Worker parent request timed out")), 30000);
			const finish = (error: Error | undefined, data?: unknown) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				pending.delete(id);
				if (error) reject(error);
				else resolve(data);
			};
			pending.set(id, { resolve: (data) => finish(undefined, data), reject: (error) => finish(error) });
			signal?.addEventListener("abort", abort, { once: true });
			process.send({ type: "pi_worker_request", id, request: body }, (error) => {
				if (error) finish(error);
			});
		});
}
