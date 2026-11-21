/**
 * Claude model capabilities that Anthropic subscription (OAuth) requests gate body fields on, derived from the model id.
 * Ported from oh-my-pi's `catalog/src/compat/rules/classes/anthropic.kdl`, its taxonomy (family from the id, revision
 * after `claude-`) and the first-party defaults of `catalog/src/compat/resolve.ts`. The table at the bottom is the one
 * place those rules live; every consumer reads {@link getClaudeModelTraits}.
 */

type ClaudeFamily = "opus" | "sonnet" | "haiku" | "fable" | "mythos";

/** `major.minor.patch`; omitted components are zero, so `claude-opus-5-5` is `[5, 5, 0]`. */
type Revision = readonly [number, number, number];

interface ClaudeIdentity {
	/** Lowercased id without its provider prefix. */
	bare: string;
	family: ClaudeFamily | undefined;
	revision: Revision | undefined;
}

/** How enabled thinking is requested: a token budget, a budget plus `output_config.effort`, or adaptive thinking. */
export type ClaudeThinkingMode = "budget" | "budget-effort" | "adaptive";

/** Body fields a model accepts on the first-party subscription endpoint. */
export interface ClaudeModelTraits {
	thinkingMode: ClaudeThinkingMode;
	/** Signed thinking is bound to the exact preceding conversation (`thinking-prefix-binding`). */
	hasThinkingPrefixBinding: boolean;
	/** `thinking.block_binding` is accepted (`supports-thinking-binding-controls`). */
	supportsThinkingBindingControls: boolean;
	/** `thinking: {type: "between_tools"}` is the lowest thinking setting; `disabled` is a 400. */
	supportsBetweenToolsThinking: boolean;
	/** `thinking.display` is accepted: adaptive generation 4.7 and newer. */
	supportsThinkingDisplay: boolean;
	/** `thinking: {type: "disabled"}` is accepted on an adaptive model (`disabled-thinking "disabled"`). */
	acceptsDisabledThinking: boolean;
	/** The model can use message threads (`supports-message-threads`). */
	supportsMessageThreads: boolean;
	/** `temperature`, `top_p` and `top_k` are accepted; newer lines reject them with a 400. */
	supportsSamplingParams: boolean;
	/** `tool_choice` of `any` or `tool` is accepted; otherwise it is downgraded to `auto`. */
	supportsForcedToolChoice: boolean;
	/** `role: "system"` messages are accepted inside the conversation. */
	supportsMidConversationSystem: boolean;
	/** `tool_addition` / `tool_removal` blocks are accepted in those system messages. */
	supportsMidConversationToolChanges: boolean;
	/** System messages may carry `clear_at: "next_user_message"`. */
	supportsTurnScopedSystem: boolean;
	/** System messages may carry `output_config.effort`. */
	supportsPerMessageEffort: boolean;
	/** The Claude Code identity block is sent in the system prompt (`inject-claude-code-instruction`). */
	injectsClaudeCodeInstruction: boolean;
}

/** One cascade rule: `traits` apply to `families` at revisions from `from` (inclusive) below `below` (exclusive). */
interface FamilyRule {
	families: readonly ClaudeFamily[];
	from?: string;
	below?: string;
	traits: Partial<ClaudeModelTraits>;
}

/** A rule for one exact id, for a model with no revision to select on. */
interface ModelRule {
	modelId: string;
	traits: Partial<ClaudeModelTraits>;
}

type TraitRule = FamilyRule | ModelRule;

const families: readonly ClaudeFamily[] = ["opus", "sonnet", "haiku", "fable", "mythos"];
const namespaceSeparators = /[/.:]/;
const claudeIdPrefix = "claude-";

/** Traits of an id that no rule selects: what the first-party resolver defaults to. */
const defaultTraits: ClaudeModelTraits = {
	thinkingMode: "budget",
	hasThinkingPrefixBinding: false,
	supportsThinkingBindingControls: false,
	supportsBetweenToolsThinking: false,
	supportsThinkingDisplay: false,
	acceptsDisabledThinking: false,
	supportsMessageThreads: false,
	supportsSamplingParams: true,
	supportsForcedToolChoice: true,
	supportsMidConversationSystem: false,
	supportsMidConversationToolChanges: false,
	supportsTurnScopedSystem: false,
	supportsPerMessageEffort: false,
	injectsClaudeCodeInstruction: true,
};

