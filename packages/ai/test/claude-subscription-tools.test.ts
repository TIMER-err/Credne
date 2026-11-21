import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildClaudeCodeBetas } from "../src/api/claude-subscription/fingerprint.ts";
import {
	type ClaudeCodeTool,
	type ClaudeCodeToolOptions,
	convertClaudeCodeTools,
} from "../src/api/claude-subscription/tools.ts";
import type { Tool } from "../src/types.ts";

const options: ClaudeCodeToolOptions = { disableStrictTools: false, supportsEagerToolInputStreaming: true };

function tool(name: string, parameters: object, extra: Partial<Tool> = {}): Tool {
	return { name, description: `${name} tool`, parameters, ...extra };
}

function convert(tools: Tool[], overrides: Partial<ClaudeCodeToolOptions> = {}) {
	const entries: ClaudeCodeTool[] = tools.map((entry) => ({ tool: entry, deferred: false }));
	return convertClaudeCodeTools(entries, { ...options, ...overrides });
}

function inputSchemaOf(parameters: object, name = "custom"): unknown {
	return convert([tool(name, parameters)]).tools[0]?.input_schema;
}

describe("tool wire form", () => {
	it("orders the keys name, description, input_schema, eager_input_streaming, strict, defer_loading", () => {
		const { tools } = convertClaudeCodeTools(
			[
				{
					tool: tool("edit", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
					deferred: true,
				},
				{ tool: tool("read", { type: "object", properties: {} }), deferred: false },
			],
			options,
		);
		expect(tools.map((entry) => Object.keys(entry))).toEqual([
			["name", "description", "input_schema", "eager_input_streaming", "strict", "defer_loading"],
			["name", "description", "input_schema", "eager_input_streaming"],
		]);
	});

	it("prefixes tool names and leaves Anthropic's built-in names alone", () => {
		const { tools } = convert([tool("read", {}), tool("web_search", {}), tool("Computer", {})]);
		expect(tools.map((entry) => entry.name)).toEqual(["_read", "web_search", "Computer"]);
	});

	it("sends an empty description for a tool without one", () => {
		expect(convert([tool("read", {}, { description: "" })]).tools[0]?.description).toBe("");
	});

	it("sends tools: [] when there are none", () => {
		expect(JSON.stringify(convert([]).tools)).toBe("[]");
	});

	it("sends no placeholder tool and no inline-tools beta", () => {
		const { tools } = convert([tool("read", {})]);
		expect(tools.map((entry) => entry.name)).toEqual(["_read"]);
		const betas = buildClaudeCodeBetas({
			agentRequest: true,
			thinkingRequest: true,
			disableStrictTools: false,
			dropPromptCacheBetas: false,
		});
		expect(betas.some((beta) => beta.startsWith("inline-tools"))).toBe(false);
	});

	it("omits eager_input_streaming where the endpoint does not support it, and buffers yield where it does", () => {
		expect(
			Object.keys(convert([tool("read", {})], { supportsEagerToolInputStreaming: false }).tools[0] ?? {}),
		).toEqual(["name", "description", "input_schema"]);
		const eager = convert([tool("read", {}), tool("yield", {})]).tools.map((entry) => entry.eager_input_streaming);
		expect(eager).toEqual([true, false]);
	});
});

describe("schema normalization", () => {
	it("closes objects, requires nothing by default and keeps the keywords the API validates", () => {
		expect(
			inputSchemaOf({
				type: "object",
				properties: {
					path: { type: "string", description: "the path" },
					mode: { enum: ["a", "b"] },
					nested: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
				},
				required: ["path"],
			}),
		).toEqual({
			type: "object",
			properties: {
				path: { type: "string", description: "the path" },
				mode: { type: "string", enum: ["a", "b"] },
				nested: {
					type: "object",
					properties: { n: { type: "integer" } },
					required: ["n"],
					additionalProperties: false,
				},
			},
			required: ["path"],
			additionalProperties: false,
		});
	});

	it("gives a schema with no properties an empty object schema", () => {
		expect(inputSchemaOf({})).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		});
	});

	it("demotes keywords the API rejects into the description", () => {
		const schema = inputSchemaOf({
			type: "object",
			properties: {
				count: { type: "integer", minimum: 1, maximum: 9, description: "how many" },
				name: { type: "string", pattern: "^a", minLength: 2 },
				tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
				when: { type: "string", format: "date-time" },
				odd: { type: "string", format: "custom-format" },
				one: { type: "array", items: { type: "string" }, minItems: 1 },
			},
		}) as { properties: Record<string, unknown> };
		expect(schema.properties).toEqual({
			count: { type: "integer", description: "how many\n\n{minimum: 1, maximum: 9}" },
			name: { type: "string", description: '{pattern: "^a", minLength: 2}' },
			tags: { type: "array", items: { type: "string" }, description: "{maxItems: 5, minItems: 2}" },
			when: { type: "string", format: "date-time" },
			odd: { type: "string", description: '{format: "custom-format"}' },
			one: { type: "array", items: { type: "string" }, minItems: 1 },
		});
	});

	it("keeps an explicit open map open", () => {
		const schema = inputSchemaOf({
			type: "object",
			properties: {
				env: { type: "object", additionalProperties: { type: "string" } },
				any: { type: "object", additionalProperties: {} },
			},
		}) as { properties: Record<string, unknown> };
		expect(schema.properties).toEqual({
			env: { type: "object", additionalProperties: { type: "string" } },
			any: { type: "object", additionalProperties: true },
		});
	});

	it("folds a root union of object variants into the root object", () => {
		expect(
			inputSchemaOf({
				type: "object",
				anyOf: [
					{ type: "object", properties: { id: { type: "string" }, a: { type: "number" } }, required: ["id", "a"] },
					{ type: "object", properties: { id: { type: "string" }, b: { type: "number" } }, required: ["id"] },
				],
			}),
		).toEqual({
			type: "object",
			properties: { id: { type: "string" }, a: { type: "number" }, b: { type: "number" } },
			required: ["id"],
			additionalProperties: false,
			description: expect.stringContaining("anyOf"),
		});
	});

	it("normalizes TypeBox schemas through their wire form", () => {
		const schema = inputSchemaOf(
			Type.Object({
				path: Type.String(),
				mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("slow")])),
				limit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
			}),
		);
		expect(schema).toEqual({
			type: "object",
			properties: {
				path: { type: "string" },
				mode: {
					anyOf: [
						{ type: "string", const: "fast" },
						{ type: "string", const: "slow" },
					],
				},
				limit: { type: ["number", "null"] },
			},
			required: ["path"],
			additionalProperties: false,
		});
	});
});

