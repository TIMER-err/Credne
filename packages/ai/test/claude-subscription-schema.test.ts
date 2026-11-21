import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { areJsonValuesEqual, type JsonObject, toolWireSchema } from "../src/api/claude-subscription/schema.ts";

function wire(parameters: object): JsonObject {
	return toolWireSchema({ name: "probe", description: "probe tool", parameters });
}

function property(schema: JsonObject, name: string): unknown {
	return (schema.properties as JsonObject)[name];
}

describe("toolWireSchema draft upgrade", () => {
	it("moves definitions to $defs and rewrites draft-07 refs", () => {
		const result = wire({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { root: { $ref: "#/definitions/Node" } },
			definitions: {
				Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" } } },
			},
		});

		expect(result).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: { root: { $ref: "#/$defs/Node" } },
			$defs: {
				Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
			},
		});
		expect(Object.keys(result)).toEqual(["$schema", "type", "properties", "$defs"]);
	});

	it("rewrites percent-encoded and pointer-escaped refs and leaves other refs alone", () => {
		const result = wire({
			type: "object",
			definitions: { "a/b": { type: "string" } },
			properties: {
				encoded: { $ref: "#%2Fdefinitions%2Ffoo" },
				escaped: { $ref: "#/definitions/a~1b" },
				spaced: { $ref: "#/definitions/with space" },
				external: { $ref: "https://example.com/schema.json#/definitions/Foo" },
				current: { $ref: "#/$defs/Foo" },
				root: { $ref: "#" },
			},
		});

		expect(result).toEqual({
			type: "object",
			$defs: { "a/b": { type: "string" } },
			properties: {
				encoded: { $ref: "#/$defs/foo" },
				escaped: { $ref: "#/$defs/a~1b" },
				spaced: { $ref: "#/$defs/with%20space" },
				external: { $ref: "https://example.com/schema.json#/definitions/Foo" },
				current: { $ref: "#/$defs/Foo" },
				root: { $ref: "#" },
			},
		});
	});

	it("upgrades the bodies of an existing $defs when another keyword needs the upgrade", () => {
		const result = wire({
			type: "object",
			$defs: { Flag: { type: "string", nullable: true } },
			properties: { flag: { $ref: "#/definitions/Flag" } },
		});

		expect(result).toEqual({
			type: "object",
			$defs: { Flag: { type: ["string", "null"] } },
			properties: { flag: { $ref: "#/$defs/Flag" } },
		});
	});

	it("turns tuple items into prefixItems and additionalItems into items", () => {
		const result = wire({
			type: "array",
			items: [{ type: "string" }, { type: "number" }],
			additionalItems: { type: "boolean" },
		});

		expect(result).toEqual({
			type: "array",
			prefixItems: [{ type: "string" }, { type: "number" }],
			items: { type: "boolean" },
		});
		expect(Object.keys(result)).toEqual(["type", "prefixItems", "items"]);
	});

	it("drops additionalItems that allow anything and keeps a forbidding one as items", () => {
		const open = wire({ type: "array", items: [{ type: "string" }], additionalItems: true });
		const closed = wire({ type: "array", items: [{ type: "string" }], additionalItems: false });

		expect(open).toEqual({ type: "array", prefixItems: [{ type: "string" }] });
		expect(closed).toEqual({ type: "array", prefixItems: [{ type: "string" }], items: false });
	});

	it("upgrades tuples nested in properties", () => {
		const result = wire({
			type: "object",
			properties: { pair: { type: "array", items: [{ type: "number" }, { type: "number" }] } },
		});

		expect(result).toEqual({
			type: "object",
			properties: { pair: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }] } },
		});
	});

	it("splits dependencies into dependentRequired and dependentSchemas", () => {
		const result = wire({
			type: "object",
			properties: { card: { type: "string" }, billing: { type: "string" }, gift: { type: "boolean" } },
			dependencies: {
				card: ["billing"],
				gift: { properties: { note: { type: "string", nullable: true } } },
			},
		});

		expect(result).toEqual({
			type: "object",
			properties: { card: { type: "string" }, billing: { type: "string" }, gift: { type: "boolean" } },
			dependentRequired: { card: ["billing"] },
			dependentSchemas: { gift: { properties: { note: { type: ["string", "null"] } } } },
		});
	});

	it("merges dependencies into existing dependentRequired and dependentSchemas", () => {
		const result = wire({
			type: "object",
			dependentRequired: { a: ["c"], b: ["d"] },
			dependentSchemas: { a: { required: ["x"] }, b: { required: ["y"] } },
			dependencies: {
				a: ["b", "c"],
				b: { required: ["y"] },
				c: { required: ["z"] },
			},
		});

		expect(result).toEqual({
			type: "object",
			dependentRequired: { a: ["c", "b"], b: ["d"] },
			dependentSchemas: {
				a: { required: ["x"] },
				b: { required: ["y"] },
				c: { required: ["z"] },
			},
		});
	});

	it("intersects a dependency schema that differs from an existing dependentSchemas entry", () => {
		const result = wire({
			type: "object",
			dependentSchemas: { a: { required: ["x"] } },
			dependencies: { a: { required: ["y"] } },
		});

		expect(result).toEqual({
			type: "object",
			dependentSchemas: { a: { allOf: [{ required: ["x"] }, { required: ["y"] }] } },
		});
	});

	it("turns nullable: true into a nullable type", () => {
		expect(wire({ type: "string", nullable: true })).toEqual({ type: ["string", "null"] });
		expect(wire({ type: ["string", "number"], nullable: true })).toEqual({ type: ["string", "number", "null"] });
		expect(wire({ type: ["string", "null"], nullable: true })).toEqual({ type: ["string", "null"] });
		expect(wire({ type: "string", nullable: false })).toEqual({ type: "string" });
	});

	it("adds a null branch to a nullable anyOf and wraps a typeless nullable schema", () => {
		expect(wire({ anyOf: [{ type: "string" }, { type: "number" }], nullable: true })).toEqual({
			anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
		});
		expect(wire({ anyOf: [{ type: "string" }, { type: "null" }, { type: "number" }], nullable: true })).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }, { type: "number" }],
		});
		expect(wire({ properties: { a: { type: "string" } }, nullable: true })).toEqual({
			anyOf: [{ properties: { a: { type: "string" } } }, { type: "null" }],
		});
	});

	it("applies nullable inside properties and completes a wrapped enum", () => {
		const result = wire({
			type: "object",
			properties: {
				name: { type: "string", nullable: true },
				mode: { enum: ["a", "b"], nullable: true },
			},
		});

		expect(result).toEqual({
			type: "object",
			properties: {
				name: { type: ["string", "null"] },
				mode: { anyOf: [{ enum: ["a", "b"], type: "string" }, { type: "null" }] },
			},
		});
	});

	it("does not touch keywords that only look like upgrade targets", () => {
		const result = wire({
			type: "object",
			properties: {
				definitions: { type: "string" },
				nullable: { type: "boolean" },
				dependencies: { type: "array", items: { type: "string" } },
			},
			default: { definitions: { nullable: true }, items: [] },
			examples: [{ nullable: true }],
		});

		expect(result).toEqual({
			type: "object",
			properties: {
				definitions: { type: "string" },
				nullable: { type: "boolean" },
				dependencies: { type: "array", items: { type: "string" } },
			},
			default: { definitions: { nullable: true }, items: [] },
			examples: [{ nullable: true }],
		});
	});

	it("returns a schema that needs no change deep-equal to its JSON clone", () => {
		const parameters = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				path: { type: "string", description: "File path", minLength: 1 },
				mode: { type: "string", enum: ["read", "write"] },
				tags: { type: "array", items: { type: "string" }, minItems: 1 },
				options: { type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false },
				ref: { $ref: "#/$defs/Shared" },
			},
			required: ["path"],
			$defs: { Shared: { type: "number", minimum: 0 } },
		};
		const snapshot = JSON.parse(JSON.stringify(parameters));

		const result = wire(parameters);

		expect(result).toEqual(snapshot);
		expect(JSON.stringify(result)).toBe(JSON.stringify(snapshot));
		expect(result).not.toBe(parameters);
	});

	it("never mutates the tool's parameters", () => {
		const parameters = {
			type: "object",
			definitions: { Id: { type: "string", nullable: true } },
			properties: {
				id: { $ref: "#/definitions/Id" },
				pair: { type: "array", items: [{}, {}] },
				maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
				kind: { enum: ["a", "b"] },
				loose: {},
			},
		};
		const snapshot = JSON.parse(JSON.stringify(parameters));

		wire(parameters);

		expect(parameters).toEqual(snapshot);
	});

	it("handles subschemas shared between properties", () => {
		const shared = { type: "string", nullable: true };
		const result = wire({ type: "object", properties: { a: shared, b: shared, c: { items: [shared] } } });

		expect(result).toEqual({
			type: "object",
			properties: {
				a: { type: ["string", "null"] },
				b: { type: ["string", "null"] },
				c: { prefixItems: [{ type: ["string", "null"] }] },
			},
		});
	});

	it("terminates on a cyclic schema", () => {
		const node: JsonObject = { type: "object", definitions: { Id: { type: "string" } } };
		node.properties = { self: node, anything: {}, status: { enum: ["a", "b"] } };

		const result = wire(node);

		expect(result.$defs).toEqual({ Id: { type: "string" } });
		expect(property(result, "self")).toBe(result);
		expect(property(result, "anything")).toBe(true);
		expect(property(result, "status")).toEqual({ enum: ["a", "b"], type: "string" });
	});
});

