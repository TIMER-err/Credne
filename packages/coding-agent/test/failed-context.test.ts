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

describe("provider failure filtering", () => {
	it("preserves failed tool pairs without changing the saved exchange", () => {
		const messages = mixedExchange();
		const original = structuredClone(messages);
		const converted = convertToLlm(messages);
		expect(converted).toEqual(messages);
		expect(messages).toEqual(original);
	});

	it.each(["error", "aborted"] as const)("omits %s model attempts and their tool results", (stopReason) => {
		const messages = mixedExchange();
		messages[1] = fauxAssistantMessage(
			[fauxToolCall("read", {}, { id: "failed-read" }), fauxToolCall("read", {}, { id: "good-read" })],
			{
				stopReason,
				errorMessage: "Account quota exhausted",
			},
		);
		expect(convertToLlm(messages)).toEqual([messages[0]]);
	});

	it("preserves ordinary worker failures and shell executions while excluding provider failures", () => {
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
			{ ...completed, content: "Worker process failed", details: { result: { status: "failed" } } },
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
		expect(filterFailedMessages(messages)).toEqual(messages);
		const providerFailures: AgentMessage[] = [
			{ ...completed, content: "Quota exhausted", details: { result: { status: "failed", stopReason: "error" } } },
			{
				...completed,
				customType: "planning-result",
				content: "No API key",
				details: { result: { status: "failed", stopReason: "error", errorMessage: "No API key provided" } },
			},
		];
		expect(filterFailedMessages(providerFailures)).toEqual([]);
	});

	it.each<{ results: Record<string, string>[]; hidden: boolean }>([
		{ results: [{ status: "failed", stopReason: "error" }], hidden: true },
		{ results: [{ status: "failed" }], hidden: false },
		{ results: [{ status: "aborted", stopReason: "aborted" }], hidden: false },
		{ results: [{ status: "failed", stopReason: "error" }, { status: "completed" }], hidden: false },
		{ results: [], hidden: false },
	])("preserves worker tool exchanges unless every result is a provider failure: $results", ({ results, hidden }) => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "Delegate the task", timestamp: 1 },
			fauxAssistantMessage(fauxToolCall("subagent", {}, { id: "worker-call" }), { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolName: "subagent",
				toolCallId: "worker-call",
				content: [{ type: "text", text: "Worker report" }],
				details: { results },
				isError: true,
				timestamp: 2,
			},
		];
		expect(convertToLlm(messages)).toEqual(hidden ? [messages[0]] : messages);
	});

	it("includes shell exit and cancellation diagnostics unless explicitly excluded", () => {
		const command: AgentMessage = {
			role: "bashExecution",
			command: "missing-command",
			output: "Command not found",
			exitCode: 127,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		};
		expect(JSON.stringify(convertToLlm([command]))).toContain("Command exited with code 127");
		expect(JSON.stringify(convertToLlm([{ ...command, cancelled: true }]))).toContain("command cancelled");
		expect(convertToLlm([{ ...command, excludeFromContext: true }])).toEqual([]);
	});

	it("does not count failed provider output toward the compaction budget", () => {
		const user: Message = { role: "user", content: "Continue", timestamp: 1 };
		const messages = [
			user,
			fauxAssistantMessage("Partial failed output ".repeat(2000), {
				stopReason: "error",
				errorMessage: "Provider overloaded",
			}),
		];
		const session = SessionManager.inMemory();
		for (const message of messages) session.appendMessage(message);
		expect(estimateContextTokens(messages).tokens).toBe(2);
		expect(estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens).toBe(2);
		expect(
			prepareCompaction(session.getEntries(), { enabled: true, keepRecentTokens: 100, reserveTokens: 0 }),
		).toBeUndefined();
	});

	it("keeps tool failures in inherited context and summaries while excluding failed model attempts", () => {
		const messages = mixedExchange();
		messages.push(fauxAssistantMessage("Quota failure", { stopReason: "error" }));
		const reference = renderParentConversation(messages);
		expect(reference).toContain("Useful file contents");
		expect(reference).toContain("missing.txt");
		expect(reference).toContain("[tool error] ENOENT: missing.txt");
		expect(reference).not.toContain("Quota failure");

		const session = SessionManager.inMemory();
		for (const message of messages) session.appendMessage(message);
		session.appendMessage({ role: "user", content: "Continue with the next task", timestamp: 4 });
		const branch = prepareBranchEntries(session.getEntries());
		expect([...branch.fileOps.read]).toEqual(["missing.txt", "existing.txt"]);
		expect(JSON.stringify(branch.messages)).toContain("missing.txt");
		expect(JSON.stringify(branch.messages)).not.toContain("Quota failure");
		const compact = prepareCompaction(session.getEntries(), {
			enabled: true,
			keepRecentTokens: 1,
			reserveTokens: 0,
		});
		expect(compact).toBeDefined();
		expect([...compact!.fileOps.read]).toEqual(["missing.txt", "existing.txt"]);
		const summaryMessages = [...compact!.messagesToSummarize, ...compact!.turnPrefixMessages];
		expect(JSON.stringify(summaryMessages)).toContain("ENOENT: missing.txt");
		expect(JSON.stringify(summaryMessages)).not.toContain("Quota failure");
	});

	it("counts failed tool exchanges toward the compaction budget", () => {
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
		expect(estimateContextTokens(messages).tokens).toBeGreaterThan(10000);
		expect(
			estimateProjectedContextTokens(session.buildSessionProjection(), session.getBranch()).tokens,
		).toBeGreaterThan(10000);
		expect(
			prepareCompaction(session.getEntries(), { enabled: true, keepRecentTokens: 100, reserveTokens: 0 }),
		).toBeDefined();
	});

	it("sends tool diagnostics to the next provider request and retains them in the session", async () => {
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
		let nextMessages: Message[] = [];
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("fail", {}, { id: "failed-call" }), { stopReason: "toolUse" }),
				(context) => {
					nextMessages = context.messages;
					return fauxAssistantMessage("Finished");
				},
			]);
			await harness.session.prompt("Run the task");
			expect(nextMessages.filter((message) => message.role !== "system")).toEqual([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({
					role: "assistant",
					content: [expect.objectContaining({ type: "toolCall", id: "failed-call" })],
				}),
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "failed-call",
					isError: true,
					content: [{ type: "text", text: "Tool transport unavailable" }],
				}),
			]);
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({ role: "toolResult", toolCallId: "failed-call", isError: true }),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("continues a provider failure before streaming on the newly selected model without resending the prompt", async () => {
		const harness = await createHarness({
			models: [{ id: "out-of-credits" }, { id: "replacement" }],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
		};
		let continuedMessages: Message[] = [];
		let continuedModel: string | undefined;
		try {
			harness.setResponses([
				() => {
					throw new Error("Insufficient credits");
				},
				fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded_error" }),
				(context, _options, _state, model) => {
					continuedMessages = context.messages.filter((message) => message.role !== "system");
					continuedModel = model.id;
					return fauxAssistantMessage("Recovered");
				},
			]);
			await harness.session.prompt("Review this image", { images: [image] });
			expect(harness.session.canContinueInterruptedRun).toBe(true);
			await harness.session.setModel(harness.models[1]!);
			expect(await harness.session.continueInterruptedRun()).toBe("continued");
			expect(continuedModel).toBe("replacement");
			expect(continuedMessages).toEqual([
				expect.objectContaining({ role: "user", content: [{ type: "text", text: "Review this image" }, image] }),
			]);
			expect(harness.session.messages.filter((message) => message.role === "user")).toEqual(continuedMessages);
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({ role: "assistant", stopReason: "error", errorMessage: "Insufficient credits" }),
			);
			await harness.session.sendCustomMessage({ customType: "aside", content: "Context only", display: false });
			expect(await harness.session.continueInterruptedRun()).toBe("nothing-to-continue");
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.eventsOfType("auto_retry_end")).toEqual([
				expect.objectContaining({ success: true, attempt: 1 }),
			]);
		} finally {
			harness.cleanup();
		}
	});

	it.each([true, false])("after compaction, resumes only if the original prompt was retained (%s)", async (kept) => {
		const manager = SessionManager.inMemory();
		const userId = manager.appendMessage({ role: "user", content: "Retry this original prompt", timestamp: 1 });
		const failedId = manager.appendMessage(fauxAssistantMessage([], { stopReason: "error" }));
		manager.appendCompaction("Earlier history", kept ? userId : failedId, 100);
		const harness = await createHarness({ sessionManager: manager });
		harness.session.refreshContext();
		try {
			harness.setResponses([fauxAssistantMessage("Recovered")]);
			expect(await harness.session.continueInterruptedRun()).toBe(kept ? "continued" : "nothing-to-continue");
			expect(harness.faux.state.callCount).toBe(kept ? 1 : 0);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["Quota exhausted", "No API key provided", "Server is at capacity", "Provider overloaded"])(
		"does not replay provider failures after continuing: %s",
		async (errorMessage) => {
			const harness = await createHarness({ settings: { retry: { enabled: false } } });
			let nextMessages: Message[] = [];
			try {
				harness.setResponses([
					fauxAssistantMessage("Partial failed answer", { stopReason: "error", errorMessage }),
					(context) => {
						nextMessages = context.messages;
						return fauxAssistantMessage("Recovered");
					},
				]);
				await harness.session.prompt("First attempt");
				await harness.session.prompt("Continue");
				expect(nextMessages.filter((message) => message.role !== "system").map((message) => message.role)).toEqual([
					"user",
					"user",
				]);
				expect(harness.session.messages).toContainEqual(
					expect.objectContaining({ role: "assistant", stopReason: "error", errorMessage }),
				);
			} finally {
				harness.cleanup();
			}
		},
	);
});