describe("strict tools", () => {
	const editParameters = {
		type: "object",
		properties: { path: { type: "string" }, note: { type: "string" } },
		required: ["path"],
	};

	it("marks only python, edit, find and yield strict", () => {
		const { tools, hasStrictTools } = convert(
			["python", "edit", "find", "yield", "bash", "read"].map((name) => tool(name, editParameters)),
		);
		expect(tools.map((entry) => [entry.name, entry.strict])).toEqual([
			["_python", true],
			["_edit", true],
			["_find", true],
			["_yield", true],
			["_bash", undefined],
			["_read", undefined],
		]);
		expect(hasStrictTools).toBe(true);
	});

	it("keeps optional properties optional while the budget lasts", () => {
		expect(convert([tool("edit", editParameters)]).tools[0]?.input_schema).toEqual({
			type: "object",
			properties: { path: { type: "string" }, note: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		});
	});

	it("turns optional properties past the budget of 24 into required nullable ones", () => {
		const properties = Object.fromEntries(
			Array.from({ length: 26 }, (_, index) => [`p${index}`, { type: "string" }]),
		);
		const schema = convert([tool("edit", { type: "object", properties })]).tools[0]?.input_schema as {
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(schema.required).toEqual(["p24", "p25"]);
		expect(schema.properties.p23).toEqual({ type: "string" });
		expect(schema.properties.p24).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
	});

	it("stops at 20 strict tools", () => {
		const names = Array.from({ length: 22 }, () => "edit");
		const { tools } = convert(names.map((name) => tool(name, editParameters)));
		expect(tools.filter((entry) => entry.strict === true)).toHaveLength(20);
	});

	it("sends a tool that cannot be strict as an ordinary tool", () => {
		const schemas = [
			{ type: "object", properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] } } },
			{ type: "object", properties: { v: { type: "object", additionalProperties: { type: "string" } } } },
			{ type: "object", properties: { v: { $ref: "#/$defs/x" } }, $defs: { x: { type: "string" } } },
		];
		for (const parameters of schemas) {
			const { tools, hasStrictTools } = convert([tool("edit", parameters)]);
			expect(tools[0]?.strict).toBeUndefined();
			expect(hasStrictTools).toBe(false);
		}
	});

	it("honors constrainedSampling: false and the session-wide downgrade", () => {
		expect(convert([tool("edit", editParameters, { constrainedSampling: false })]).tools[0]?.strict).toBeUndefined();
		expect(convert([tool("edit", editParameters)], { disableStrictTools: true }).tools[0]?.strict).toBeUndefined();
	});
});
