/**
 * Tool definitions of an Anthropic subscription (OAuth) request in Claude Code's wire form: the source schema's keys
 * normalized to the keyword subset the API validates, strict mode for an allowlist of tools, and deferred tools.
 * Ported from oh-my-pi's `providers/anthropic.ts` tool conversion.
 */

import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { Tool } from "../../types.ts";
import { applyClaudeToolPrefix } from "./identity.ts";
import { areJsonValuesEqual, type JsonObject, toolWireSchema } from "./schema.ts";

/** One tool of the request: its definition and whether it is declared with `defer_loading`. */
export interface ClaudeCodeTool {
	tool: Tool;
	deferred: boolean;
}

export interface ClaudeCodeToolOptions {
	/** Send no `strict: true` tool: Anthropic rejected strict tools for this request or session. */
	disableStrictTools: boolean;
	/** Send `eager_input_streaming` on every tool. */
	supportsEagerToolInputStreaming: boolean;
}

/** Tools in wire form, and whether any of them is strict, which the strict-tool downgrade ladder keys on. */
export interface ClaudeCodeWireTools {
	tools: BetaTool[];
	hasStrictTools: boolean;
}

const COMBINATOR_KEYS = ["anyOf", "allOf", "oneOf"] as const;

// Not `bash`: strict decoding fixes property order, so an optional key declared before one the model has already
// written can no longer be emitted. `yield` carries a subagent's whole structured result and only holds together with
// buffered input streaming.
const STRICT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(["python", "edit", "find", "yield"]);
const MAX_STRICT_TOOLS = 20;
const MAX_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_STRICT_UNION_PARAMETERS = 16;

// Tools sent with `eager_input_streaming: false`, so the API buffers and validates their input: eagerly streamed
// `yield` input from Claude Haiku arrived as invalid JSON even with `strict` set.
const BUFFERED_INPUT_TOOLS: ReadonlySet<string> = new Set(["yield"]);

