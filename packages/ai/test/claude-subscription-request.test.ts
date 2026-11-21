import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AnthropicOptions } from "../src/api/anthropic-messages.ts";
import type { ClaudeCodeRequestIdentity } from "../src/api/claude-subscription/identity.ts";
import {
	buildClaudeCodeParams,
	convertClaudeCodeReply,
	getClaudeCodeBetaFeatures,
	getFirstUserText,
} from "../src/api/claude-subscription/request.ts";
import type { AssistantMessage, Message, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const identity: ClaudeCodeRequestIdentity = {
	ccVersion: "2.1.326.abc",
	sessionId: "session-1",
	userId: '{"session_id":"session-1"}',
};

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-4-6",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1000,
	compat: { forceAdaptiveThinking: true },
};

const flags = { disableStrictTools: false, dropPromptCacheBetas: false };

function lookupTool(): Tool {
	return { name: "lookup", description: "Look it up", parameters: Type.Object({ value: Type.String() }) };
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function build(
	options: AnthropicOptions = {},
	overrides: { model?: Model<"anthropic-messages">; tools?: Tool[] } = {},
) {
	const context = normalizeContext({
		systemPrompt: "You are a test assistant.",
		tools: overrides.tools ?? [lookupTool()],
		messages: [user("Hello world, this is a test")],
	});
	return buildClaudeCodeParams(overrides.model ?? model, context, options, identity, flags);
}

function systemBlocks(params: MessageCreateParamsStreaming): Array<{ text: string }> {
	return Array.isArray(params.system) ? params.system : [];
}

function toolNames(params: MessageCreateParamsStreaming): string[] {
	return (params.tools ?? []).flatMap((tool) => ("name" in tool ? [tool.name] : []));
}

describe("Claude subscription request body", () => {
	it("writes the fields in Claude Code's key order", () => {
		const { params } = build({ thinkingEnabled: true, effort: "high", toolChoice: "auto" });

		expect(Object.keys(params)).toEqual([
			"model",
			"messages",
			"system",
			"tools",
			"metadata",
			"max_tokens",
			"thinking",
			"context_management",
			"output_config",
			"stream",
			"tool_choice",
			"betas",
		]);
		expect(params).toMatchObject({
			model: "claude-opus-4-6",
			metadata: { user_id: identity.userId },
			max_tokens: 1000,
			thinking: { type: "adaptive" },
			context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
			output_config: { effort: "high" },
			stream: true,
			tool_choice: { type: "auto" },
		});
	});

	it("puts sampling before the tool choice, and only without thinking", () => {
		const plain = build(
			{ thinkingEnabled: false, temperature: 0.2, toolChoice: "auto" },
			{ model: { ...model, compat: {} } },
		);
		const thinking = build({ thinkingEnabled: true, temperature: 0.2 });

		expect(Object.keys(plain.params).slice(-3)).toEqual(["temperature", "tool_choice", "betas"]);
		expect(thinking.params).not.toHaveProperty("temperature");
	});

	it("starts the system blocks with the billing block, then Claude Code's identity, then the prompt", () => {
		const system = systemBlocks(build().params);

		expect(system.map((block) => block.text)).toEqual([
			"x-anthropic-billing-header: cc_version=2.1.326.abc; cc_entrypoint=cli; cch=00000;",
			"You are Claude Code, Anthropic's official CLI for Claude.",
			"You are a test assistant.",
		]);
		expect(system[0]).not.toHaveProperty("cache_control");
	});

	it("declares every tool with the wire prefix, and still declares none for a request without tools", () => {
		expect(toolNames(build().params)).toEqual(["_lookup"]);
		expect(build({}, { tools: [] }).params.tools).toEqual([]);
	});

	it("limits max_tokens to what the model allows", () => {
		expect(build({ maxTokens: 400 }).params.max_tokens).toBe(400);
		expect(build({ maxTokens: 5000 }).params.max_tokens).toBe(1000);
		expect(build().params.max_tokens).toBe(1000);
	});

	it("names a forced tool by its wire name and turns thinking off beside it", () => {
		const { params } = build({
			thinkingEnabled: true,
			effort: "high",
			toolChoice: { type: "tool", name: "lookup" },
		});

		expect(params.tool_choice).toEqual({ type: "tool", name: "_lookup" });
		expect(params).not.toHaveProperty("thinking");
		expect(params).not.toHaveProperty("context_management");
		// An adaptive model cannot switch thinking off by omitting it, so the lowest effort is pinned.
		expect(params.output_config).toEqual({ effort: "low" });
	});

	it("sends no effort beside a forced tool for a model that thinks on a budget", () => {
		const budgetModel = { ...model, id: "claude-sonnet-4-5", compat: {} };

		const { params } = build(
			{ thinkingEnabled: true, thinkingBudgetTokens: 2048, toolChoice: "any" },
			{ model: budgetModel },
		);

		expect(params.tool_choice).toEqual({ type: "any" });
		expect(params).not.toHaveProperty("thinking");
		expect(params).not.toHaveProperty("output_config");
	});

	it("records the effort in force on the reply", () => {
		expect(build({ thinkingEnabled: true, effort: "high" }).providerThinkingLevel).toBeUndefined();
		const perMessage = { ...model, compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true } };

		expect(build({ thinkingEnabled: true, effort: "high" }, { model: perMessage }).providerThinkingLevel).toBe(
			"high",
		);
	});
});

