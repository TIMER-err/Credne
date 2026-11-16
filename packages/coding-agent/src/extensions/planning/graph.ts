// Validates and transitions an ordered task plan without executing worker commands.
export interface TaskInput {
	name: string;
	order: number;
	description: string;
	acceptance?: string[];
	paths?: string[];
}

export interface TaskRevision extends TaskInput {
	id?: string;
}

export interface TaskSpec extends TaskInput {
	id: string;
}

export type TaskState =
	| { status: "pending" }
	| { status: "queued" }
	| { status: "running" }
	| { status: "done"; output: string }
	| { status: "failed"; error: string }
	| { status: "superseded"; reason: string };

export type TaskUpdate = Partial<Omit<TaskSpec, "id">> & {
	status?: Exclude<TaskState["status"], "queued">;
	output?: string;
	error?: string;
	reason?: string;
};

export interface Task {
	spec: TaskSpec;
	state: TaskState;
}

export interface Plan {
	objective: string;
	revision: number;
	tasks: Task[];
	reason: string;
}

/** Creates a validated plan with generated IDs for new tasks and every task pending. */
export function createPlan(objective: string, specs: TaskInput[], reason: string): Plan {
	requireText(objective, "objective");
	requireText(reason, "reason");
	return {
		objective,
		revision: 1,
		tasks: allocateSpecs(
			specs.map(({ name, order, description, acceptance, paths }) => ({
				name,
				order,
				description,
				...(acceptance !== undefined ? { acceptance } : {}),
				...(paths !== undefined ? { paths } : {}),
			})),
			[],
		).map((spec) => ({ spec, state: { status: "pending" } })),
		reason,
	};
}

/** Replaces the active tasks atomically and reopens affected completed work. */
export function revisePlan(plan: Plan, specs: TaskRevision[], reason: string): Plan {
	requireText(reason, "reason");
	const normalized = allocateSpecs(
		specs,
		plan.tasks.map((task) => task.spec.id),
	);
	const changed = new Set<string>();
	const tasks: Task[] = normalized.map((spec) => {
		const previous = plan.tasks.find((task) => task.spec.id === spec.id);
		if (previous && previous.state.status !== "superseded" && sameSpec(previous.spec, spec)) return previous;
		changed.add(spec.id);
		return { spec, state: { status: "pending" } };
	});
	for (const previous of plan.tasks) {
		if (normalized.some((spec) => spec.id === previous.spec.id)) continue;
		if (previous.state.status !== "superseded") changed.add(previous.spec.id);
		tasks.push({ spec: previous.spec, state: { status: "superseded", reason } });
	}
	let affected = changed;
	let previousSize = -1;
	while (previousSize !== affected.size) {
		previousSize = affected.size;
		affected = affectedIds(tasks.filter(isActive), affectedIds(activeTasks(plan), affected));
	}
	for (const task of plan.tasks) {
		if ((task.state.status === "running" || task.state.status === "queued") && affected.has(task.spec.id))
			throw new Error(`Cannot invalidate running task ${task.spec.id}`);
	}
	return { ...plan, revision: plan.revision + 1, reason, tasks: reopenTasks(tasks, affected) };
}

