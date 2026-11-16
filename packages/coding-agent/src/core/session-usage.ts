// Aggregates billable parent entries and the latest cumulative snapshot for each subagent worker.
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SessionEntry } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "./usage-totals.ts";

export const SUBAGENT_USAGE_ENTRY = "subagent-usage";

export interface SubagentUsageSnapshot {
	workerId: string;
	usage: UsageTotals;
}

const snapshotSchema = Type.Object({
	workerId: Type.String({ minLength: 1 }),
	usage: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		cost: Type.Number(),
	}),
});

/** Returns session-wide usage, replacing earlier worker snapshots with each worker's latest lifetime totals. */
export function getSessionUsage(entries: SessionEntry[]): UsageTotals {
	const totals = createUsageTotals();
	const workers = new Map<string, UsageTotals>();
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (entry.type === "usage") usage = entry.usage;
		else if (entry.type === "message" && entry.message.role === "assistant") usage = entry.message.usage;
		else if (entry.type === "message" && entry.message.role === "toolResult") usage = entry.message.usage;
		else if (entry.type === "branch_summary" || entry.type === "compaction") usage = entry.usage;
		if (usage) addUsageToTotals(totals, usage);

		if (
			entry.type === "custom" &&
			entry.customType === SUBAGENT_USAGE_ENTRY &&
			Value.Check(snapshotSchema, entry.data)
		) {
			workers.set(entry.data.workerId, entry.data.usage);
		}
	}
	for (const usage of workers.values()) {
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.cost += usage.cost;
	}
	return totals;
}