describe("Claude subscription betas", () => {
	const facts = {
		hasTools: false,
		disableStrictTools: false,
		dropPromptCacheBetas: false,
		carriesThinkingBinding: false,
		carriesContextManagement: false,
	};

	it("uses the utility profile for a request without tools or thinking, and the agent profile otherwise", () => {
		const utility = getClaudeCodeBetaFeatures(model, {}, facts);
		const agent = getClaudeCodeBetaFeatures(model, {}, { ...facts, hasTools: true });

		expect(utility).not.toContain("claude-code-20250219");
		expect(utility).toContain("structured-outputs-2025-12-15");
		expect(agent[0]).toBe("claude-code-20250219");
		expect(agent).toContain("oauth-2025-04-20");
		expect(agent).not.toContain("structured-outputs-2025-12-15");
	});

	it("never advertises the 1m context beta, and lists every beta once", () => {
		const betas = getClaudeCodeBetaFeatures(model, { thinkingEnabled: true }, { ...facts, hasTools: true });

		expect(betas.some((beta) => beta.includes("context-1m"))).toBe(false);
		expect(new Set(betas).size).toBe(betas.length);
		expect(betas).toContain("effort-2025-11-24");
	});

	it("withholds the prompt-cache beta once the endpoint refused cache_control", () => {
		const betas = getClaudeCodeBetaFeatures(model, {}, { ...facts, hasTools: true, dropPromptCacheBetas: true });

		expect(betas).not.toContain("prompt-caching-scope-2026-01-05");
		expect(getClaudeCodeBetaFeatures(model, {}, { ...facts, hasTools: true })).toContain(
			"prompt-caching-scope-2026-01-05",
		);
	});

	it("adds the betas of what the body carries, and ignores a caller's anthropic-beta header", () => {
		const withHeader = { headers: { "anthropic-beta": "caller-beta" } };
		const betas = getClaudeCodeBetaFeatures(model, withHeader, {
			...facts,
			carriesThinkingBinding: true,
			carriesContextManagement: true,
		});

		expect(betas).toContain("thinking-binding-controls-2026-08-01");
		expect(betas).toContain("context-management-2025-06-27");
		expect(betas).not.toContain("caller-beta");
	});

	it("never carries the threads beta: the thread planner adds it to a body that has a thread", () => {
		expect(getClaudeCodeBetaFeatures(model, {}, { ...facts, hasTools: true })).not.toContain(
			"message-threads-2026-08-12",
		);
		expect(build().params.betas).not.toContain("message-threads-2026-08-12");
	});
});

describe("getFirstUserText", () => {
	it("returns the first user text, skipping blank turns, and nothing for an image-only turn", () => {
		expect(getFirstUserText([user("  "), user("first"), user("second")])).toBe("first");
		expect(
			getFirstUserText([{ role: "user", content: [{ type: "text", text: "from a block" }], timestamp: 1 }]),
		).toBe("from a block");
		expect(
			getFirstUserText([
				{ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
				user("later"),
			]),
		).toBe("");
		expect(getFirstUserText([])).toBe("");
	});
});

describe("convertClaudeCodeReply", () => {
	it("serializes the reply as the next request's history carries it", () => {
		const reply: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hm", thinkingSignature: "sig" },
				{ type: "text", text: "Looking it up." },
				{ type: "toolCall", id: "toolu_1", name: "lookup", arguments: { value: "x" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};

		expect(convertClaudeCodeReply(model, reply)).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hm", signature: "sig" },
					{ type: "text", text: "Looking it up." },
					{ type: "tool_use", id: "toolu_1", name: "_lookup", input: { value: "x" } },
				],
			},
		]);
	});
});