/** Keys kept on every node. Root `anyOf`/`allOf` are spilled (the API rejects combinators at the root); `oneOf` always. */
const UNIVERSAL_KEEP: ReadonlySet<string> = new Set([
	"$ref",
	"$defs",
	"$schema",
	"definitions",
	"type",
	"anyOf",
	"allOf",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"nullable",
]);
const OBJECT_KEEP: ReadonlySet<string> = new Set(["properties", "required", "additionalProperties"]);
const ARRAY_KEEP: ReadonlySet<string> = new Set(["items", "prefixItems", "minItems"]);
const STRING_KEEP: ReadonlySet<string> = new Set(["format"]);
const STRING_FORMATS: ReadonlySet<string> = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEntries(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isArrayNode(schema: JsonObject): boolean {
	const type = schema.type;
	if (type === "array") return true;
	if (Array.isArray(type) && type.includes("array") && !type.includes("object")) return true;
	return schema.items !== undefined || Array.isArray(schema.prefixItems);
}

function isObjectNode(schema: JsonObject): boolean {
	if (isArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	return isRecord(schema.properties);
}

/** The principal non-null scalar of a `type` keyword; `["number", "null"]` is a number. */
function pickScalarType(type: unknown): string | undefined {
	if (typeof type === "string") return type;
	if (!Array.isArray(type)) return undefined;
	return type.find((entry): entry is string => typeof entry === "string" && entry !== "null");
}

function pickEffectiveScalarType(schema: JsonObject): string | undefined {
	const explicit = pickScalarType(schema.type);
	if (explicit) return explicit;
	if (isRecord(schema.properties)) return "object";
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return "array";
	return undefined;
}

function perTypeKeep(scalarType: string | undefined): ReadonlySet<string> | undefined {
	if (scalarType === "object") return OBJECT_KEEP;
	if (scalarType === "array") return ARRAY_KEEP;
	if (scalarType === "string") return STRING_KEEP;
	return undefined;
}

/** Demotes the stripped keywords into the node's description so the model still reads the constraint. */
function spillToDescription(node: JsonObject, entries: ReadonlyArray<readonly [string, unknown]>): void {
	const spilled = entries.filter((entry) => entry[1] !== undefined);
	if (spilled.length === 0) return;
	const existing = typeof node.description === "string" ? node.description : "";
	const formatted = `{${spilled.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")}}`;
	node.description = existing ? `${existing}\n\n${formatted}` : formatted;
}

function normalizeList(value: unknown, cache: WeakMap<object, JsonObject>): unknown[] {
	return (value as unknown[]).map((entry) => normalizeNode(entry, cache));
}

function normalizeMap(source: JsonObject, cache: WeakMap<object, JsonObject>): JsonObject {
	const normalized: JsonObject = {};
	for (const name in source) {
		if (Object.hasOwn(source, name)) normalized[name] = normalizeNode(source[name], cache);
	}
	return normalized;
}

/**
 * Normalizes one JSON Schema node the way the Anthropic SDK's `transform_schema` whitelists keywords: universal keys
 * and the keys of the node's type survive, anything else moves into `description`. Object nodes default to
 * `additionalProperties: false`; explicit open maps are kept.
 */
function normalizeNode(schema: unknown, cache: WeakMap<object, JsonObject>, isRoot = false): unknown {
	if (Array.isArray(schema)) return normalizeList(schema, cache);
	if (!isRecord(schema)) return schema;
	const existing = cache.get(schema);
	if (existing !== undefined) return existing;

	const result: JsonObject = {};
	cache.set(schema, result);
	const scalarType = pickEffectiveScalarType(schema);
	const typeKeep = perTypeKeep(scalarType);
	const spill: Array<[string, unknown]> = [];
	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;
		const isRootCombinator = isRoot && (COMBINATOR_KEYS as readonly string[]).includes(key);
		if (!isRootCombinator && (UNIVERSAL_KEEP.has(key) || typeKeep?.has(key))) result[key] = schema[key];
		else spill.push([key, schema[key]]);
	}

	if (scalarType === "string" && typeof result.format === "string" && !STRING_FORMATS.has(result.format)) {
		spill.push(["format", result.format]);
		delete result.format;
	}
	if (scalarType === "array" && result.minItems !== undefined && result.minItems !== 0 && result.minItems !== 1) {
		spill.push(["minItems", result.minItems]);
		delete result.minItems;
	}
	if (scalarType === "object" && result.additionalProperties === undefined) result.additionalProperties = false;

	if (isRecord(result.properties)) result.properties = normalizeMap(result.properties, cache);
	if (isRecord(result.additionalProperties)) {
		const normalized = normalizeNode(result.additionalProperties, cache);
		result.additionalProperties = isRecord(normalized) && Object.keys(normalized).length === 0 ? true : normalized;
	}
	if (Array.isArray(result.items)) result.items = normalizeList(result.items, cache);
	else if (isRecord(result.items)) result.items = normalizeNode(result.items, cache);
	if (Array.isArray(result.prefixItems)) result.prefixItems = normalizeList(result.prefixItems, cache);
	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(result[key])) result[key] = normalizeList(result[key], cache);
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (isRecord(definitions)) result[defsKey] = normalizeMap(definitions, cache);
	}

	spillToDescription(result, spill);
	return result;
}

/**
 * Whether a root combinator variant can merge into the root object. `allOf` branches may be open (every branch must
 * hold); an open `anyOf`/`oneOf` variant admits any value for keys other variants declare.
 */
function isFoldableRootVariant(variant: unknown, conjunctive: boolean): variant is JsonObject {
	if (!isRecord(variant)) return false;
	const type = pickEffectiveScalarType(variant);
	if (type !== undefined && type !== "object") return false;
	if (variant.$ref !== undefined || variant.not !== undefined || variant.if !== undefined) return false;
	if (COMBINATOR_KEYS.some((key) => variant[key] !== undefined)) return false;
	return conjunctive || variant.additionalProperties === undefined || variant.additionalProperties === false;
}

interface RootFold {
	properties: JsonObject;
	required: Set<string>;
	open: boolean;
}

