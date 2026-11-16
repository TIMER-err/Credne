// Exposes configured worker models without requiring account IDs or exposing credentials.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { SubagentDispatch } from "./dispatch.ts";

/** Registers model discovery using the same account scope as worker dispatch. */
export function registerModelSearch(pi: ExtensionAPI, dispatch: SubagentDispatch): void {
	pi.registerTool({
		name: "search_models",
		label: "Search models",
		description:
			"Discover configured chat models on the current serving account. Defaults to five compact, cost-ranked results; use detail: 'full' for metadata, or query, sort, provider, limit and offset to refine. Costs are USD per million tokens; zero input and output rates may mean unknown, not free. Use the bare modelId portion of a result ID for same-account dispatch.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Case insensitive substring of a model ID or display name" })),
			provider: Type.Optional(Type.String({ description: "Optional explicit account, pool or provider override" })),
			sort: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("cost")])),
			detail: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("full")], { default: "compact" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 5 })),
			offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const pool = dispatch.models(ctx, params.provider);
			const query = params.query?.trim().toLowerCase() ?? "";
			const matches = pool.models.filter((model) =>
				`${model.provider}/${model.id}\n${model.name}`.toLowerCase().includes(query),
			);
			const sort = params.sort ?? "cost";
			matches.sort((a, b) => {
				if (sort === "cost") {
					const aUnknown = a.cost.input === 0 && a.cost.output === 0;
					const bUnknown = b.cost.input === 0 && b.cost.output === 0;
					if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
					if (!aUnknown) {
						const price = a.cost.input + a.cost.output - b.cost.input - b.cost.output;
						if (price !== 0) return price;
					}
				}
				return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
			});
			const offset = params.offset ?? 0;
			const page = matches.slice(offset, offset + (params.limit ?? 5));
			const nextOffset = offset + page.length;
			const details = {
				provider: pool.provider,
				total: matches.length,
				models: page.map((model) => ({
					id: `${model.provider}/${model.id}`,
					modelId: model.id,
					name: model.name,
					reasoningEfforts: getSupportedThinkingLevels(model),
					input: model.input,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					cost: model.cost,
				})),
				nextOffset: nextOffset < matches.length ? nextOffset : undefined,
				note: "Costs are configured USD rates per million tokens. Zero input and output rates may mean unknown, not free. Use the exact provider/model ID to identify a result; pass its bare modelId to dispatch on the current account. Refresh discovery after the model or account changes, or if dispatch fails.",
			};
			const result =
				params.detail === "full"
					? details
					: {
							...details,
							models: page.map((model) => ({
								id: `${model.provider}/${model.id}`,
								reasoningEfforts: getSupportedThinkingLevels(model),
								contextWindow: model.contextWindow,
								cost: {
									input: model.cost.input,
									output: model.cost.output,
									cacheRead: model.cost.cacheRead,
								},
							})),
						};
			return { content: [{ type: "text", text: JSON.stringify(result) }], details };
		},
	});
}