/** Updates one task's details or status while preserving unrelated work. */
export function updateTask(plan: Plan, id: string, patch: TaskUpdate): Plan {
	// Wire schema validation does not express these conditional status fields.
	if (patch.output !== undefined && patch.status !== "done") throw new Error("output requires done status");
	if (patch.error !== undefined && patch.status !== "failed") throw new Error("error requires failed status");
	if (patch.reason !== undefined && patch.status !== "superseded")
		throw new Error("reason requires superseded status");
	const previous = getTask(plan, id);
	const spec = { ...previous.spec };
	if (patch.name !== undefined) spec.name = patch.name;
	if (patch.description !== undefined) spec.description = patch.description;
	if (patch.order !== undefined) spec.order = patch.order;
	if (patch.acceptance !== undefined) spec.acceptance = patch.acceptance;
	if (patch.paths !== undefined) spec.paths = patch.paths;
	validateTaskSpec(spec);
	const changed = !sameSpec(previous.spec, spec);
	let state: TaskState = changed && previous.state.status === "done" ? { status: "pending" } : previous.state;
	switch (patch.status) {
		case "pending":
		case "running":
			state = { status: patch.status };
			break;
		case "done": {
			const output = patch.output ?? "";
			requireText(output, "output for done status");
			state = { status: "done", output };
			break;
		}
		case "failed": {
			const error = patch.error ?? "";
			requireText(error, "error for failed status");
			state = { status: "failed", error };
			break;
		}
		case "superseded": {
			const reason = patch.reason ?? "";
			requireText(reason, "reason for superseded status");
			state = { status: "superseded", reason };
			break;
		}
	}
	const tasks = plan.tasks.map((task) => (task.spec.id === id ? { spec, state } : task));
	if (
		(state.status === "running" || state.status === "done") &&
		activeTasks({ ...plan, tasks }).some((task) => task.spec.order < spec.order && task.state.status !== "done")
	)
		throw new Error(`Earlier orders must complete before task ${id}`);
	const invalidates = changed || (previous.state.status === "done" && state.status !== "done");
	if (!invalidates) return { ...plan, revision: plan.revision + 1, reason: `Updated task ${id}`, tasks };
	const affected = affectedIds(activeTasks(plan), affectedIds(tasks.filter(isActive), new Set([id])));
	affected.delete(id);
	for (const task of tasks) {
		if ((task.state.status === "running" || task.state.status === "queued") && affected.has(task.spec.id))
			throw new Error(`Cannot invalidate assigned task ${task.spec.id}`);
	}
	return { ...plan, revision: plan.revision + 1, reason: `Updated task ${id}`, tasks: reopenTasks(tasks, affected) };
}

/** Reserves ready tasks for worker notification queues without starting them. */
export function queueTasks(plan: Plan, ids: string[]): Plan {
	if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length)
		throw new Error("Assign between 1 and 4 distinct tasks");
	for (const id of ids) {
		if (!isReady(getTask(plan, id), activeTasks(plan))) throw new Error(`Task ${id} is not ready`);
	}
	return updateStates(plan, new Map(ids.map((id) => [id, { status: "queued" }])));
}

/** Starts a queued task when its retained worker reaches the assignment. */
export function startQueuedTask(plan: Plan, id: string): Plan {
	if (getTask(plan, id).state.status !== "queued") throw new Error(`Task ${id} is not queued`);
	return updateStates(plan, new Map([[id, { status: "running" }]]));
}

/** Selects tasks whose earlier phases are complete, up to the available worker limit. */
export function selectReadyTasks(plan: Plan, limit = 4): Task[] {
	if (!Number.isInteger(limit) || limit < 1 || limit > 4)
		throw new Error("Worker limit must be an integer from 1 to 4");
	const tasks = activeTasks(plan);
	return tasks
		.filter((task) => isReady(task, tasks))
		.sort((left, right) => left.spec.order - right.spec.order)
		.slice(0, limit);
}

/** Starts a requested batch only when every task is currently executable. */
export function startTasks(plan: Plan, ids: string[]): Plan {
	if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length)
		throw new Error("Start between 1 and 4 distinct tasks");
	const tasks = activeTasks(plan);
	const selected = ids.map((id) => getTask(plan, id));
	const runningCount = tasks.filter((task) => task.state.status === "running").length;
	if (runningCount + ids.length > 4) throw new Error("At most 4 workers may run concurrently");
	for (const task of selected) {
		if (!isReady(task, tasks)) throw new Error(`Task ${task.spec.id} is not ready`);
	}
	return updateStates(plan, new Map(ids.map((id) => [id, { status: "running" }])));
}

/** Completes successful worker work. */
export function completeTask(plan: Plan, id: string, output: string): Plan {
	requireText(output, "output");
	requireRunning(plan, id);
	return updateStates(plan, new Map([[id, { status: "done", output }]]));
}

/** Records a worker failure while leaving the task available for retry. */
export function failTask(plan: Plan, id: string, error: string): Plan {
	requireText(error, "error");
	const status = getTask(plan, id).state.status;
	if (status !== "running" && status !== "queued") throw new Error(`Task ${id} is not assigned`);
	return updateStates(plan, new Map([[id, { status: "failed", error }]]));
}

