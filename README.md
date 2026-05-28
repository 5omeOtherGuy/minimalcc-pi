# Claude Subscription Provider for Pi

[![CI](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/ci.yml)
[![CodeQL](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](.nvmrc)

A [Pi](https://pi.dev) package that adds a native `claude-subscription` provider, authenticating through your existing Claude Code login. Same account, same model ids, different agent loop — useful for separating model behavior from harness behavior (system prompt, tool loop, compaction). See [`docs/rationale.md`](docs/rationale.md) for the longer "why".

No bundled credentials, no Anthropic API keys, no local proxy: at request time the provider reads the Claude Code OAuth token from its standard credential store.

> Independent community package. Review the source before installing — Pi packages run with your local user permissions. Individual local subscription use only; not for resale, pooled access, or replacing Anthropic API usage.

## What it provides

- Provider id `claude-subscription` (native API id `claude-subscription-native`).
- Models `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-7-300k`, and `claude-opus-4-8` — see [Model reference](#model-reference) for context windows, output caps, and thinking behavior.
- Native Anthropic Messages request construction with Claude Code OAuth headers; no `x-api-key`, no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` fallback.
- Incremental Anthropic SSE streaming with fail-closed lifecycle validation.
- The required Claude Code system-block shape, with Pi's prompt as the next block — see [`docs/why-system-blocks.md`](docs/why-system-blocks.md).
- Prompt-cache anchors with Pi `cacheRetention` support (`short`, `long`, `none`) and `PI_CACHE_RETENTION=long` compatibility.
- In-process slash commands `/claude-subscription-status`, `/claude-subscription-usage`, `/claude-subscription-cache-diagnostics` for local provider, token, and cache visibility — full reference in [`docs/slash-commands.md`](docs/slash-commands.md).
- Deterministic test coverage with mocked network boundaries; no live Anthropic calls in the test suite.

## Requirements

- Pi installed.
- Node.js ≥ 22.19 (per `.nvmrc`, matching Pi's current `engines.node` floor) and npm available for install from Git.
- Claude Code installed and logged in on the same machine.
- A credential source: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` containing `.claudeAiOauth.accessToken`, or on macOS the `Claude Code-credentials` Keychain item when the file is absent.

If the credential cannot be read, requests fail with a login hint. The provider refreshes expired/near-expired tokens before sending, retries once on a 401 after force-refresh, coalesces concurrent in-process refreshes, and avoids overwriting newer credentials written by another process. Full behavior: [`docs/current-status.md`](docs/current-status.md) § Credential handling. The provider intentionally does not fall back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or ordinary Anthropic API-key billing.

## Install

```bash
pi install git:github.com/5omeOtherGuy/minimalcc-pi
```

Pin a tag or commit for reproducible installs:

```bash
pi install git:github.com/5omeOtherGuy/minimalcc-pi@<tag-or-commit>
```

## How to use

After install, start Pi as usual; the extension registers on startup and adds its models to Pi's registry, with no further configuration required. If Pi is already running when you install or update, run `/reload` — extensions in auto-discovered locations are hot-reloaded without restart.

`/login` is **not** required for this extension. It reuses the credential Claude Code itself wrote during its own login. Make sure Claude Code is installed and logged in on the same machine.

### 1. Recommended safety setup (defense in depth)

The provider only authenticates through the Claude Code OAuth credential store. It never sends `x-api-key`, never reads `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, and rejects non-`claude-subscription` routing before loading credentials. That guarantees this extension can't bill against your Anthropic API account or your Claude plan's metered "extra usage".

Pi's *built-in* `anthropic` provider is independent of this extension and is not constrained by it. Unless you specifically want Anthropic API billing or Claude "extra usage" in parallel:

- **Remove Anthropic API credentials from Pi's environment.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` should not be exported in the shell that launches Pi, and `~/.pi/agent/auth.json` should have no `anthropic` API-key entry (in Pi: `/logout` → select `Anthropic` if one exists).
- **Turn off "extra usage"** at <https://claude.ai/settings/usage>. This prevents the built-in `anthropic` provider's `/login`-driven Claude Pro/Max path from drawing metered third-party-harness usage.
- Keep Pi's `warnings.anthropicExtraUsage` enabled (default on).

If you *do* want to run Pi's built-in `anthropic` provider in parallel — for example to A/B against an API-keyed Claude — leave the credentials in place and just be aware that built-in `anthropic` requests are billed separately from this extension's subscription requests.

### 2. Verify the extension registered

Run `/claude-subscription-status` in any Pi session. If the extension loaded, Pi shows a single info notification:

```
claude-subscription uses native Anthropic Messages with Claude Code OAuth.
```

If Pi reports the command as unknown, the extension did not load — check `pi list` and the install output, then re-run `pi install`. (`/claude-subscription-status` is one of three slash commands the extension registers; full reference below.)

Once the status command works, open the model picker with `/model` (or `Ctrl+L`). The six models should appear under provider `claude-subscription`:

- `claude-haiku-4-5 (claude-subscription)`
- `claude-sonnet-4-6 (claude-subscription)`
- `claude-opus-4-6 (claude-subscription)`
- `claude-opus-4-7 (claude-subscription)`
- `claude-opus-4-7-300k (claude-subscription)`
- `claude-opus-4-8 (claude-subscription)`

The built-in `anthropic` provider's own Claude entries may also be listed; those are unrelated to this extension.

You can also start a session with a specific subscription model directly:

```bash
pi --model claude-subscription/claude-sonnet-4-6
```

#### Slash commands

The extension registers three local-only slash commands. They run in-process with no network call, can be used in any Pi session, and report only state recorded by this extension in the current Pi process. State resets when Pi restarts. None of them record prompt text, tool arguments, file paths, model output, or credentials.

| Command | What it reports |
|---|---|
| `/claude-subscription-status` | Provider is registered; transport in use. |
| `/claude-subscription-usage` | Per-process token, cache, and request totals for traffic through this extension. |
| `/claude-subscription-cache-diagnostics` | Per-process cache-read drops between comparable requests, with a fingerprint of which request-shape section changed. |

Exact output shapes, per-field meaning, and interpretation of `requests=0`, `cacheHitRatio`, `events=0`, and every `changedSections` value: [`docs/slash-commands.md`](docs/slash-commands.md).

### 3. Optional: scope model cycling to this provider

Pi's `Ctrl+P` / `Shift+Ctrl+P` shortcut cycles through *scoped* models only. Adding the extension's models to that list makes mid-session switching one keystroke and prevents accidental cycling into the built-in `anthropic` provider.

- Interactive: `/scoped-models` and enable the six `claude-subscription/*` entries.
- One session: `pi --models "claude-subscription/*"`.
- Persistent, in `~/.pi/agent/settings.json`:
  ```json
  { "enabledModels": ["claude-subscription/*"] }
  ```

Mix patterns to keep cross-provider comparisons one keystroke away: `["claude-subscription/*", "gpt-5*", "gemini-2*"]`.

### 4. Subagents

Pi's optional subagent extension spawns separate `pi` processes and appends each agent's markdown body to the child process system prompt. This provider keeps that appended agent prompt intact as Pi's system-prompt block, behind the required separate Claude Code identity block.

If you use Pi's bundled subagent example agents, edit their frontmatter to use a supported subscription model, for example:

```markdown
model: claude-subscription/claude-sonnet-4-6
```

Do not leave example agents on `claude-sonnet-4-5` when you intend to use this package: this provider does not register that model, and unqualified unsupported Claude model names may resolve to Pi's built-in Anthropic provider instead. The extension's guardrails block known non-subscription Anthropic routing to avoid accidental API-key or extra-usage billing.

### 5. Switching models during a session

- `Ctrl+P` / `Shift+Ctrl+P` — cycle forward/backward through scoped models.
- `Ctrl+L` or `/model` — full picker across every registered provider.
- `Shift+Tab` — cycle the thinking level (subject to each model's `thinkingLevelMap`; see [Model reference](#model-reference)).

Mid-session switches: same provider + same model id replays signed reasoning; cross-model or cross-provider preserves visible reasoning as plain assistant text and never replays foreign signatures. Full rules: [`docs/current-status.md`](docs/current-status.md) § Stream and tool-call behavior.

## Model reference

Pi exposes fixed thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. The extension registers per-model metadata so Pi clamps or hides unsupported levels:

| Model | Context | Output cap | Pi thinking levels | Request thinking |
|---|---:|---:|---|---|
| `claude-haiku-4-5` | 200,000 | 64,000 | full Pi range | manual `budget_tokens`; no adaptive/effort mode |
| `claude-sonnet-4-6` | 200,000 | 64,000 | full Pi range | manual `budget_tokens` |
| `claude-opus-4-6` | 1,000,000 | 128,000 | full Pi range | manual `budget_tokens` |
| `claude-opus-4-7` | 1,000,000 | 128,000 | full Pi range; shifted upward to Claude `low`→`max` | adaptive thinking required by the API |
| `claude-opus-4-7-300k` | 300,000 | 128,000 | full Pi range; shifted upward to Claude `low`→`max` | adaptive thinking required by the API; sends native `claude-opus-4-7` |
| `claude-opus-4-8` | 1,000,000 | 128,000 | full Pi range; shifted upward to Claude `low`→`max` | adaptive thinking required by the API |

`Output cap` is the per-model upper bound the extension enforces. The actual `max_tokens` sent to Anthropic is `min(requestedOutputTokens + thinkingBudget, output_cap)`, so manual-thinking models always have room for both the visible reply and the thinking budget (see [`docs/current-status.md`](docs/current-status.md) § Manual thinking budgets). For manual-thinking models, Pi's `minimal`/`low`/`medium`/`high`/`xhigh` levels send `budget_tokens` of `1024`/`4096`/`10240`/`20480`/`32768`. Adaptive-only Opus models map Pi `minimal`/`low`/`medium`/`high`/`xhigh` to Claude effort `low`/`medium`/`high`/`xhigh`/`max`. Anthropic's [adaptive thinking docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) mark manual `budget_tokens` as deprecated-but-functional on Sonnet 4.6 and Opus 4.6; this package keeps the manual path for now to preserve predictable per-turn budgets. Haiku 4.5 supports extended thinking via manual `budget_tokens` but not adaptive `effort`-based thinking. Sonnet 4.6 stays at a 200,000-token context window because the Claude Code subscription path targeted by this package provides 200,000 tokens there, even though Pi's Anthropic API-key metadata may advertise a larger window.

These defaults are owned by [`src/models.ts`](src/models.ts). Pi's `models.json` `modelOverrides` does **not** apply to extension-registered providers — fork or modify the extension to change them.

`claude-opus-4-7-300k` is a provider-local soft-cap route: Pi sees a 300,000-token context window for selection, status, and native compaction, while this extension sends Anthropic the native `claude-opus-4-7` model id.

**Why multiple Opus snapshots are exposed:** 4.6 uses manual `budget_tokens` (predictable budgets), while 4.7 and 4.8 require adaptive thinking when thinking is enabled (API-enforced; the model dynamically allocates reasoning). Detailed rationale, complementary use cases, and source citations: [`docs/model-selection.md`](docs/model-selection.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Directory containing Claude Code `.credentials.json`. |
| `PI_CACHE_RETENTION` | unset | When set to `long`, requests use Anthropic 1-hour prompt-cache TTL where the model supports it, unless Pi passes an explicit `cacheRetention` option. |

No environment variable is required by this package beyond Claude Code's normal login state.

## How it works

The provider builds Anthropic Messages API requests directly and sends OAuth-only headers:

- `Authorization: Bearer <Claude Code OAuth token>`
- `Content-Type: application/json`
- `anthropic-version`
- `anthropic-beta`

It does not send `x-api-key`. Tool requests use Anthropic's per-tool `eager_input_streaming` flag by default and fall back to the legacy fine-grained tool-streaming beta only when model compatibility marks eager input streaming unsupported.

The request `system` field is shaped as an Anthropic content-block array with the Claude Code identity as a separate first block:

```json
[
  { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." },
  { "type": "text", "text": "<Pi system prompt>" }
]
```

See [`docs/why-system-blocks.md`](docs/why-system-blocks.md) for the compatibility notes behind this shape.

Token/cache hygiene (prompt-cache anchors, retention controls, deterministic payload shaping, usage telemetry, cache-break diagnostics) and thinking-block replay rules across model switches are documented in [`docs/current-status.md`](docs/current-status.md). Both are observable through the slash commands above.

## Development

Repository tests are deterministic and use fake credentials, static fixtures, or mocked network boundaries; they do not make live Anthropic requests. Coverage includes credential/config failures, provider guardrails, request/message conversion edges, SSE contract violations, transport failures, manifest integrity, and redaction behavior.

```bash
npm ci
npm test
npm run typecheck
npm run check
```

`npm run check` is the safe public gate: deterministic tests plus TypeScript type-checking. Live verification runbooks and local environment notes are intentionally not stored in this repository; use an ignored local workspace such as `.local/` for those.

## Documentation

- [`docs/rationale.md`](docs/rationale.md) — why this package exists, harness-vs-model isolation, comparison with Claude Code CLI, and why a native Pi provider over a proxy.
- [`docs/current-status.md`](docs/current-status.md) — implementation status, credential handling, cache-retention behavior, stream/tool-call guards, thinking-block replay rules, verification scope.
- [`docs/slash-commands.md`](docs/slash-commands.md) — exact output shapes and per-field interpretation for the three in-process slash commands.
- [`docs/model-selection.md`](docs/model-selection.md) — when to choose between exposed Opus snapshots, thinking-control trade-offs, source citations.
- [`docs/why-system-blocks.md`](docs/why-system-blocks.md) — compatibility notes for the required system-block shape.
- [`REPO_MAP.md`](REPO_MAP.md) — source layout and request-flow map.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor workflow and deterministic test expectations.
- [`SECURITY.md`](SECURITY.md) — security reporting and credential-handling expectations.

## License

MIT; see [`LICENSE`](LICENSE).