/** The traits of the Claude model named by `modelId`; an id that is not a Claude gets the defaults. */
export function getClaudeModelTraits(modelId: string): ClaudeModelTraits {
	const traits = { ...defaultTraits };
	const identity = parseClaudeIdentity(modelId);
	if (!identity) return traits;
	for (const rule of traitRules) {
		if (ruleMatches(rule, identity)) Object.assign(traits, rule.traits);
	}
	return traits;
}

function parseClaudeIdentity(modelId: string): ClaudeIdentity | undefined {
	const lower = modelId.trim().toLowerCase();
	const bare = lower.slice(lower.lastIndexOf("/") + 1);
	if (!isClaudeClass(lower, bare)) return undefined;
	return { bare, family: parseFamily(bare), revision: parseRevisionAfterPrefix(bare) };
}

/** The `anthropic` taxonomy class: `claude` or `anthropic` bounded in the bare id, or `anthropic` as a namespace. */
function isClaudeClass(lower: string, bare: string): boolean {
	if (isBounded(bare, "claude") || isBounded(bare, "anthropic")) return true;
	return lower.split(namespaceSeparators).some((part) => part.length > 0 && isBounded(part, "anthropic"));
}

/** A token at the start of `value`, followed by the end or one of `- _ . :` or a digit. */
function isBounded(value: string, token: string): boolean {
	if (value === token) return true;
	if (!value.startsWith(token)) return false;
	return /[-_.:0-9]/.test(value.charAt(token.length));
}

/** The family whose name the id contains; two families of equal rank are ambiguous and select none. */
function parseFamily(bare: string): ClaudeFamily | undefined {
	const matching = families.filter((family) => bare.includes(family));
	const longest = Math.max(0, ...matching.map((family) => family.length));
	const ranked = matching.filter((family) => family.length === longest);
	return ranked.length === 1 ? ranked[0] : undefined;
}

function parseRevisionAfterPrefix(bare: string): Revision | undefined {
	const start = bare.indexOf(claudeIdPrefix);
	if (start === -1) return undefined;
	const tail = bare.slice(start + claudeIdPrefix.length);
	const digit = tail.search(/[0-9]/);
	return digit === -1 ? undefined : parseRevisionPrefix(tail.slice(digit));
}

/**
 * A leading revision of up to three components separated by `.` or by `-` followed by a digit. A component that runs
 * into a letter is a size token, and one above 255 (a date suffix such as `20250929`) ends the revision.
 */
function parseRevisionPrefix(value: string): Revision | undefined {
	const components: number[] = [];
	let index = 0;
	while (components.length < 3) {
		const digits = /^[0-9]+/.exec(value.slice(index))?.[0];
		const component = digits === undefined ? undefined : Number(digits);
		const nextCharacter = value.charAt(index + (digits?.length ?? 0));
		if (component === undefined || component > 255 || /[a-z]/i.test(nextCharacter)) break;
		components.push(component);
		index += digits?.length ?? 0;
		if (!/^[-.][0-9]/.test(value.slice(index, index + 2))) break;
		index++;
	}
	if (components.length === 0) return undefined;
	return [components[0] ?? 0, components[1] ?? 0, components[2] ?? 0];
}

function parseRevisionLiteral(literal: string): Revision {
	const [major, minor, patch] = literal.split(".").map(Number);
	return [major ?? 0, minor ?? 0, patch ?? 0];
}

