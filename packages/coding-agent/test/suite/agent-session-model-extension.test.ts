import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type JsonObject,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { BuildSystemPromptOptions, ExtensionAPI } from "../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("setModel saves the model to the session and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
		expect(harness.settingsManager.getDefaultProvider()).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
	});

	it("only persists model and thinking defaults when requested", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);
		expect(harness.settingsManager.getDefaultProvider()).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();

		harness.session.setThinkingLevel("low");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBeUndefined();

		await harness.session.setModel(nextModel, { persist: true });
		expect(harness.settingsManager.getDefaultProvider()).toBe(nextModel.provider);
		expect(harness.settingsManager.getDefaultModel()).toBe(nextModel.id);

		harness.session.setThinkingLevel("high", { persist: true });
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("high");
	});

	it("persists the requested default thinking level even when the current model clamps it", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("max", { persist: true });

		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("max");
	});

	it("cycleModel and cycleThinkingLevel are session-only by default", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: {
				defaultProvider: "faux",
				defaultModel: "faux-1",
				defaultThinkingLevel: "low",
			},
		});
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-1");

		harness.session.setThinkingLevel("off");
		expect(harness.session.cycleThinkingLevel()).toBe("minimal");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
	});

	it("applies per-model thinking level override on model switch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultThinkingLevel: "medium" },
		});
		harnesses.push(harness);

		// Set a per-model override for faux-2
		harness.settingsManager.setModelThinkingLevel("faux", "faux-2", "low");

		// Session starts on faux-1 with default thinking
		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("high");

		// Switch to faux-2 → per-model override should apply
		const model2 = harness.getModel("faux-2")!;
		await harness.session.setModel(model2);
		expect(harness.session.thinkingLevel).toBe("low");

		// The model's override does not replace the session preference.
		const model1 = harness.getModel("faux-1")!;
		await harness.session.setModel(model1);
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("medium");
	});

	it("restores a session thinking preference after switching through limited models", async () => {
		const harness = await createHarness({
			models: [
				{ id: "extended", reasoning: true },
				{ id: "limited", reasoning: true },
				{ id: "plain", reasoning: false },
			],
			settings: { defaultThinkingLevel: "medium" },
		});
		harnesses.push(harness);
		const { session, sessionManager, settingsManager } = harness;
		const extended = harness.getModel();
		extended.thinkingLevelMap = { max: "max" };
		session.setThinkingLevel("max");

		await session.setModel(harness.getModel("limited")!);
		expect(session.thinkingLevel).toBe("high");
		await session.setModel(harness.getModel("plain")!);
		expect(session.thinkingLevel).toBe("off");
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe("max");
		await session.setModel(extended, { persist: true });
		expect(session.thinkingLevel).toBe("max");
		expect(settingsManager.getDefaultThinkingLevel()).toBe("medium");

		await session.setModel(harness.getModel("plain")!);
		session.setThinkingLevel("off");
		// A user's explicit change also wins when the effective level does not change.
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe("off");
		await session.setModel(extended);
		expect(session.thinkingLevel).toBe("off");
	});

	it("keeps the requested startup and resumed thinking levels when the selected model clamps them", async () => {
		const harness = await createHarness({ models: [{ id: "first", reasoning: false }] });
		harnesses.push(harness);
		const model = harness.getModel();
		const options = {
			model,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			cwd: harness.tempDir,
		};
		const { session: first } = await createAgentSession({ ...options, thinkingLevel: "max" });
		try {
			expect(first.thinkingLevel).toBe("off");
			expect(first.sessionManager.buildSessionContext().thinkingLevel).toBe("max");
			first.sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		} finally {
			first.dispose();
		}
		const { session: resumed } = await createAgentSession(options);
		try {
			expect(resumed.thinkingLevel).toBe("off");
			await resumed.setModel({ ...model, id: "extended", reasoning: true, thinkingLevelMap: { max: "max" } });
			expect(resumed.thinkingLevel).toBe("max");
		} finally {
			resumed.dispose();
		}
	});

	it("restores a scoped override on resume without replacing the preference for other models", async () => {
		const harness = await createHarness({
			models: [
				{ id: "scoped", reasoning: true },
				{ id: "plain", reasoning: true },
			],
			settings: { defaultThinkingLevel: "high", modelThinkingLevels: { "faux/scoped": "medium" } },
		});
		harnesses.push(harness);
		const [scoped, plain] = harness.models;
		const options = {
			model: scoped,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			cwd: harness.tempDir,
		};
		const { session: first } = await createAgentSession({
			...options,
			scopedModels: [{ model: scoped, thinkingLevel: "low" }],
		});
		try {
			expect(first.thinkingLevel).toBe("low");
			expect(first.sessionManager.buildSessionContext().thinkingLevel).toBe("high");
			first.sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		} finally {
			first.dispose();
		}

		const { session: resumed } = await createAgentSession(options);
		try {
			expect(resumed.thinkingLevel).toBe("low");
			await resumed.setModel(plain);
			expect(resumed.thinkingLevel).toBe("high");
			await resumed.setModel(scoped);
			expect(resumed.thinkingLevel).toBe("medium");
			resumed.setThinkingLevel("low");
			await resumed.setModel(scoped, { persist: true });
			expect(resumed.thinkingLevel).toBe("low");
		} finally {
			resumed.dispose();
		}

		const { session: afterManualChange } = await createAgentSession(options);
		try {
			expect(afterManualChange.thinkingLevel).toBe("low");
			await afterManualChange.setModel(plain);
			expect(afterManualChange.thinkingLevel).toBe("low");
		} finally {
			afterManualChange.dispose();
		}
	});

	it("editing the current model's settings applies only to that model", async () => {
		const harness = await createHarness({ models: [{ id: "configured", reasoning: true }] });
		harnesses.push(harness);
		const { session, settingsManager } = harness;
		const { provider, id } = harness.getModel();
		session.setThinkingLevel("high");

		session.setModelThinkingLevel(provider, id, "low");
		expect(settingsManager.getModelThinkingLevel(provider, id)).toBe("low");
		expect(session.thinkingLevel).toBe("low");
		session.setModelThinkingLevel(provider, id, undefined);
		expect(settingsManager.getModelThinkingLevel(provider, id)).toBeUndefined();
		expect(session.thinkingLevel).toBe("high");
	});

	it("per-model override takes priority over global default during model switch", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: {
				defaultThinkingLevel: "high",
				modelThinkingLevels: { "faux/faux-2": "minimal" },
			},
		});
		harnesses.push(harness);

		// Start on a non-thinking model, then switch to faux-2
		const model2 = harness.getModel("faux-2")!;
		await harness.session.setModel(model2);
		expect(harness.session.thinkingLevel).toBe("minimal");
	});

	it("inherits the session thinking level for unqualified scoped models but applies explicit suffixes", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
				{ id: "faux-3", reasoning: true },
			],
			settings: { defaultThinkingLevel: "medium", modelThinkingLevels: { "faux/faux-3": "minimal" } },
		});
		harnesses.push(harness);
		const [modelOne, modelTwo, modelThree] = harness.models;
		harness.session.setScopedModels([
			{ model: modelOne },
			{ model: modelTwo },
			{ model: modelThree, thinkingLevel: "low" },
		]);
		harness.session.setThinkingLevel("high");

		const clamped = await harness.session.cycleModel();
		expect(clamped?.model.id).toBe("faux-2");
		expect(clamped?.thinkingLevel).toBe("off");
		expect((await harness.session.cycleModel("backward"))?.thinkingLevel).toBe("high");

		const explicit = await harness.session.cycleModel("backward");
		expect(explicit?.model.id).toBe("faux-3");
		expect(explicit?.thinkingLevel).toBe("low");
		expect((await harness.session.cycleModel())?.thinkingLevel).toBe("high");
	});

	// Regression test for https://github.com/earendil-works/pi/issues/11806
	it("cycles to the only scoped model and to the first scoped model from outside the scope", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One" },
				{ id: "faux-2", name: "Two" },
				{ id: "faux-3", name: "Three" },
			],
		});
		harnesses.push(harness);
		const modelTwo = harness.getModel("faux-2")!;
		const modelThree = harness.getModel("faux-3")!;

		harness.session.setScopedModels([{ model: modelTwo }]);
		expect((await harness.session.cycleModel())?.model.id).toBe("faux-2");
		expect(harness.session.model?.id).toBe("faux-2");
		expect(await harness.session.cycleModel()).toBeUndefined();
		expect(harness.session.model?.id).toBe("faux-2");

		await harness.session.setModel(harness.getModel("faux-1")!);
		harness.session.setScopedModels([{ model: modelTwo }, { model: modelThree }]);
		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");

		await harness.session.setModel(harness.getModel("faux-1")!);
		await harness.session.cycleModel("backward");
		expect(harness.session.model?.id).toBe("faux-3");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();
	});

	it("cycles xhigh before max when both are supported", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);
		harness.getModel().thinkingLevelMap = { xhigh: "xhigh", max: "max" };

		expect(harness.session.getAvailableThinkingLevels()).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		harness.session.setThinkingLevel("high");
		expect(harness.session.cycleThinkingLevel()).toBe("xhigh");
		expect(harness.session.cycleThinkingLevel()).toBe("max");
		expect(harness.session.cycleThinkingLevel()).toBe("off");
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const toolUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const patchedToolUsage: Usage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			totalTokens: 26,
			cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2.6 },
		};
		let observedToolUsage: Usage | undefined;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text }, usage: toolUsage };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						observedToolUsage = event.usage;
						return {
							content: [{ type: "text", text: "patched result" }],
							details: { patched: true },
							usage: patchedToolUsage,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("patched result");
		const toolResult = harness.session.messages.find(
			(message) =>
				message.role === "toolResult" &&
				typeof message.details === "object" &&
				message.details !== null &&
				!Array.isArray(message.details) &&
				(message.details as JsonObject).patched === true,
		);
		expect(observedToolUsage).toEqual(toolUsage);
		expect(toolResult).toBeDefined();
		expect(toolResult?.role === "toolResult" ? toolResult.usage : undefined).toEqual(patchedToolUsage);
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.prompt("hello");
		await transformedHarness.session.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(extensionApi).toBeDefined();
	});

	it("allows extension commands to inspect live system prompt options", async () => {
		const seenOptions: BuildSystemPromptOptions[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("inspect-options", {
						description: "Inspect system prompt options",
						handler: async (_args, ctx) => {
							const options = ctx.getSystemPromptOptions();
							seenOptions.push(options);
							options.selectedTools?.push("mutated_tool");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/inspect-options");
		await harness.session.prompt("/inspect-options");

		expect(seenOptions).toHaveLength(2);
		expect(seenOptions[0]).toBe(seenOptions[1]);
		expect(seenOptions[0]?.cwd).toBe(harness.tempDir);
		expect(seenOptions[0]?.selectedTools).toContain("read");
		expect(seenOptions[1]?.selectedTools).toContain("mutated_tool");
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = getCurrentSystemPrompt(context.messages);
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					pi.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
});
