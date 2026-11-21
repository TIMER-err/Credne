// Wire form of a tool's JSON Schema parameters: draft 2020-12 upgrade plus provider-neutral clean-ups, ported from
// oh-my-pi's `utils/schema`. Key order is part of the request bytes, so every pass keeps oh-my-pi's mutation order.

import type { Tool } from "../../types.ts";

export type JsonObject = Record<string, unknown>;

/** The JSON Schema oh-my-pi sends for `tool.parameters`: plain-JSON clone, upgraded to draft 2020-12, then cleaned up. */
export function toolWireSchema(tool: Tool): JsonObject {
	const upgraded = upgradeJsonSchemaTo202012(cloneJson(tool.parameters)) as JsonObject;
	walk(upgraded, new WeakSet());
	normalizeEmptySchemas(upgraded, new WeakSet());
	return upgraded;
}

/** Deep equality of JSON values that ignores object key order and compares arrays element by element. */
export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) return areJsonArraysEqual(left, right);
	if (!isJsonObject(left) || !isJsonObject(right)) return false;
	let rightLength = 0;
	for (const _ in right) rightLength++;
	let leftLength = 0;
	for (const key in left) {
		leftLength++;
		if (!(key in right) || !areJsonValuesEqual(left[key], right[key])) return false;
	}
	return leftLength === rightLength;
}

function areJsonArraysEqual(left: unknown, right: unknown): boolean {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (!areJsonValuesEqual(left[index], right[index])) return false;
	}
	return true;
}

function isJsonObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` is a plain JSON object with no own enumerable keys. */
function isEmptyObject(value: unknown): boolean {
	return isJsonObject(value) && Object.keys(value).length === 0;
}

// Same clone as oh-my-pi's `structuredCloneJSON`. `tool.parameters` is caller data, so this is a trust boundary:
// `structuredClone` copies a plain graph (shared and cyclic subschemas included) and ignores symbol and non-enumerable
// keys such as TypeBox's `~kind`; anything it cannot copy (functions, class instances) falls back to a JSON round trip.
function cloneJson(value: object): JsonObject {
	if (Object.getPrototypeOf(value) === Object.prototype) {
		try {
			return structuredClone(value) as JsonObject;
		} catch {
			// A nested value is not structured-cloneable; the JSON round trip below drops it.
		}
	}
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

// ---------------------------------------------------------------------------------------------------------------
// Draft 2020-12 upgrade (oh-my-pi `utils/schema/draft.ts`)
// ---------------------------------------------------------------------------------------------------------------

const JSON_SCHEMA_DRAFT_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

const DRAFT_07_SCHEMA_URIS: ReadonlySet<string> = new Set([
	"http://json-schema.org/draft-07/schema#",
	"https://json-schema.org/draft-07/schema#",
	"http://json-schema.org/draft-07/schema",
	"https://json-schema.org/draft-07/schema",
]);

// Keys whose values are name -> schema maps: each entry is upgraded, the map itself is kept.
const UPGRADE_SCHEMA_MAP_KEYS: ReadonlySet<string> = new Set(["properties", "patternProperties", "dependentSchemas"]);

// Keys whose values are JSON values, not schemas: the upgrade copies them verbatim and never descends.
const NON_SCHEMA_VALUE_KEYS: ReadonlySet<string> = new Set([
	"const",
	"default",
	"enum",
	"example",
	"examples",
	"required",
	"dependentRequired",
	"type",
]);

// Draft-07 keywords with no 2020-12 spelling of their own: the upgrade drops them and emits their replacements.
const DROPPED_DRAFT_07_KEYS: ReadonlySet<string> = new Set(["dependencies", "additionalItems", "nullable"]);

/** Returns `schema` itself when nothing in it needs upgrading, otherwise an upgraded copy. */
function upgradeJsonSchemaTo202012(schema: unknown): unknown {
	if (!needsUpgrade(schema, new WeakSet())) return schema;
	return upgradeNode(schema, new WeakMap());
}

/** Cheap walk looking for any keyword or value the upgrade would rewrite; `seen` breaks cycles and shared nodes. */
function needsUpgrade(value: unknown, seen: WeakSet<object>): boolean {
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		return value.some((entry) => needsUpgrade(entry, seen));
	}
	if (!isJsonObject(value) || seen.has(value)) return false;
	seen.add(value);
	for (const key in value) {
		if (keyNeedsUpgrade(key, value[key], seen)) return true;
	}
	return false;
}

function keyNeedsUpgrade(key: string, entry: unknown, seen: WeakSet<object>): boolean {
	if (key === "$schema") return typeof entry === "string" && DRAFT_07_SCHEMA_URIS.has(entry);
	if (key === "definitions" || DROPPED_DRAFT_07_KEYS.has(key)) return true;
	if (key === "$ref") return typeof entry === "string" && entry.startsWith("#/definitions/");
	if (key === "items" && Array.isArray(entry)) return true;
	if (key === "$defs" || UPGRADE_SCHEMA_MAP_KEYS.has(key)) return schemaMapNeedsUpgrade(entry, seen);
	if (NON_SCHEMA_VALUE_KEYS.has(key)) return false;
	return needsUpgrade(entry, seen);
}

function schemaMapNeedsUpgrade(value: unknown, seen: WeakSet<object>): boolean {
	if (!isJsonObject(value)) return false;
	for (const key in value) {
		if (needsUpgrade(value[key], seen)) return true;
	}
	return false;
}

// The `cache` maps each input object to its converted output. It is seeded before recursing, so shared subschemas are
// converted once and a back-edge of a cyclic graph resolves to the (still filling) result instead of looping.
function upgradeNode(value: unknown, cache: WeakMap<object, unknown>): unknown {
	if (Array.isArray(value)) return upgradeArray(value, cache);
	if (!isJsonObject(value)) return value;
	const cached = cache.get(value);
	if (cached !== undefined) return cached;

	const result: JsonObject = {};
	cache.set(value, result);
	for (const key in value) copyUpgradedKey(result, key, value[key], cache);

	// Draft-07 tuple `items: [a, b]` (+ `additionalItems`) becomes `prefixItems: [a, b]` (+ `items` for the rest).
	if (Array.isArray(value.items)) {
		const convertedItems = upgradeNode(value.items, cache) as unknown[];
		result.prefixItems = mergePrefixItems(result.prefixItems, convertedItems);
		if (value.additionalItems !== undefined && value.additionalItems !== true) {
			result.items = upgradeNode(value.additionalItems, cache);
		} else {
			// `additionalItems: true` or absent in draft-07 is no `items` in 2020-12.
			delete result.items;
		}
	}

	convertDependencies(value, result, cache);

	// OpenAPI 3.0 `nullable: true`. `makeNullable` may return a fresh wrapper, which later references to the same input
	// must see instead of the inner result.
	if (value.nullable === true) {
		const nullable = makeNullable(result);
		if (nullable !== result) cache.set(value, nullable);
		return nullable;
	}
	return result;
}

function upgradeArray(value: unknown[], cache: WeakMap<object, unknown>): unknown[] {
	const cached = cache.get(value);
	if (cached !== undefined) return cached as unknown[];
	const result: unknown[] = [];
	cache.set(value, result);
	for (const entry of value) result.push(upgradeNode(entry, cache));
	return result;
}

/** Copies one key of a schema into `result`, rewriting it when draft-07 spelled it differently. */
function copyUpgradedKey(result: JsonObject, key: string, entry: unknown, cache: WeakMap<object, unknown>): void {
	// `definitions` is the draft-07 name of `$defs`; both merge under `$defs`, and their bodies are upgraded.
	if (key === "definitions" || key === "$defs") {
		if (isJsonObject(entry)) mergeSchemaMap(result, "$defs", entry, cache);
		return;
	}
	if (UPGRADE_SCHEMA_MAP_KEYS.has(key)) {
		copySchemaMap(result, key, entry, cache);
		return;
	}
	if (NON_SCHEMA_VALUE_KEYS.has(key)) {
		result[key] = entry;
		return;
	}
	// Array-valued `items` is the tuple form, converted after the key loop.
	if (DROPPED_DRAFT_07_KEYS.has(key) || (key === "items" && Array.isArray(entry))) return;
	if (key === "$schema") {
		result.$schema =
			typeof entry === "string" && DRAFT_07_SCHEMA_URIS.has(entry) ? JSON_SCHEMA_DRAFT_2020_12_URI : entry;
		return;
	}
	if (key === "$ref" && typeof entry === "string") {
		result.$ref = convertRef(entry);
		return;
	}
	result[key] = upgradeNode(entry, cache);
}

// `#/definitions/Foo` becomes `#/$defs/Foo`. The fragment is percent-decoded first, so `#%2Fdefinitions%2Ffoo` matches
// too; external refs pass through.
function convertRef(ref: string): string {
	const pointer = parseLocalRefPointer(ref);
	if (pointer?.[0] !== "definitions") return ref;
	const encoded = ["$defs", ...pointer.slice(1)]
		.map((token) => encodeURIComponent(token.replace(/~/g, "~0").replace(/\//g, "~1")))
		// `$` is legal in a fragment; keeping it readable leaves `$defs` as is.
		.map((token) => token.replace(/%24/g, "$"));
	return `#/${encoded.join("/")}`;
}

// Decoded RFC 6901 tokens of a local `$ref` fragment, `[]` for `#`, `undefined` for a non-local or undecodable ref.
function parseLocalRefPointer(ref: string): string[] | undefined {
	if (!ref.startsWith("#")) return undefined;
	let pointer: string;
	try {
		pointer = decodeURIComponent(ref.slice(1));
	} catch {
		return undefined;
	}
	if (pointer.length > 0 && !pointer.startsWith("/")) return undefined;
	return pointer
		.split("/")
		.slice(1)
		.map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Get-or-create the object map at `target[key]`. */
function getObjectMap(target: JsonObject, key: string): JsonObject {
	const existing = target[key];
	if (isJsonObject(existing)) return existing;
	const next: JsonObject = {};
	target[key] = next;
	return next;
}

/** Upgrades every entry of a schema map (such as `properties`) and merges them into `target[key]`. */
function mergeSchemaMap(target: JsonObject, key: string, value: JsonObject, cache: WeakMap<object, unknown>): void {
	const map = getObjectMap(target, key);
	for (const name in value) {
		map[name] = upgradeNode(value[name], cache);
	}
}

/** Copies a schema map with each entry upgraded; a non-object value passes through verbatim. */
function copySchemaMap(target: JsonObject, key: string, value: unknown, cache: WeakMap<object, unknown>): void {
	if (!isJsonObject(value)) {
		target[key] = value;
		return;
	}
	mergeSchemaMap(target, key, value, cache);
}

/** Merges converted tuple items into an existing `prefixItems`, intersecting a schema already at the same index. */
function mergePrefixItems(existing: unknown, convertedItems: unknown[]): unknown[] {
	if (!Array.isArray(existing)) return convertedItems;
	const merged = [...existing];
	for (let index = 0; index < convertedItems.length; index += 1) {
		merged[index] = index in merged ? combineSchemas(merged[index], convertedItems[index]) : convertedItems[index];
	}
	return merged;
}

/** Intersects two schemas: `true` or missing is the identity, `false` absorbs, equal schemas collapse, else `allOf`. */
function combineSchemas(left: unknown, right: unknown): unknown {
	if (left === undefined || left === true) return right;
	if (right === undefined || right === true) return left;
	if (left === false || right === false) return false;
	if (areJsonValuesEqual(left, right)) return left;
	return { allOf: [left, right] };
}

/** Splits draft-07 `dependencies` into `dependentRequired` (array values) and `dependentSchemas` (schema values). */
function convertDependencies(source: JsonObject, target: JsonObject, cache: WeakMap<object, unknown>): void {
	const dependencies = source.dependencies;
	if (!isJsonObject(dependencies)) return;
	for (const key in dependencies) {
		const converted = upgradeNode(dependencies[key], cache);
		if (Array.isArray(converted)) {
			mergeDependentRequired(target, key, converted);
		} else {
			const dependentSchemas = getObjectMap(target, "dependentSchemas");
			dependentSchemas[key] = combineSchemas(dependentSchemas[key], converted);
		}
	}
}

/** Records `key -> deps` in `dependentRequired`, unioning with an existing array. */
function mergeDependentRequired(target: JsonObject, key: string, deps: unknown[]): void {
	const dependentRequired = getObjectMap(target, "dependentRequired");
	const existing = dependentRequired[key];
	if (existing === undefined) {
		dependentRequired[key] = deps;
	} else if (Array.isArray(existing)) {
		dependentRequired[key] = unionJsonValues(existing, deps);
	}
}

function unionJsonValues(left: unknown[], right: unknown[]): unknown[] {
	const merged = [...left];
	for (const value of right) {
		if (!merged.some((existing) => areJsonValuesEqual(existing, value))) merged.push(value);
	}
	return merged;
}

// Makes `schema` accept `null`: a scalar `type` becomes `[type, "null"]`, a type array gains `"null"`, an `anyOf` gains a
// null branch, anything else is wrapped in a new `anyOf`.
function makeNullable(schema: JsonObject): JsonObject {
	const type = schema.type;
	if (typeof type === "string") {
		if (type !== "null") schema.type = [type, "null"];
		return schema;
	}
	if (Array.isArray(type)) {
		if (!type.includes("null")) schema.type = [...type, "null"];
		return schema;
	}
	if (Array.isArray(schema.anyOf)) {
		if (!schema.anyOf.some(variantAllowsNull)) schema.anyOf = [...schema.anyOf, { type: "null" }];
		return schema;
	}
	return { anyOf: [schema, { type: "null" }] };
}

/** True for a schema whose `type` is `"null"` or a type array containing it. */
function variantAllowsNull(variant: unknown): boolean {
	if (!isJsonObject(variant)) return false;
	return variant.type === "null" || (Array.isArray(variant.type) && variant.type.includes("null"));
}

// ---------------------------------------------------------------------------------------------------------------
// Post-processing (oh-my-pi `utils/schema/wire.ts`)
// ---------------------------------------------------------------------------------------------------------------

/** Keys whose values are a single JSON Schema. */
const SCHEMA_VALUE_KEYS = [
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"items",
	"contains",
	"propertyNames",
	"if",
	"then",
	"else",
	"not",
] as const;

/** Keys whose values are `{ name: schema }` maps. */
const SCHEMA_MAP_KEYS = ["properties", "patternProperties", "$defs", "definitions"] as const;

/** Keys whose values are arrays of schemas. */
const SCHEMA_ARRAY_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

const NULLABLE_SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean"]);

const SCHEMA_DEFINING_SIBLING_KEYS: ReadonlySet<string> = new Set([
	"$ref",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"enum",
	"if",
	"items",
	"not",
	"oneOf",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"then",
	"else",
	"unevaluatedItems",
	"unevaluatedProperties",
]);

// Pre-order over every key, instance data such as `default` and `enum` included, like oh-my-pi. Each rewrite sees its
// children before they are rewritten themselves. `seen` only ends cycles and revisits of a shared node, which are no-ops.
function walk(node: unknown, seen: WeakSet<object>): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, seen);
		return;
	}
	if (!isJsonObject(node) || seen.has(node)) return;
	seen.add(node);
	rewriteNullableScalarAnyOf(node);
	inferBareEnumScalarType(node);
	collapseConstUnionAnyOf(node);
	for (const key in node) walk(node[key], seen);
}

function hasSchemaDefiningSibling(schema: JsonObject): boolean {
	for (const key in schema) {
		if (key !== "anyOf" && SCHEMA_DEFINING_SIBLING_KEYS.has(key)) return true;
	}
	return false;
}

// `anyOf: [{ type: "string", ... }, { type: "null" }]` becomes `{ ..., type: ["string", "null"] }`.
function rewriteNullableScalarAnyOf(schema: JsonObject): void {
	if (hasSchemaDefiningSibling(schema)) return;
	const variants = schema.anyOf;
	if (!Array.isArray(variants) || variants.length !== 2) return;

	let scalarVariant: (JsonObject & { type: string }) | undefined;
	let sawNull = false;
	for (const variant of variants) {
		if (!isJsonObject(variant)) return;
		if (isNullVariant(variant)) {
			if (sawNull) return;
			sawNull = true;
			continue;
		}
		if (!isScalarVariant(variant) || scalarVariant) return;
		scalarVariant = variant;
	}
	if (!sawNull || !scalarVariant) return;

	delete schema.anyOf;
	copyNullableScalarConstraints(schema, scalarVariant);
	schema.type = [scalarVariant.type, "null"];
}

function isNullVariant(schema: JsonObject): boolean {
	return schema.type === "null" && Object.keys(schema).length === 1;
}

function isScalarVariant(schema: JsonObject): schema is JsonObject & { type: string } {
	return typeof schema.type === "string" && NULLABLE_SCALAR_TYPES.has(schema.type);
}

// Moves the scalar variant's constraints onto the wrapper (the wrapper's own keys win) and widens `const`/`enum` with null.
function copyNullableScalarConstraints(schema: JsonObject, scalarVariant: JsonObject): void {
	for (const key in scalarVariant) {
		if (key === "type" || key === "enum" || key === "const" || Object.hasOwn(schema, key)) continue;
		schema[key] = scalarVariant[key];
	}

	if (Object.hasOwn(scalarVariant, "const")) {
		schema.enum = [scalarVariant.const, null];
		return;
	}

	const enumValues = scalarVariant.enum;
	if (Array.isArray(enumValues)) {
		schema.enum = enumValues.includes(null) ? enumValues : [...enumValues, null];
	}
}

// A bare `{ enum: [...] }` of one scalar kind gains that `type`; Gemini and Vertex reject an enum without one.
function inferBareEnumScalarType(schema: JsonObject): void {
	if ("type" in schema || !Array.isArray(schema.enum)) return;
	const inferred = homogeneousEnumScalarType(schema.enum);
	if (inferred !== undefined) schema.type = inferred;
}

/** The one JSON scalar `type` shared by every value, or `undefined` for an empty, mixed or non-scalar list. */
function homogeneousEnumScalarType(values: readonly unknown[]): string | undefined {
	if (values.length === 0) return undefined;
	let inferred: string | undefined;
	for (const value of values) {
		const scalar = scalarTypeOf(value);
		if (scalar === undefined || (inferred !== undefined && inferred !== scalar)) return undefined;
		inferred = scalar;
	}
	return inferred;
}

function scalarTypeOf(value: unknown): string | undefined {
	switch (typeof value) {
		case "string":
			return "string";
		case "boolean":
			return "boolean";
		case "number":
			return "number";
		default:
			return undefined; // null, object and array are not one scalar type
	}
}

/** A union of bare `{ const }` branches (optionally with one shared `description`), read as its values. */
interface ConstUnion {
	values: unknown[];
	description: string | undefined;
}

// `anyOf: [{ const: "a" }, { const: "b" }]` becomes `{ type: "string", enum: ["a", "b"] }` when that loses nothing: no
// wrapper `type`, branches with no extra keyword, one scalar kind, and no description that would be dropped.
function collapseConstUnionAnyOf(schema: JsonObject): void {
	// `hasSchemaDefiningSibling` does not list `type`, and the collapse would overwrite it.
	if (hasSchemaDefiningSibling(schema) || "type" in schema) return;
	const variants = schema.anyOf;
	if (!Array.isArray(variants) || variants.length < 2) return;

	const union = readConstUnion(variants);
	if (!union) return;
	// A branch description that disagrees with the root's own would be dropped by the collapse.
	if (
		union.description !== undefined &&
		typeof schema.description === "string" &&
		schema.description !== union.description
	) {
		return;
	}
	const scalarType = homogeneousEnumScalarType(union.values);
	if (scalarType === undefined) return;

	delete schema.anyOf;
	schema.type = scalarType;
	schema.enum = union.values;
	if (typeof schema.description !== "string" && union.description !== undefined) {
		schema.description = union.description;
	}
}

function readConstUnion(variants: unknown[]): ConstUnion | undefined {
	const values: unknown[] = [];
	let description: string | undefined;
	let describedCount = 0;
	for (const variant of variants) {
		if (!isBareConstBranch(variant)) return undefined;
		const branchDescription = variant.description;
		if (typeof branchDescription === "string") {
			if (describedCount === 0) description = branchDescription;
			// Distinct per-branch descriptions have nowhere to live in a flat enum.
			else if (branchDescription !== description) return undefined;
			describedCount++;
		}
		values.push(variant.const);
	}
	if (describedCount !== 0 && describedCount !== variants.length) return undefined;
	return { values, description };
}

function isBareConstBranch(variant: unknown): variant is JsonObject {
	if (!isJsonObject(variant) || !Object.hasOwn(variant, "const")) return false;
	for (const key in variant) {
		if (key !== "const" && key !== "description") return false;
	}
	return true;
}

// `{}` and `true` are the same schema (draft 2020-12 section 4.3.1), but grammar-constrained samplers read `{}` as "an
// empty object". Rewrites every empty schema in a schema-valued position to `true`, in place.
function normalizeEmptySchemas(node: unknown, seen: WeakSet<object>): void {
	if (Array.isArray(node)) {
		for (const child of node) normalizeEmptySchemas(child, seen);
		return;
	}
	if (!isJsonObject(node) || seen.has(node)) return;
	seen.add(node);
	emptyValuesToTrue(node);
	emptyMapEntriesToTrue(node);
	emptyArrayEntriesToTrue(node);
	for (const key in node) normalizeEmptySchemas(node[key], seen);
}

function emptyValuesToTrue(node: JsonObject): void {
	for (const key of SCHEMA_VALUE_KEYS) {
		if (Object.hasOwn(node, key) && isEmptyObject(node[key])) node[key] = true;
	}
}

function emptyMapEntriesToTrue(node: JsonObject): void {
	for (const mapKey of SCHEMA_MAP_KEYS) {
		const map = node[mapKey];
		if (!isJsonObject(map)) continue;
		for (const key in map) {
			if (isEmptyObject(map[key])) map[key] = true;
		}
	}
}

function emptyArrayEntriesToTrue(node: JsonObject): void {
	for (const arrayKey of SCHEMA_ARRAY_KEYS) {
		const array = node[arrayKey];
		if (!Array.isArray(array)) continue;
		for (let index = 0; index < array.length; index++) {
			if (isEmptyObject(array[index])) array[index] = true;
		}
	}
}
