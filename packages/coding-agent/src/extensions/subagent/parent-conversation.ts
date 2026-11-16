// Renders the main agent's conversation as the stripped copy a subagent reads in its first message.
//
// The text is a pure function of the messages: two subagents given the same cutoff get the same
// bytes, so the provider can cache it once for both.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { filterFailedMessages } from "../../core/messages.ts";

/** Opening tag of the stripped conversation. The worker cache marks the block that starts with it. */
export const PARENT_CONVERSATION_TAG = "<parent_conversation";

/**
 * Renders `messages` as one text block. User messages and assistant text stay in full; system
 * messages and thinking are dropped; a tool call keeps its name and arguments (long arguments
 * shortened) and a tool output its first characters, with a note of how many were cut.
 */
export function renderParentConversation(messages: AgentMessage[]): string {
	const lines = filterFailedMessages(messages).flatMap(renderMessage);
	return [
		`${PARENT_CONVERSATION_TAG} note="The main agent's conversation, given for reference. Tool outputs are shortened.">`,
		...lines,
		"</parent_conversation>",
	].join("\n");
}

function renderMessage(message: AgentMessage): string[] {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return [`[user] ${contentText(message.content)}`];
		case "assistant":
			return message.content.flatMap((part) => {
				if (part.type === "text") return [`[assistant] ${part.text}`];
				if (part.type === "toolCall")
					return [
						`[tool call] ${part.name} ${shorten(JSON.stringify(part.arguments, sortedArgumentKeys), maxArgumentChars)}`,
					];
				return [];
			});
		case "toolResult":
			return [`[${message.isError ? "tool error" : "tool result"}] ${shortenOutput(contentText(message.content))}`];
		case "custom":
			return [`[${message.customType}] ${contentText(message.content)}`];
		case "bashExecution":
			return message.excludeFromContext
				? []
				: [`[user ran] ${message.command}`, `[command output] ${shortenOutput(message.output)}`];
		case "compactionSummary":
			return [`[summary of earlier conversation] ${message.summary}`];
		case "branchSummary":
			return [`[summary of another branch] ${message.summary}`];
	}
}

function contentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

// Arguments carry the call's intent, so they get more room than outputs; long ones are mostly file contents.
const maxArgumentChars = 500;
const maxOutputChars = 200;

function sortedArgumentKeys(_key: string, value: unknown): unknown {
	// Persisted tool arguments are a JSON input boundary and may contain nested objects or arrays.
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}

/** A tool output on one line: its first characters with line breaks written as `\n`. */
function shortenOutput(output: string): string {
	return shorten(output, maxOutputChars).replace(/\r?\n/g, "\\n");
}

function shorten(text: string, max: number): string {
	const characters = Array.from(text);
	if (characters.length <= max) return text;
	// A fixed locale, so the note is the same on every machine.
	return `${characters.slice(0, max).join("")} … [${(characters.length - max).toLocaleString("en-US")} characters cut]`;
}
