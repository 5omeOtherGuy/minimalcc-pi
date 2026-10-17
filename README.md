# pi-claude-subscription — Claude subscriptions for Pi

[![CI](https://github.com/5omeOtherGuy/pi-claude-subscription/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/pi-claude-subscription/actions/workflows/ci.yml)
[![CodeQL](https://github.com/5omeOtherGuy/pi-claude-subscription/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/pi-claude-subscription/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Use your **Claude Pro or Max subscription with the [Pi coding agent](https://pi.dev)**. `pi-claude-subscription` is a Pi extension that connects Claude models through your existing Claude Code OAuth login, with streaming responses, tool calling, and model-specific thinking levels.

The provider appears in Pi as `claude-subscription`. It reads and refreshes Claude Code credentials locally and sends requests directly to Anthropic, without a proxy or an Anthropic API key. This is an independent community package.

## Install and start

Requires **Pi 0.80.6 or newer**, **Node.js 22.19 or newer**, and **Claude Code installed and logged in on the same machine**.

```bash
pi install git:github.com/5omeOtherGuy/pi-claude-subscription
pi --model claude-subscription/claude-sonnet-5-5
```

Already running Pi? Run `/reload`, then `/claude-subscription-status` to check the provider and credentials. Choose a Claude model with `/model` or `Ctrl+L`. You do not need to run Pi's `/login`: this extension reuses your Claude Code login.

To pin an install:

```bash
pi install git:github.com/5omeOtherGuy/pi-claude-subscription@<tag-or-commit>
```

## Using Claude in Pi

- Select models under **claude-subscription** in `/model`.
- Change thinking levels with `Shift+Tab`, or start with `--thinking high`.
- Add `claude-subscription/*` through `/scoped-models` to include these models when cycling with `Ctrl+P` / `Shift+Ctrl+P`.

Pi refreshes the model list from Anthropic's authenticated Models API. The bundled catalog remains available if discovery fails. A listed model still needs to be enabled for your subscription. See the model reference below for bundled models and thinking behavior.

### Accounts and credentials

| Command | Purpose |
|---|---|
| `/claude-subscription-status` | Check provider wiring, account, token freshness, and credential errors. |
| `/claude-subscription-accounts` | Discover Claude Code accounts and select a credential source. |
| `/claude-subscription-import` | Copy the selected Claude Code credential into this package's local state. |

These commands run locally without an Anthropic model call. Credentials come from `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json`, an imported copy, or a `Claude Code-credentials*` Keychain item on macOS. The provider refreshes expiring tokens and retries once after a 401. See [command details](docs/slash-commands.md).

## Subscription usage and billing

Requests use Claude Code OAuth and count against your Claude subscription. The extension does not read `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, send `x-api-key`, or fall back to API-key billing.

**Subscription extra usage can still incur charges** when enabled on your Claude account. Manage it at [Claude usage settings](https://claude.ai/settings/usage). With extra usage disabled, requests fail when the included plan quota is exhausted.

Pi's built-in `anthropic` provider has separate credentials and billing behavior. This package's local state lives in `pi-claude-subscription/` under Pi's agent directory and does not modify Pi's generic `auth.json`. Treat `imported-credentials.json` as a secret.

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
| `claude-fable-5-1` | 1,000,000 | 128,000 | `minimal`–`max`; no `off` | always-on adaptive; refusal fallback to `claude-opus-5` |
| `claude-sonnet-5` | 1,000,000 | 128,000 | `off`–`max` | adaptive |
| `claude-sonnet-5-5` | 1,000,000 | 128,000 | `off`–`max` | adaptive; `off` uses `between_tools` |
| `claude-haiku-5-5` | 1,000,000 | 128,000 | `off`–`max` | adaptive; `off` uses `disabled` |

When reasoning is enabled, adaptive models send `thinking: { type: "adaptive", display: "summarized" }` and map Pi levels to Claude `effort` (soft guidance, not a fixed token budget):

| Pi level | Claude effort |
|---|---|
| `off` | model-specific; see below |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

Notes:

- `claude-fable-5-1` and `claude-opus-5-5` cannot run without thinking: Pi hides `off`, and a persisted `off` clamps to `minimal` (Claude `low`). Every request sends explicit adaptive thinking and effort.
- `off` on `claude-sonnet-5-5` sends only `thinking: { type: "between_tools" }` with effort `low`: it skips up-front reasoning, but still returns thinking-block progress updates between tool calls. `off` on `claude-haiku-5-5` sends `thinking: { type: "disabled" }` with effort `low`. Neither mode is used at `xhigh` or `max`, where it would return a 400 error. Other adaptive models retain the legacy omission of `thinking`/`output_config`, which does not guarantee thinking is off.
- Anthropic's API defaults are `high` for Fable 5.1/Sonnet 5.5 and `medium` for Opus 5.5/Haiku 5.5. Pi's selected level is sent explicitly, not replaced with the API default. All four support `low`, `medium`, `high`, `xhigh`, and `max`; Anthropic has no `minimal`, so Pi `minimal` maps to `low`.
- Verified against Anthropic's [effort reference](https://platform.claude.com/docs/en/build-with-claude/effort) and [per-model thinking rules](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting) on 2026-10-12. Sampling parameters and forced tool choice are not sent. Optional per-message effort and turn-scoped system-message betas are not implemented by this provider; effort is top-level per request.
- Manual-budget models compute `max_tokens = min(requestedOutputTokens + thinkingBudget, output_cap)`, where Pi `minimal`/`low`/`medium`/`high`/`xhigh` map to `1024`/`4096`/`10240`/`20480`/`32768`. Details: [`docs/current-status.md`](docs/current-status.md#manual-thinking-budgets).
- `claude-opus-4-7-300k` is a provider-local soft-cap route: Pi sees a 300,000-token window for selection, status, and compaction, while native requests send `claude-opus-4-7`.
- Model metadata is owned by [`src/models.ts`](src/models.ts). Pi's `models.json` `modelOverrides` do not apply to extension-registered providers.

After compaction or a prompt/tool/history edit, newer models can reject old conversation-bound thinking signatures. On that specific HTTP 400, the provider retries once without historical thinking blocks while preserving text and tool calls/results. It does not alter Pi's stored history or retry errors after streaming starts. See [thinking-block replay](docs/current-status.md#thinking-block-replay-across-model-switches).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Directory containing Claude Code credentials. |
| `PI_CACHE_RETENTION` | unset | Set to `long` for a 1-hour prompt-cache TTL where supported, unless Pi supplies an explicit cache option. |

## Troubleshooting

- **Provider missing:** check `pi list`, run `/reload`, then `/claude-subscription-status`.
- **Missing or expired credentials:** log in through Claude Code, then check status again. Use the accounts command to select another local source.
- **Model unavailable:** choose another model enabled for your subscription and refresh Pi's model catalog.
- **Usage limit reached:** check your subscription quota and extra-usage setting on Claude.

## Development and documentation

```bash
git clone https://github.com/5omeOtherGuy/pi-claude-subscription.git
cd pi-claude-subscription
npm ci
npm run check
```

Tests use fake credentials and mocked network boundaries. `npm run check` runs the deterministic test suite and TypeScript checks.

- [Contributing](CONTRIBUTING.md) and [verification gates](docs/verification-gates.md)
- [Architecture and request flow](REPO_MAP.md)
- [Implementation details](docs/current-status.md) and [model selection](docs/model-selection.md)
- [Documentation index](INDEX.md) and [security](SECURITY.md)

## License

[MIT](LICENSE).
