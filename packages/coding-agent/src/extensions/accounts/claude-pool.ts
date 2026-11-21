// Virtual pools `pool:claude` and `pool:all`: each request goes to one account, subscriptions first, API accounts last.
import { setTimeout as delay } from "node:timers/promises";
import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionVirtualModel } from "../../core/extensions/types.ts";
import type { ModelRoute, ModelRouteRequest } from "../../core/virtual-models.ts";
import { ALL_POOL, poolDisplayName, poolProviderId, VIRTUAL_POOLS } from "./catalog.ts";
import { type ClaudeLimits, claudeModelKind, usageLimitFailure } from "./claude-limits.ts";
import { rankByUsage } from "./claude-rank.ts";
import type { AccountProviderSpec } from "./provider.ts";

/** A virtual pool entry of the account list. */
export type VirtualPoolSpec = AccountProviderSpec & { target: { type: "virtual-pool"; name: string } };

/** Finds a physical model in the model registry. */
export type ModelLookup = (providerId: string, modelId: string) => Model<Api> | undefined;

/** What routing a pool request reads and updates. */
export interface PoolRouting {
	limits: ClaudeLimits;
	/** Asks the usage endpoint for an account's windows and records them in `limits`; best effort. */
	refreshUsage: (providerId: string, signal: AbortSignal) => Promise<void>;
	find: ModelLookup;
	/** Epoch milliseconds; replaced in tests. */
	now?: () => number;
}

/** A conversation stays on its account while the account's prompt cache can still be warm: Anthropic's longest TTL. */
const stickyWarmMs = 60 * 60_000;
/** Ranking waits this long for the usage endpoint, then ranks without the accounts that did not answer. */
const usageTimeoutMs = 5_000;
/** After a limit, a request waits for a sibling that frees up within this span instead of failing at once. */
const siblingWaitMaxMs = 5_000;
/** Slack past a sibling's deadline so the block has expired when the request is routed again. */
const siblingWaitSlackMs = 25;

/**
 * The enabled physical accounts that fund a pool, in routing order: subscriptions first, then API accounts,
 * each group in listing order (local subscriptions before broker accounts).
 */
export function poolMembers(specs: readonly AccountProviderSpec[], pool: string): AccountProviderSpec[] {
	return specs
		.filter((spec) => isPhysical(spec) && !spec.disabled && (pool === ALL_POOL || spec.family === pool))
		.sort((a, b) => Number(b.subscription) - Number(a.subscription));
}

/** One entry per virtual pool that has members; `pool:all` leads. A pool lists the models of its members. */
export function virtualPoolSpecs(physical: readonly AccountProviderSpec[]): VirtualPoolSpec[] {
	return VIRTUAL_POOLS.flatMap((name): VirtualPoolSpec[] => {
		const members = poolMembers(physical, name);
		if (members.length === 0) return [];
		return [
			{
				id: poolProviderId(name),
				name: poolDisplayName({ name, accountCount: members.length }),
				target: { type: "virtual-pool", name },
				family: name,
				subscription: false,
				disabled: false,
				models: poolModels(name, members),
			},
		];
	});
}

/**
 * One virtual model per model id of each pool. `membersOf` is read on every request, so accounts that are added,
 * removed or disabled later take effect without registering the models again.
 */
export function virtualModelDefinitions(
	pools: readonly VirtualPoolSpec[],
	membersOf: (pool: string) => readonly AccountProviderSpec[],
	routing: Omit<PoolRouting, "find">,
): ExtensionVirtualModel[] {
	return pools.flatMap((pool) =>
		pool.models.map(
			(model): ExtensionVirtualModel => ({
				provider: pool.id,
				id: model.id,
				name: model.name,
				thinkingLevels: getSupportedThinkingLevels(model),
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				input: model.input,
				route: (request, ctx) =>
					routePool(request, membersOf(pool.target.name), {
						...routing,
						find: (provider, id) => ctx.modelRegistry.find(provider, id),
					}),
			}),
		),
	);
}

/**
 * Pick the physical model for one request of a pool model, following oh-my-pi's credential selection.
 *
 * A conversation stays on the account that answered last while that account can serve and its prompt cache can be
 * warm. An API account that has the conversation yields to a subscription that can serve again. Otherwise the
 * subscriptions are ranked by usage (see `rankByUsage`), then the API accounts follow in listing order. An account
 * is blocked while a window that gates the request is used up and after a failure named a limit, until its reset.
 * A retry after a 429 or usage-limit failure blocks the failed account and moves on; when every account is blocked,
 * a sibling that frees up within a few seconds is awaited, and otherwise the one that frees up first gets the
 * request and reports the limit itself.
 */
export async function routePool(
	request: ModelRouteRequest,
	members: readonly AccountProviderSpec[],
	routing: PoolRouting,
): Promise<ModelRoute> {
	const now = routing.now ?? Date.now;
	const kind = claudeModelKind(request.model.id);
	const offering = members.filter((spec) => spec.models.some((model) => model.id === request.model.id));
	if (offering.length === 0) throw new Error(`No account offers ${request.model.id}. Add one with /accounts add.`);
	markFailedAccount(request, routing.limits, now(), kind);
	const spec = await chooseMember(request, offering, routing, kind);
	const model = routing.find(spec.id, request.model.id);
	if (!model) throw new Error(`${spec.name} does not list ${request.model.id}.`);
	return { model, thinkingLevel: request.thinkingLevel };
}

