import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerSession } from "../../src/extensions/subagent/runner.ts";
import { WorkerTeam } from "../../src/extensions/subagent/team.ts";
import type { WorkerChannel } from "../../src/extensions/subagent/worker-channel.ts";
import { createHarness, type Harness } from "./harness.ts";

const channels = new Map<string, WorkerChannel>();
const deliveries: Array<{ message: string; mode: "steer" | "followUp" }> = [];

vi.mock("../../src/extensions/subagent/runner.ts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	createWorkerSession: (
		_defaults: unknown,
		_resolved: unknown,
		_name: string,
		channel: WorkerChannel,
	): WorkerSession => {
		channels.set(channel.id, channel);
		return {
			run: (_task, _step, signal) =>
				new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("test worker stopped")), { once: true });
				}),
			send: async (message, mode) => {
				deliveries.push({ message, mode });
				return true;
			},
			setModel: async () => {},
			dispose: async () => {},
		};
	},
}));

describe("subagent message delivery", () => {
	let harness: Harness;
	let team: WorkerTeam;
	let explorerId: string;
	let batchSecondRan: boolean;
	const statuses: unknown[] = [];

	beforeEach(async () => {
		channels.clear();
		deliveries.length = 0;
		statuses.length = 0;
		batchSecondRan = false;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					team = new WorkerTeam(pi);
					pi.registerTool({
						name: "report_worker",
						label: "Report worker",
						description: "Receive a report from the worker",
						parameters: Type.Object({}),
						async execute() {
							statuses.push(
								await channels.get(explorerId)!.request({ type: "send", to: "main", message: "found cause" }),
							);
							return { content: [{ type: "text", text: "report queued" }], details: {} };
						},
					});
					pi.registerTool({
						name: "batch_second",
						label: "Second batch tool",
						description: "Finish the same batch",
						parameters: Type.Object({}),
						async execute() {
							batchSecondRan = true;
							return { content: [{ type: "text", text: "second tool completed" }], details: {} };
						},
					});
				},
			],
		});
		const explorer = team.spawn({
			name: "explorer",
			task: "Investigate the cause",
			defaults: { context: { mode: "fresh", sessionId: "parent" } },
			resolved: { available: [], cwd: harness.tempDir },
		});
		explorerId = explorer.id;
		await vi.waitFor(() => expect(team.list()[0]?.status).toBe("running"));
	});

	afterEach(async () => {
		await team.dispose();
		harness.cleanup();
	});

	it("steers a worker report into main's next request after every tool in the batch completes", async () => {
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("report_worker", {}), fauxToolCall("batch_second", {})], {
				stopReason: "toolUse",
			}),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("final answer with findings");
			},
		]);

		await harness.session.prompt("Run both tools and then summarize");

		expect(statuses).toEqual(["queued"]);
		expect(batchSecondRan).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(`Message from explorer (${explorerId}):\\nfound cause`);
		expect(requests[0]).toContain("second tool completed");
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "agent-message", details: { sender: explorerId } }),
		);
	});

	it("wakes idle main and keeps the authenticated sender label", async () => {
		const requests: string[] = [];
		harness.setResponses([fauxAssistantMessage("initial response")]);
		await harness.session.prompt("Start and stop");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		harness.setResponses([
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("responding to explorer");
			},
		]);

		const status = await channels.get(explorerId)!.request({ type: "send", to: "main", message: "idle report" });
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(2));

		expect(status).toBe("queued");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(`Message from explorer (${explorerId}):\\nidle report`);
	});

	it("steers messages to active peers but retains interrupted messages for continuation", async () => {
		const peer = team.spawn({
			name: "peer",
			task: "Investigate another area",
			defaults: { context: { mode: "fresh", sessionId: "parent" } },
			resolved: { available: [], cwd: harness.tempDir },
		});
		await vi.waitFor(() => expect(team.list().find((worker) => worker.id === peer.id)?.status).toBe("running"));

		expect(await channels.get(explorerId)!.request({ type: "send", to: peer.id, message: "check this" })).toBe(
			"delivered",
		);
		expect(deliveries).toEqual([{ message: `Message from explorer (${explorerId}):\ncheck this`, mode: "steer" }]);
		await team.interrupt(peer.id);
		expect(await channels.get(explorerId)!.request({ type: "send", to: peer.id, message: "later" })).toBe(
			"queued_until_continue",
		);
		expect(team.list().find((worker) => worker.id === peer.id)?.inboxCount).toBe(1);
		expect(deliveries).toHaveLength(1);
	});
});