/** Merges one root combinator's variants into `fold`; a combinator whose variants cannot merge opens the root. */
function foldRootCombinator(fold: RootFold, key: (typeof COMBINATOR_KEYS)[number], variants: unknown[]): void {
	const conjunctive = key === "allOf";
	if (!variants.every((variant) => isFoldableRootVariant(variant, conjunctive))) {
		fold.open = true;
		return;
	}
	const declared = new Map<string, unknown[]>();
	let shared: Set<string> | undefined;
	for (const variant of variants as JsonObject[]) {
		for (const [name, propertySchema] of Object.entries(isRecord(variant.properties) ? variant.properties : {})) {
			const declarations = declared.get(name) ?? [];
			if (!declarations.some((entry) => areJsonValuesEqual(entry, propertySchema)))
				declarations.push(propertySchema);
			declared.set(name, declarations);
		}
		const variantRequired = stringEntries(variant.required);
		if (conjunctive) {
			for (const name of variantRequired) fold.required.add(name);
		} else {
			shared = new Set(shared ? variantRequired.filter((name) => shared?.has(name)) : variantRequired);
		}
		if (variant.additionalProperties !== undefined && variant.additionalProperties !== false) fold.open = true;
	}
	for (const name of shared ?? []) fold.required.add(name);
	// A key the root (or an earlier combinator) already declares keeps that declaration: both must hold.
	for (const [name, declarations] of declared) {
		if (Object.hasOwn(fold.properties, name)) continue;
		fold.properties[name] =
			declarations.length === 1 ? declarations[0] : { [conjunctive ? "allOf" : "anyOf"]: declarations };
	}
}

/**
 * Folds root `anyOf`/`oneOf`/`allOf` object variants into the root object. The API rejects root combinators, so
 * normalization spills them into the description; without this fold a pure root union would reach the wire as a closed
 * object that admits only `{}`.
 */
function foldRootCombinators(schema: JsonObject): JsonObject {
	const rootType = pickEffectiveScalarType(schema);
	if (rootType !== undefined && rootType !== "object") return schema;
	const combinators = COMBINATOR_KEYS.filter((key) => Array.isArray(schema[key]) && schema[key].length > 0);
	if (combinators.length === 0) return schema;

	const fold: RootFold = {
		properties: isRecord(schema.properties) ? { ...schema.properties } : {},
		required: new Set(stringEntries(schema.required)),
		open: false,
	};
	for (const key of combinators) foldRootCombinator(fold, key, schema[key] as unknown[]);

	const folded: JsonObject = { ...schema };
	if (Object.keys(fold.properties).length > 0 || isRecord(schema.properties)) folded.properties = fold.properties;
	if (fold.required.size > 0) folded.required = [...fold.required];
	if (fold.open && folded.additionalProperties === undefined && isRecord(folded.properties)) {
		folded.additionalProperties = true;
	}
	return folded;
}

function normalizeToolSchema(schema: JsonObject): JsonObject {
	return normalizeNode(foldRootCombinators(schema), new WeakMap(), true) as JsonObject;
}

function buildBaseInputSchema(wireSchema: JsonObject): JsonObject {
	return normalizeToolSchema({
		...wireSchema,
		type: "object",
		properties: isRecord(wireSchema.properties) ? wireSchema.properties : {},
		required: stringEntries(wireSchema.required),
	});
}

interface StrictBudget {
	optionalRemaining: number;
	unionRemaining: number;
	optionalCount: number;
	unionCount: number;
}

interface StrictSchemaResult {
	schema: JsonObject;
	optionalCount: number;
	unionCount: number;
}

type StrictCache = WeakMap<object, StrictSchemaResult | null>;

function hasUnionType(schema: JsonObject): boolean {
	return Array.isArray(schema.type) || Array.isArray(schema.anyOf);
}

function hasNullVariant(schema: JsonObject): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => isRecord(variant) && variant.type === "null");
}

function hasSchemaDefiningKeyword(schema: JsonObject): boolean {
	const keys = ["type", "properties", "additionalProperties", "items", "prefixItems", "enum", "const", "$ref"];
	return (
		keys.some((key) => schema[key] !== undefined) ||
		COMBINATOR_KEYS.some((key) => schema[key] !== undefined) ||
		schema.$defs !== undefined ||
		schema.definitions !== undefined
	);
}

function makeNullable(schema: unknown, budget: StrictBudget): unknown {
	if (isRecord(schema)) {
		if (hasNullVariant(schema)) return schema;
		if (Array.isArray(schema.anyOf)) return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
		if (Array.isArray(schema.type)) return { ...schema, type: [...schema.type, "null"] };
	}
	if (budget.unionRemaining <= 0) return undefined;
	budget.unionRemaining--;
	budget.unionCount++;
	return { anyOf: [schema, { type: "null" }] };
}

