import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import planningExtension from "../src/extensions/planning/index.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { aggregateUsage, type SingleResult, type SubagentDetails } from "../src/extensions/subagent/runner.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("subagent cache usage", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	const result = (usage: SingleResult["usage"]): SingleResult => ({
		agent: "worker",
		agentSource: "builtin",
		task: "task",
		status: "completed",
		exitCode: 0,
		messages: [fauxAssistantMessage("done")],
		stderr: "",
		usage,
	});

	it("shows each worker's hit rate, its first request, and the aggregate rate", async () => {
		const extensionsResult = await createTestExtensionsResult([
			{ name: "planning", factory: planningExtension },
			{ name: "subagent", factory: subagentExtension },
		]);
		harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		await harness.session.bindExtensions({});
		const tool = harness.session.getToolDefinition("subagent");
		if (!tool?.renderResult) throw new Error("subagent tool has no result renderer");
		const results = [
			result({
				input: 100,
				output: 10,
				cacheRead: 900,
				cacheWrite: 0,
				cacheHitRate: 0.9,
				firstCacheHitRate: 0.5,
				cost: 0,
				contextTokens: 0,
				turns: 2,
			}),
			result({
				input: 1000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cacheHitRate: 0,
				cost: 0,
				contextTokens: 0,
				turns: 1,
			}),
		];
		const details: SubagentDetails = { mode: "parallel", results, usage: aggregateUsage(results), isError: false };
		const toolResult: AgentToolResult<SubagentDetails> = { content: [{ type: "text", text: "done" }], details };
		const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
		const rendered = tool
			.renderResult(toolResult, { expanded: true, isPartial: false }, theme, {} as never)
			.render(160)
			.join("\n");
		expect(rendered).toContain("CH90.0% (first 50.0%)");
		expect(rendered).toContain("CH0.0%");
		expect(rendered).toContain("Total: 3 turns ↑1.1k ↓20 R900 CH45.0%");
		expect(details.usage.cacheHitRate).toBe(0.45);
	});
});
