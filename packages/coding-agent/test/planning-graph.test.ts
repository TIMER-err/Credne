// Verifies flat planning inputs, phase scheduling, and revision safety.
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	completeTask,
	createPlan,
	failTask,
	reopenTask,
	revisePlan,
	selectReadyTasks,
	startTasks,
	type TaskInput,
	validatePersistedPlan,
} from "../src/extensions/planning/graph.ts";
import { planSchema, taskCreateSchema, taskRevisionSchema } from "../src/extensions/planning/schema.ts";

const first: TaskInput = { name: "API", description: "Implement search", order: 1 };
const second: TaskInput = { name: "UI", description: "Render search", order: 1 };
const last: TaskInput = { name: "Integration", description: "Verify the full flow", order: 2 };

describe("planning task inputs", () => {
	it("accepts only name, description, and order and persists generated IDs", () => {
		expect(taskCreateSchema.required).toEqual(["name", "order", "description"]);
		expect(Value.Check(taskCreateSchema, first)).toBe(true);
		const plan = createPlan("Search", [first, second], "Initial plan");
		expect(plan.tasks.map((task) => task.spec)).toEqual([
			{ ...first, id: "1" },
			{ ...second, id: "2" },
		]);
		expect(Value.Check(planSchema, plan)).toBe(true);
		expect(Value.Check(planSchema, { ...plan, tasks: [{ spec: first, state: { status: "pending" } }] })).toBe(false);
	});

	it.each(["name", "description", "order"] as const)("requires %s", (field) => {
		const { [field]: omitted, ...incomplete } = first;
		expect(omitted).toBeDefined();
		expect(Value.Check(taskCreateSchema, incomplete)).toBe(false);
	});

	it.each([{ parentId: "group" }, { dependsOn: [] }, { component: "api" }])(
		"rejects removed fields: %j",
		(removed) => {
			expect(Value.Check(taskCreateSchema, { ...first, ...removed })).toBe(false);
			const plan = createPlan("Search", [first], "Initial plan");
			expect(
				Value.Check(planSchema, {
					...plan,
					tasks: [{ ...plan.tasks[0], spec: { ...plan.tasks[0].spec, ...removed } }],
				}),
			).toBe(false);
		},
	);

	it("accepts empty optional acceptance criteria", () => {
		const input = { ...first, acceptance: [] };
		expect(Value.Check(taskCreateSchema, input)).toBe(true);
		expect(() => createPlan("Search", [input], "Initial plan")).not.toThrow();
	});

	it("rejects creation IDs and allocates above historical IDs on revision", () => {
		expect(Value.Check(taskCreateSchema, { ...first, id: "1" })).toBe(false);
		const taskCreateTool = Type.Object(
			{ revision: Type.Integer(), ...taskCreateSchema.properties },
			{ additionalProperties: false },
		);
		expect(Value.Check(taskCreateTool, { revision: 1, ...first, id: "1" })).toBe(false);
		expect(Value.Check(taskRevisionSchema, { ...first, id: "1" })).toBe(true);
		const suppliedId = { ...first, id: "arbitrary" };
		expect(createPlan("Search", [suppliedId], "Initial plan").tasks[0].spec.id).toBe("1");
		const plan = createPlan("Search", [first, second], "Initial plan");
		const revised = revisePlan(plan, [last], "Replace the tasks");
		expect(revised.tasks[0].spec.id).toBe("3");
		expect(revised.tasks.slice(1).every((task) => task.state.status === "superseded")).toBe(true);
		const appended = revisePlan(revised, [revised.tasks[0].spec, first], "Add a task");
		expect(appended.tasks.map((task) => task.spec.id)).toEqual(["3", "4", "1", "2"]);
		expect(() => revisePlan(plan, [{ ...first, id: "unknown" }], "Invalid")).toThrow("Unknown task ID");
		expect(() => revisePlan(plan, [plan.tasks[0].spec, plan.tasks[0].spec], "Duplicate")).toThrow(
			"Duplicate task IDs",
		);
	});

	it("validates historical IDs without renaming them", () => {
		const plan = createPlan("Search", [first, second], "Initial plan");
		plan.tasks[0].spec.id = "legacy-task";
		plan.tasks[0].state = { status: "done", output: "Complete" };
		plan.tasks[1].spec.id = "12";
		plan.tasks[1].state = { status: "superseded", reason: "Removed" };
		validatePersistedPlan(plan);
		const revised = revisePlan(plan, [plan.tasks[0].spec, last], "Add integration");
		expect(revised.tasks[0]).toEqual(plan.tasks[0]);
		expect(revised.tasks[1].spec.id).toBe("13");
		expect(revised.tasks[2].spec.id).toBe("12");
	});

	it.each([{ name: " " }, { description: " " }, { order: 0 }, { order: 1.5 }, { acceptance: [" "] }])(
		"rejects invalid task declarations: %j",
		(invalid) => {
			expect(() => createPlan("Search", [{ ...first, ...invalid }], "Initial plan")).toThrow();
		},
	);
});

