import { describe, expect, it } from "vitest";
import { REASONING_SUMMARY_LABEL, transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

const kimi: Model<"openai-completions"> = {
	id: "moonshotai/Kimi-K3",
	name: "Kimi K3",
	api: "openai-completions",
	provider: "sference",
	baseUrl: "https://api.sference.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 32768,
};

function assistant(model: string, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "sference",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

const summary = (text: string) => ({ type: "text" as const, text: `${REASONING_SUMMARY_LABEL}\n${text}` });

describe("thinking from other models", () => {
	// https://github.com/earendil-works/pi/issues/10995: unlabeled thinking was continued as the visible reply
	it("replaces another model's thinking with a labeled summary", () => {
		const messages: Message[] = [
			{ role: "user", content: "Why does curl work but node fails?", timestamp: Date.now() },
			assistant("zai-org/GLM-5.3", [
				{
					type: "thinking",
					thinking: "The user asks about ECONNRESET. Candidates: proxy, IPv6, TLS.",
					thinkingSignature: "reasoning_content",
				},
				{ type: "text", text: "Let me check the TLS versions." },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "curl -v" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "TLSv1.2" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, kimi);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;

		expect(assistantMsg.content).toEqual([
			summary("The user asks about ECONNRESET. Candidates: proxy, IPv6, TLS."),
			{ type: "text", text: "Let me check the TLS versions." },
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "curl -v" } },
		]);
	});

	it("drops redacted and empty thinking and bounds long summaries", () => {
		const long = "x".repeat(5000);
		const messages: Message[] = [
			{ role: "user", content: "go", timestamp: Date.now() },
			{
				...assistant("zai-org/GLM-5.3", [
					{ type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
					{ type: "thinking", thinking: "   ", thinkingSignature: "sig" },
					{ type: "thinking", thinking: long, thinkingSignature: "sig" },
					{ type: "text", text: "ok" },
				]),
				stopReason: "stop",
			},
			{ role: "user", content: "next", timestamp: Date.now() },
		];
		const assistantMsg = transformMessages(messages, kimi).find((m) => m.role === "assistant") as AssistantMessage;
		const [first, second] = assistantMsg.content;
		expect(first).toEqual({ type: "text", text: expect.stringMatching(/^\[Reasoning summary[\s\S]*x …$/) });
		expect((first as { text: string }).text.length).toBeLessThan(1600);
		expect(second).toEqual({ type: "text", text: "ok" });
	});

	it("keeps thinking only from the target model when models alternate", () => {
		const thinking = (text: string) => ({
			type: "thinking" as const,
			thinking: text,
			thinkingSignature: "reasoning_content",
		});
		const messages: Message[] = [
			{ role: "user", content: "1", timestamp: Date.now() },
			{ ...assistant("moonshotai/Kimi-K3", [thinking("kimi 1"), { type: "text", text: "a" }]), stopReason: "stop" },
			{ role: "user", content: "2", timestamp: Date.now() },
			{ ...assistant("zai-org/GLM-5.3", [thinking("glm 1"), { type: "text", text: "b" }]), stopReason: "stop" },
			{ role: "user", content: "3", timestamp: Date.now() },
			{ ...assistant("moonshotai/Kimi-K3", [thinking("kimi 2"), { type: "text", text: "c" }]), stopReason: "stop" },
			{ role: "user", content: "4", timestamp: Date.now() },
			{ ...assistant("zai-org/GLM-5.3", [thinking("glm 2"), { type: "text", text: "d" }]), stopReason: "stop" },
			{ role: "user", content: "hi", timestamp: Date.now() },
		];

		const result = transformMessages(messages, kimi);
		const contents = result.filter((m) => m.role === "assistant").map((m) => (m as AssistantMessage).content);

		expect(contents).toEqual([
			[thinking("kimi 1"), { type: "text", text: "a" }],
			[summary("glm 1"), { type: "text", text: "b" }],
			[thinking("kimi 2"), { type: "text", text: "c" }],
			[summary("glm 2"), { type: "text", text: "d" }],
		]);
	});
});
