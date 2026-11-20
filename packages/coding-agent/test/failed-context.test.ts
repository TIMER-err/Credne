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

	it("honors a boundary continuation from a failed raw assistant tail", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", (event) => {
						if (event.outcome === "error") return { continue: true };
					});
				},
			],
		});
		let continuedMessages: Message[] = [];
		try {
			harness.setResponses([
				fauxAssistantMessage([], { stopReason: "error", errorMessage: "Insufficient credits" }),
				(context) => {
					continuedMessages = context.messages.filter((message) => message.role !== "system");
					return fauxAssistantMessage("Recovered");
				},
			]);
			await harness.session.prompt("Run the task");
			expect(continuedMessages).toEqual([
				expect.objectContaining({ role: "user", content: [fauxText("Run the task")] }),
			]);
			expect(harness.faux.state.callCount).toBe(2);
		} finally {
			harness.cleanup();
		}
	});

	it("offers continuation only on the reopened failed branch until it is dismissed", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Completed branch", timestamp: 1 });
		const completedId = manager.appendMessage(fauxAssistantMessage("Complete"));
		manager.appendMessage({ role: "user", content: "Retry this", timestamp: 2 });
		const failedId = manager.appendMessage(fauxAssistantMessage([], { stopReason: "error" }));
		const harness = await createHarness({ sessionManager: manager });
		harness.session.refreshContext();
		try {
			expect(harness.session.canContinueInterruptedRun).toBe(true);
			await harness.session.navigateTree(completedId);
			expect(await harness.session.continueInterruptedRun()).toBe("nothing-to-continue");
			await harness.session.navigateTree(failedId);
			expect(harness.session.canContinueInterruptedRun).toBe(true);
			harness.session.dismissInterruptedRun();
			expect(await harness.session.continueInterruptedRun()).toBe("nothing-to-continue");
			expect(harness.faux.state.callCount).toBe(0);
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

	it("continues an interrupted tool batch from its completed result without running the tool again", async () => {
		const toolStarted = Promise.withResolvers<void>();
		let completedCalls = 0;
		const parameters = Type.Object({ wait: Type.Boolean() });
		const tool: AgentTool<typeof parameters> = {
			name: "checked",
			label: "Checked",
			description: "Record completed and interrupted calls",
			parameters,
			execute: async (_id, args, signal) => {
				if (args.wait) {
					toolStarted.resolve();
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
					throw new Error("Operation aborted");
				}
				completedCalls++;
				return { content: [fauxText("Completed once")], details: undefined };
			},
		};
		// The harness erases tool types; the agent validates arguments against parameters before execute.
		const harness = await createHarness({ tools: [tool as AgentTool] });
		harness.session.agent.toolExecution = "sequential";
		let continuedMessages: Message[] = [];
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("checked", { wait: false }, { id: "completed" }),
						fauxToolCall("checked", { wait: true }, { id: "interrupted" }),
					],
					{ stopReason: "toolUse" },
				),
			]);
			const run = harness.session.prompt("Check both files");
			await toolStarted.promise;
			expect(await harness.session.continueInterruptedRun()).toBe("busy");
			await harness.session.abort();
			await run;
			harness.setResponses([
				(context) => {
					continuedMessages = context.messages.filter((message) => message.role !== "system");
					return fauxAssistantMessage("Recovered");
				},
			]);
			expect(await harness.session.continueInterruptedRun()).toBe("continued");
			expect(continuedMessages).toEqual([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({
					role: "assistant",
					content: [expect.objectContaining({ type: "toolCall", id: "completed" })],
				}),
				expect.objectContaining({
					role: "toolResult",
					toolCallId: "completed",
					content: [fauxText("Completed once")],
				}),
			]);
			expect(completedCalls).toBe(1);
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