function strictList(schema: unknown[], budget: StrictBudget, cache: StrictCache): unknown[] | undefined {
	const result: unknown[] = [];
	for (const entry of schema) {
		const normalized = normalizeStrictNode(entry, budget, cache);
		if (normalized === undefined) return undefined;
		result.push(normalized);
	}
	return result;
}

function strictMap(source: JsonObject, budget: StrictBudget, cache: StrictCache): JsonObject | undefined {
	const result: JsonObject = {};
	for (const [name, entry] of Object.entries(source)) {
		const normalized = normalizeStrictNode(entry, budget, cache);
		if (normalized === undefined) return undefined;
		result[name] = normalized;
	}
	return result;
}

/** Closes the object's properties for strict decoding: optional keys stay optional while the budget lasts. */
function strictProperties(result: JsonObject, budget: StrictBudget, cache: StrictCache): boolean {
	const originalRequired = new Set(stringEntries(result.required));
	const properties: JsonObject = {};
	const required: string[] = [];
	for (const [propertyName, propertySchema] of Object.entries(result.properties as JsonObject)) {
		const normalized = normalizeStrictNode(propertySchema, budget, cache);
		if (normalized === undefined) return false;
		if (originalRequired.has(propertyName)) {
			properties[propertyName] = normalized;
			required.push(propertyName);
		} else if (budget.optionalRemaining > 0) {
			budget.optionalRemaining--;
			budget.optionalCount++;
			properties[propertyName] = normalized;
		} else {
			const nullable = makeNullable(normalized, budget);
			if (nullable === undefined) return false;
			properties[propertyName] = nullable;
			required.push(propertyName);
		}
	}
	result.properties = properties;
	result.required = required;
	return true;
}

/** Applies the strict transform to the child schemas of `result`; false when any child cannot be strict. */
function strictChildren(result: JsonObject, budget: StrictBudget, cache: StrictCache): boolean {
	if (isRecord(result.properties) && !strictProperties(result, budget, cache)) return false;
	for (const key of ["items", "prefixItems", ...COMBINATOR_KEYS] as const) {
		const value = result[key];
		if (!Array.isArray(value) && !(key === "items" && isRecord(value))) continue;
		const normalized = normalizeStrictNode(value, budget, cache);
		if (normalized === undefined) return false;
		result[key] = normalized;
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalized = strictMap(definitions, budget, cache);
		if (normalized === undefined) return false;
		result[defsKey] = normalized;
	}
	return true;
}

function normalizeStrictNode(schema: unknown, budget: StrictBudget, cache: StrictCache): unknown {
	if (Array.isArray(schema)) return strictList(schema, budget, cache);
	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached === null) return undefined;
	if (
		cached !== undefined &&
		cached.optionalCount <= budget.optionalRemaining &&
		cached.unionCount <= budget.unionRemaining
	) {
		// JSON repeats shared nodes; Anthropic charges every serialized occurrence.
		budget.optionalRemaining -= cached.optionalCount;
		budget.optionalCount += cached.optionalCount;
		budget.unionRemaining -= cached.unionCount;
		budget.unionCount += cached.unionCount;
		return cached.schema;
	}
	if (!hasSchemaDefiningKeyword(schema)) return undefined;
	// Strict tool use only supports closed objects; open maps stay available on the non-strict plan.
	if (isObjectNode(schema) && schema.additionalProperties !== false) return undefined;

	const result: JsonObject = { ...schema };
	const optionalCountBefore = budget.optionalCount;
	const unionCountBefore = budget.unionCount;
	// An unfinished entry denotes a cycle, not a reusable serialized subtree.
	cache.set(schema, null);
	if (hasUnionType(result)) {
		if (budget.unionRemaining <= 0) return undefined;
		budget.unionRemaining--;
		budget.unionCount++;
	}
	if (!strictChildren(result, budget, cache)) return undefined;
	cache.set(schema, {
		schema: result,
		optionalCount: budget.optionalCount - optionalCountBefore,
		unionCount: budget.unionCount - unionCountBefore,
	});
	return result;
}

