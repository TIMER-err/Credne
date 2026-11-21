import { describe, expect, it } from "vitest";
import { getClaudeModelTraits } from "../src/api/claude-subscription/model.ts";
import {
	type ClaudeCodeThinkingInput,
	planClaudeCodeContextManagement,
	planClaudeCodeThinking,
	planClaudeCodeToolChoice,
} from "../src/api/claude-subscription/thinking.ts";

/** A thinking request of `modelId` with every other input at its neutral value. */
function thinkingInput(modelId: string, overrides: Partial<ClaudeCodeThinkingInput> = {}): ClaudeCodeThinkingInput {
	const traits = getClaudeModelTraits(modelId);
	return {
		traits,
		reasoning: true,
		adaptive: traits.thinkingMode === "adaptive",
		thinkingEnabled: true,
		effort: "high",
		budgetTokens: undefined,
		display: undefined,
		effortBlocksDisabledThinking: false,
		...overrides,
	};
}

function plan(modelId: string, overrides: Partial<ClaudeCodeThinkingInput> = {}): string {
	return JSON.stringify(planClaudeCodeThinking(thinkingInput(modelId, overrides)));
}

describe("planClaudeCodeThinking", () => {
	it("sends adaptive thinking without display where the model rejects it (Opus 4.6)", () => {
		expect(plan("claude-opus-4-6")).toBe('{"thinking":{"type":"adaptive"},"effort":"high"}');
	});

	it("requests summarized display on adaptive generation 4.7 and newer", () => {
		expect(plan("claude-opus-4-7")).toBe('{"thinking":{"type":"adaptive","display":"summarized"},"effort":"high"}');
		expect(plan("claude-opus-4-7", { display: "omitted" })).toBe(
			'{"thinking":{"type":"adaptive","display":"omitted"},"effort":"high"}',
		);
	});

	it("adds block_binding after display on prefix-bound models with binding controls", () => {
		for (const modelId of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
			expect(plan(modelId)).toBe(
				'{"thinking":{"type":"adaptive","display":"summarized","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"effort":"high"}',
			);
		}
	});

	it("sends no block_binding for prefix-bound models without binding controls", () => {
		expect(plan("claude-mythos-5-1")).toBe('{"thinking":{"type":"adaptive","display":"summarized"},"effort":"high"}');
	});

	it("takes the mismatch behavior from the request", () => {
		expect(plan("claude-opus-5-5", { prefixMismatchBehavior: "error" })).toContain(
			'"block_binding":{"prefix_mismatch_behavior":"error"}',
		);
	});

	it("re-adds adaptive thinking with block_binding where the request omitted thinking", () => {
		expect(plan("claude-opus-5-5", { thinkingEnabled: undefined, effort: undefined })).toBe(
			'{"thinking":{"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"drop_block"}}}',
		);
		expect(plan("claude-opus-4-8", { thinkingEnabled: undefined, effort: undefined })).toBe("{}");
	});

	it("never binds a model that does not reason", () => {
		expect(plan("claude-opus-5-5", { reasoning: false })).toBe("{}");
	});

	it("turns thinking off on an adaptive-only model by omitting it and pinning the lowest effort", () => {
		expect(plan("claude-opus-4-8", { thinkingEnabled: false })).toBe('{"effort":"low"}');
	});

	it("keeps the binding on an adaptive-only model with thinking off", () => {
		expect(plan("claude-opus-5-5", { thinkingEnabled: false })).toBe(
			'{"thinking":{"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"effort":"low"}',
		);
	});

	it("turns thinking off on Sonnet 5.5 with between_tools and no effort", () => {
		expect(plan("claude-sonnet-5-5", { thinkingEnabled: false })).toBe('{"thinking":{"type":"between_tools"}}');
	});

	it("turns thinking off on Haiku 5.5 with disabled, unless effort controls forbid it", () => {
		expect(plan("claude-haiku-5-5", { thinkingEnabled: false })).toBe('{"thinking":{"type":"disabled"}}');
		expect(plan("claude-haiku-5-5", { thinkingEnabled: false, effortBlocksDisabledThinking: true })).toBe(
			'{"thinking":{"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"drop_block"}},"effort":"low"}',
		);
	});

	it("uses budget thinking on older models, with display, and no effort", () => {
		expect(plan("claude-sonnet-4-5", { budgetTokens: 2048 })).toBe(
			'{"thinking":{"type":"enabled","budget_tokens":2048,"display":"summarized"}}',
		);
		expect(plan("claude-sonnet-4-5")).toBe(
			'{"thinking":{"type":"enabled","budget_tokens":1024,"display":"summarized"}}',
		);
	});

	it("sends the effort beside the budget on Opus 4.5", () => {
		expect(plan("claude-opus-4-5", { budgetTokens: 4096 })).toBe(
			'{"thinking":{"type":"enabled","budget_tokens":4096,"display":"summarized"},"effort":"high"}',
		);
	});

	it("disables thinking on a budget model that is asked to stop thinking", () => {
		expect(plan("claude-sonnet-4-5", { thinkingEnabled: false })).toBe('{"thinking":{"type":"disabled"}}');
	});
});

