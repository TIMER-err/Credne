import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, stream } from "../src/compat.ts";
import type { AssistantMessage, Context, Tool, ToolResultMessage } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const oauthToken = await resolveApiKey("anthropic");

/**
 * Tests for Anthropic OAuth tool name prefixing.
 *
 * With a subscription (OAuth) token the request mimics Claude Code, so every client tool is sent with a
 * wire-only `_` prefix that keeps it apart from Claude Code's own tools (`_read`, `_todowrite`, ...), except
 * Anthropic's built-in tools (`web_search`, `code_execution`, `text_editor`, `computer`). The prefix is
 * removed again from tool calls in the response, so callers only ever see the names they defined.
 *
 * There is no Claude Code casing map: `todowrite` is sent as `_todowrite`, never as `TodoWrite`, and `find`
 * is never renamed to `Glob`. Names the model returns must round-trip to exactly the original name.
 */
describe.skipIf(!oauthToken)("Anthropic OAuth tool name prefixing", () => {
	const model = getModel("anthropic", "claude-sonnet-4-6");

	function userContext(systemPrompt: string, prompt: string, tools: Tool[]): Context {
		return { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }], tools };
	}

	/** Every tool call the model made must carry exactly the name the caller defined, never a wire form. */
	function expectOnlyToolCallName(toolCallNames: string[], expected: string): void {
		expect(toolCallNames.length).toBeGreaterThan(0);
		expect(toolCallNames.filter((name) => name !== expected)).toEqual([]);
	}

	async function runToolCall(context: Context): Promise<{ response: AssistantMessage; toolCallNames: string[] }> {
		const s = stream(model, context, { apiKey: oauthToken });
		const toolCallNames: string[] = [];

		for await (const event of s) {
			if (event.type !== "toolcall_end") continue;
			const toolCall = event.partial.content[event.contentIndex];
			if (toolCall.type === "toolCall") toolCallNames.push(toolCall.name);
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");
		return { response, toolCallNames };
	}

	it("decodes a tool named like a Claude Code tool back to its own name (todowrite)", async () => {
		// Claude Code has "TodoWrite". The tool is sent as "_todowrite" and must come back as "todowrite",
		// not "TodoWrite" and not "_todowrite".
		const todoTool: Tool = {
			name: "todowrite",
			description: "Write a todo item",
			parameters: Type.Object({
				task: Type.String({ description: "The task to add" }),
			}),
		};

		const { toolCallNames } = await runToolCall(
			userContext(
				"You are a helpful assistant. Use the todowrite tool when asked to add todos.",
				"Add a todo: buy milk. Use the todowrite tool.",
				[todoTool],
			),
		);

		expectOnlyToolCallName(toolCallNames, "todowrite");
	});

	it("decodes pi's built-in tools (read, write, edit, bash) back to lowercase names", async () => {
		// Pi's tools use lowercase names and Claude Code's use PascalCase; neither side is renamed, the wire
		// name is just "_read" and the response is decoded back to "read".
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String({ description: "File path" }),
			}),
		};

		const { toolCallNames } = await runToolCall(
			userContext(
				"You are a helpful assistant. Use the read tool to read files.",
				"Read the file /tmp/test.txt using the read tool.",
				[readTool],
			),
		);

		expectOnlyToolCallName(toolCallNames, "read");
	});

	it("keeps find as find - it is not mapped to Glob", async () => {
		// Pi has a "find" tool and Claude Code has "Glob". They are different tools: the wire name is "_find"
		// and the decoded name must be "find". A find -> Glob mapping would come back as "Glob" and match no
		// tool in context.tools.
		const findTool: Tool = {
			name: "find",
			description: "Find files by pattern",
			parameters: Type.Object({
				pattern: Type.String({ description: "Glob pattern" }),
			}),
		};

		const { toolCallNames } = await runToolCall(
			userContext(
				"You are a helpful assistant. Use the find tool to search for files.",
				"Find all .ts files using the find tool.",
				[findTool],
			),
		);

		expectOnlyToolCallName(toolCallNames, "find");
	});

	it("decodes custom tools that match no Claude Code tool name", async () => {
		const customTool: Tool = {
			name: "my_custom_tool",
			description: "A custom tool",
			parameters: Type.Object({
				input: Type.String({ description: "Input value" }),
			}),
		};

		const { toolCallNames } = await runToolCall(
			userContext(
				"You are a helpful assistant. Use my_custom_tool when asked.",
				"Use my_custom_tool with input 'hello'.",
				[customTool],
			),
		);

		expectOnlyToolCallName(toolCallNames, "my_custom_tool");
	});

	it("removes only one prefix from a tool whose own name starts with an underscore", async () => {
		// "_private_tool" is sent as "__private_tool"; stripping exactly one "_" restores the original name.
		const privateTool: Tool = {
			name: "_private_tool",
			description: "A tool whose name starts with an underscore",
			parameters: Type.Object({
				input: Type.String({ description: "Input value" }),
			}),
		};

		const { toolCallNames } = await runToolCall(
			userContext(
				"You are a helpful assistant. Use _private_tool when asked.",
				"Use _private_tool with input 'hello'.",
				[privateTool],
			),
		);

		expectOnlyToolCallName(toolCallNames, "_private_tool");
	});

	it("sends the decoded tool call back with the same wire prefix on the next turn", async () => {
		// The assistant tool call and its result are replayed in history. If history carried "read" while the
		// tool list carried "_read", the second request would be rejected or the model would lose the call.
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String({ description: "File path" }),
			}),
		};
		const context = userContext(
			"You are a helpful assistant. Use the read tool to read files, then answer in one short sentence.",
			"Read the file /tmp/test.txt using the read tool.",
			[readTool],
		);

		const first = await runToolCall(context);
		const toolCall = first.response.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({ type: "toolCall", name: "read" });
		if (toolCall?.type !== "toolCall") throw new Error("Expected a tool call");
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "hello from the file" }],
			isError: false,
			timestamp: Date.now(),
		};

		const second = await stream(
			model,
			{ ...context, messages: [...context.messages, first.response, toolResult] },
			{ apiKey: oauthToken },
		).result();

		expect(second.stopReason, `Error: ${second.errorMessage}`).not.toBe("error");
	});
});
