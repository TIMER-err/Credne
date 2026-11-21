import { describe, expect, it } from "vitest";
import { type ClaudeModelTraits, getClaudeModelTraits } from "../src/api/claude-subscription/model.ts";

/** The traits that differ from the defaults, so each case lists only what the model's rules change. */
function changedTraits(modelId: string): Partial<ClaudeModelTraits> {
	const defaults = getClaudeModelTraits("not-a-claude-model");
	const traits = getClaudeModelTraits(modelId);
	const changed: Partial<Record<keyof ClaudeModelTraits, unknown>> = {};
	for (const key of Object.keys(traits) as Array<keyof ClaudeModelTraits>) {
		if (traits[key] !== defaults[key]) changed[key] = traits[key];
	}
	return changed as Partial<ClaudeModelTraits>;
}

describe("Claude model traits", () => {
	it("gives an id that is not a Claude the defaults", () => {
		expect(getClaudeModelTraits("gpt-5")).toEqual({
			thinkingMode: "budget",
			hasThinkingPrefixBinding: false,
			supportsThinkingBindingControls: false,
			supportsBetweenToolsThinking: false,
			supportsThinkingDisplay: false,
			acceptsDisabledThinking: false,
			supportsMessageThreads: false,
			supportsSamplingParams: true,
			supportsForcedToolChoice: true,
			supportsMidConversationSystem: false,
			supportsMidConversationToolChanges: false,
			supportsTurnScopedSystem: false,
			supportsPerMessageEffort: false,
			injectsClaudeCodeInstruction: true,
		});
	});

	it("derives Opus 5.5: prefix-bound adaptive thinking with binding controls and no forced tool choice", () => {
		expect(changedTraits("claude-opus-5-5")).toEqual({
			thinkingMode: "adaptive",
			hasThinkingPrefixBinding: true,
			supportsThinkingBindingControls: true,
			supportsThinkingDisplay: true,
			supportsMessageThreads: true,
			supportsSamplingParams: false,
			supportsForcedToolChoice: false,
			supportsMidConversationSystem: true,
			supportsMidConversationToolChanges: true,
			supportsTurnScopedSystem: true,
			supportsPerMessageEffort: true,
		});
	});

	it("derives Sonnet 5.5: between_tools is its lowest thinking setting", () => {
		expect(changedTraits("claude-sonnet-5-5")).toEqual({
			thinkingMode: "adaptive",
			hasThinkingPrefixBinding: true,
			supportsThinkingBindingControls: true,
			supportsBetweenToolsThinking: true,
			supportsThinkingDisplay: true,
			supportsMessageThreads: true,
			supportsSamplingParams: false,
			supportsForcedToolChoice: false,
			supportsMidConversationSystem: true,
			supportsMidConversationToolChanges: true,
			supportsTurnScopedSystem: true,
			supportsPerMessageEffort: true,
		});
	});

	it("derives Haiku 5.5: adaptive, accepts disabled thinking and forced tool choice", () => {
		expect(changedTraits("claude-haiku-5-5")).toEqual({
			thinkingMode: "adaptive",
			hasThinkingPrefixBinding: true,
			supportsThinkingBindingControls: true,
			acceptsDisabledThinking: true,
			supportsThinkingDisplay: true,
			supportsMessageThreads: true,
			supportsSamplingParams: false,
			supportsMidConversationSystem: true,
			supportsMidConversationToolChanges: true,
			supportsTurnScopedSystem: true,
			supportsPerMessageEffort: true,
		});
	});

	it("derives Fable 5.1 and later: binding controls, per-message effort", () => {
		expect(changedTraits("claude-fable-5-1")).toEqual({
			thinkingMode: "adaptive",
			hasThinkingPrefixBinding: true,
			supportsThinkingBindingControls: true,
			supportsThinkingDisplay: true,
			supportsMessageThreads: true,
			supportsSamplingParams: false,
			supportsForcedToolChoice: false,
			supportsMidConversationSystem: true,
			supportsMidConversationToolChanges: true,
			supportsTurnScopedSystem: true,
			supportsPerMessageEffort: true,
		});
		expect(getClaudeModelTraits("claude-fable-5-2").supportsThinkingBindingControls).toBe(true);
	});

	it("derives Fable 5 before binding: no prefix binding, no per-message effort", () => {
		const traits = getClaudeModelTraits("claude-fable-5");
		expect(traits.hasThinkingPrefixBinding).toBe(false);
		expect(traits.supportsThinkingBindingControls).toBe(false);
		expect(traits.supportsPerMessageEffort).toBe(false);
		expect(traits.supportsThinkingDisplay).toBe(true);
		expect(traits.supportsMidConversationSystem).toBe(true);
	});

	it("derives Mythos 5.1: prefix binding without binding controls", () => {
		const traits = getClaudeModelTraits("claude-mythos-5-1");
		expect(traits.hasThinkingPrefixBinding).toBe(true);
		expect(traits.supportsThinkingBindingControls).toBe(false);
		expect(traits.supportsPerMessageEffort).toBe(true);
	});

	it("derives Opus 4.8, 4.7, 4.6 and 4.5 by revision", () => {
		expect(changedTraits("claude-opus-4-8")).toEqual({
			thinkingMode: "adaptive",
			supportsThinkingDisplay: true,
			supportsMessageThreads: true,
			supportsSamplingParams: false,
			supportsMidConversationSystem: true,
			supportsMidConversationToolChanges: true,
			supportsTurnScopedSystem: true,
		});
		expect(changedTraits("claude-opus-4-7")).toEqual({
			thinkingMode: "adaptive",
			supportsThinkingDisplay: true,
			supportsMessageThreads: true,
			supportsSamplingParams: false,
		});
		expect(changedTraits("claude-opus-4-6")).toEqual({ thinkingMode: "adaptive", supportsMessageThreads: true });
		expect(changedTraits("claude-opus-4-5-20251101")).toEqual({
			thinkingMode: "budget-effort",
			supportsMessageThreads: true,
		});
	});

	it("reads the revision before a date suffix and ignores a thinking suffix", () => {
		expect(getClaudeModelTraits("claude-sonnet-4-5-20250929").thinkingMode).toBe("budget");
		expect(getClaudeModelTraits("claude-opus-4-20250514").supportsMessageThreads).toBe(false);
		expect(getClaudeModelTraits("claude-opus-5-5-thinking")).toEqual(getClaudeModelTraits("claude-opus-5-5"));
	});

	it("handles the older version-first ids", () => {
		expect(changedTraits("claude-3-7-sonnet-20250219")).toEqual({});
		expect(changedTraits("claude-3-5-haiku-20241022")).toEqual({ injectsClaudeCodeInstruction: false });
	});

	it("selects the revision-less Mythos preview by its id", () => {
		expect(changedTraits("claude-mythos-preview")).toEqual({
			supportsMessageThreads: true,
			supportsForcedToolChoice: false,
		});
	});

	it("ignores a provider prefix and case", () => {
		expect(getClaudeModelTraits("anthropic/Claude-Opus-5-5")).toEqual(getClaudeModelTraits("claude-opus-5-5"));
		expect(changedTraits("~anthropic/claude-sonnet-latest")).toEqual({});
	});

	it("gives Sonnet 6 the open-ended rules only", () => {
		const traits = getClaudeModelTraits("claude-sonnet-6");
		expect(traits.hasThinkingPrefixBinding).toBe(false);
		expect(traits.supportsBetweenToolsThinking).toBe(false);
		expect(traits.supportsThinkingBindingControls).toBe(true);
		expect(traits.supportsForcedToolChoice).toBe(true);
	});
});
