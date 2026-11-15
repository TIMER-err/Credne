// Validates and transitions a planning graph without executing worker commands.
export interface TaskSpec {
	id: string;
	name: string;
	order: number;
	component: string;
	description: string;
	paths: string[];
	dependsOn: string[];
	parentId?: string;
	acceptance: string[];
}

export type TaskState =
	| { status: "pending" }
	| { status: "running" }
	| { status: "done"; evidence?: string; output: string }
	| { status: "failed"; error: string }
	| { status: "superseded"; reason: string };

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

/** Creates a validated graph with every task pending. */
export function createPlan(objective: string, specs: TaskSpec[], reason: string): Plan {
	requireText(objective, "objective");
	requireText(reason, "reason");
	return {
		objective,
		revision: 1,
		tasks: validateSpecs(specs).map((spec) => ({ spec, state: { status: "pending" } })),
		reason,
	};
}

/** Replaces the active graph atomically and reopens affected completed work. */
export function revisePlan(plan: Plan, specs: TaskSpec[], reason: string): Plan {
	requireText(reason, "reason");
	const normalized = validateSpecs(specs);
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
		if (task.state.status === "running" && affected.has(task.spec.id))
			throw new Error(`Cannot invalidate running task ${task.spec.id}`);
	}
	return completeGroups({ ...plan, revision: plan.revision + 1, reason, tasks: reopenTasks(tasks, affected) });
}

/** Selects executable leaves with satisfied prerequisites and disjoint ownership. */
export function selectReadyTasks(plan: Plan, limit = 4): Task[] {
	if (!Number.isInteger(limit) || limit < 1 || limit > 4)
		throw new Error("Worker limit must be an integer from 1 to 4");
	const tasks = activeTasks(plan);
	const owners = tasks.filter((task) => task.state.status === "running");
	const available = Math.min(limit, 4 - owners.length);
	if (available <= 0) return [];
	const selected: Task[] = [];
	for (const task of [...tasks].sort((left, right) => left.spec.order - right.spec.order)) {
		if (!isReady(task, tasks) || [...owners, ...selected].some((owner) => conflicts(task, owner))) continue;
		selected.push(task);
		if (selected.length === available) break;
	}
	return selected;
}

/** Starts a requested batch only when every task is currently executable. */
export function startTasks(plan: Plan, ids: string[]): Plan {
	if (!ids.length || ids.length > 4 || new Set(ids).size !== ids.length)
		throw new Error("Start between 1 and 4 distinct tasks");
	const tasks = activeTasks(plan);
	const selected = ids.map((id) => getTask(plan, id));
	const owners = tasks.filter((task) => task.state.status === "running");
	if (owners.length + ids.length > 4) throw new Error("At most 4 workers may run concurrently");
	for (const task of selected) {
		if (!isReady(task, tasks)) throw new Error(`Task ${task.spec.id} is not ready`);
		if ([...owners, ...selected].some((other) => other !== task && conflicts(task, other)))
			throw new Error(`Ownership conflict for ${task.spec.id}`);
	}
	return updateStates(plan, new Map(ids.map((id) => [id, { status: "running" }])));
}

/** Completes successful worker work and any groups whose prerequisites are satisfied. */
export function completeTask(plan: Plan, id: string, output: string): Plan {
	requireText(output, "output");
	requireRunning(plan, id);
	return updateStates(plan, new Map([[id, { status: "done", output }]]));
}

/** Records a worker failure while leaving the task available for retry. */
export function failTask(plan: Plan, id: string, error: string): Plan {
	requireText(error, "error");
	requireRunning(plan, id);
	return updateStates(plan, new Map([[id, { status: "failed", error }]]));
}

/** Optionally records review evidence or reopens completed work after rejection. */
export function reviewTask(plan: Plan, id: string, verdict: "accept" | "reject", evidence: string): Plan {
	requireText(evidence, "evidence");
	const task = getTask(plan, id);
	if (task.state.status !== "done") throw new Error(`Task ${id} is not completed`);
	if (verdict === "accept") return updateStates(plan, new Map([[id, { ...task.state, evidence }]]));
	return reopenTask(plan, id, `Rejected task ${id}: ${evidence}`);
}

/** Reopens completed work and affected results without invalidating running tasks. */
export function reopenTask(plan: Plan, id: string, reason: string): Plan {
	requireText(reason, "reason");
	if (getTask(plan, id).state.status !== "done") throw new Error(`Task ${id} is not completed`);
	const tasks = activeTasks(plan);
	const affected = affectedIds(tasks, new Set([id]));
	if (tasks.some((entry) => entry.state.status === "running" && affected.has(entry.spec.id)))
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

function validateSpecs(specs: TaskSpec[]): TaskSpec[] {
	if (!specs.length) throw new Error("Plan must contain tasks");
	const normalized = specs.map((spec) => {
		for (const field of ["id", "name", "component", "description"] as const) requireText(spec[field], field);
		if (!Number.isInteger(spec.order) || spec.order < 1)
			throw new Error(`Task ${spec.id} requires a positive integer order`);
		if (!spec.paths.length || !spec.acceptance.length)
			throw new Error(`Task ${spec.id} requires paths and acceptance criteria`);
		for (const criterion of spec.acceptance) requireText(criterion, "acceptance");
		const paths = spec.paths.map(normalizePath);
		if (new Set(spec.dependsOn).size !== spec.dependsOn.length)
			throw new Error(`Duplicate dependencies for ${spec.id}`);
		return { ...spec, paths };
	});
	const ids = new Set(normalized.map((spec) => spec.id));
	if (ids.size !== normalized.length) throw new Error("Duplicate task IDs");
	for (const spec of normalized) {
		for (const ref of [...spec.dependsOn, ...(spec.parentId === undefined ? [] : [spec.parentId])]) {
			if (!ids.has(ref)) throw new Error(`Unknown task reference ${ref}`);
		}
	}
	const tasks: Task[] = normalized.map((spec) => ({ spec, state: { status: "pending" } }));
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Task cycle involving ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		const task = tasks.find((entry) => entry.spec.id === id)!;
		for (const dependency of prerequisites(task, tasks)) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const task of tasks) visit(task.spec.id);
	return normalized;
}

