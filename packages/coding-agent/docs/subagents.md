# Subagents

The built in `subagent` tool delegates work to isolated child processes. It includes four agent definitions: `explorer`, `worker`, `critic`, and `crazy`. An installed extension that registers `subagent` replaces the built in extension.

Bundled definitions have the lowest priority. User definitions in the agent configuration directory override matching bundled names. With `agentScope: "both"`, project definitions override user definitions too. `agentScope: "project"` loads bundled and project definitions; the default `"user"` loads bundled and user definitions.

The bundled profiles set no model, so each agent inherits the main agent's selected model unless the main agent overrides it. Selection instructions call for:

- `explorer`: a cheap, fast model at `medium` or `high` effort to search and return information, rather than reason about solutions.
- `worker`: a capable middle-tier model, such as Sol or Opus 5.5, at `xhigh` effort to reason through implementation within the assigned scope.
- `crazy`: an expensive, highly capable model at `xhigh` or `max` effort. Supply the relevant context, references, constraints, and a focused question so it can concentrate on the hard problem.

Use `search_models` to select an available model that fits the role. These are selection instructions, not hardcoded provider routes.

## Context and model controls

Single calls and individual items in `tasks` or `chain` accept these controls. An item overrides the corresponding top level value.

| Parameter | Meaning |
| :--- | :--- |
| `turn: 0` | Start fresh. This is the default. |
| `turn: -1` | Copy the latest safe conversation history from the current branch. |
| `turn: 3` | Copy history through checkpoint 3 from `get_subagent_context`. |
| `model` | Model ID or unique name on the current account, such as `luna`. An explicit `provider/model` ID selects that route. Overrides the profile model. |
| `reasoningEffort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, where supported by the selected model. |

`get_subagent_context({})` lists chronological checkpoints on the current branch as `{turn, kind, preview}`. They include user messages, completed main agent responses, worker results, agent messages, completed local tasks, and named steps. The main agent marks a stage it completed itself with `checkpoint_context({name, description?})`, for example `name: "Documentation reviewed"`. Planning results and successful `task_update` completions create checkpoints automatically. Ordinary tool calls do not create checkpoints; selecting individual tool calls is not currently exposed.

Checkpoint numbers remain stable while that branch grows. A snapshot contains the history through the selected boundary, including the returned worker report rather than its entire private conversation. Selecting earlier context does not restore earlier working files. After switching branches, list checkpoints again.

Checkpoints wait for every result in their tool batch before becoming selectable. Several milestones in one batch share its completed boundary. The latest safe selection stops before an unfinished batch. Snapshots are captured when the task is submitted, including tasks that wait in the queue. Future main agent messages are delivered only when explicitly sent. Resuming a worker retains its own accumulated conversation.

For example, a context listing might contain:

```json
{
  "turns": [
    {"turn": 1, "kind": "user", "preview": "Build product search"},
    {"turn": 2, "kind": "step", "preview": "Documentation reviewed: Routing and storage contracts identified"},
    {"turn": 3, "kind": "task_result", "preview": "Task api, worker ...: completed."},
    {"turn": 4, "kind": "task_result", "preview": "Task docs completed: Documented the product search contract"}
  ]
}
```

`turn: 2` includes the documentation milestone; `turn: 4` also includes the API result and the documentation task completed by the main agent. A successful planning worker completes its task immediately. Later orders become ready when all earlier tasks are done. The result checkpoint records what the worker reported.

Omitting reasoning effort inherits the main agent's setting, adjusted to the selected model's supported levels. An explicitly unsupported effort is rejected. By default, broker workers use the account serving the parent. Selecting another model on the same pool still pins that account. An explicit different provider or account selects that route instead. Unknown parent affinity or a model unavailable on the parent account produces an error rather than silently choosing another account.

```json
{
  "agent": "worker",
  "task": "Implement the agreed API contract in src/api",
  "background": true,
  "turn": -1,
  "model": "sol",
  "reasoningEffort": "xhigh"
}
```

The model value above resolves Sol on the current account automatically. No account name is required.

## Finding models

Call `search_models` when choosing a subagent model. It searches the same configured chat-model scope used by dispatch: the current serving account for a pool, or the pinned account or provider otherwise. Discovery is on demand; model catalogs are not added to the system prompt or refreshed through per-turn hooks.

`search_models({})` returns a compact, cost-ranked shortlist of five models. Each compact model has an exact `provider/model` `id`, `reasoningEfforts`, `contextWindow`, and `cost` with `input`, `output`, and `cacheRead` rates. Costs are USD per million tokens. A zero input and output cost sorts after known prices because zero may mean unknown, not free. Cost is only a price signal, not a capability guarantee; prefer economical models for bounded work, then judge suitability from the task.

Use `detail: "full"` when you need the existing metadata such as display name, input types, maximum output tokens, or full cost tiers. Full metadata is also retained in the tool result's `details` in either mode. Search matches IDs and display names case-insensitively. Specify `sort: "name"` for alphabetical order or `sort: "cost"` for price order. `limit` defaults to five and can be increased up to 100; pass `nextOffset` as `offset` to fetch another page. For example:

```json
{"query": "luna", "detail": "full"}
```

Reuse a result while the parent model and serving account remain unchanged. Refresh discovery after a model/account change or a dispatch failure. For dispatch on the same account, pass the bare `modelId` portion of the exact result ID; do not pass its provider prefix, which can pin a pool result to an account that no longer serves the parent. To intentionally change routes, search with an explicit `provider` and pass a returned `provider/model` ID. Unknown pool affinity fails closed instead of silently selecting another account. The same selection rules apply to `assign_tasks`.

## Background work

Set `background: true` when the main agent can continue without the result. Set `background: false` to wait for the results in the tool call. The general `subagent` tool defaults to `false`; planned `assign_tasks` calls default to `true`. Both modes use the same worker queue and return worker IDs that can be used for later communication and continuation.

```json
{
  "agent": "explorer",
  "task": "Find the routing module and describe its contracts",
  "background": true
}
```

For parallel tasks:

```json
{
  "tasks": [
    {"agent": "explorer", "task": "Inspect the routing module"},
    {"agent": "critic", "task": "Review the database changes"}
  ],
  "background": true
}
```

The call returns one worker ID per task immediately. Up to four runs are active across general subagents, planning workers, and continuations combined; remaining runs wait in submission order. Each background completion delivers the worker ID, result text, and usage as a follow up message. An idle main agent starts a turn to handle it. Background mode supports single and parallel calls; chains remain foreground operations. Foreground results also include worker IDs for later continuation.

`/subagents` opens the session picker for general and planning workers in the terminal UI (Enter shows the chosen session in the main view), or lists them in non-interactive modes. `/subagents cancel <id>` stops one worker permanently, and `/subagents cancel all` closes all workers. Active runs retain their slots until interruption settles. Queued runs that are cancelled never start. Session changes and shutdown stop child processes and suppress late notifications. Worker identities and conversations belong to the running parent session and are not restored after a restart.

## Communication and control

The main agent and workers can call `list_agents({})` and `send_agent_message({to, message})`. Use a worker ID as `to`, or `"main"` from a worker. The coordinator labels messages with the actual sending worker. Messages to a running main agent or peer enter its steering queue and arrive before the next model request, after the current tool batch finishes. A worker-to-main acknowledgement of `queued` means the coordinator accepted the message, not that the main agent has already read it. An idle main agent starts a turn to receive it. Messages to completed peers start a queued continuation when the assignment permits it. Interrupted workers retain messages until explicitly continued.

Only the main agent has these controls:

* `assign_task({revision, taskId, workerId, background?})` queues a ready planning task for an existing worker. A busy worker finishes its current run before reading the assignment notification. The queue preserves assignment order. `list_agents` reports `assignmentCount` separately from ordinary messages in `inboxCount`.
* `interrupt_agent({agentId})` stops the current run and retains its conversation and inbox.
* `continue_agent({agentId, prompt})` queues another run of that worker with the supplied instruction and its retained context.
* `steer_agent({agentId, prompt})` sends an instruction to a running worker at Pi's next steering boundary. It does not immediately stop a shell command.

For example, the API worker can send the UI worker `"The endpoint returns {items, nextCursor}; use nextCursor for pagination"`. The main agent can interrupt either worker, inspect the partial changes, and continue it with a correction. Messages do not grant permission to edit another worker's files. Planning workers must still satisfy the planner's execution order and worker limit when continued. Continuing completed work reopens affected results and is rejected if affected work is running.

If a worker process crashes or must be forcibly killed because it ignores interruption, that conversation cannot continue in the current process. Its result reports the failure. Inspect partial changes and assign the task to a new worker.

## Display and prompt caching

Below the prompt, a compact tree shows `main` and its workers. Worker names are bold, idle workers have an open circle, and running workers use the standard animated spinner. The right column shows status, model, agent type, reasoning effort, elapsed working time, token usage, cache hit rates, and cost, separated by ` • `. While the prompt has focus, at most three workers are shown, prioritizing running workers. A horizontally centered `Press down for more` hint shows how many additional workers are hidden and follows the configured `app.subagents.select` key. Short terminals show fewer rows so the prompt stays visible. Focusing the inline list expands it, and arrow navigation scrolls through every worker. `/subagents` opens the separate session picker, which also lists every worker. Narrow terminals truncate rows instead of wrapping them.

With an empty prompt and no autocomplete open, press **Down Arrow** to focus the inline agent list, initially on `main`. Use **Up/Down** to move through its rows. Press **Enter** on a worker to switch the main view to its retained conversation, and on `main` to switch back. **Up Arrow** from `main` or **Escape** collapses the list and returns focus to the prompt; typing also collapses the list and returns to the prompt. Hovering highlights either a worker or `main`. Click a worker to open it, or click `main` to return to the main session.

While a worker is shown, the chat area holds its transcript, the prompt takes the worker's color, its top border ends in an `@name` badge, and the empty prompt reads `Message @name…`. Text submitted from the prompt goes to that worker as a follow-up; sending to an interrupted worker explicitly resumes it. Slash commands still run in the main session. **Escape** in the prompt switches back to the main session. The transcript updates as worker messages arrive, and the main session keeps running and recording output while a worker is shown. When the inline list has focus, its selection arrow replaces the row's status icon; it does not add a column. Normal prompt cursor movement is unchanged when the editor contains text. Remap the shortcut with `app.subagents.select` in `keybindings.json`. Run `/subagents` when you want the explicit session picker.

Ordinary tool calls remain in the conversation. Foreground subagents retain their expandable results, and background completions and messages appear as labeled conversation messages.

Workers retain their subprocess and session between prompts. Continuations preserve the worker's model, reasoning effort, account, and conversation. Each worker receives a distinct session identity so provider continuation state cannot collide with its parent or peers. [Prompt caching](#prompt-caching) describes how matching workers share cached prefixes.

Every subagent uses its own agent file body as its system prompt, followed by the project instruction files and the working directory last. It receives neither the main agent's system prompt nor its documentation pointer or skills list. Agent prompt wording is preserved.

A fresh worker's initial user message contains only its task. With a selected conversation cutoff, its first text block contains a stripped reference conversation and its second block contains the task. Stripping removes system messages, thinking, failed model responses, failed tool call/result pairs, and failed worker notifications. It preserves user messages and successful assistant text, retains successful tool names and bounded arguments, and keeps the first 200 characters of each retained tool output with the number of omitted characters. The wrapper is `<parent_conversation note="The main agent's conversation, given for reference. Tool outputs are shortened.">`. The same history produces identical text.

New planned workers use the bundled `worker` system prompt. Assignments to existing workers preserve their original profile, tools, model, and conversation. Each assignment notification contains the objective, task details, and completed results from earlier orders. The full plan is included on its first delivery to a worker and again when its definition changes. A selected reference conversation precedes a new worker's assignment. Later assignments and continuations append prompts to the retained conversation.

Workers share the working directory with the main agent. Define task scope in descriptions and coordinate edits when delegating implementation. Use the [planning tools](planning.md) when work needs ordered phases or revisions. The general subagent tool reports results without changing planning task states.

## Prompt caching

Cache reuse requires an identical request prefix. Anthropic processes tools, system, and messages in that order. Subagents share prefixes with matching siblings. Reusing the main agent's cache is outside this design because each subagent needs its own system prompt and tools.

For example, three workers with the same profile, model, account, effort, project context, and conversation cutoff share their tools, system prompt, and stripped reference conversation. The first worker warms that prefix while beginning its task. Its siblings wait for provider response evidence, then submit their different tasks after the shared prefix.

* **Tools.** Each worker declares its agent's tools plus `list_agents` and `send_agent_message`, sorted by name. An unrestricted agent gets `read`, `bash`, `edit`, `write`, and `tool_search`. Subagents never declare delegation, planning, or main agent control tools. MCP schemas are discovered through `tool_search` rather than preloaded.
* **Stable content first.** Agent instructions remain in the system prompt. The stripped conversation, when present, precedes the task. Worker IDs, session IDs, and timestamps do not enter this shared content.
* **Cache key.** OpenAI requests use a deterministic `prompt_cache_key` derived from the provider, model, tools, system prompt, and reasoning configuration. Different tasks and conversation cutoffs keep the same routing key so they can reuse their common system prefix. The provider still matches the actual prefix tokens before reusing any cached work. Profile names alone do not split identical prefixes. Parent and worker session identities do not determine this key; transport sessions remain separate.
* **Breakpoints.** Anthropic requests mark the end of the system prompt and the end of the stripped conversation. The existing conversation tail marker supports the worker's own later turns. Marker placement stays within the provider's four breakpoint limit.
* **One initial writer.** Admission happens after each child builds its actual request. Matching siblings wait until the first provider response proves processing has reached response generation. The system prefix and each reference-conversation cutoff have separate warmup records: a new cutoff can reuse the system prefix while its own siblings wait for that longer prefix. A local stream startup event alone does not release them. If the leader fails without that evidence, one waiting sibling takes its place. Cancellation releases waiting work.

The first productive request performs the sibling warmup. This feature adds no speculative requests or recurring paid keepalive calls. The harness's separately configured cache warming remains unchanged. A separate Claude `max_tokens: 0` request would require nonstreaming transport and cannot preserve every supported thinking configuration; issuing it only when tasks arrive would add a request and delay useful work.

Native Anthropic requests through the account broker retain the worker's explicit markers. Workers select the broker's explicit caching mode so it does not add conflicting markers; native API routes consume that broker option before forwarding upstream. Claude subscription routes still apply the broker's Claude Code compatibility transformation. It relocates caller system content after the first user message and fingerprints that message in a billing header. Fresh tasks can therefore differ before the shared agent prompt reaches the upstream model. Inherited siblings can share the reference conversation, but the relocated agent prompt follows their different tasks. The harness does not change this subscription behavior, so exact native layout and sibling reuse are not guaranteed on that route.

Explicit sibling admission covers Anthropic Messages and OpenAI request families, including Codex, Azure, and compatible Chat Completions. Other provider adapters keep their existing caching behavior and benefit from the stable prompt layout, without this provider readiness gate.

Two explorers with the same instructions, tools, model, account, and effort can therefore share their system cache even when their tasks or selected checkpoints differ. The same applies to workers. An explorer and worker whose instructions differ cannot reuse the project context that follows that difference: caching requires a matching beginning, not matching text anywhere in the request. Sharing those later sections would require changing prompt order, which this implementation does not do.

Cache entries live at the provider, not in a local store of agent answers. Different pinned accounts do not share this cache, and pool routing can reduce reuse if requests land on different accounts. Provider cache lifetime, minimum prefix size, account scope, and capacity still apply. Short prefixes may report no cache activity even with valid markers. Changing tools or prompts changes their cache identity. The harness preserves the configured cache lifetime and does not pad or rewrite prompts to reach a token threshold. Provider usage is the evidence of a hit, rather than the existence of a key or marker.

### Cache hit rate

Every usage line with prompt tokens shows `CH`, the share read from the cache: `cacheRead / (input + cacheRead + cacheWrite)`. `first` is the same share for the worker's first request with reported prompt usage. It helps distinguish sibling reuse from reuse of the worker's own later conversation. Zero prompt tokens yield a zero rate. Totals divide the summed token counts, rather than averaging percentages.

```text
3 turns ↑1.2k ↓850 R58k W2.1k CH94.6% (first 96.2%) $0.0412 ctx:21k provider/model-id
```

Results carry both values as `usage.cacheHitRate` and `usage.firstCacheHitRate`. The details of a `subagent` tool result carry the sum over its workers as `usage`, without a first request share.

Usage includes configured cache refreshes that finish during the active run. Those refreshes add tokens and cost without adding task turns or changing the first request rate. A completed result is a snapshot of that run. Later idle refreshes do not rewrite the completed result. The parent session also records cumulative worker usage separately from model context, including idle refreshes, so the footer below the prompt combines the main agent and all workers across the entire session. Its price is the total recorded cost, and its `CH` is the weighted rate from all recorded input, cache-read, and cache-write tokens. Cumulative worker records replace earlier records for the same worker rather than adding them twice, and survive reopening the parent session.

See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## Implementation source

The built in extension adapts the repository's [official subagent example](../examples/extensions/subagent/README.md), leaving the example folder unchanged. Planning and general subagents share the child process runner under `src/extensions/subagent/`.

The queue design was informed by [pi-fast-subagent's background job manager at commit 559cc175](https://github.com/tuansondinh/pi-fast-subagent/blob/559cc175447b25d1a162cf436875f0c60ac569be/background-job-manager.ts). The coordinator reuses the queue and Pi's RPC commands for retained subprocess sessions, interruption, steering, and continuation.
