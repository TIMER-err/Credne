import { prewarmModelConnection } from "@earendil-works/pi-ai/api/claude-subscription/prewarm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

vi.mock("@earendil-works/pi-ai/api/claude-subscription/prewarm", () => ({
	prewarmModelConnection: vi.fn(async () => {}),
}));

describe("AgentSession connection prewarm", () => {
	const harnesses: Harness[] = [];

	async function createSession(): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		return harness;
	}

	function useSubscriptionAuth(harness: Harness): void {
		vi.spyOn(harness.session.modelRuntime, "isUsingOAuth").mockReturnValue(true);
	}

	beforeEach(() => {
		vi.mocked(prewarmModelConnection).mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("warms the current model of a session served by a subscription credential, with the app's identity", async () => {
		const harness = await createSession();
		useSubscriptionAuth(harness);

		harness.session.prewarmModelConnection();

		expect(prewarmModelConnection).toHaveBeenCalledExactlyOnceWith(harness.session.model, {
			identity: expect.objectContaining({ userAgent: "detailed" }),
		});
	});

	it("does nothing for credentials that are not a subscription", async () => {
		const harness = await createSession();

		harness.session.prewarmModelConnection();

		expect(prewarmModelConnection).not.toHaveBeenCalled();
	});

	it("does nothing while a turn is running", async () => {
		const harness = await createSession();
		useSubscriptionAuth(harness);
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);

		harness.session.prewarmModelConnection();

		expect(prewarmModelConnection).not.toHaveBeenCalled();
	});

	it("warms the new model when the model changes, and not when it stays the same", async () => {
		const harness = await createSession();
		useSubscriptionAuth(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);
		await harness.session.setModel(nextModel);

		expect(prewarmModelConnection).toHaveBeenCalledExactlyOnceWith(nextModel, expect.anything());
	});
});
