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
			"Find configured models for subagent or assign_tasks calls. Defaults to the current serving account, including when the parent uses a pool. Search IDs or display names, for example query: 'luna', or sort by cost to find cheaper models. Results include exact IDs and reasoning levels. Use this tool yourself instead of asking the user to look up model settings. Leave provider omitted to stay on the current account; specify another provider only when intentionally changing accounts.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Case insensitive substring of a model ID or display name" })),
			provider: Type.Optional(Type.String({ description: "Optional explicit account, pool or provider override" })),
			sort: Type.Optional(Type.Union([Type.Literal("name"), Type.Literal("cost")])),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
			offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const pool = dispatch.models(ctx, params.provider);
			const query = params.query?.trim().toLowerCase() ?? "";
			const matches = pool.models.filter((model) =>
				`${model.provider}/${model.id}\n${model.name}`.toLowerCase().includes(query),
			);
			matches.sort((a, b) => {
				const cost = params.sort === "cost" ? a.cost.input + a.cost.output - b.cost.input - b.cost.output : 0;
				return cost || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
			});
			const offset = params.offset ?? 0;
			const page = matches.slice(offset, offset + (params.limit ?? 20));
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
				note: "Costs are configured rates per million tokens. Zero may mean unknown pricing. Bare model IDs and unique names stay on the current account. Use an exact result ID to select a model. Refine query or use nextOffset for more results.",
			};
			return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
		},
	});
}
