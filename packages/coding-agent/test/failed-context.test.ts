import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import {
	estimateContextTokens,
	estimateProjectedContextTokens,
	prepareCompaction,
} from "../src/core/compaction/compaction.ts";
import { convertToLlm, filterFailedMessages } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { renderParentConversation } from "../src/extensions/subagent/parent-conversation.ts";
import { createHarness } from "./suite/harness.ts";

function mixedExchange(): Message[] {
	return [
		{ role: "user", content: "Read the files", timestamp: 1 },
		fauxAssistantMessage(
			[
				fauxText("Checking the files."),
				fauxToolCall("read", { path: "missing.txt" }, { id: "failed-read" }),
				fauxToolCall("read", { path: "existing.txt" }, { id: "good-read" }),
			],
			{ stopReason: "toolUse" },
		),
		{
			role: "toolResult",
			toolCallId: "failed-read",
			toolName: "read",
			content: [{ type: "text", text: "ENOENT: missing.txt" }],
			isError: true,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "good-read",
			toolName: "read",
			content: [{ type: "text", text: "Useful file contents" }],
			isError: false,
			timestamp: 3,
		},
	];
}

describe("failure-free model context", () => {
	it("removes only failed tool pairs without changing the saved exchange", () => {
		const messages = mixedExchange();
		const original = structuredClone(messages);
		const converted = convertToLlm(messages);
		expect(converted).toEqual([
			messages[0],
			{
				...messages[1],
				content: [
					fauxText("Checking the files."),
					fauxToolCall("read", { path: "existing.txt" }, { id: "good-read" }),
				],
			},
			messages[3],
		]);
		expect(messages).toEqual(original);
	});

	it.each(["error", "aborted"] as const)("omits %s model attempts and their tool results", (stopReason) => {
		const messages = mixedExchange();
		messages[1] = fauxAssistantMessage(fauxToolCall("read", {}, { id: "good-read" }), {
			stopReason,
			errorMessage: "Account quota exhausted",
		});
		expect(convertToLlm(messages)).toEqual([messages[0]]);
	});

	it("excludes failed worker notifications and shell executions but keeps successful reports", () => {
		const completed: AgentMessage = {
			role: "custom",
			customType: "subagent-result",
			content: "Implementation complete",
			details: { result: { status: "completed" } },
			display: true,
			timestamp: 1,
		};
		const messages: AgentMessage[] = [
			completed,
			{ ...completed, content: "Quota exhausted", details: { result: { status: "failed" } } },
			{
				...completed,
				customType: "planning-result",
				content: "Worker cancelled",
				details: { result: { status: "aborted" } },
			},
			{
				role: "bashExecution",
				command: "missing-command",
				output: "Command not found",
				exitCode: 127,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			},
		];
		expect(filterFailedMessages(messages)).toEqual([completed]);
	});

	it("keeps failures out of inherited context and summary file tracking", () => {
		const messages = mixedExchange();
		messages.push(fauxAssistantMessage("Quota failure", { stopReason: "error" }));
		const reference = renderParentConversation(messages);
		expect(reference).toContain("Useful file contents");
		expect(reference).not.toMatch(/missing\.txt|Quota failure|tool error/);

		const session = SessionManager.inMemory();
		for (const message of messages) session.appendMessage(message);
		session.appendMessage({ role: "user", content: "Continue with the next task", timestamp: 4 });
		const branch = prepareBranchEntries(session.getEntries());
		expect([...branch.fileOps.read]).toEqual(["existing.txt"]);
		expect(JSON.stringify(branch.messages)).not.toMatch(/missing\.txt|Quota failure/);
		const compact = prepareCompaction(session.getEntries(), {
			enabled: true,
			keepRecentTokens: 1,
			reserveTokens: 0,
		});
		expect(compact).toBeDefined();
		expect([...compact!.fileOps.read]).toEqual(["existing.txt"]);
		expect(JSON.stringify(compact!.messagesToSummarize)).not.toMatch(/missing\.txt|Quota failure/);
	});

	it("does not spend the compaction budget on large failed exchanges", () => {
		const user: Message = { role: "user", content: "Read a file", timestamp: 1 };
		const messages: Message[] = [
			user,
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "failed-read" }), { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "failed-read",
				content: [{ type: "text", text: "Very long tool failure ".repeat(2000) }],
				isError: true,
				timestamp: 2,
			},
			fauxAssistantMessage("Quota exhausted", { stopReason: "error" }),
		];
		const session = SessionManager.inMemory();
		for (const message of messages) session.appendMessage(message);
		expect(estimateContextTokens(messages).tokens).toBe(3);
		expect(estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens).toBe(3);
		expect(
			prepareCompaction(session.getEntries(), { enabled: true, keepRecentTokens: 100, reserveTokens: 0 }),
		).toBeUndefined();
	});

	it("retains tool diagnostics in the session while omitting them from the next provider request", async () => {
		const tool: AgentTool = {
			name: "fail",
			label: "Fail",
			description: "Return an execution failure",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("Tool transport unavailable");
			},
		};
		const harness = await createHarness({ tools: [tool] });
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("fail", {}, { id: "failed-call" }), { stopReason: "toolUse" }),
				(context) => {
					expect(context.messages.filter((message) => message.role !== "system")).toEqual([
						expect.objectContaining({ role: "user" }),
					]);
					return fauxAssistantMessage("Finished");
				},
			]);
			await harness.session.prompt("Run the task");
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: "failed-call", isError: true }),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("does not replay exhausted-account responses after the user continues", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		try {
			harness.setResponses([
				fauxAssistantMessage("Partial failed answer", { stopReason: "error", errorMessage: "Quota exhausted" }),
				(context) => {
					expect(
						context.messages.filter((message) => message.role !== "system").map((message) => message.role),
					).toEqual(["user", "user"]);
					return fauxAssistantMessage("Recovered");
				},
			]);
			await harness.session.prompt("First attempt");
			await harness.session.prompt("Continue");
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({ role: "assistant", stopReason: "error", errorMessage: "Quota exhausted" }),
			);
		} finally {
			harness.cleanup();
		}
	});
});
