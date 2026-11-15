# Planning tools

The main agent owns the plan and assigns individual tasks to background subagents. Planning is available by default for implementation work that benefits from decomposition. A small edit can still be completed directly.

`create_plan` records the objective and tasks without starting workers. Each task describes an outcome, its place in the execution order, its module, the files it owns, and its completion criteria. The main agent chooses which ready tasks to run through a separate `assign_tasks` call.

```json
{
  "objective": "Add a searchable product catalog",
  "tasks": [
    {
      "id": "api",
      "order": 1,
      "name": "Product search API",
      "description": "Implement GET /products?q= returning {id, name, price} records. Keep this response contract consistent with the UI task.",
      "component": "backend",
      "paths": ["src/api/products", "test/api/products"],
      "dependsOn": [],
      "acceptance": ["Search filters products by name", "API tests pass"]
    },
    {
      "id": "ui",
      "order": 1,
      "name": "Product search interface",
      "description": "Build the search interface against GET /products?q= and the agreed {id, name, price} response contract.",
      "component": "frontend",
      "paths": ["src/ui/products", "test/ui/products"],
      "dependsOn": [],
      "acceptance": ["Search renders results and empty states", "UI tests pass"]
    },
    {
      "id": "integration",
      "order": 2,
      "name": "Verify the complete search flow",
      "description": "Verify the interface against the implemented API and report any contract mismatch.",
      "component": "integration",
      "paths": ["test/integration/products"],
      "dependsOn": ["api", "ui"],
      "acceptance": ["A search returns the same products through the API and UI"]
    }
  ]
}
```

The main agent calls `assign_tasks` with the plan revision and `taskIds: ["api", "ui"]`. Both tasks have order 1 and can run simultaneously. With `background: true`, the default, assignment returns immediately so the main agent can continue reasoning or revise other tasks. With `background: false`, the call waits for all assigned workers and returns their results and usage. At most four workers run at once in either mode.

Tasks with the same order may run together when their dependencies are satisfied, they own different components, and their declared paths do not overlap. The main agent assesses parallel execution when assigning work; there is no separate independence flag. Put a task alone in an order phase when it must run exclusively. All leaf tasks in a lower order must be completed before later orders run. Explicit `dependsOn` references add requirements within an order or reference a completed group.

Paths are literal relative files or directories, without glob patterns. Ownership prevents conflicting assignments through this planner. Workers share the working directory, so ownership is a coordination rule, not a filesystem sandbox. The main agent must also avoid editing files assigned to running workers.

## Main agent tools

* `create_plan({objective, tasks})` records a plan without starting workers.
* `get_plan({taskId?})` returns the current plan and ready task IDs. Select a task ID to inspect an individual result.
* `revise_plan({revision, reason, tasks})` replaces the active task definitions. Use it to add tasks, add subtasks with `parentId`, revise contracts, or supersede obsolete work. Supply the complete desired active task list.
* `checkpoint_context({name, description?})` marks a meaningful stage the main agent completed itself, such as documentation reviewed or design agreed. It records a context boundary without changing a planning task's state.
* `get_subagent_context({})` lists numbered context checkpoints with their kinds and previews. Task results and review decisions become checkpoints automatically.
* `assign_tasks({revision, taskIds, background?, model?, reasoningEffort?, turn?})` starts individual tasks and returns a worker ID for each task. `background` defaults to `true`; `false` waits for results. `model` is an exact `provider/id` selection. `turn` is 0 for fresh context, -1 for latest safe history, or a positive checkpoint number from `get_subagent_context`. Controls apply to the selected batch; use separate calls for different controls.
* `review_task({revision, taskId, verdict, evidence})` optionally reviews an already completed result. `accept` records evidence; `reject` reopens affected work. This tool is never required to complete a task or release its dependents.
* `cancel_tasks({revision, taskIds})` stops selected workers and waits for them to exit before their tasks can be assigned again.