function normalizePath(path: string): string {
	requireText(path, "path");
	const normalized = path.replaceAll("\\", "/");
	if (
		/^[/]|[:*?[\]{}\x00-\x1f]/.test(normalized) ||
		normalized.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
	)
		throw new Error(`Path must be relative and literal: ${path}`);
	return normalized;
}

function isActive(task: Task): boolean {
	return task.state.status !== "superseded";
}

function activeTasks(plan: Plan): Task[] {
	return plan.tasks.filter(isActive);
}

function prerequisites(task: Task, tasks: Task[]): string[] {
	const dependencies = [
		...task.spec.dependsOn,
		...tasks.filter((child) => child.spec.parentId === task.spec.id).map((child) => child.spec.id),
	];
	const isLeaf = !tasks.some((child) => child.spec.parentId === task.spec.id);
	if (isLeaf)
		dependencies.push(
			...tasks
				.filter(
					(entry) =>
						entry.spec.order < task.spec.order && !tasks.some((child) => child.spec.parentId === entry.spec.id),
				)
				.map((entry) => entry.spec.id),
		);
	const ancestors = new Set<string>([task.spec.id]);
	let parentId = task.spec.parentId;
	while (parentId !== undefined) {
		if (ancestors.has(parentId)) throw new Error(`Parent cycle involving ${parentId}`);
		ancestors.add(parentId);
		const parent = tasks.find((entry) => entry.spec.id === parentId);
		if (!parent) break;
		dependencies.push(...parent.spec.dependsOn);
		parentId = parent.spec.parentId;
	}
	return dependencies;
}

function affectedIds(tasks: Task[], initial: Set<string>): Set<string> {
	const affected = new Set(initial);
	let size = -1;
	while (size !== affected.size) {
		size = affected.size;
		for (const task of tasks) {
			if (
				(task.spec.parentId !== undefined && affected.has(task.spec.parentId)) ||
				prerequisites(task, tasks).some((id) => affected.has(id))
			)
				affected.add(task.spec.id);
		}
	}
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
		left.component === right.component &&
		left.description === right.description &&
		left.parentId === right.parentId &&
		JSON.stringify(left.paths) === JSON.stringify(right.paths) &&
		JSON.stringify(left.dependsOn) === JSON.stringify(right.dependsOn) &&
		JSON.stringify(left.acceptance) === JSON.stringify(right.acceptance)
	);
}

function conflicts(left: Task, right: Task): boolean {
	if (left.spec.component.toLowerCase() === right.spec.component.toLowerCase()) return true;
	return left.spec.paths.some((leftPath) =>
		right.spec.paths.some((rightPath) => {
			const a = leftPath.toLowerCase();
			const b = rightPath.toLowerCase();
			return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
		}),
	);
}

function isReady(task: Task, tasks: Task[]): boolean {
	return (
		(task.state.status === "pending" || task.state.status === "failed") &&
		!tasks.some((child) => child.spec.parentId === task.spec.id) &&
		prerequisites(task, tasks).every(
			(id) => tasks.find((dependency) => dependency.spec.id === id)?.state.status === "done",
		)
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
	return completeGroups({
		...plan,
		revision: plan.revision + 1,
		tasks: plan.tasks.map((task) => ({ ...task, state: states.get(task.spec.id) ?? task.state })),
	});
}

function completeGroups(plan: Plan): Plan {
	let tasks = plan.tasks;
	while (true) {
		const active = tasks.filter(isActive);
		const ready = active.filter((task) => canCompleteGroup(task, active));
		if (!ready.length) return { ...plan, tasks };
		const completed = new Map(
			ready.map((task) => [
				task.spec.id,
				{
					status: "done" as const,
					output: active
						.filter((child) => child.spec.parentId === task.spec.id)
						.map((child) => (child.state.status === "done" ? child.state.output : ""))
						.join("\n"),
				},
			]),
		);
		tasks = tasks.map((task) => ({ ...task, state: completed.get(task.spec.id) ?? task.state }));
	}
}

function canCompleteGroup(task: Task, tasks: Task[]): boolean {
	return (
		task.state.status === "pending" &&
		tasks.some((child) => child.spec.parentId === task.spec.id) &&
		prerequisites(task, tasks).every(
			(id) => tasks.find((dependency) => dependency.spec.id === id)?.state.status === "done",
		)
	);
}
