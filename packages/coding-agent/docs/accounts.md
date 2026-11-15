# Multiple Accounts

The built-in `accounts` extension connects several accounts per provider, for example two Claude subscriptions, a Claude API key and a ChatGPT subscription. Each session chooses which account it uses, and two terminals can use two different accounts at the same time. Credentials are held by a separate shared process, the account broker (`credne-broker`), which embeds [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Pi keeps sessions, prompts, tools and the agent loop. The broker design is described in `broker/README.md` in the repository.

## Setup

Build the broker once and put it in Pi's bin directory or on `PATH`:

```bash
cd broker && go build -o ~/.pi/agent/bin/credne-broker ./cmd/credne-broker
```

Pi starts the broker on demand, and every Pi process shares it. The broker stops after 30 minutes without requests and starts again on the next one. Set `PI_ACCOUNTS_BROKER` to use a binary elsewhere.

With no accounts configured, the extension registers no providers and does nothing. Add an account with `/account add`.

## Adding accounts

Run `/account add` and choose `Claude account` or `ChatGPT account`. The next menu lists the available login methods. Choose by how you pay for the models:

| Account | Way | What you do |
| --- | --- | --- |
| Claude | `Subscription (Pro, Max, Team sign-in)` | Sign in with your claude.ai account in the browser. |
| Claude | `API credits (monthly credits of Max, Ultra, Team plans, Claude Console sign-in)` | Name the account, then sign in to a Claude Console organization in the browser. Usage draws on that organization's API credits. |
| Claude | `API key (Anthropic Console key)` | Name the account, then paste an Anthropic API key. |
| ChatGPT | Subscription | Sign in with your ChatGPT account in the browser. |
| ChatGPT | `API key (OpenAI API credits)` | Name the account, then paste an OpenAI API key. Requests use the official OpenAI API with that project's API billing. |

Escape in either menu returns to the first menu. `/account add claude` and `/account add chatgpt` open their respective menus. Use `/account add openai-api-key` for an OpenAI API key, `/account add codex` for a ChatGPT subscription, or `/account add claude-subscription`, `claude-api-credits`, or `claude-api-key` for a Claude method.

OpenAI API keys are registered as `openai-api` accounts with kind `api-key`. They use the official OpenAI API and never authenticate through Codex. Their family pool is `pool:openai`; ChatGPT subscription accounts stay in `pool:codex`.

The same account cannot be added twice the same way. The broker rejects a second account with the same API key (including keys in `config.yaml`) or the same name, and an API-credit sign-in to a Console organization that is already added; the new `ant` sign-in is then signed out. Signing in again to a subscription that is already added renews its sign-in and reports that no account was added. Adding the same person in two different ways, for example a subscription and API credits, is allowed: they are separate accounts with separate limits.

For browser sign-in, Pi opens the page and also shows the link, so you can open it yourself. The broker normally receives the redirect automatically. If the browser shows an error after sign-in, copy the full redirect URL from the address bar and paste it into the prompt that Pi shows. Sign-in times out after five minutes.

The API-key prompt shows the key while you type, because extension dialogs have no masked input. The broker checks the key by listing its models before it stores the account, so an invalid key is rejected and nothing is saved.

The first account you add also becomes the default for new sessions, unless a default model is already configured. The default is the combined pool `pool:all`, described below.

## Accounts and providers

Each account appears as its own provider named `acct:<id>`. For example, `--model acct:claude-1a2b3c4d-you@example.com/claude-sonnet-4-5` starts a session on one account. Accounts also appear in `/model`, where choosing one saves it as the default for new sessions, as any other model does.

The accounts list shows each account with its state and model count:

```
Claude · you@example.com (Max)     ready           12 models
Claude · work key (API key)        cooling down until 14:05   12 models
ChatGPT Codex · you@example.com (Plus)   disabled   7 models
```

Each account name shows its family (Claude or ChatGPT Codex), its label or email, and its plan or kind. The state line is one of `ready`, `cooling down until ...`, `quota exceeded`, `unavailable`, `error`, or `disabled`.

## Pools

A pool is a provider that spreads requests over several accounts. The broker chooses which account serves each request among the enabled accounts that offer the requested model. There is one pool per model family and one combined pool:

| Pool | Provider | Contents |
| --- | --- | --- |
| All accounts | `pool:all` | Every enabled account, of any family. This is the default for new sessions after the first account is added. |
| Claude | `pool:claude` | Enabled Claude subscriptions, Claude API-credit accounts and Claude API keys. |
| ChatGPT Codex | `pool:codex` | Enabled ChatGPT subscriptions. |
| OpenAI API | `pool:openai` | Enabled OpenAI API key accounts. |

A pool exists as soon as one enabled account belongs to its family, so `pool:claude` is listed even with a single Claude account. Pool models are the union of the models of its accounts. When a model is listed by more than one account, a request for it can be served by any of them.

A pool keeps a conversation on one account while that account is usable, so provider-side caches and reasoning state stay valid. If the account hits a limit, the broker moves the next request to another account in the pool. The footer shows which account served the last request (see below).

## Pinned accounts

A session on `acct:<id>` is pinned to one account. Every request uses that account. When it is rate-limited, out of quota or rejected, Pi reports the error with the account name and the provider's retry time, and it never moves the session to another account. Use a pool when you want failover, and a pinned account when you need a specific account.

## Commands

| Command | Effect |
| --- | --- |
| `/accounts` | Open the account list. Choose an account to use it in this session, choose a model, enable or disable it, clear its cooldown, or remove it. The list also has `+ Add account` and `Restart broker`. |
| `/account` or `/account status` | Show whether this session uses a pinned account or a pool, and which provider and model it uses. |
| `/account list` | Same as `/accounts`. |
| `/account switch [account]` | Switch this session to an account or pool. The current model stays if the account offers it. Other sessions are not affected. |
| `/account default [account]` | Switch this session and use the same account or pool for new sessions. |
| `/account add [kind]` | Add an account. See "Adding accounts". |
| `/account remove [account]` | Remove an account and delete its stored credential after confirmation. |
| `/account enable\|disable [account]` | Turn an account on or off without removing it. |
| `/account reset [account]` | Clear an account's cooldown and quota state, for example after you know its usage window has reset. |
| `/models [account]` | List the models of this session's provider. With an account name, list that account's models instead, and choose one to switch this session to it. |

An account can be named by part of its label, email or id. If exactly one account matches, the command uses it. If several match, Pi shows a list to choose from. Without interactive prompts, name the account exactly.

Restart broker, found in `/accounts`, stops the shared broker. This reloads `config.yaml` (see "Configuration file" below). The broker is shared, so every Pi process is affected: a request in progress is interrupted, and the next request in any session starts a new broker. Use it only when the configuration file changed.

## Footer

The footer shows the account of the current session:

- On a pinned account: `account: Claude · you@example.com (Max)`.
- On a pool: `account: All accounts pool (3 accounts) -> Claude · work key (API key)`. The name after the arrow is the account that served the last request, so it changes as the pool moves a conversation. Before the first request the arrow is not shown.

## Switching accounts mid-session

The conversation history is kept when you switch accounts, and the next request continues it. Earlier reasoning is handled differently from visible text. Providers sign or encrypt reasoning for the account that produced it, so the new account cannot accept it as is. Pi replaces that reasoning with a short summary that starts with this label:

```
[Reasoning summary from an earlier turn, not shown to the user]
```

The label marks the summary as earlier private reasoning, so the model does not treat it as part of its visible reply. Each summary is limited to about 1500 characters. Visible text, tool calls and tool results are kept unchanged. Reasoning the provider marks as redacted is dropped, because it has no readable text.

This applies in two places. Switching a session between accounts is handled by Pi. Inside a pool, the broker makes the same replacement when the account that served the previous request can no longer serve the conversation, and when an account rejects reasoning from another account. In the second case the broker retries the request once, so the conversation continues without an error.

## Configuration file

Accounts defined in `~/.pi/agent/accounts/config.yaml`, using the CLIProxyAPI v8 `api-keys` layout, appear in the list as API-key accounts. The extension cannot disable, enable or remove them, because the file is their source of truth. Edit the file and choose `Restart broker` in `/accounts` to apply changes. The broker reads the file only at startup. Routing options such as the account selection strategy can also be set there.

## Security

Credentials stay in `~/.pi/agent/accounts`: subscription logins in `auths`, Anthropic and OpenAI API keys in `api-accounts.json`, and Claude Console sign-in state in `ant`. They are readable only by your user. The broker process holds them in memory while it runs. Pi holds only a per-run broker token for the loopback connection, which stops working when the broker restarts.

Pi's `read`, `edit` and `write` tools cannot access the accounts directory. Shell commands run as your user and can read it, as they can read [`auth.json`](configuration.md#agent-directory). Treat the accounts directory the same way you treat `auth.json`.