function compareRevision(left: Revision, right: Revision): number {
	return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function ruleMatches(rule: TraitRule, identity: ClaudeIdentity): boolean {
	if ("modelId" in rule) return identity.bare === rule.modelId;
	if (!identity.family || !rule.families.includes(identity.family)) return false;
	if (rule.from === undefined && rule.below === undefined) return true;
	const { revision } = identity;
	if (!revision) return false;
	if (rule.from !== undefined && compareRevision(revision, parseRevisionLiteral(rule.from)) < 0) return false;
	return rule.below === undefined || compareRevision(revision, parseRevisionLiteral(rule.below)) < 0;
}

/**
 * The cascade, in the order the kdl classes and resolver defaults apply: a later rule overrides an earlier one. Bounds
 * are the kdl `revision` constraints; an upper bound is there because that line was verified, and a later generation
 * has to be re-verified before it inherits the trait.
 */
const traitRules: readonly TraitRule[] = [
	// Thinking mode: budget thinking up to Opus 4.5, which also takes an effort, then adaptive. Haiku is adaptive only
	// in 5.5, its first adaptive generation.
	{ families: ["opus", "sonnet", "fable", "mythos"], from: "4.6", traits: { thinkingMode: "adaptive" } },
	{ families: ["opus"], from: "4.5", below: "4.6", traits: { thinkingMode: "budget-effort" } },
	{
		families: ["haiku"],
		from: "5.5",
		below: "6",
		traits: { thinkingMode: "adaptive", acceptsDisabledThinking: true },
	},
	// `thinking.display`: adaptive Claude 4.7 and newer.
	{ families: ["opus"], from: "4.7", traits: { supportsThinkingDisplay: true } },
	{ families: ["sonnet", "fable", "mythos"], from: "5", traits: { supportsThinkingDisplay: true } },
	{ families: ["haiku"], from: "5.5", traits: { supportsThinkingDisplay: true } },
	// Signed thinking bound to the exact preceding conversation, and the `block_binding` control that handles a mismatch.
	{ families: ["fable", "mythos"], from: "5.1", traits: { hasThinkingPrefixBinding: true } },
	{ families: ["opus", "sonnet", "haiku"], from: "5.5", below: "6", traits: { hasThinkingPrefixBinding: true } },
	{ families: ["fable"], from: "5.1", traits: { supportsThinkingBindingControls: true } },
	{ families: ["sonnet"], from: "5.5", traits: { supportsThinkingBindingControls: true } },
	{ families: ["opus", "haiku"], from: "5.5", below: "6", traits: { supportsThinkingBindingControls: true } },
	// Sonnet 5.5 rejects `thinking: {type: "disabled"}`; `between_tools` is its lowest setting.
	{ families: ["sonnet"], from: "5.5", below: "6", traits: { supportsBetweenToolsThinking: true } },
	// Message threads on the Claude API: every line from 4.5, and the revision-less Mythos preview.
	{ families, from: "4.5", traits: { supportsMessageThreads: true } },
	{ modelId: "claude-mythos-preview", traits: { supportsMessageThreads: true } },
	// Sampling parameters are a 400 on adaptive Claude.
	{ families: ["opus"], from: "4.7", below: "10", traits: { supportsSamplingParams: false } },
	{ families: ["sonnet", "fable", "mythos"], from: "5", below: "10", traits: { supportsSamplingParams: false } },
	{ families: ["haiku"], from: "5.5", below: "10", traits: { supportsSamplingParams: false } },
	// Forced tool selection is a 400 on Fable, Mythos, Opus 5.5 and Sonnet 5.5; Haiku 5.5 accepts it.
	{ families: ["fable", "mythos"], traits: { supportsForcedToolChoice: false } },
	{ families: ["opus", "sonnet"], from: "5.5", below: "6", traits: { supportsForcedToolChoice: false } },
	// Mid-conversation system messages, their tool changes and turn scope.
	{ families: ["opus"], from: "4.8", traits: { supportsMidConversationSystem: true } },
	{ families: ["fable", "mythos"], from: "5", traits: { supportsMidConversationSystem: true } },
	{ families: ["sonnet", "haiku"], from: "5.5", traits: { supportsMidConversationSystem: true } },
	{
		families: ["opus"],
		from: "4.8",
		traits: { supportsMidConversationToolChanges: true, supportsTurnScopedSystem: true },
	},
	{
		families: ["fable", "mythos"],
		from: "5",
		traits: { supportsMidConversationToolChanges: true, supportsTurnScopedSystem: true },
	},
	{
		families: ["sonnet"],
		from: "5.5",
		traits: { supportsMidConversationToolChanges: true, supportsTurnScopedSystem: true },
	},
	{
		families: ["haiku"],
		from: "5.5",
		below: "6",
		traits: { supportsMidConversationToolChanges: true, supportsTurnScopedSystem: true },
	},
	// Per-message effort.
	{ families: ["opus"], from: "5", traits: { supportsPerMessageEffort: true } },
	{ families: ["fable", "mythos"], from: "5.1", traits: { supportsPerMessageEffort: true } },
	{ families: ["sonnet"], from: "5.5", traits: { supportsPerMessageEffort: true } },
	{ families: ["haiku"], from: "5.5", below: "6", traits: { supportsPerMessageEffort: true } },
	// Claude 3.5 Haiku OAuth requests omit the Claude Code instruction.
	{ families: ["haiku"], from: "3.5", below: "3.5.1", traits: { injectsClaudeCodeInstruction: false } },
];
