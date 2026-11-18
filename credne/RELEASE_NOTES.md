# Credne 0.1.2

ChatGPT accounts can start and resume conversations with the planning tools enabled. In 0.1.1, Codex rejected the tool declarations for `assign_tasks` and `cancel_tasks` because they contained the unsupported JSON Schema keyword `uniqueItems`. Credne now checks for duplicate task IDs locally before assigning or cancelling workers.

## Windows x64 package

Extract `credne-0.1.2-windows-x64.tar.gz` into a new directory. The package includes the CLI, broker, assets, and runtime dependencies. It requires Node.js 22.19 or newer. From the extracted package directory, run:

```shell
node dist/bundle/cli.js --version --offline
node dist/bundle/cli.js
```

Existing Credne accounts and settings carry over.