The main agent can use `list_agents`, `send_agent_message`, `interrupt_agent`, `continue_agent`, and `steer_agent` with the returned worker IDs. Workers can send information to `"main"` or another worker ID. Interrupting retains the worker conversation; continuing rechecks task readiness and file ownership. Continuing a completed task reopens it and affected completed work, and is rejected if affected work is running. Superseded, changed, or reassigned tasks cannot be resumed through an old worker ID. See [Subagent communication](subagents.md#communication-and-control).

```json
{
  "revision": 1,
  "taskIds": ["api", "ui"],
  "background": true,
  "turn": -1,
  "reasoningEffort": "high"
}
```

An assignment response includes a mapping such as `[{"taskId":"api","workerId":"..."},{"taskId":"ui","workerId":"..."}]`. The plan remains separate from its worker conversations.

Planned workers use the existing `worker` profile, including its original instructions and description. User profiles override the bundled profile under the same discovery rules as general subagents. The assignment follows those instructions as plain text: the plan objective, active task names in execution order, assigned task name, description, and numbered acceptance goals. The planner retains paths, dependencies, components, and ordering for coordination; it does not append that metadata or other task descriptions to the worker's assignment. Include any implementation context the worker needs in its description. Inherited conversation history can still contain earlier full plan details when selected through `turn`.

Foreground assignment waits for the first run of each assigned worker; later continuations remain separate runs. Aborting a foreground call cancels its assigned workers and waits for them to stop. An already aborted call starts no workers. Both modes record completion checkpoints and complete successful tasks directly. Background results and later continuations can wake an idle main agent; initial foreground results do not start an extra parent turn.

Use the latest revision returned by the tools. A stale revision is rejected rather than overwriting a worker result that arrived in the meantime.

After reading the architecture documentation, the main agent can call `checkpoint_context({name: "Documentation reviewed", description: "Routing and storage contracts identified"})`. On a subsequent call, `get_subagent_context` returns that milestone alongside conversation boundaries, worker reports, messages, and reviews. A worker can inherit history through its checkpoint number. Ordinary tool calls do not create checkpoints. This selects conversation history, not an earlier version of the working files. See [Context and model controls](subagents.md#context-and-model-controls) for safe tool batch boundaries.

## Completion and optional review

A successful worker result moves directly from `running` to `done` and satisfies its dependents. There is no mandatory main agent code review or acceptance step. Failed and interrupted runs remain unfinished. Ready tasks still need an explicit assignment.

The main agent can choose to inspect a result, delegate a review, or call `review_task` when useful. An optional rejection reopens the task and affected completed work; it cannot invalidate work that is currently running. Recorded review evidence is not an automatically certified test result.

Revisions preserve unchanged work and invalidate affected completed results. Removed tasks remain in the history as superseded. A running task and the prerequisites it relies on cannot be changed until it stops. Unrelated work can be revised while workers run.

`parentId` groups subtasks under a larger outcome. Groups complete automatically once their children and prerequisites are done, including nested groups. They are not assigned to another worker. Order barriers apply to executable leaf tasks.

## Sessions and models

The current plan is stored in session entries and restored from the selected conversation branch. Interrupted workers become failed tasks on recovery and are never restarted automatically. Changing sessions or navigating the conversation tree stops active workers.

Workers use the `worker` profile's model when configured, otherwise they inherit the main agent's model. `assign_tasks.model` or `--planning-model provider/id` overrides that selection. The main agent controls `reasoningEffort` per assignment. Broker workers use the parent's serving account by default; an explicit different provider or account overrides this choice. Invalid model selections or unsupported explicit reasoning levels fail before any task starts. Worker processes disable planning and delegation tools while retaining peer and main agent messaging.

All workers share one queue with at most four active runs, including general subagents and continuations. The planner additionally limits active assignments to four and protects their paths while a run waits in the shared queue.

Credne shows a compact text widget above the input, for example `Tasks: 1 completed, 2 running, revision 4`. Detailed task states and worker IDs appear in `get_plan` results. Worker messages and completions appear in the conversation, and `/subagents` lists workers. There is no graphical task board or dedicated task panel.

The execution code comes from [Pi's official subagent example](../examples/extensions/subagent/README.md) and is shared with the built in subagent tool. The planner adds task ordering, dependency validation, concurrent ownership checks, revisions, automatic completion, and optional review without installing another runtime package. The example folder remains unchanged.
