import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import subagentExtension from "../src/extensions/subagent/index.ts";
import { DELEGATION_TOOLS } from "../src/extensions/subagent/team.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("subagent follow-up tools", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function start(sessionManager?: SessionManager, cwd?: string): Promise<Harness> {
		const harness = await createHarness({ cwd, sessionManager, extensionFactories: [subagentExtension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("are active but left out of requests until the first delegation reveals them", async () => {
		const harness = await start();
		const requests: string[][] = [];
		harness.setResponses([
			(context) => {
				requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("subagent", { agent: "no-such-agent", task: "Look around" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Delegate a search.");
		const active = harness.session.getActiveToolNames();
		const followUps = DELEGATION_TOOLS.filter((name) => active.includes(name));
		expect(followUps).toEqual(expect.arrayContaining(["list_agents", "send_agent_message", "search_models"]));
		expect(requests[0]).toContain("subagent");
		for (const name of followUps) expect(requests[0]).not.toContain(name);
		// A failed first delegation still reveals them, so the model can look up a model or agent.
		expect(requests[1]).toEqual(expect.arrayContaining(followUps));
		const result = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
			)[0];
		expect(JSON.stringify(result?.content)).toContain("These tools are declared from your next call");
	});

	it("are declared on a resumed branch that already delegated", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-reveal-"));
		directories.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		const call = fauxToolCall("subagent", { agent: "explorer", task: "Look around" });
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Delegate." }], timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "subagent",
			content: [{ type: "text", text: "Found it." }],
			isError: false,
			timestamp: 2,
		});
		const harness = await start(sessionManager, cwd);
		let tools: string[] = [];
		harness.setResponses([
			(context) => {
				tools = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Continue.");
		expect(tools).toEqual(expect.arrayContaining(["list_agents", "send_agent_message", "search_models"]));
	});
});
