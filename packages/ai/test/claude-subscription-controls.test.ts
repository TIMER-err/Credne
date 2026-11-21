import type { BetaMessageParam as MessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, it } from "vitest";
import {
	effortControlsBlockDisabledThinking,
	insertEffortControls,
	planClaudeCodeTools,
	planClaudeEffortControls,
	renderClaudeSystemControl,
} from "../src/api/claude-subscription/controls.ts";
import { convertClaudeCodeTools } from "../src/api/claude-subscription/tools.ts";
import type { Message, SystemMessage, Tool } from "../src/types.ts";

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: { type: "object", properties: {} } };
}

function system(content: string, changes: Pick<SystemMessage, "toolsAdded" | "toolsRemoved"> = {}): SystemMessage {
	return { role: "system", content, ...changes, timestamp: 0 };
}

function reference(type: "tool_addition" | "tool_removal", name: string) {
	return { type, tool: { type: "tool_reference", name } };
}

describe("planClaudeCodeTools", () => {
	it("declares the current tools when tool changes are not native", () => {
		const messages: Message[] = [
			system("base", { toolsAdded: [tool("a"), tool("b")] }),
			system("", { toolsRemoved: [{ name: "a" }], toolsAdded: [tool("c")] }),
		];
		const plan = planClaudeCodeTools(messages, false);
		expect(plan.tools.map((entry) => [entry.tool.name, entry.deferred])).toEqual([
			["b", false],
			["c", false],
		]);
		expect(plan.changeBlocks).toBeUndefined();
	});

	it("declares every tool the transcript ever declared, the later ones deferred", () => {
		const messages: Message[] = [
			system("base", { toolsAdded: [tool("a"), tool("b")] }),
			system("", { toolsAdded: [tool("c")] }),
		];
		const plan = planClaudeCodeTools(messages, true);
		expect(plan.tools.map((entry) => [entry.tool.name, entry.deferred])).toEqual([
			["a", false],
			["b", false],
			["c", true],
		]);
	});

	it("sends a deferred tool in wire form with defer_loading after strict and before the breakpoint", () => {
		const messages: Message[] = [
			system("base", { toolsAdded: [tool("a")] }),
			system("", { toolsAdded: [tool("c")] }),
		];
		const plan = planClaudeCodeTools(messages, true);
		const { tools } = convertClaudeCodeTools(plan.tools, {
			disableStrictTools: false,
			supportsEagerToolInputStreaming: true,
		});
		expect(tools.map((entry) => Object.keys(entry))).toEqual([
			["name", "description", "input_schema", "eager_input_streaming"],
			["name", "description", "input_schema", "eager_input_streaming", "defer_loading"],
		]);
	});

	it("replays tool changes as tool_reference additions and removals, removals first", () => {
		const messages: Message[] = [
			system("base", { toolsAdded: [tool("a"), tool("b")] }),
			system("", { toolsAdded: [tool("c"), tool("d")] }),
			system("", { toolsRemoved: [{ name: "a" }, { name: "c" }] }),
			system("", { toolsRemoved: [{ name: "d" }], toolsAdded: [tool("a")] }),
		];
		const plan = planClaudeCodeTools(messages, true);
		const blocks = messages.slice(1).map((message) => plan.changeBlocks?.(message as SystemMessage));
		expect(blocks).toEqual([
			[reference("tool_addition", "_c"), reference("tool_addition", "_d")],
			[reference("tool_removal", "_a"), reference("tool_removal", "_c")],
			[reference("tool_removal", "_d"), reference("tool_addition", "_a")],
		]);
	});

	it("sends no blocks for a same-name redefinition, which stays active", () => {
		const messages: Message[] = [
			system("base", { toolsAdded: [tool("a")] }),
			system("", { toolsRemoved: [{ name: "a" }], toolsAdded: [{ ...tool("a"), description: "new" }] }),
		];
		const plan = planClaudeCodeTools(messages, true);
		expect(plan.changeBlocks?.(messages[1] as SystemMessage)).toEqual([]);
		expect(plan.tools[0]?.tool.description).toBe("new");
	});

	it("declares tools of a transcript that starts without any in place, none deferred", () => {
		const messages: Message[] = [system("base"), system("", { toolsAdded: [tool("a")] })];
		const plan = planClaudeCodeTools(messages, true);
		expect(plan.tools.map((entry) => [entry.tool.name, entry.deferred])).toEqual([["a", false]]);
		expect(plan.changeBlocks?.(messages[1] as SystemMessage)).toEqual([]);
	});

	it("declares no tools for a transcript without any", () => {
		expect(planClaudeCodeTools([system("base")], true).tools).toEqual([]);
		expect(planClaudeCodeTools([], false).tools).toEqual([]);
	});

	it("sends tools: [] on the wire when there are none", () => {
		const { tools } = convertClaudeCodeTools([], {
			disableStrictTools: false,
			supportsEagerToolInputStreaming: true,
		});
		expect(JSON.stringify(tools)).toBe("[]");
	});
});

