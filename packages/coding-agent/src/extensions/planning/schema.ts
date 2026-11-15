// Defines planning tool input and persisted session state schemas.
import { Type } from "typebox";

export const taskSpecSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	order: Type.Integer({
		minimum: 1,
		description:
			"Positive execution phase. Same order tasks may be assigned together when dependencies and ownership permit. Earlier leaf phases must be completed first. Put a task alone in a phase for exclusive execution. Creation never starts workers.",
	}),
	component: Type.String({ minLength: 1 }),
	description: Type.String({ minLength: 1 }),
	paths: Type.Array(Type.String(), {
		description:
			"Owned literal paths relative to the working directory, files or directories, without glob patterns.",
	}),
	dependsOn: Type.Array(Type.String()),
	parentId: Type.Optional(
		Type.String({
			description:
				"Optional parent group task ID. Groups are not assigned to workers and complete automatically after their children and prerequisites complete.",
		}),
	),
	acceptance: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Concrete criteria the worker must satisfy and report validation evidence for before completing work.",
	}),
});

export const planSchema = Type.Object({
	objective: Type.String(),
	revision: Type.Integer({ minimum: 1 }),
	reason: Type.String(),
	tasks: Type.Array(
		Type.Object({
			spec: taskSpecSchema,
			state: Type.Union([
				Type.Object({ status: Type.Literal("pending") }),
				Type.Object({ status: Type.Literal("running") }),
				Type.Object({
					status: Type.Literal("done"),
					output: Type.String(),
					evidence: Type.Optional(Type.String()),
				}),
				Type.Object({ status: Type.Literal("failed"), error: Type.String() }),
				Type.Object({ status: Type.Literal("superseded"), reason: Type.String() }),
			]),
		}),
	),
});