/** Rotation: a retry after a usage-limit failure blocks the account that failed. */
function markFailedAccount(
	request: ModelRouteRequest,
	limits: ClaudeLimits,
	now: number,
	kind: string | undefined,
): void {
	if (request.reason !== "retry" || !request.failed) return;
	const failure = usageLimitFailure(request.failed.message, now);
	if (failure) limits.markReached(request.failed.model.provider, kind, failure.until);
}

async function chooseMember(
	request: ModelRouteRequest,
	offering: readonly AccountProviderSpec[],
	routing: PoolRouting,
	kind: string | undefined,
): Promise<AccountProviderSpec> {
	const now = routing.now ?? Date.now;
	const { limits } = routing;
	const isFree = (spec: AccountProviderSpec) => limits.blockedUntil(spec.id, kind, now()) === undefined;
	const lastProvider = (request.reason === "retry" ? request.failed : request.previous)?.model.provider;
	const pinned = offering.find((spec) => spec.id === lastProvider);
	const free = offering.filter(isFree);
	if (pinned && free.includes(pinned) && keepsConversation(pinned, free, request, now())) return pinned;

	await refreshStaleUsage(
		offering.filter((spec) => spec.target.type === "local"),
		request.signal,
		routing,
	);
	const ranked = orderMembers(offering, pinned, routing, kind, now());
	const usable = ranked.filter(isFree);
	if (usable.length > 0) return usable[0];
	// Every account is blocked: the one that frees up first answers, with the limit's own message if it still holds.
	const first = ranked.reduce((best, spec) =>
		blockedUntilOf(spec, routing, kind) < blockedUntilOf(best, routing, kind) ? spec : best,
	);
	const wait = blockedUntilOf(first, routing, kind) - now();
	if (request.reason === "retry" && wait <= siblingWaitMaxMs) {
		await delay(Math.max(0, wait) + siblingWaitSlackMs, undefined, { signal: request.signal });
	}
	return first;
}

/**
 * Whether the conversation stays on its account. Not when the prompt cache is cold, or when an API account has it
 * and a subscription can serve.
 */
function keepsConversation(
	pinned: AccountProviderSpec,
	free: readonly AccountProviderSpec[],
	request: ModelRouteRequest,
	now: number,
): boolean {
	if (isCold(request, now)) return false;
	return pinned.subscription || !free.some((spec) => spec.subscription);
}

/** Whether the latest answer in the conversation is older than the longest prompt cache TTL. */
function isCold(request: ModelRouteRequest, now: number): boolean {
	const latest = request.messages.findLast((message) => message.role === "assistant");
	return latest !== undefined && now - latest.timestamp >= stickyWarmMs;
}

/** Ask the usage endpoint about subscriptions whose windows are unknown or stale, in parallel and within a bound. */
async function refreshStaleUsage(
	subscriptions: readonly AccountProviderSpec[],
	signal: AbortSignal | undefined,
	routing: PoolRouting,
): Promise<void> {
	const now = routing.now?.() ?? Date.now();
	const stale = subscriptions.filter((spec) => routing.limits.needsUsage(spec.id, now));
	if (stale.length === 0) return;
	const timeout = AbortSignal.timeout(usageTimeoutMs);
	const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
	await Promise.all(stale.map((spec) => routing.refreshUsage(spec.id, deadline)));
}

/** Subscriptions ranked by usage, then API accounts in listing order; the pinned account wins real ties. */
function orderMembers(
	offering: readonly AccountProviderSpec[],
	pinned: AccountProviderSpec | undefined,
	routing: PoolRouting,
	kind: string | undefined,
	now: number,
): AccountProviderSpec[] {
	const subscriptions = offering.filter((spec) => spec.subscription);
	const seeded =
		pinned && subscriptions.includes(pinned)
			? [pinned, ...subscriptions.filter((spec) => spec !== pinned)]
			: subscriptions;
	const free = (spec: AccountProviderSpec) => routing.limits.blockedUntil(spec.id, kind, now) === undefined;
	const ranked = rankByUsage(
		seeded.filter(free).map((spec, order) => ({ spec, order, windows: routing.limits.windows(spec.id) })),
		kind,
		now,
	).map((candidate) => candidate.spec);
	const blocked = offering.filter((spec) => !free(spec));
	return [...ranked, ...offering.filter((spec) => !spec.subscription && free(spec)), ...blocked];
}

function blockedUntilOf(spec: AccountProviderSpec, routing: PoolRouting, kind: string | undefined): number {
	return routing.limits.blockedUntil(spec.id, kind, routing.now?.() ?? Date.now()) ?? 0;
}

/** Physical providers: local subscriptions and broker accounts, not pools. */
function isPhysical(spec: AccountProviderSpec): boolean {
	return spec.target.type === "local" || spec.target.type === "account";
}

/** The pool's models: the first member that offers a model id describes it. */
function poolModels(pool: string, members: readonly AccountProviderSpec[]): Model<Api>[] {
	const models = new Map<string, Model<Api>>();
	for (const member of members) {
		for (const model of member.models) {
			if (!models.has(model.id)) models.set(model.id, { ...model, provider: poolProviderId(pool) });
		}
	}
	return [...models.values()];
}