const user = (text: string): MessageParam => ({ role: "user", content: text });
const assistant = (text: string): MessageParam => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResults: MessageParam = {
	role: "user",
	content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
};
const toolUse: MessageParam = { role: "assistant", content: [{ type: "tool_use", id: "t", name: "_x", input: {} }] };

describe("planClaudeEffortControls", () => {
	it("sends the effort at the top level of a model without per-message effort", () => {
		const plan = planClaudeEffortControls("high", [user("a")], new Map(), false);
		expect(plan).toEqual({ topLevel: "high", inserts: [], tail: undefined });
	});

	it("sends the first request's effort at the top level and no control", () => {
		const plan = planClaudeEffortControls("high", [user("a")], new Map(), true);
		expect(plan).toEqual({ topLevel: "high", inserts: [], tail: "high" });
	});

	it("keeps the first reply's effort at the top level and sends a control only when the level changes", () => {
		const messages = [user("a"), assistant("1"), user("b"), assistant("2"), user("c")];
		const levels = new Map([
			[1, "high"],
			[3, "high"],
		] as const);
		expect(planClaudeEffortControls("high", messages, levels, true)).toEqual({
			topLevel: "high",
			inserts: [],
			tail: "high",
		});
		expect(planClaudeEffortControls("low", messages, levels, true)).toEqual({
			topLevel: "high",
			inserts: [{ index: 4, effort: "low" }],
			tail: "low",
		});
	});

	it("replays an earlier change before the user turn it applied to, then the current one at the tail", () => {
		const messages = [user("a"), assistant("1"), user("b"), assistant("2"), user("c"), assistant("3"), user("d")];
		const levels = new Map([
			[1, "high"],
			[3, "high"],
			[5, "low"],
		] as const);
		const plan = planClaudeEffortControls("medium", messages, levels, true);
		expect(plan).toEqual({
			topLevel: "high",
			inserts: [
				{ index: 4, effort: "low" },
				{ index: 6, effort: "medium" },
			],
			tail: "medium",
		});
	});

	it("keeps the effort in force when the request names none", () => {
		const messages = [user("a"), assistant("1"), user("b")];
		const plan = planClaudeEffortControls(undefined, messages, new Map([[1, "low"]] as const), true);
		expect(plan).toEqual({ topLevel: "low", inserts: [], tail: "low" });
	});

	it("puts a control at the end of a tool loop instead of between a tool_use and its result", () => {
		const messages = [user("a"), toolUse, toolResults, assistant("done")];
		const levels = new Map([
			[1, "high"],
			[3, "low"],
		] as const);
		// The reply at index 3 continues the loop, so its control sits right before it, after the tool results.
		expect(planClaudeEffortControls(undefined, messages, levels, true).inserts).toEqual([
			{ index: 3, effort: "low" },
		]);
		const loop = [user("a"), toolUse, toolResults];
		const loopLevels = new Map([[1, "high"]] as const);
		expect(planClaudeEffortControls("low", loop, loopLevels, true).inserts).toEqual([{ index: 3, effort: "low" }]);
	});
});

