# Credne 0.1.3

- After a provider error such as “no credits remaining,” switch to a funded account or top up the current one, then run `/continue`. Credne retries the pending turn with its original prompt and attachments.
- Switching models or accounts keeps your chosen reasoning effort unless you configured an explicit level for the destination. A model with fewer supported levels uses a compatible level without overwriting your preference.

## Install on Windows x64

Install Node.js 22.19 or newer, then run these commands from any directory. The package includes the account broker and runtime dependencies.

```shell
npm.cmd install --global --ignore-scripts https://github.com/neilhuang007/Credne/releases/download/0.1.3/credne-0.1.3-windows-x64.tgz
credne.cmd --version
credne.cmd
```

`credne.cmd --version` should print `0.1.3`. Install [Git for Windows](https://git-scm.com/download/win) if you need Bash for shell commands. Existing accounts and settings are kept. For a first install, use `/accounts add` inside Credne.

On macOS or Linux, follow the [source installation instructions for 0.1.3](https://github.com/neilhuang007/Credne/blob/0.1.3/README.md#credne) to build the broker for your platform.
