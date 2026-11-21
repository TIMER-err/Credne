import type {
	BetaTool,
	BetaMessageParam as MessageParam,
	BetaTextBlockParam as TextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, it } from "vitest";
import {
	applyHeadCaching,
	applyPromptCaching,
	buildClaudeCodeSystemBlocks,
	continueBreakpoints,
	getSystemPromptSegments,
	isConversationalUser,
	resolveClaudeCodeCacheControl,
} from "../src/api/claude-subscription/cache.ts";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/api/claude-subscription/fingerprint.ts";
import { repairClaudeCodeTurnOrder } from "../src/api/claude-subscription/messages.ts";

const longControl = { type: "ephemeral", ttl: "1h" } as const;
const shortControl = { type: "ephemeral" } as const;
const billing = "x-anthropic-billing-header: cc_version=2.1.326.abc; cc_entrypoint=cli; cch=00000;";

function tool(name: string, extra: Partial<BetaTool> = {}): BetaTool {
	return { name, description: name, input_schema: { type: "object", properties: {} }, ...extra };
}

/** `count` rounds of a user turn answered by an assistant turn. */
function conversation(count: number): MessageParam[] {
	return Array.from({ length: count }, (_, index): MessageParam[] => [
		{ role: "user", content: `question ${index}` },
		{ role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
	]).flat();
}

/** Indexes of the messages that carry a breakpoint, with the breakpoint's block position. */
function breakpointIndexes(messages: readonly MessageParam[]): number[] {
	return messages.flatMap((message, index) => {
		if (typeof message.content === "string") return [];
		return message.content.some((block) => "cache_control" in block && block.cache_control) ? [index] : [];
	});
}

describe("resolveClaudeCodeCacheControl", () => {
	it("defaults to the one-hour lifetime where the model supports it", () => {
		expect(resolveClaudeCodeCacheControl(true, undefined, {})).toEqual(longControl);
	});

	it("defaults to the short lifetime where it does not", () => {
		expect(resolveClaudeCodeCacheControl(false, undefined, {})).toEqual(shortControl);
	});

	it("honors an explicit retention before the environment", () => {
		expect(resolveClaudeCodeCacheControl(true, "short", { PI_CACHE_RETENTION: "long" })).toEqual(shortControl);
		expect(resolveClaudeCodeCacheControl(true, "none", {})).toBeUndefined();
		expect(resolveClaudeCodeCacheControl(true, undefined, { PI_CACHE_RETENTION: "short" })).toEqual(shortControl);
		expect(resolveClaudeCodeCacheControl(true, undefined, { PI_CACHE_RETENTION: "none" })).toBeUndefined();
	});

	it("never sends a ttl where long retention is unsupported", () => {
		expect(resolveClaudeCodeCacheControl(false, "long", {})).toEqual(shortControl);
	});
});

describe("system blocks", () => {
	it("sends the billing block bare, the identity block with the breakpoint, then one block per segment", () => {
		const blocks = buildClaudeCodeSystemBlocks(billing, ["base prompt", "<rules>\nA</rules>"], longControl);
		expect(blocks).toEqual([
			{ type: "text", text: billing },
			{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION, cache_control: { type: "ephemeral", ttl: "1h" } },
			{ type: "text", text: "base prompt" },
			{ type: "text", text: "<rules>\nA</rules>" },
		]);
	});

	it("keeps a default breakpoint on the identity block when caching is off", () => {
		const blocks = buildClaudeCodeSystemBlocks(billing, ["base prompt"], undefined);
		expect(blocks[1]).toEqual({
			type: "text",
			text: CLAUDE_CODE_SYSTEM_INSTRUCTION,
			cache_control: { type: "ephemeral" },
		});
	});

	it("drops blank segments and replaces lone surrogates", () => {
		const blocks = buildClaudeCodeSystemBlocks(billing, ["  \n", "a\uD800b", ""], longControl);
		expect(blocks.slice(2)).toEqual([{ type: "text", text: "a�b" }]);
	});

	it("reads segments from the leading system message: base prompt, then each section", () => {
		expect(
			getSystemPromptSegments({
				role: "system",
				content: "base",
				sections: { a: "<a>1</a>", gone: null, b: "<b>2</b>" },
				timestamp: 0,
			}),
		).toEqual(["base", "<a>1</a>", "<b>2</b>"]);
		expect(getSystemPromptSegments(undefined)).toEqual([]);
	});
});

describe("head breakpoints", () => {
	it("moves the identity breakpoint to the last system block and marks the last tool", () => {
		const system = buildClaudeCodeSystemBlocks(billing, ["base", "extra"], longControl);
		const tools = [tool("read"), tool("edit")];
		applyHeadCaching(system, tools, longControl);
		expect(system.map((block) => block.cache_control)).toEqual([undefined, undefined, undefined, longControl]);
		expect(tools.map((entry) => entry.cache_control)).toEqual([undefined, longControl]);
	});

	it("anchors the system breakpoint before the first volatile segment", () => {
		const system = buildClaudeCodeSystemBlocks(
			billing,
			["static", "<memories>recall</memories>", "<project-context>x</project-context>"],
			longControl,
		);
		applyHeadCaching(system, [], longControl);
		expect(system.map((block) => block.cache_control)).toEqual([
			undefined,
			undefined,
			longControl,
			undefined,
			undefined,
		]);
	});

	it("falls back to the last block when every prompt segment is volatile and there are none", () => {
		const system: TextBlockParam[] = [{ type: "text", text: "<memories>m</memories>" }];
		applyHeadCaching(system, [], longControl);
		expect(system[0]?.cache_control).toEqual(longControl);
	});

	it("skips deferred tools when picking the tool breakpoint", () => {
		const tools = [tool("read"), tool("edit"), tool("later", { defer_loading: true })];
		applyHeadCaching([], tools, longControl);
		expect(tools.map((entry) => entry.cache_control)).toEqual([undefined, longControl, undefined]);
	});

	it("leaves a tool that already has a breakpoint, and does nothing when caching is off", () => {
		const tools = [tool("read", { cache_control: shortControl }), tool("edit")];
		applyHeadCaching([], tools, longControl);
		expect(tools[1]?.cache_control).toBeUndefined();
		const system = buildClaudeCodeSystemBlocks(billing, ["base"], undefined);
		applyHeadCaching(system, [tool("x")], undefined);
		expect(system[1]?.cache_control).toEqual(shortControl);
	});
});

describe("message breakpoints", () => {
	function headBlocks() {
		const system = buildClaudeCodeSystemBlocks(billing, ["base"], longControl);
		const tools = [tool("read")];
		applyHeadCaching(system, tools, longControl);
		return { system, tools };
	}

	it("spends the budget of four minus the head breakpoints on the two newest messages", () => {
		const { system, tools } = headBlocks();
		const messages = conversation(3);
		applyPromptCaching(messages, system, tools, longControl);
		expect(breakpointIndexes(messages)).toEqual([4, 5]);
		expect(messages[5]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "answer 2", cache_control: { type: "ephemeral", ttl: "1h" } }],
		});
		expect(messages[4]).toEqual({
			role: "user",
			content: [{ type: "text", text: "question 2", cache_control: { type: "ephemeral", ttl: "1h" } }],
		});
	});

	it("sends no message breakpoint when the head already uses all four", () => {
		const system: TextBlockParam[] = [
			{ type: "text", text: "a", cache_control: longControl },
			{ type: "text", text: "b", cache_control: longControl },
		];
		const tools = [tool("x", { cache_control: longControl }), tool("y", { cache_control: longControl })];
		const messages = conversation(2);
		applyPromptCaching(messages, system, tools, longControl);
		expect(breakpointIndexes(messages)).toEqual([]);
	});

	it("does nothing when caching is off or there are no messages", () => {
		const messages = conversation(2);
		applyPromptCaching(messages, [], [], undefined);
		expect(breakpointIndexes(messages)).toEqual([]);
		expect(() => applyPromptCaching([], [], [], longControl)).not.toThrow();
	});

	it("adds a decimation checkpoint on every 15th user turn", () => {
		const { system, tools } = headBlocks();
		const messages = conversation(31);
		applyPromptCaching(messages, system, tools, longControl);
		// 31 user turns: the newest message, then the 30th user turn (index 58), the budget being 2 of 4.
		expect(breakpointIndexes(messages)).toEqual([58, 61]);
	});

	it("takes the checkpoint before the second newest message when the budget allows both", () => {
		const system: TextBlockParam[] = [{ type: "text", text: "a", cache_control: longControl }];
		const messages = conversation(31);
		applyPromptCaching(messages, system, [], longControl);
		// Budget 3: newest, then the 30th and 15th turn checkpoints (newest first); the second newest message loses.
		expect(breakpointIndexes(messages)).toEqual([28, 58, 61]);
	});

	it("counts only conversational user turns, not tool results or the Continue pad", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "_read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];
		repairClaudeCodeTurnOrder(messages);
		expect(messages.map(isConversationalUser)).toEqual([true, false, false, false, false]);
	});

	it("treats a user's own Continue. as a turn but the pad as none", () => {
		const own: MessageParam = { role: "user", content: "Continue." };
		const padded: MessageParam[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: "ok" },
		];
		repairClaudeCodeTurnOrder(padded);
		expect(isConversationalUser(own)).toBe(true);
		expect(isConversationalUser(padded[2] as MessageParam)).toBe(false);
	});

	it("anchors the rolling window on the assistant before a trailing Continue pad", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "text", text: "partial" }] },
		];
		repairClaudeCodeTurnOrder(messages);
		applyPromptCaching(messages, [], [], longControl);
		expect(breakpointIndexes(messages)).toEqual([0, 1]);
		expect(messages[2]).toEqual({ role: "user", content: "Continue." });
	});

	it("skips mid-conversation tool controls as candidates, and thinking blocks within a message", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "a" },
					{ type: "thinking", thinking: "t", signature: "sig" },
				],
			},
			{ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "_x" } }] },
		];
		applyPromptCaching(messages, [], [], longControl);
		expect(breakpointIndexes(messages)).toEqual([0, 1]);
		expect(messages[1]?.content).toEqual([
			{ type: "text", text: "a", cache_control: longControl },
			{ type: "thinking", thinking: "t", signature: "sig" },
		]);
	});

	it("keeps a thinking-only assistant from spending the budget", () => {
		const system: TextBlockParam[] = [
			{ type: "text", text: "a", cache_control: longControl },
			{ type: "text", text: "b", cache_control: longControl },
			{ type: "text", text: "c", cache_control: longControl },
		];
		const messages: MessageParam[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }] },
		];
		applyPromptCaching(messages, system, [], longControl);
		// The one message breakpoint falls through the thinking-only reply to the user turn before it.
		expect(breakpointIndexes(messages)).toEqual([0]);
	});

	it("anchors the stable prefix before a turn-scoped system message and counts turns only before it", () => {
		const system: TextBlockParam[] = [{ type: "text", text: "a", cache_control: longControl }];
		const messages: MessageParam[] = [
			...conversation(16),
			{ role: "system", content: [{ type: "text", text: "scoped" }], clear_at: "next_user_message" },
			{ role: "user", content: "newest" },
		];
		applyPromptCaching(messages, system, [], longControl);
		// Budget 3: the newest message, the 15th user turn (the turn-scoped message ends the stable range), then the
		// newest message of the stable range.
		expect(breakpointIndexes(messages)).toEqual([28, 31, 33]);
	});
});

describe("continue breakpoints", () => {
	it("keeps the newest breakpoint, adds one on the first appended block and drops the rest", () => {
		const appended: MessageParam[] = [
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "_a", input: {} }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "r1", cache_control: shortControl },
					{ type: "text", text: "tail", cache_control: shortControl },
				],
			},
		];
		const result = continueBreakpoints(appended);
		expect(result).toEqual([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "_a", input: {}, cache_control: shortControl }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "r1" },
					{ type: "text", text: "tail", cache_control: shortControl },
				],
			},
		]);
	});

	it("passes messages without any breakpoint through", () => {
		const appended: MessageParam[] = [{ role: "user", content: "plain" }];
		expect(continueBreakpoints(appended)).toBe(appended);
	});
});