describe("planClaudeCodeContextManagement", () => {
	it("keeps all thinking whenever thinking is adaptive or enabled", () => {
		const edits = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
		expect(planClaudeCodeContextManagement({ type: "adaptive" })).toEqual(edits);
		expect(planClaudeCodeContextManagement({ type: "enabled", budget_tokens: 1024 })).toEqual(edits);
	});

	it("sends none without thinking, with disabled thinking and with between_tools", () => {
		expect(planClaudeCodeContextManagement(undefined)).toBeUndefined();
		expect(planClaudeCodeContextManagement({ type: "disabled" })).toBeUndefined();
		expect(planClaudeCodeContextManagement({ type: "between_tools" })).toBeUndefined();
	});
});

describe("planClaudeCodeToolChoice", () => {
	function choose(modelId: string, toolChoice: Parameters<typeof planClaudeCodeToolChoice>[0]["toolChoice"]) {
		const traits = getClaudeModelTraits(modelId);
		return planClaudeCodeToolChoice({
			toolChoice,
			traits,
			adaptive: traits.thinkingMode === "adaptive",
			thinking: { type: "adaptive" },
			effort: "high",
		});
	}

	it("sends no choice when none is requested", () => {
		expect(choose("claude-opus-4-8", undefined)).toEqual({
			toolChoice: undefined,
			thinking: { type: "adaptive" },
			effort: "high",
		});
	});

	it("passes auto and none through with thinking untouched", () => {
		expect(choose("claude-opus-4-8", "auto").toolChoice).toEqual({ type: "auto" });
		expect(choose("claude-opus-4-8", "none")).toEqual({
			toolChoice: { type: "none" },
			thinking: { type: "adaptive" },
			effort: "high",
		});
	});

	it("drops thinking and pins the lowest effort for a forced choice on an adaptive model", () => {
		expect(choose("claude-opus-4-8", "any")).toEqual({
			toolChoice: { type: "any" },
			thinking: undefined,
			effort: "low",
		});
	});

	it("prefixes the forced tool name", () => {
		expect(choose("claude-opus-4-8", { type: "tool", name: "edit" }).toolChoice).toEqual({
			type: "tool",
			name: "_edit",
		});
	});

	it("drops the effort with thinking for a forced choice on a budget model", () => {
		expect(choose("claude-sonnet-4-5", "any")).toEqual({
			toolChoice: { type: "any" },
			thinking: undefined,
			effort: undefined,
		});
	});

	it("downgrades a forced choice to auto where the model rejects it", () => {
		expect(choose("claude-opus-5-5", "any")).toEqual({
			toolChoice: { type: "auto" },
			thinking: { type: "adaptive" },
			effort: "high",
		});
		expect(choose("claude-fable-5-1", { type: "tool", name: "edit" }).toolChoice).toEqual({ type: "auto" });
	});
});
