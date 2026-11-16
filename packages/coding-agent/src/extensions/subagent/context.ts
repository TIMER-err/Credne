// Selects safe chronological context checkpoints for isolated child sessions.
import type { ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { buildSessionProjection, type SessionEntry } from "../../core/session-manager.ts";
import { renderParentConversation } from "./parent-conversation.ts";

export const turnSchema = Type.Integer({
	minimum: -1,
	default: 0,
	description:
		"0 starts fresh, -1 inherits the latest safe context, positive numbers inherit through a labeled checkpoint from get_subagent_context.",
});

export const subagentContextResultSchema = Type.Object({
	turns: Type.Array(
		Type.Object({
			turn: Type.Integer(),
			kind: Type.Union([
				Type.Literal("user"),
				Type.Literal("assistant"),
				Type.Literal("task_result"),
				Type.Literal("subagent_result"),
				Type.Literal("agent_message"),
				Type.Literal("step"),
			]),
			preview: Type.String(),
		}),
	),
});

export type SubagentContextResult = Static<typeof subagentContextResultSchema>;

/**
 * What a subagent starts from. A fresh one gets only its task; one with the conversation also gets
 * the stripped copy of the parent conversation up to the cutoff, rendered at submission.
 */
export type SubagentContextSnapshot =
	| { mode: "fresh"; sessionId: string }
	| { mode: "latest" | "turn"; sessionId: string; conversation: string };

type CheckpointLabel = Omit<SubagentContextResult["turns"][number], "turn">;

interface ContextCheckpoints {
	checkpoints: { label: CheckpointLabel; end: number }[];
	safeEnd: number;
}

/** Lists safe conversation, worker report, communication, task completion and named step checkpoints. */
export function listSubagentContext(ctx: ExtensionContext): SubagentContextResult {
	const { checkpoints } = scanCheckpoints(ctx.sessionManager.getBranch());
	return { turns: checkpoints.map(({ label }, index) => ({ turn: index + 1, ...label })) };
}

/**
 * Captures what a subagent starts from now: nothing for a fresh one, otherwise the stripped
 * conversation of the selected branch prefix, excluding unfinished tool batches.
 */
export function captureSubagentContext(turn: number | undefined, ctx: ExtensionContext): SubagentContextSnapshot {
	const sessionId = ctx.sessionManager.getSessionId();
	if (turn === undefined || turn === 0) return { mode: "fresh", sessionId };
	if (!Number.isInteger(turn) || turn < -1) throw new Error("Context turn must be -1, 0, or a positive integer");
	const branch = ctx.sessionManager.getBranch();
	const { checkpoints, safeEnd } = scanCheckpoints(branch);
	const selected = turn > 0 ? checkpoints[turn - 1] : undefined;
	if (turn > 0 && !selected)
		throw new Error(
			`Unknown context checkpoint: ${turn}. Available checkpoints: ${checkpoints.length ? `1 through ${checkpoints.length}` : "none"}`,
		);
	const prefix = branch.slice(0, selected?.end ?? safeEnd);
	// Projected as the parent's own requests see it: compactions, context edits and custom messages applied.
	const { messages } = buildSessionProjection(prefix, prefix.at(-1)?.id ?? null);
	return { mode: turn === -1 ? "latest" : "turn", sessionId, conversation: renderParentConversation(messages) };
}

function scanCheckpoints(entries: SessionEntry[]): ContextCheckpoints {
	const calls = new Map<string, ToolCall>();
	const pending: CheckpointLabel[] = [];
	const checkpoints: ContextCheckpoints["checkpoints"] = [];
	let safeEnd = 0;
	for (const [index, entry] of entries.entries()) {
		trackToolCalls(entry, calls);
		const label = checkpointLabel(entry, calls);
		if (label) pending.push(label);
		if (entry.type === "message" && entry.message.role === "toolResult") calls.delete(entry.message.toolCallId);
		if (calls.size > 0) continue;
		safeEnd = index + 1;
		for (const candidate of pending) checkpoints.push({ label: candidate, end: safeEnd });
		pending.length = 0;
	}
	return { checkpoints, safeEnd };
}

function trackToolCalls(entry: SessionEntry, calls: Map<string, ToolCall>): void {
	if (entry.type !== "message" || entry.message.role !== "assistant") return;
	for (const part of entry.message.content) {
		if (part.type === "toolCall") calls.set(part.id, part);
	}
}

function checkpointLabel(entry: SessionEntry, calls: Map<string, ToolCall>): CheckpointLabel | undefined {
	if (entry.type === "custom_message") return customCheckpoint(entry.customType, entry.content);
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "custom") return customCheckpoint(message.customType, message.content);
	if (message.role === "user") return { kind: "user", preview: boundedPreview(message.content) };
	if (message.role === "assistant") {
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "toolUse")
			return undefined;
		if (message.content.some((part) => part.type === "toolCall")) return undefined;
		return { kind: "assistant", preview: boundedPreview(message.content.filter((part) => part.type === "text")) };
	}
	if (message.role !== "toolResult" || message.isError) return undefined;
	const call = calls.get(message.toolCallId);
	if (call?.name === "task_update" && Value.Check(completedTaskArgumentsSchema, call.arguments))
		return {
			kind: "task_result",
			preview: `Completed task ${call.arguments.taskId}: ${call.arguments.output}`.slice(0, 200),
		};
	if (call?.name === "checkpoint_context") return stepCheckpoint(call.arguments);
	return undefined;
}

function customCheckpoint(
	customType: string,
	content: string | (TextContent | ImageContent)[],
): CheckpointLabel | undefined {
	const preview = boundedPreview(content);
	switch (customType) {
		case "planning-result":
			return { kind: "task_result", preview };
		case "subagent-result":
			return { kind: "subagent_result", preview };
		case "agent-message":
			return { kind: "agent_message", preview };
		default:
			return undefined;
	}
}

const completedTaskArgumentsSchema = Type.Object({
	taskId: Type.String(),
	status: Type.Literal("done"),
	output: Type.String(),
});

const stepArgumentsSchema = Type.Object({ name: Type.String(), description: Type.Optional(Type.String()) });

function stepCheckpoint(args: unknown): CheckpointLabel | undefined {
	// A historical tool call is a disk boundary, so validate the persisted label.
	if (!Value.Check(stepArgumentsSchema, args)) return undefined;
	return { kind: "step", preview: boundedPreview(`${args.name}${args.description ? `: ${args.description}` : ""}`) };
}

function boundedPreview(content: string | (TextContent | ImageContent)[]): string {
	const text =
		typeof content === "string"
			? content
			: content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join(" ");
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
