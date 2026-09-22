# Claude Subscription Provider for Pi

[![CI](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/ci.yml)
[![CodeQL](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](.nvmrc)

A [Pi](https://pi.dev) package that adds a native `claude-subscription` provider, authenticating through your existing Claude Code login. Same account, same model ids, different agent loop.

No bundled credentials, no Anthropic API keys, no local proxy: at request time the provider reads the Claude Code OAuth token from its standard credential store.

> Independent community package. Review the source before installing — Pi packages run with your local user permissions. Individual local subscription use only; not for resale, pooled access, or replacing Anthropic API usage.

## Requirements

- Pi ≥ 0.80.6 (required for native `max` thinking).
- Node.js ≥ 22.19.0.
- Claude Code installed and logged in on the same machine.
- A credential source: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` (`.claudeAiOauth.accessToken`), a minimalcc-owned import from `/claude-subscription-import`, or on macOS a `Claude Code-credentials*` Keychain item.

If the credential cannot be read, requests fail with a login hint. The provider refreshes expired/near-expired tokens before sending, retries once on a 401 after a force-refresh, coalesces concurrent in-process refreshes, and does not overwrite newer credentials written by another process. It never falls back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or Anthropic API-key billing.

## Install

```bash
pi install git:github.com/5omeOtherGuy/minimalcc-pi
```

Pin a tag or commit for reproducible installs:

```bash
pi install git:github.com/5omeOtherGuy/minimalcc-pi@<tag-or-commit>
```

## Select a model

After install, start Pi as usual; the extension registers at startup. If Pi is already running, run `/reload`. `/login` is **not** required — the provider reuses the credential Claude Code wrote during its own login.

Run `/claude-subscription-status` in any Pi session to confirm the extension loaded and see credential health. Then choose a model:

- `/model` or `Ctrl+L` — full picker; the models appear under provider `claude-subscription`:
  `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-7-300k`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-sonnet-5`.
- Start directly: `pi --model claude-subscription/claude-sonnet-4-6`.
- Cycle thinking level with `Shift+Tab`, or `--thinking max` at startup.

`Ctrl+P` / `Shift+Ctrl+P` cycle through *scoped* models only. Add these to the list with `/scoped-models`, `pi --models "claude-subscription/*"`, or in `~/.pi/agent/settings.json`:

```json
{ "enabledModels": ["claude-subscription/*"] }
```

Pi's built-in `anthropic` provider is independent of this extension; its Claude entries are unrelated and may also be listed.

### Slash commands

The extension registers three local-only slash commands. They run in-process with no Anthropic model call and record no prompt text, tool arguments, file paths, or model output.

| Command | What it reports or changes |
|---|---|
| `/claude-subscription-status` | Provider wiring, active provider, discovered account, token freshness, refresh availability, and actionable credential errors. |
| `/claude-subscription-accounts` | Discovers Claude Code OAuth accounts and saves the selected source in minimalcc-owned state. |
| `/claude-subscription-import` | Copies the selected Claude Code OAuth credential blob into minimalcc-owned state and uses that copy for future requests. |

Exact output shape and field interpretation: [`docs/slash-commands.md`](docs/slash-commands.md).

## Model reference

Pi exposes thinking levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and opt-in `max` (since Pi 0.80.6). This extension enables native `max` for every adaptive model; manual-budget models stop at `xhigh`.

| Model | Context | Output cap | Pi thinking levels | Request thinking |
|---|---:|---:|---|---|
| `claude-haiku-4-5` | 200,000 | 64,000 | `off`–`xhigh`; no `max` | manual `budget_tokens` |
| `claude-sonnet-4-6` | 200,000 | 64,000 | `off`–`xhigh`; no `max` | manual `budget_tokens` |
| `claude-opus-4-6` | 1,000,000 | 128,000 | `off`–`xhigh`; no `max` | manual `budget_tokens` |
| `claude-opus-4-7` | 1,000,000 | 128,000 | `off`–`max` | adaptive |
| `claude-opus-4-7-300k` | 300,000 | 128,000 | `off`–`max` | adaptive; sends native `claude-opus-4-7` |
| `claude-opus-4-8` | 1,000,000 | 128,000 | `off`–`max` | adaptive |
| `claude-opus-5` | 1,000,000 | 128,000 | `off`–`max` | adaptive |
| `claude-opus-5-5` | 1,000,000 | 128,000 | `minimal`–`max`; no `off` | adaptive; explicit effort every request; no refusal fallback |
| `claude-fable-5` | 1,000,000 | 128,000 | `off`–`max` | adaptive; refusal fallback to `claude-opus-4-8` |
| `claude-fable-5-1` | 1,000,000 | 128,000 | `off`–`max` | adaptive; refusal fallback to `claude-opus-5` |
| `claude-sonnet-5` | 1,000,000 | 128,000 | `off`–`max` | adaptive |

When reasoning is enabled, adaptive models send `thinking: { type: "adaptive", display: "summarized" }` and map Pi levels to Claude `effort` (soft guidance, not a fixed token budget):

| Pi level | Claude effort |
|---|---|
| `off` | `thinking` and `output_config` omitted |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

Notes:

- `off` on an adaptive model omits `thinking` and `output_config`; it does not guarantee the server skips thinking. `claude-opus-5-5` cannot run without thinking, so it does not offer `off`: a persisted `off` is clamped to `minimal`, which sends Claude effort `low`. Every Opus 5.5 request sends an explicit effort, so the API's default effort (`medium`) is never used silently.
- Manual-budget models compute `max_tokens = min(requestedOutputTokens + thinkingBudget, output_cap)`, where Pi `minimal`/`low`/`medium`/`high`/`xhigh` map to `1024`/`4096`/`10240`/`20480`/`32768`. Details: [`docs/current-status.md`](docs/current-status.md#manual-thinking-budgets).
- `claude-opus-4-7-300k` is a provider-local soft-cap route: Pi sees a 300,000-token window for selection, status, and compaction, while native requests send `claude-opus-4-7`.
- Model metadata is owned by [`src/models.ts`](src/models.ts). Pi's `models.json` `modelOverrides` do not apply to extension-registered providers.

## Billing and safety

The provider authenticates only through the Claude Code OAuth credential store. It never sends `x-api-key`, never reads `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, and rejects non-`claude-subscription` routing before loading credentials. That keeps it off your Anthropic **API-account** billing entirely.

It does **not** prevent your Claude plan's metered "extra usage". Extra usage is the Pro/Max subscription's own overage, consumed through the same OAuth lane this extension uses: once included quota is exhausted, requests draw from extra usage (if enabled with a prepaid balance) and can fail with `400 … "You're out of extra usage"`. No client header or request parameter can opt a request out of extra usage, because none exists. The only control is the account-level toggle at <https://claude.ai/settings/usage>; with it off, requests fail at the plan limit instead.

Pi's built-in `anthropic` provider is not constrained by this extension. If you also want API-key billing or extra usage in parallel, leave its credentials in place and note that those requests are billed separately.

Local credential state written by this package lives under Pi's agent directory in `pi-claude-subscription/`; it never mutates Pi's generic `auth.json`. Treat `imported-credentials.json` as a secret and delete it when no longer needed.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Directory containing Claude Code `.credentials.json`. |
| `PI_CACHE_RETENTION` | unset | When set to `long`, requests use the Anthropic 1-hour prompt-cache TTL where the model supports it, unless Pi passes an explicit `cacheRetention` option. |

No environment variable is required beyond Claude Code's normal login state.

## How it works

The provider builds Anthropic Messages API requests directly and sends OAuth-only headers: `Authorization: Bearer <Claude Code OAuth token>`, `Content-Type: application/json`, `anthropic-version`, and `anthropic-beta`. It never sends `x-api-key`.

The request `system` field is an Anthropic content-block array with the Claude Code identity (`You are Claude Code, Anthropic's official CLI for Claude.`) as a separate first block, followed by Pi's system prompt. Tools use the standard Anthropic schema (`name`, `description`, `input_schema`, optional `cache_control`) without eager/fine-grained tool-input streaming.

Requests add short ephemeral prompt-cache anchors to the shaped system blocks, the last user message block, and the last tool schema. Responses are parsed incrementally and the stream fails closed on lifecycle violations. Architecture, cache policy, stream guards, and replay rules: [`docs/current-status.md`](docs/current-status.md) and [`REPO_MAP.md`](REPO_MAP.md).

## Development

Repository tests are deterministic and use fake credentials, static fixtures, or mocked network boundaries; they do not make live Anthropic requests.

```bash
npm ci
npm test
npm run typecheck
npm run check
```

`npm run check` is the safe public gate: deterministic tests plus TypeScript type-checking. Focused gates by change type: [`docs/verification-gates.md`](docs/verification-gates.md). Live verification runbooks and machine-specific notes are intentionally kept outside tracked files; use an ignored local path such as `.local/`.

## Documentation

[`INDEX.md`](INDEX.md) is the repository entry point; [`REPO_MAP.md`](REPO_MAP.md) maps the source and request flow. [`docs/current-status.md`](docs/current-status.md) covers implementation status, credentials, cache behavior, stream guards, and replay rules; [`docs/slash-commands.md`](docs/slash-commands.md) is the command output reference; [`docs/model-selection.md`](docs/model-selection.md) and [`docs/why-system-blocks.md`](docs/why-system-blocks.md) cover model and system-block choices; [`docs/verification-gates.md`](docs/verification-gates.md) documents test gates and dependency-drift policy; [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md) cover contribution and security.

## License

MIT; see [`LICENSE`](LICENSE).
