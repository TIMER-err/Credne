# Slash commands

Type `/` in Pi's terminal editor to search the commands available in the current session. This page lists the built-in commands in the current Pi release.

Extensions, prompt templates, and skills can add commands. The command menu in Pi is therefore the exact reference for the resources loaded in your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/effort [level]` | Set the reasoning effort level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |
| `/accounts [subcommand]` | Browse accounts and pools, view live quotas and session estimates, or run status/list/switch/default/add/remove/enable/disable/reset ([Multiple Accounts](accounts.md)) |
| `/models [account]` | Choose a model on a broker account or pool |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Resume another session |
| `/continue` | Continue the last interrupted or failed turn without sending a new prompt |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import a JSONL session, preserving its ID and working directory |

Use `/continue` after interrupting a turn or after a provider failure, such as running out of credits. You can switch accounts or models first. The command uses the original prompt, including attachments, and keeps completed tool results in context. It does not restart a completed turn.

When you reopen an unfinished session with `/resume`, `-r`, or `-c`, you can continue the turn or stop and give new instructions. Press Escape to close the menu without deciding, for example to switch accounts first. A new prompt supplied at startup skips this menu. Reopening uses the recorded system prompt and tool loadout; system prompts that extensions force for a single run are not saved.

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the Pi developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future Pi processes |
| `/mcp` | Manage MCP servers: sign in, reconnect, enable or disable, and change exposure |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit Pi |

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.
