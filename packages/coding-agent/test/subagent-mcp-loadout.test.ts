import {
	fauxAssistantMessage,
	fauxToolCall,
	getInitialSystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpExposure } from "../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { registerTeamTools } from "../src/extensions/subagent/team.ts";
import { registerWorkerPrompt, WORKER_FLAG } from "../src/extensions/subagent/worker-prompt.ts";
import { workerTools } from "../src/extensions/subagent/worker-tools.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function fakeMcpServer() {
	const pair = createInMemoryTransportPair();
	const result = (request: JsonRpcRequest): unknown => {
		if (request.method === "initialize")
			return {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "docs", version: "1" },
			};
		if (request.method === "tools/list")
			return {
				tools: [
					{
						name: "search",
						description: "Search project documentation",
						inputSchema: { type: "object", properties: {} },
					},
					{
						name: "private",
						description: "Private internal tool",
						inputSchema: { type: "object", properties: {} },
					},
				],
			};
		if (request.method === "resources/list") return { resources: [] };
		if (request.method === "resources/templates/list") return { resourceTemplates: [] };
		return { content: [{ type: "text", text: "result" }] };
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: result(request) }));
	});
	void pair.server.start();
	return pair.client;
}

describe("subagent MCP discovery loadout", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	async function session(exposure: McpExposure, role: "main" | "worker" = "worker"): Promise<Harness> {
		vi.stubEnv("PI_SUBAGENT_WORKER_ID", role === "worker" ? "worker-id" : "");
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				registerWorkerPrompt(pi);
				registerTeamTools(pi, async () => []);
			},
			createToolSearchExtension(),
			createMcpExtension({
				loadConfig: () => ({
					servers: [
						{
							name: "docs",
							config: { url: "http://unused.invalid", exposure, toolExposure: { private: "hidden" } },
							source: "test",
						},
					],
					errors: [],
				}),
				createTransport: fakeMcpServer,
			}),
		]);
		extensionsResult.runtime.flagValues.set(WORKER_FLAG, role === "worker");
		const tools = workerTools(undefined);
		const harness = await createHarness({
			initialActiveToolNames: tools,
			allowedToolNames: role === "worker" ? tools : undefined,
			resourceLoader: {
				...createTestResourceLoader({ extensionsResult }),
				getSystemPrompt: () => "Worker agent prompt",
			},
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await vi.waitFor(() =>
			expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);
		return harness;
	}

	it.each(["direct", "deferred"] as const)(
		"defers configured %s MCP tools until tool_search loads them",
		async (exposure) => {
			const harness = await session(exposure);
			expect(harness.session.getActiveToolNames()).toEqual(workerTools(undefined));
			expect(harness.session.getAllTools().find((tool) => tool.name === "mcp__docs__search")?.exposure).toBe(
				"deferred",
			);
			expect(harness.session.getAllTools().find((tool) => tool.name === "mcp__docs__private")?.exposure).toBe(
				"hidden",
			);
			expect(harness.session.getAllTools().find((tool) => tool.name === "list_mcp_resources")?.exposure).toBe(
				"deferred",
			);
			const requests: TranscriptContext[] = [];
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage(fauxToolCall("tool_search", { query: "mcp__docs__search", limit: 1 }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("Find project documentation.");
			expect(getInitialSystemMessage(requests[0].messages)?.toolsAdded?.map((tool) => tool.name)).toEqual(
				workerTools(undefined),
			);
			expect(getInitialSystemMessage(requests[1].messages)?.toolsAdded?.map((tool) => tool.name)).toContain(
				"mcp__docs__search",
			);
			expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__private");
		},
	);

	it("keeps configured direct MCP declarations in ordinary main sessions", async () => {
		const harness = await session("direct", "main");
		expect(harness.session.getAllTools().find((tool) => tool.name === "mcp__docs__search")?.exposure).toBe("direct");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
		expect(harness.session.getAllTools().find((tool) => tool.name === "list_mcp_resources")?.exposure).toBe("direct");
	});
});
