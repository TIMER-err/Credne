# Credne 0.1.1

## Added

- Inline worker navigation with live transcripts and follow-up messages to individual workers.
- Account and pool management through `/accounts`, with subscription quota bars and per-account session cost estimates.
- `/effort` as an alias for `/thinking`, including a saved startup default.
- Persistent per-project prompt history and remembered model and account selections.
- A local installer that builds, stages, verifies, and backs up the previous Credne package before replacement.

## Changed

- Planning uses a flat ordered task list with generated task IDs, reusable worker assignments, and on-demand planning guidance.
- Session costs and cache-hit rates include the main agent and workers and survive session resume.
- Failed exchanges are retained in the transcript but excluded from subsequent model context.
- Startup update checks and release links point to Credne rather than upstream Pi.

## Fixed

- Worker notifications reach active agents before their next model request.
- Matching workers reuse their shared OpenAI prompt-cache routing key.
- The diff panel supports consecutive per-file sections, independent scrolling, and a resizable divider.
- Agent-list focus, hover behavior, warning expansion, and empty-editor placeholder handling are improved.

## Migration

Saved plans using `parentId`, `dependsOn`, or `component` must be recreated. Use `order` to sequence tasks. The separate `review_task` tool and singular `/account` command have been removed. Use `/accounts` instead.

## Windows x64 package

The attached `credne-0.1.1-windows-x64.tar.gz` contains the built CLI, broker, assets, and runtime dependencies. It requires Node.js 22.19 or newer on Windows x64. Extract it into a new directory and run:

```shell
node dist/bundle/cli.js --version --offline
node dist/bundle/cli.js
```

Keep your existing `.credne` configuration directory to retain accounts and settings. This release is distributed through GitHub, not npm.