describe("toolWireSchema nullable scalar anyOf", () => {
	it("rewrites anyOf of a scalar and null into a type array", () => {
		expect(wire({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({ type: ["string", "null"] });
		expect(wire({ anyOf: [{ type: "null" }, { type: "integer" }] })).toEqual({ type: ["integer", "null"] });
		expect(wire({ anyOf: [{ type: "boolean" }, { type: "null" }] })).toEqual({ type: ["boolean", "null"] });
	});

	it("rewrites nested nullable unions", () => {
		const result = wire({
			type: "object",
			properties: { limit: { anyOf: [{ type: "number" }, { type: "null" }], description: "Max rows" } },
		});

		expect(result).toEqual({
			type: "object",
			properties: { limit: { description: "Max rows", type: ["number", "null"] } },
		});
	});

	it("copies the scalar branch's constraints and keeps the union's own keys", () => {
		const result = wire({
			description: "outer",
			anyOf: [{ type: "integer", minimum: 1, maximum: 5, description: "inner" }, { type: "null" }],
		});

		expect(result).toEqual({ description: "outer", minimum: 1, maximum: 5, type: ["integer", "null"] });
		expect(Object.keys(result)).toEqual(["description", "minimum", "maximum", "type"]);
	});

	it("widens an enum or const with null", () => {
		const enumResult = wire({ anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] });
		const nullEnumResult = wire({ anyOf: [{ type: "string", enum: ["a", null] }, { type: "null" }] });
		const constResult = wire({ anyOf: [{ type: "string", const: "a" }, { type: "null" }] });

		expect(enumResult).toEqual({ enum: ["a", "b", null], type: ["string", "null"] });
		expect(Object.keys(enumResult)).toEqual(["enum", "type"]);
		expect(nullEnumResult).toEqual({ enum: ["a", null], type: ["string", "null"] });
		expect(constResult).toEqual({ enum: ["a", null], type: ["string", "null"] });
	});

	it("leaves unions that are not exactly one scalar plus a bare null", () => {
		const unions = [
			{ anyOf: [{ type: "string" }, { type: "null" }, { type: "number" }] },
			{ anyOf: [{ type: "string" }, { type: "number" }] },
			{ anyOf: [{ type: "null" }, { type: "null" }] },
			{ anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
			{ anyOf: [{ type: "object" }, { type: "null" }] },
			{ anyOf: [{ type: "string" }, { type: "null", description: "nothing" }] },
			{ anyOf: [{ type: ["string", "number"] }, { type: "null" }] },
			{ anyOf: [{ type: "string" }, "null"] },
			{ anyOf: [{ type: "string" }] },
		];

		for (const union of unions) expect(wire(union)).toEqual(union);
	});

	it("leaves a union that has a schema-defining sibling", () => {
		const union = { anyOf: [{ type: "string" }, { type: "null" }], enum: ["a", null] };

		expect(wire(union)).toEqual(union);
	});
});

describe("toolWireSchema bare enum", () => {
	it("adds the scalar type of a homogeneous enum", () => {
		expect(wire({ enum: ["a", "b"] })).toEqual({ enum: ["a", "b"], type: "string" });
		expect(wire({ enum: [1, 2.5] })).toEqual({ enum: [1, 2.5], type: "number" });
		expect(wire({ enum: [true, false] })).toEqual({ enum: [true, false], type: "boolean" });
		expect(Object.keys(wire({ enum: ["a"], description: "d" }))).toEqual(["enum", "description", "type"]);
	});

	it("completes enums nested in properties and array items", () => {
		const result = wire({
			type: "object",
			properties: { level: { enum: ["low", "high"] }, levels: { type: "array", items: { enum: [1, 2] } } },
		});

		expect(result).toEqual({
			type: "object",
			properties: {
				level: { enum: ["low", "high"], type: "string" },
				levels: { type: "array", items: { enum: [1, 2], type: "number" } },
			},
		});
	});

	it("leaves enums that are typed, empty, mixed or not scalar", () => {
		const enums = [
			{ type: ["string", "null"], enum: ["a", null] },
			{ type: "integer", enum: [1, 2] },
			{ enum: [] },
			{ enum: ["a", 1] },
			{ enum: ["a", null] },
			{ enum: [{ a: 1 }] },
			{ enum: [["a"]] },
		];

		for (const schema of enums) expect(wire(schema)).toEqual(schema);
	});
});

describe("toolWireSchema const union collapse", () => {
	it("collapses an anyOf of bare const branches into a typed enum", () => {
		expect(wire({ anyOf: [{ const: "a" }, { const: "b" }, { const: "c" }] })).toEqual({
			type: "string",
			enum: ["a", "b", "c"],
		});
		expect(wire({ anyOf: [{ const: 1 }, { const: 2 }] })).toEqual({ type: "number", enum: [1, 2] });
		expect(wire({ anyOf: [{ const: true }, { const: false }] })).toEqual({ type: "boolean", enum: [true, false] });
	});

	it("moves a description shared by every branch to the collapsed schema", () => {
		const result = wire({
			anyOf: [
				{ const: "a", description: "Mode" },
				{ const: "b", description: "Mode" },
			],
		});

		expect(result).toEqual({ type: "string", enum: ["a", "b"], description: "Mode" });
		expect(Object.keys(result)).toEqual(["type", "enum", "description"]);
	});

	it("keeps the union's own description when it matches the branches", () => {
		const result = wire({
			description: "Mode",
			anyOf: [
				{ const: "a", description: "Mode" },
				{ const: "b", description: "Mode" },
			],
		});

		expect(result).toEqual({ description: "Mode", type: "string", enum: ["a", "b"] });
		expect(Object.keys(result)).toEqual(["description", "type", "enum"]);
	});

	it("keeps the union's own description over undescribed branches", () => {
		expect(wire({ description: "Mode", anyOf: [{ const: "a" }, { const: "b" }] })).toEqual({
			description: "Mode",
			type: "string",
			enum: ["a", "b"],
		});
	});

	it("does not collapse branches with distinct descriptions", () => {
		const union = {
			anyOf: [
				{ const: "a", description: "First" },
				{ const: "b", description: "Second" },
			],
		};

		expect(wire(union)).toEqual(union);
	});

	it("does not collapse when only some branches are described or the root disagrees", () => {
		const partial = { anyOf: [{ const: "a", description: "First" }, { const: "b" }] };
		const disagreeing = {
			description: "Root",
			anyOf: [
				{ const: "a", description: "Branch" },
				{ const: "b", description: "Branch" },
			],
		};

		expect(wire(partial)).toEqual(partial);
		expect(wire(disagreeing)).toEqual(disagreeing);
	});

	it("does not collapse mixed, null or non-scalar constants", () => {
		const unions = [
			{ anyOf: [{ const: "a" }, { const: 1 }] },
			{ anyOf: [{ const: "a" }, { const: null }] },
			{ anyOf: [{ const: "a" }, { const: { b: 1 } }] },
			{ anyOf: [{ const: "a" }] },
		];

		for (const union of unions) expect(wire(union)).toEqual(union);
	});

	it("does not collapse branches with other keywords or a wrapper type", () => {
		const unions = [
			{
				anyOf: [
					{ const: "a", type: "string" },
					{ const: "b", type: "string" },
				],
			},
			{
				anyOf: [
					{ const: "a", title: "A" },
					{ const: "b", title: "B" },
				],
			},
			{ anyOf: [{ const: "a" }, { type: "string" }] },
			{ type: "string", anyOf: [{ const: "a" }, { const: "b" }] },
			{ enum: ["a", "b"], anyOf: [{ const: "a" }, { const: "b" }] },
		];

		for (const union of unions) {
			const result = wire(union);
			expect(result.anyOf).toEqual(union.anyOf);
		}
	});
});

describe("toolWireSchema empty schemas", () => {
	it("turns {} into true in every schema-valued position", () => {
		const result = wire({
			type: "object",
			properties: { any: {}, list: { type: "array", items: {} }, typed: { type: "string" } },
			additionalProperties: {},
			patternProperties: { "^x-": {} },
			$defs: { Anything: {} },
			anyOf: [{}, { type: "string" }],
			allOf: [{}],
			oneOf: [{ type: "number" }, {}],
			not: {},
			propertyNames: {},
			contains: {},
			unevaluatedItems: {},
			unevaluatedProperties: {},
		});

		expect(result).toEqual({
			type: "object",
			properties: { any: true, list: { type: "array", items: true }, typed: { type: "string" } },
			additionalProperties: true,
			patternProperties: { "^x-": true },
			$defs: { Anything: true },
			anyOf: [true, { type: "string" }],
			allOf: [true],
			oneOf: [{ type: "number" }, true],
			not: true,
			propertyNames: true,
			contains: true,
			unevaluatedItems: true,
			unevaluatedProperties: true,
		});
	});

	it("turns {} in if, then and else into true", () => {
		// Parsed from JSON: a `then` key in an object literal trips the lint rule against thenable objects.
		const conditional = JSON.parse('{"if":{},"then":{},"else":{}}');

		expect(wire(conditional)).toEqual(JSON.parse('{"if":true,"then":true,"else":true}'));
	});

	it("turns {} in prefixItems and definitions into true", () => {
		const result = wire({
			type: "array",
			items: [{}, { type: "string" }],
			definitions: { Anything: {} },
		});

		expect(result).toEqual({
			type: "array",
			prefixItems: [true, { type: "string" }],
			$defs: { Anything: true },
		});
	});

	it("reaches empty schemas nested in other schemas", () => {
		const result = wire({
			type: "object",
			properties: { rows: { type: "array", items: { type: "object", properties: { cell: {} } } } },
		});

		expect(result).toEqual({
			type: "object",
			properties: { rows: { type: "array", items: { type: "object", properties: { cell: true } } } },
		});
	});

	it("keeps an empty root schema and empty values outside schema positions", () => {
		expect(wire({})).toEqual({});
		expect(wire({ default: {}, examples: [{}], const: {}, properties: { a: { default: {} } } })).toEqual({
			default: {},
			examples: [{}],
			const: {},
			properties: { a: { default: {} } },
		});
	});

	it("does not treat an empty object property named like a keyword as a schema", () => {
		const result = wire({ type: "object", properties: { items: {}, not: {} } });

		expect(result).toEqual({ type: "object", properties: { items: true, not: true } });
	});
});

describe("toolWireSchema with TypeBox parameters", () => {
	it("keeps a union of literals as an anyOf of typed consts", () => {
		const result = wire(
			Type.Object({
				mode: Type.Union([Type.Literal("fast"), Type.Literal("slow")]),
				attempts: Type.Number(),
			}),
		);

		expect(result).toEqual({
			type: "object",
			required: ["mode", "attempts"],
			properties: {
				mode: {
					anyOf: [
						{ type: "string", const: "fast" },
						{ type: "string", const: "slow" },
					],
				},
				attempts: { type: "number" },
			},
		});
		expect(JSON.stringify(result)).toBe(
			'{"type":"object","required":["mode","attempts"],"properties":{"mode":{"anyOf":[{"type":"string","const":"fast"},{"type":"string","const":"slow"}]},"attempts":{"type":"number"}}}',
		);
	});

	it("rewrites an optional nullable string and opens Any to true", () => {
		const result = wire(
			Type.Object({
				path: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				meta: Type.Any(),
				tags: Type.Array(Type.Any()),
				extra: Type.Object({}, { additionalProperties: Type.Any() }),
			}),
		);

		expect(result).toEqual({
			type: "object",
			required: ["meta", "tags", "extra"],
			properties: {
				path: { type: ["string", "null"] },
				meta: true,
				tags: { type: "array", items: true },
				extra: { type: "object", properties: {}, additionalProperties: true },
			},
		});
		expect(JSON.stringify(result)).toBe(
			'{"type":"object","required":["meta","tags","extra"],"properties":{"path":{"type":["string","null"]},"meta":true,"tags":{"type":"array","items":true},"extra":{"type":"object","properties":{},"additionalProperties":true}}}',
		);
	});

	it("drops TypeBox's non-enumerable marks", () => {
		const parameters = Type.Object({ a: Type.Optional(Type.String()) });

		const result = wire(parameters);

		expect(Reflect.ownKeys(result)).toEqual(["type", "properties"]);
		expect(Reflect.ownKeys(property(result, "a") as object)).toEqual(["type"]);
	});
});

describe("areJsonValuesEqual", () => {
	it("ignores object key order at every depth", () => {
		const left = { a: 1, b: { c: [1, { x: "y", z: null }], d: true } };
		const right = { b: { d: true, c: [1, { z: null, x: "y" }] }, a: 1 };

		expect(areJsonValuesEqual(left, right)).toBe(true);
		expect(JSON.stringify(left)).not.toBe(JSON.stringify(right));
	});

	it("compares arrays in order and by length", () => {
		expect(areJsonValuesEqual([1, 2, 3], [1, 2, 3])).toBe(true);
		expect(areJsonValuesEqual([1, 2, 3], [3, 2, 1])).toBe(false);
		expect(areJsonValuesEqual([1, 2], [1, 2, 3])).toBe(false);
		expect(areJsonValuesEqual([], [])).toBe(true);
	});

	it("tells different values and different shapes apart", () => {
		expect(areJsonValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(areJsonValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(areJsonValuesEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
		expect(areJsonValuesEqual({ a: 1 }, { b: 1 })).toBe(false);
		expect(areJsonValuesEqual({}, [])).toBe(false);
		expect(areJsonValuesEqual([], {})).toBe(false);
		expect(areJsonValuesEqual(null, {})).toBe(false);
		expect(areJsonValuesEqual({}, null)).toBe(false);
		expect(areJsonValuesEqual("1", 1)).toBe(false);
	});

	it("compares primitives with Object.is", () => {
		expect(areJsonValuesEqual("a", "a")).toBe(true);
		expect(areJsonValuesEqual(null, null)).toBe(true);
		expect(areJsonValuesEqual(undefined, undefined)).toBe(true);
		expect(areJsonValuesEqual(Number.NaN, Number.NaN)).toBe(true);
		expect(areJsonValuesEqual(true, false)).toBe(false);
	});
});
