import type { InlineExtension } from "../core/extensions/types.ts";
import accountsExtension from "./accounts/index.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import planningExtension from "./planning/index.ts";
import subagentExtension from "./subagent/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Provider accounts through the shared credne-broker; registers nothing until accounts exist.
	{ name: "accounts", factory: accountsExtension, builtin: true },
	{ name: "planning", factory: planningExtension, builtin: true },
	{ name: "subagent", factory: subagentExtension, replaceable: true, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
