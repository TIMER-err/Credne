// Gives a subagent worker its own request layout: its agent prompt as the system prompt, and the
// parent conversation, when it has one, as the first block of its first message.
import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { buildSystemPromptSections } from "../../core/system-prompt.ts";

/** Flag that marks a Pi process as a subagent worker. */
export const WORKER_FLAG = "subagent-worker";

/** Environment variable through which the runner passes the file holding the stripped parent conversation. */
export const WORKER_CONVERSATION_ENV = "PI_SUBAGENT_CONVERSATION";

/**
 * Registers the worker flag and, in a worker, the request layout.
 *
 * The runner starts the worker with `--system-prompt <agent prompt file>` and `--tools <agent tools>`.
 * Here the sent system prompt is pinned to that agent prompt, the project instruction files and the
 * working directory, in that order. Skills, appended prompt files and extension sections such as the
 * MCP server list stay out, so every worker of one agent type sends the same system prompt.
 */
export function registerWorkerPrompt(pi: ExtensionAPI): void {
	pi.registerFlag(WORKER_FLAG, { description: "Internal isolated subagent worker", type: "boolean", default: false });
	pi.on("before_agent_start", (event) => {
		if (!pi.getFlag(WORKER_FLAG)) return;
		const { customPrompt, contextFiles, cwd } = event.systemPromptOptions;
		const sections = buildSystemPromptSections({ customPrompt, contextFiles, cwd });
		// A returned prompt is projected onto every request of the run, after all handlers changed
		// their sections, so a later extension cannot add to it.
		return {
			systemPrompt: getSystemMessageText({
				role: "system",
				content: "",
				sections: {
					preamble: customPrompt ?? "",
					...(sections.project_context ? { project_context: sections.project_context } : {}),
					cwd: sections.cwd,
				},
				timestamp: 0,
			}),
		};
	});
	const conversationPath = process.env[WORKER_CONVERSATION_ENV];
	if (!conversationPath) return;
	let conversation: string | undefined;
	pi.on("context", (event) => {
		if (!pi.getFlag(WORKER_FLAG)) return;
		conversation ??= readFileSync(conversationPath, "utf8");
		return { messages: prependConversation(event.messages, conversation) };
	});
}

/**
 * Puts the conversation before the first user message's content as a block of its own. It is
 * added to each request instead of the transcript, so the task stays the recorded message and the
 * parent receives no copy of the conversation in the worker's results.
 */
function prependConversation(messages: AgentMessage[], conversation: string): AgentMessage[] {
	const index = messages.findIndex((message) => message.role === "user");
	const first = messages[index];
	if (first?.role !== "user") return messages;
	const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
	const next = [...messages];
	next[index] = { ...first, content: [{ type: "text", text: conversation }, ...content] };
	return next;
}