/** Reopens completed work and affected results without invalidating running tasks. */
export function reopenTask(plan: Plan, id: string, reason: string): Plan {
	requireText(reason, "reason");
	if (getTask(plan, id).state.status !== "done") throw new Error(`Task ${id} is not completed`);
	const tasks = activeTasks(plan);
	const affected = affectedIds(tasks, new Set([id]));
	if (
		tasks.some(
			(entry) =>
				(entry.state.status === "running" || entry.state.status === "queued") && affected.has(entry.spec.id),
		)
	)
		throw new Error("Cannot invalidate running work");
	return {
		...plan,
		revision: plan.revision + 1,
		reason,
		tasks: reopenTasks(plan.tasks, affected),
	};
}

function requireText(value: string, name: string): void {
	// Declaration policy requires meaningful text even after wire schema validation.
	if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function allocateSpecs(specs: TaskRevision[], previousIds: string[]): TaskSpec[] {
	const issued = new Set(previousIds);
	const retained = new Set<string>();
	let nextId = previousIds.reduce((max, id) => (/^\d+$/.test(id) && BigInt(id) > max ? BigInt(id) : max), 0n) + 1n;
	return specs.map((spec) => {
		if (spec.id !== undefined) {
			if (!issued.has(spec.id)) throw new Error(`Unknown task ID ${spec.id}`);
			if (retained.has(spec.id)) throw new Error("Duplicate task IDs");
			retained.add(spec.id);
		}
		const task = { ...spec, id: spec.id ?? String(nextId++) };
		validateTaskSpec(task);
		return task;
	});
}

/** Validates persisted identities and task declarations without allocating new IDs. */
export function validatePersistedPlan(plan: Plan): void {
	requireText(plan.objective, "objective");
	requireText(plan.reason, "reason");
	const ids = new Set<string>();
	for (const task of plan.tasks) {
		validateTaskSpec(task.spec);
		if (ids.has(task.spec.id)) throw new Error("Duplicate task IDs");
		ids.add(task.spec.id);
	}
}

function validateTaskSpec(spec: TaskSpec): void {
	for (const field of ["id", "name", "description"] as const) requireText(spec[field], field);
	if (!Number.isInteger(spec.order) || spec.order < 1)
		throw new Error(`Task ${spec.name} requires a positive integer order`);
	for (const criterion of spec.acceptance ?? []) requireText(criterion, "acceptance");
	for (const path of spec.paths ?? []) requireText(path, "path");
}

function isActive(task: Task): boolean {
	return task.state.status !== "superseded";
}

function activeTasks(plan: Plan): Task[] {
	return plan.tasks.filter(isActive);
}

function affectedIds(tasks: Task[], initial: Set<string>): Set<string> {
	const affected = new Set(initial);
	const earliestOrder = tasks.reduce(
		(order, task) => (initial.has(task.spec.id) ? Math.min(order, task.spec.order) : order),
		Infinity,
	);
	for (const task of tasks) if (task.spec.order > earliestOrder) affected.add(task.spec.id);
	return affected;
}

function reopenTasks(tasks: Task[], affected: Set<string>): Task[] {
	return tasks.map((task) =>
		affected.has(task.spec.id) && task.state.status === "done" ? { ...task, state: { status: "pending" } } : task,
	);
}

function sameSpec(left: TaskSpec, right: TaskSpec): boolean {
	return (
		left.id === right.id &&
		left.name === right.name &&
		left.order === right.order &&
		left.description === right.description &&
		JSON.stringify(left.acceptance ?? []) === JSON.stringify(right.acceptance ?? []) &&
		JSON.stringify(left.paths ?? []) === JSON.stringify(right.paths ?? [])
	);
}

function isReady(task: Task, tasks: Task[]): boolean {
	return (
		(task.state.status === "pending" || task.state.status === "failed") &&
		tasks.every((earlier) => earlier.spec.order >= task.spec.order || earlier.state.status === "done")
	);
}

function getTask(plan: Plan, id: string): Task {
	const task = plan.tasks.find((entry) => entry.spec.id === id && isActive(entry));
	if (!task) throw new Error(`Unknown active task ${id}`);
	return task;
}

function requireRunning(plan: Plan, id: string): void {
	if (getTask(plan, id).state.status !== "running") throw new Error(`Task ${id} is not running`);
}

function updateStates(plan: Plan, states: Map<string, TaskState>): Plan {
	return {
		...plan,
		revision: plan.revision + 1,
		tasks: plan.tasks.map((task) => ({ ...task, state: states.get(task.spec.id) ?? task.state })),
	};
}