const STRICT_INCOMPATIBLE_KEYWORDS = ["oneOf", "allOf", "$ref", "patternProperties", "propertyNames"] as const;

/**
 * Anthropic's strict grammar subset supports `anyOf` and type-array unions only; the other keywords compile
 * unpredictably and fail the turn with a 400. Runs on the raw schema, since normalization spills several of them.
 */
function hasStrictIncompatibleKeyword(schema: unknown, seen = new Set<object>()): boolean {
	if (typeof schema !== "object" || schema === null || seen.has(schema)) return false;
	seen.add(schema);
	if (Array.isArray(schema)) return schema.some((entry) => hasStrictIncompatibleKeyword(entry, seen));
	const node = schema as JsonObject;
	if (STRICT_INCOMPATIBLE_KEYWORDS.some((keyword) => node[keyword] !== undefined)) return true;
	return Object.values(node).some((value) => hasStrictIncompatibleKeyword(value, seen));
}

function normalizeStrictSchema(
	schema: JsonObject,
	optionalRemaining: number,
	unionRemaining: number,
): StrictSchemaResult | undefined {
	const budget: StrictBudget = { optionalRemaining, unionRemaining, optionalCount: 0, unionCount: 0 };
	const normalized = normalizeStrictNode(schema, budget, new WeakMap());
	if (!isRecord(normalized)) return undefined;
	return { schema: normalized, optionalCount: budget.optionalCount, unionCount: budget.unionCount };
}

interface ToolSchemaPlan {
	inputSchema: JsonObject;
	strict: boolean;
}

function isStrictCandidate(tool: Tool, wireSchema: JsonObject): boolean {
	return (
		STRICT_TOOL_ALLOWLIST.has(tool.name) &&
		tool.constrainedSampling !== false &&
		!hasStrictIncompatibleKeyword(wireSchema)
	);
}

/** Plans each tool's schema: normalized, and strict for allowlisted tools while the request-wide strict budgets last. */
function planToolSchemas(tools: readonly Tool[], disableStrictTools: boolean): ToolSchemaPlan[] {
	const wireSchemas = tools.map(toolWireSchema);
	const plans = wireSchemas.map(
		(wireSchema): ToolSchemaPlan => ({ inputSchema: buildBaseInputSchema(wireSchema), strict: false }),
	);
	if (disableStrictTools) return plans;

	let strictTools = 0;
	let optionalParameters = 0;
	let unionParameters = 0;
	for (const [index, tool] of tools.entries()) {
		if (strictTools >= MAX_STRICT_TOOLS) break;
		if (!isStrictCandidate(tool, wireSchemas[index])) continue;
		const result = normalizeStrictSchema(
			plans[index].inputSchema,
			MAX_STRICT_OPTIONAL_PARAMETERS - optionalParameters,
			MAX_STRICT_UNION_PARAMETERS - unionParameters,
		);
		if (!result) continue;
		plans[index] = { inputSchema: result.schema, strict: true };
		strictTools++;
		optionalParameters += result.optionalCount;
		unionParameters += result.unionCount;
	}
	return plans;
}

/**
 * Tools in Claude Code's wire form. Keys are `name, description, input_schema, eager_input_streaming, [strict],
 * [defer_loading]`; the cache breakpoint, when there is one, is appended after them.
 */
export function convertClaudeCodeTools(
	entries: readonly ClaudeCodeTool[],
	options: ClaudeCodeToolOptions,
): ClaudeCodeWireTools {
	const plans = planToolSchemas(
		entries.map((entry) => entry.tool),
		options.disableStrictTools,
	);
	const tools = entries.map(({ tool, deferred }, index): BetaTool => {
		const plan = plans[index];
		return {
			name: applyClaudeToolPrefix(tool.name),
			description: tool.description || "",
			// The schema is plain JSON that normalization keeps open to arbitrary keywords.
			input_schema: plan.inputSchema as BetaTool["input_schema"],
			...(options.supportsEagerToolInputStreaming
				? { eager_input_streaming: !BUFFERED_INPUT_TOOLS.has(tool.name) }
				: {}),
			...(plan.strict ? { strict: true } : {}),
			...(deferred ? { defer_loading: true } : {}),
		};
	});
	return { tools, hasStrictTools: plans.some((plan) => plan.strict) };
}