describe("insertEffortControls", () => {
	it("splices bare system controls with output_config in front of the indexed messages", () => {
		const messages = [user("a"), assistant("1"), user("b")];
		const result = insertEffortControls(messages, [
			{ index: 2, effort: "low" },
			{ index: 3, effort: "high" },
		]);
		expect(JSON.stringify(result)).toBe(
			JSON.stringify([
				user("a"),
				assistant("1"),
				{ role: "system", content: [], output_config: { effort: "low" } },
				user("b"),
				{ role: "system", content: [], output_config: { effort: "high" } },
			]),
		);
	});

	it("merges controls at one index, the later effort winning, and returns the input when there are none", () => {
		const messages = [user("a")];
		const merged = insertEffortControls(messages, [
			{ index: 0, effort: "low" },
			{ index: 0, effort: "max" },
		]);
		expect(merged).toEqual([{ role: "system", content: [], output_config: { effort: "max" } }, user("a")]);
		expect(insertEffortControls(messages, [])).toBe(messages);
	});
});

describe("effortControlsBlockDisabledThinking", () => {
	const messages = [user("a"), assistant("1"), user("b"), assistant("2")];

	it("blocks disabled thinking once a control exists", () => {
		const levels = new Map([
			[1, "high"],
			[3, "low"],
		] as const);
		expect(effortControlsBlockDisabledThinking(messages, levels)).toBe(true);
	});

	it("blocks it for a top-level effort above high", () => {
		expect(effortControlsBlockDisabledThinking(messages, new Map([[1, "xhigh"]] as const))).toBe(true);
		expect(effortControlsBlockDisabledThinking(messages, new Map([[1, "max"]] as const))).toBe(true);
	});

	it("allows it otherwise", () => {
		expect(effortControlsBlockDisabledThinking(messages, new Map([[1, "high"]] as const))).toBe(false);
		expect(effortControlsBlockDisabledThinking(messages, new Map())).toBe(false);
	});
});

describe("renderClaudeSystemControl", () => {
	const traits = { supportsTurnScopedSystem: true, supportsPerMessageEffort: true };
	const text = { type: "text", text: "note" } as const;
	const addition = reference("tool_addition", "_x") as never;

	it("keeps a plain system message as one message", () => {
		const result = renderClaudeSystemControl({ content: [text], clearAt: undefined, effort: undefined, traits });
		expect(JSON.stringify(result)).toBe('[{"role":"system","content":[{"type":"text","text":"note"}]}]');
	});

	it("scopes a text-only message to the next user turn", () => {
		const result = renderClaudeSystemControl({
			content: [text],
			clearAt: "next_user_message",
			effort: undefined,
			traits,
		});
		expect(JSON.stringify(result)).toBe(
			'[{"role":"system","content":[{"type":"text","text":"note"}],"clear_at":"next_user_message"}]',
		);
	});

	it("splits a turn-scoped message that also changes tools or effort", () => {
		const result = renderClaudeSystemControl({
			content: [text, addition],
			clearAt: "next_user_message",
			effort: "low",
			traits,
		});
		expect(JSON.stringify(result)).toBe(
			JSON.stringify([
				{ role: "system", content: [text], clear_at: "next_user_message" },
				{ role: "system", content: [addition], output_config: { effort: "low" } },
			]),
		);
	});

	it("sends a scoped control with no text as one message without a scope", () => {
		const result = renderClaudeSystemControl({
			content: [addition],
			clearAt: "next_user_message",
			effort: undefined,
			traits,
		});
		expect(JSON.stringify(result)).toBe(JSON.stringify([{ role: "system", content: [addition] }]));
	});

	it("ignores the scope and effort on a model that does not support them", () => {
		const result = renderClaudeSystemControl({
			content: [text],
			clearAt: "next_user_message",
			effort: "high",
			traits: { supportsTurnScopedSystem: false, supportsPerMessageEffort: false },
		});
		expect(JSON.stringify(result)).toBe('[{"role":"system","content":[{"type":"text","text":"note"}]}]');
	});
});
