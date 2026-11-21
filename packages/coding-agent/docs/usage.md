# Use Pi in the terminal

Run `pi` from the folder you want to work in. Pi uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed Pi or chosen a model yet, follow the [Quickstart](quickstart.md).

Pi may ask whether you trust the working folder before loading its project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="Pi interactive mode showing a conversation, editor, and status information" width="750"></p>

The transcript shows your prompts, Pi's responses, tool calls, results, and errors. You write prompts and commands in the editor. The footer shows the current folder, session, model, context usage, and accumulated usage and cost.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

Press `Up Arrow` in an empty prompt to recall previous submissions, including those from earlier sessions in this project. Prompt history is stored separately for each working directory under the agent configuration directory, so switching projects does not mix their prompts.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal.

## Follow Pi's work

Pi shows each tool call and result while it works. Press `Ctrl+O` to expand or collapse tool output. Press `Ctrl+T` to show or hide thinking blocks.

The startup header lists the instructions and resources Pi loaded. Warnings start as a collapsed summary; click it to inspect or hide the details. The editor border indicates the current thinking level.

The footer's cost and cache-hit rate (`CH`) combine recorded usage from the main agent and every subagent across the entire session. The rate divides total cache-read tokens by total input, cache-read, and cache-write tokens. Context-window usage still describes the main agent's current context.

Failed provider attempts, including exhausted credits, usage limits, authentication errors, and capacity errors, stay visible in the transcript but are omitted from subsequent model requests, new summaries, and inherited subagent context. Ordinary tool failures, failed shell commands, and worker execution failures remain in model context so the agent can respond to their diagnostics.

Pi does not ask before every tool call. Review commands and changed files, and use a sandbox for untrusted or unattended work. See [Security](security.md).

## Review changed files

Run `/diff` to open or close the side panel. The panel needs at least 80 terminal columns and takes 40% of the width by default. In fullscreen mode, drag the vertical divider to resize it while the input dock stays full width. The chosen percentage is limited to 25–60% and saved across launches. Saved widths in columns are converted to a percentage when the panel is first shown. See [`sidePanel.width`](settings.md#terminal-and-display).

Tasks, Agents, the file index, and the diff each have their own scrolling area when visible. Put the pointer over the list or diff you want to scroll without moving the others. Click a file to jump to its diff. Use `Alt+PageUp` and `Alt+PageDown` to scroll the diff by a page. The next/previous file shortcuts are `Alt+Down`/`Alt+Up` on Windows and WSL, or `Ctrl+Alt+Down`/`Ctrl+Alt+Up` elsewhere. These shortcuts are configurable through the `app.sidePanel.*` actions.

The panel shows changes since the session started, falling back to the last commit if a starting snapshot cannot be captured. Each file has its own heading, so a binary file does not replace the diffs of later text files. Existing file-count and large-diff limits are reported in the panel.

## Change direction

You can send more input while Pi is working:

| What you want | Action |
|---|---|
| Adjust the current task | Type a message and press `Enter` |
| Add work after the current task | Type a message and press `Alt+Enter` |
| Return queued messages to the editor | Press `Alt+Up` |
| Stop the current task | Press `Escape` |

A message sent with `Enter` waits until the current response and its tool calls finish, then guides the next response. A follow-up sent with `Alt+Enter` waits until Pi finishes the current task. Aborting returns queued messages to the editor.

Windows Terminal reserves some Alt shortcuts. See [Terminal Setup](terminal-setup.md) for the Windows alternatives.

## Change the model or settings

Type `/` to search the available commands. The commands you will use most often are:

- `/model` selects a model. Press `Ctrl+L` to open the same selector.
- `/thinking [level]` or `/effort [level]` selects a reasoning level supported by the current model. Without a level, either command opens the selector; press `Shift+Tab` to cycle through supported levels.
- `/login` and `/logout` manage provider access.
- `/settings` changes common preferences.

Prompt templates, skills, and extensions can add more commands to the same menu. See [Choose a Model](models.md), [Configuration](configuration.md), or the complete [Slash Commands reference](slash-commands.md).

## Continue or start over

Pi saves sessions automatically unless session persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` shows its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` when you want to explore another approach without losing existing work. Use `/compact` to reduce the conversation history sent to the model. With an empty prompt and no autocomplete open, press `Down Arrow` to focus the agent list below the prompt; `/subagents` opens the separate worker session picker. See [Sessions and Context](sessions.md) for session workflows and [Subagents](subagents.md) for worker navigation.

After leaving Pi, run `pi --continue` from the same folder to resume its most recent session.

## Run a terminal command

Prefix a command with `!` to run it and include its output in the conversation:

```text
!git status
```

Use `!!` when you want to run a command without sending its output to the model.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last assistant response. Use `/export` to save the session as HTML or JSONL.

Use `/share` to upload the session and get a viewer link. By default, Radius authentication makes the artifact visible to your Radius organization; otherwise, Pi creates a private GitHub gist through the GitHub CLI. The [`sessionShareDestination`](settings.md#sessions-and-context) setting can force either destination. Review the session first because it can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Fullscreen mode, the default, keeps the editor and status area fixed while the transcript scrolls within the terminal window. Regular mode uses the terminal's normal scrollback. Choose a mode through `/settings` or `--tui-mode`.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) for platform-specific configuration and [Keybindings](keybindings.md) for every configurable shortcut. Run `/hotkeys` to inspect the shortcuts active in your current session.

## Collect diagnostic information

When troubleshooting terminal rendering or conversation state, run `/debug`. Pi writes the rendered terminal lines and current session messages to `pi-debug.log` in your [agent directory](configuration.md#agent-directory).

Review this file before sharing it. It can contain prompts, model responses, tool output, file contents, and terminal data.