describe("planning execution order", () => {
	it("runs peers together and waits for every earlier task before releasing the next order", () => {
		let plan = createPlan("Search", [first, second, last], "Initial plan");
		expect(selectReadyTasks(plan).map((task) => task.spec.id)).toEqual(["1", "2"]);
		expect(() => startTasks(plan, ["3"])).toThrow("not ready");
		plan = startTasks(plan, ["1", "2"]);
		plan = completeTask(plan, "1", "API works");
		expect(selectReadyTasks(plan)).toEqual([]);
		plan = failTask(plan, "2", "UI needs correction");
		expect(selectReadyTasks(plan).map((task) => task.spec.id)).toEqual(["2"]);
		plan = completeTask(startTasks(plan, ["2"]), "2", "UI works");
		expect(selectReadyTasks(plan).map((task) => task.spec.id)).toEqual(["3"]);
	});

	it("leaves scope coordination to the caller when assigning peers", () => {
		const plan = createPlan(
			"Search",
			[
				{ ...first, description: "Update src/api/search.ts" },
				{ ...second, description: "Update src/api/search.ts" },
			],
			"Initial plan",
		);
		expect(selectReadyTasks(plan)).toHaveLength(2);
		expect(() => startTasks(plan, ["1", "2"])).not.toThrow();
		const running = startTasks(plan, ["1"]);
		expect(selectReadyTasks(running).map((task) => task.spec.id)).toEqual(["2"]);
		expect(() => startTasks(running, ["2"])).not.toThrow();
	});

	it("limits simultaneous workers to four", () => {
		const plan = createPlan(
			"Search",
			Array.from({ length: 5 }, (_, index) => ({ ...first, name: `Task ${index}` })),
			"Initial plan",
		);
		expect(selectReadyTasks(plan)).toHaveLength(4);
		const running = startTasks(plan, ["1", "2", "3", "4"]);
		expect(selectReadyTasks(running).map((task) => task.spec.id)).toEqual(["5"]);
		expect(() => startTasks(running, ["5"])).toThrow("At most 4 workers");
	});
});

describe("planning revisions and reviews", () => {
	it("preserves retained IDs and completed peers but reopens later results after a change", () => {
		let plan = createPlan("Search", [first, second, last], "Initial plan");
		plan = completeTask(startTasks(plan, ["1"]), "1", "API works");
		plan = completeTask(startTasks(plan, ["2"]), "2", "UI works");
		plan = completeTask(startTasks(plan, ["3"]), "3", "Flow works");
		const specs = plan.tasks.map((task) => task.spec);
		expect(revisePlan(plan, specs, "Same tasks").tasks).toEqual(plan.tasks);
		const revised = revisePlan(
			plan,
			[{ ...specs[0], description: "Add pagination" }, ...specs.slice(1)],
			"Update API",
		);
		expect(revised.tasks.map((task) => task.state.status)).toEqual(["pending", "done", "pending"]);
		const rejected = reopenTask(plan, "1", "Pagination missing");
		expect(rejected.tasks.map((task) => task.state.status)).toEqual(["pending", "done", "pending"]);
	});

	it("protects running later work against changes, removals, new earlier tasks, and rejection", () => {
		let plan = createPlan("Search", [first, last], "Initial plan");
		plan = completeTask(startTasks(plan, ["1"]), "1", "API works");
		plan = startTasks(plan, ["2"]);
		const [earlier, running] = plan.tasks.map((task) => task.spec);
		expect(() => revisePlan(plan, [{ ...earlier, description: "New API" }, running], "Change earlier task")).toThrow(
			"Cannot invalidate running task",
		);
		expect(() => revisePlan(plan, [running], "Remove earlier task")).toThrow("Cannot invalidate running task");
		expect(() => revisePlan(plan, [earlier, running, second], "Add earlier task")).toThrow(
			"Cannot invalidate running task",
		);
		expect(() => reopenTask(plan, earlier.id, "API incomplete")).toThrow("Cannot invalidate running work");
	});

	it("allows unrelated peers to change while a task is running", () => {
		const plan = startTasks(createPlan("Search", [first, second], "Initial plan"), ["1"]);
		const revised = revisePlan(
			plan,
			[plan.tasks[0].spec, { ...plan.tasks[1].spec, description: "Render empty states" }],
			"Clarify UI",
		);
		expect(revised.tasks[0]).toEqual(plan.tasks[0]);
		expect(selectReadyTasks(revised).map((task) => task.spec.id)).toEqual(["2"]);
	});
});
