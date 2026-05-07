# Claude Subscription Provider for Pi

[![CI](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/ci.yml)
[![CodeQL](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/5omeOtherGuy/minimalcc-pi/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=20.6](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)](.nvmrc)

A public [Pi](https://pi.dev) package that registers a native `claude-subscription` provider authenticating with an existing Claude Code login. It is intended primarily as a **research tool for studying how much of perceived Claude model behavior is attributable to the *harness* (system prompt, tool loop, compaction, hidden middleware) versus the underlying model itself**.

This package does **not** include credentials, does **not** use Anthropic API keys, and does **not** require a local proxy. At request time it reads the Claude Code OAuth token from the standard Claude Code credential store on the user's machine.

> This is an independent community package. Review the source before installing; Pi packages run code with your local user permissions.

## Why this exists

Over the last several months there have been recurring public reports of Claude model regressions: Opus following instructions less reliably on long tasks, Sonnet looping on tool errors, ignored repository conventions, and degraded coding behavior compared to earlier snapshots. Anthropic has itself published postmortems acknowledging serving-side bugs that intermittently degraded responses. The community discussion that follows these reports usually conflates three distinct variables:

1. The **model weights and routing** Anthropic is currently serving.
2. The **Claude Code harness** around them: a large product-specific system prompt, tool descriptions, compaction strategy, and CLI behavior that cannot be disabled from outside.
3. The **user's own prompts, tools, and workflow**.

Without isolating (2), it is very hard to tell whether a bad Claude session is a model regression, a harness interaction, or a local prompt problem. This package exists to make (2) controllable for individual users with an existing Claude Code subscription, so they can run the same tasks under a leaner, fully auditable harness (Pi) and compare.

It is not a benchmark suite and it does not claim to prove that any specific Anthropic change caused any specific regression. It is a switch: same account, same model id, different agent loop. What you do with the comparison — anecdotal A/B, structured evals, or just "does this finally stop looping" — is up to you.

In local use, the maintainers have observed Claude following instructions more reliably when the same work runs through Pi's prompt and tool loop. That observation is subjective and workload-dependent, and this README should not be read as a benchmark or as a claim that Anthropic has misconfigured any specific model. It sits alongside public Claude Code issue reports about Opus regressions, ignored instructions, repeated basic errors, and looping behavior — useful context, not a root-cause claim.

The package therefore avoids Claude Code's full system prompt and runtime harness as far as the OAuth route permits. Because that route validates request shape, the provider still sends the Claude Code identity as the first `system` block for compatibility, followed by Pi's system prompt as the next block. See [`docs/why-system-blocks.md`](docs/why-system-blocks.md).

## What this lets you compare

With Claude Code installed and logged in, the same Claude Code subscription account can be exercised through two different harnesses on the same machine:

| Variable | Claude Code CLI | This package (via Pi) |
|---|---|---|
| Model weights / routing | Anthropic-controlled, same account | Anthropic-controlled, same account |
| Auth path | Claude Code OAuth | Claude Code OAuth (reused) |
| System prompt | Full Claude Code product prompt | Pi’s system prompt with Claude Code compatibility context |
| Tool descriptions and ordering | Claude Code defaults | Pi's tool surface, user-controllable |
| Compaction / context management | Claude Code internal | Pi's compaction, user-controllable |
| Thinking / reasoning controls | Claude Code defaults | Explicit per-model `thinkingLevelMap`, see below |
| Cache behavior | Opaque | Visible: cache anchors, retention, telemetry, diagnostics |
| Source visibility | Closed | Fully readable TypeScript with deterministic tests |

## Intended use and fair-use boundary

Use this package if you want to investigate harness effects on Claude behavior on your own tasks, prefer Pi's minimal, customizable agent loop for day-to-day work, have Claude Code logged in locally, and want subscription-backed Claude access without running a proxy or configuring API-key billing.

Do **not** use this package with OpenClaw or similar API-capacity or arbitrage harnesses. It is not intended to convert a consumer subscription into a general replacement for paid Anthropic API usage. If your workload belongs on the API, use the API and pay for it.

The implementation aims to keep subscription quota and upstream cost in check. Native requests include prompt-cache anchors, optional long-cache retention where supported, local token and cache telemetry, and cache-break diagnostics, so repeated Pi sessions reuse stable prefixes instead of wasting tokens through poor cache hygiene. These optimizations live in the Pi provider, are covered by deterministic tests, and are not a guarantee of identical behavior to Claude Code internals.

## Why a native Pi provider

A native Pi integration is deliberately simpler and safer than a proxy-based bridge:

- No background daemon, local proxy, Python service, or port binding to install, monitor, or trust.
- Pi owns the provider registration, model metadata, thinking-level mapping, request conversion, and stream conversion.
- OAuth credentials are loaded only at request time from Claude Code's local credential store, and the native stream rejects non-`claude-subscription` routing before credential loading.
- Requests use OAuth-only Anthropic headers and intentionally omit `x-api-key`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` fallback behavior.
- Prompt/cache behavior is visible in source: system-block shaping, cache-control anchors, cache retention, telemetry, and diagnostics are all implemented in TypeScript with mocked tests.
- Streaming is parsed incrementally from the Anthropic response body and fails closed on malformed or out-of-order SSE lifecycle events before emitting final Pi assistant events.
- The package composes with Pi's normal customization surface: model overrides, cache-retention options, user prompts, tools, and local extension configuration.

## Project principles and next improvements

The project should continue to prefer:

- Measured, redacted evidence over anecdotes when discussing Claude Code, Opus, Sonnet, or Anthropic configuration changes.
- Minimal model-visible intervention: avoid prompt rewrites, hidden compaction, or tool filtering unless the behavior and token impact are measurable.
- Transparent quota hygiene: keep improving cache diagnostics, usage telemetry, and repeatable live verification runbooks without committing prompts, logs, or credentials.
- Compatibility through narrow shims: preserve only the Claude Code system-block shape and OAuth headers required by the route, while keeping Pi's own prompt and tool loop authoritative.
- Clear ethical boundaries: this package is for individual local subscription use — not for resale, pooled access, or avoiding API billing for workloads that belong on the API.

## What it provides

- Provider id: `claude-subscription`
- Native API id: `claude-subscription-native`
- Models:
  - `claude-haiku-4-5`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6`
  - `claude-opus-4-7`
- Native Anthropic Messages request construction using Claude Code OAuth headers.
- Incremental Anthropic SSE streaming into Pi assistant events, with fail-closed stream lifecycle validation.
- System-block shaping required by the Claude Code subscription/OAuth route.
- Prompt-cache anchors with Pi `cacheRetention` support (`short`, `long`, `none`) and `PI_CACHE_RETENTION=long` compatibility.
- In-process `/claude-subscription-status`, `/claude-subscription-usage`, and `/claude-subscription-cache-diagnostics` slash commands for local provider, token, and cache visibility.
- Deterministic test coverage for request construction, credential loading, SSE parsing, stream conversion, provider registration, manifest guardrails, cache-retention behavior, local telemetry/diagnostics, and redaction behavior.

## Requirements

- Pi installed.
- Node.js/npm available for package installation from Git.
- Claude Code installed and logged in on the machine that runs Pi.
- A Claude Code credential source:
  - `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` containing `.claudeAiOauth.accessToken`, or
  - on macOS, the `Claude Code-credentials` Keychain item when the credentials file is absent.

If Claude Code is not logged in or the credential cannot be read, requests fail with a login/configuration hint. When Claude Code OAuth credentials include an expired or near-expired `expiresAt` and a `refreshToken`, the provider refreshes the OAuth token before sending the model request and persists the refreshed credential file. If Anthropic rejects a locally fresh token with a 401/authentication error, the provider force-refreshes from the current credential store, rebuilds the request, and retries once. Concurrent in-process refreshes share the first persisted token, and a refresh will not overwrite a credential file that another process refreshed while the token exchange was in flight. On macOS, if the credential file is absent and the expired credential is read from Keychain, the refreshed credential is written to the standard credential-file path for subsequent requests. The provider intentionally does not fall back to `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or ordinary Anthropic API-key billing.

## Install

Install from the public Git repository:

```bash
pi install git:github.com/5omeOtherGuy/minimalcc-pi
```

Pin a tag or commit for reproducible installs:

```bash
pi install git:github.com/5omeOtherGuy/minimalcc-pi@<tag-or-commit>
```

## How to use

After `pi install …` finishes, start Pi as usual; the extension registers a `claude-subscription` provider on startup and adds its models to Pi's model registry, with no further configuration required. If Pi is already running when you install or update the package, run `/reload` in the session — extensions in auto-discovered locations are hot-reloaded and the new provider becomes available immediately, without restarting Pi.

Note: `/login` is **not** required for this extension. Pi's other subscription providers (Codex, Claude Pro/Max via the built-in `anthropic` provider, GitHub Copilot) authenticate through `/login`, but `claude-subscription` reuses the credential that Claude Code itself wrote during its own login. Make sure Claude Code is installed and logged in on the same machine; this provider does not prompt for credentials.

### 1. Recommended safety setup (defense in depth)

The provider only authenticates through the Claude Code OAuth credential store. It never sends `x-api-key`, never reads `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, and rejects non-`claude-subscription` routing before loading credentials. That guarantees this extension can't bill against your Anthropic API account or your Claude plan's metered "extra usage".

Pi's *built-in* `anthropic` provider is independent of this extension and is not constrained by it. To keep the two paths cleanly separated, unless you have a reason to use Anthropic API billing or Claude "extra usage" alongside the subscription route:

- **Remove Anthropic API credentials from Pi's environment.** Make sure `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are not exported in the shell that launches Pi, and that `~/.pi/agent/auth.json` has no `anthropic` API-key entry (in Pi, run `/logout` and select `Anthropic` if one exists). Without these, Pi's built-in `anthropic` provider has no credentials to use.
- **Turn off "extra usage" on your Anthropic account** at <https://claude.ai/settings/usage>. This prevents Claude Pro/Max subscription auth — used by Pi's built-in `anthropic` provider when logged in via `/login` — from drawing metered third-party-harness usage that bills per token outside your plan limits.
- Keep Pi's `warnings.anthropicExtraUsage` warning enabled (it is on by default) so any future Anthropic-subscription request through the built-in path is still flagged.

If you *do* want to run Pi's built-in `anthropic` provider in parallel — for example, to A/B the same task against an API-keyed Claude — leave the credentials in place and just be aware that built-in `anthropic` requests are billed separately from this extension's subscription requests.

### 2. Verify the extension registered

Open the model picker with `/model` (or `Ctrl+L`). The following entries should be listed under provider `claude-subscription` (not `anthropic`):

- `claude-haiku-4-5 (claude-subscription)`
- `claude-sonnet-4-6 (claude-subscription)`
- `claude-opus-4-6 (claude-subscription)`
- `claude-opus-4-7 (claude-subscription)`

If they are missing, the extension did not load — check `pi extensions list` and the install output. The built-in `anthropic` provider's own Claude entries may also be listed; those are unrelated to this extension.

You can also start a session with a specific subscription model directly:

```bash
pi --model claude-subscription/claude-sonnet-4-6
```

#### Slash-command reference

The extension registers three slash commands. They are local-only (handlers run in-process with no network call), can be run in any Pi session, and report only state recorded by this extension in the current Pi process. Prompts sent through OpenAI, Gemini, or other providers are not counted. State resets when Pi restarts. Note the exact names: Pi commands are single tokens — `/claude-subscription-status` (not `/claude-subscription status`), and the diagnostics command is plural (`-cache-diagnostics`).

| Command | What it reports |
|---|---|
| `/claude-subscription-status` | That the extension's provider is registered and which transport it uses. |
| `/claude-subscription-usage` | Per-process token, cache, and request totals for traffic routed through this extension. |
| `/claude-subscription-cache-diagnostics` | Per-process record of cache-read drops between comparable requests, with a fingerprint of which request-shape section changed. |

##### `/claude-subscription-status`

How to use: type the command in any Pi session.

Output (single info notification, fixed text):

```
claude-subscription uses native Anthropic Messages with Claude Code OAuth.
```

How to interpret it:

- The notification confirms the command is registered and the extension loaded.
- The text describes the extension's provider wiring; it does not mean the current active model is `claude-subscription`.
- If Pi reports the command as unknown, the extension did not load — fall back to `pi extensions list` and re-run `pi install`.

##### `/claude-subscription-usage`

How to use: run after prompts have been sent through `claude-subscription/...` in the current Pi process. If the session only used other providers, the output stays at zero. If you switch away later, the command still reports earlier subscription requests from this process. It does **not** capture prompt text, tool arguments, file paths, model output, or credentials.

Output (single info notification; one line, current process counters):

```
Claude subscription usage: requests=N input=N output=N cacheRead=N cacheWrite=N totalTokens=N cacheHitRatio=XX.XX%
```

Fields:

- `requests` — provider responses completed through `claude-subscription` since this Pi process started. Requests routed to any other provider are not counted.
- `input` — non-cached input tokens reported by the API.
- `output` — output tokens reported by the API.
- `cacheRead` — tokens served from the prompt cache.
- `cacheWrite` — tokens written into the prompt cache.
- `totalTokens` — sum reported by the API per response, accumulated.
- `cacheHitRatio` — `cacheRead / (input + cacheRead + cacheWrite)`, formatted as a percentage; `0.00%` when no cacheable tokens have been seen.

How to interpret it:

- `requests=0` after sending prompts means no successful `claude-subscription` response has completed in this Pi process.
- Switching between subscription models is aggregated in this one-line summary; the command does not show the internal per-model breakdown.
- All counters are per-process: a Pi restart, a fresh `pi` invocation, or running multiple Pi processes will each have their own independent totals. This is a session hygiene tool, not a subscription-quota tracker.

##### `/claude-subscription-cache-diagnostics`

How to use: run after at least two `claude-subscription` requests sharing the same key (Pi session id, falling back to model name when no session id is present) have completed in the current Pi process. Other providers do not create diagnostic samples. The handler reports cache-read **drops** and identifies which request-shape section changed. Only the latest event is summarized; prompt content, tool arguments, and credentials are never included.

Output when no drops have been recorded:

```
Claude subscription cache diagnostics: events=0
```

Output when at least one drop has been recorded (latest event summarized):

```
Claude subscription cache diagnostics: events=N latest=cache-read-drop model=<id> previousCacheRead=<n> currentCacheRead=<n> changedSections=<sections>
```

`changedSections` is a comma-separated subset of `model`, `system`, `messages`, `tools`, `cacheControl`, `bodyConfig`, or the literal `none`.

How to interpret it:

- `events=0` is the healthy steady state — every cache lookup either matched the previous request or grew. No action needed.
- A reported drop means the most recent request invalidated the prefix cache against an earlier comparable request. The `changedSections` field points at the most likely cause:
  - `system` — system prompt or the extension's identity-block shaping changed.
  - `messages` — message-history shape changed (commonly: a long tool result was inserted before a previously cached prefix, or compaction rewrote earlier turns).
  - `tools` — tool list or tool schemas changed mid-session.
  - `cacheControl` — explicit `cache_control` markers shifted position.
  - `bodyConfig` — unrelated body fields drifted (`temperature`, `max_tokens`, `metadata`, etc.).
  - `model` — the model id changed; switching subscription models invalidates the cache by design.
  - `none` — fingerprints matched but `cacheRead` still shrank; this usually means upstream cache eviction (the cached prefix expired on Anthropic's side) rather than a client-side change.
- In mixed-provider sessions, non-subscription turns are not sampled; when you switch back, changed replayed history may appear under `messages`.
- Fingerprints are SHA-256 hashes salted with per-process random bytes, so they are comparable only within one Pi run and never leak prompt content.
- Diagnostic state is per-process: a Pi restart clears recorded events and resets the fingerprint salt.

### 3. Optional but recommended: scope model cycling to this provider

Pi's `Ctrl+P` / `Shift+Ctrl+P` shortcut cycles through *scoped* models only. Adding the extension's models to that list makes mid-session switching between Haiku, Sonnet, and the two Opus snapshots a single keystroke, and prevents accidental cycling into the built-in `anthropic` provider.

- Interactive: run `/scoped-models` and enable the four `claude-subscription/*` entries.
- CLI for one session: `pi --models "claude-subscription/*"`.
- Persistent, in `~/.pi/agent/settings.json`:

  ```json
  {
    "enabledModels": ["claude-subscription/*"]
  }
  ```

You can mix patterns — e.g. `["claude-subscription/*", "gpt-5*", "gemini-2*"]` — to keep cross-provider comparisons one keystroke away.

### 4. Switching models during a session

- `Ctrl+P` / `Shift+Ctrl+P` — cycle forward/backward through your scoped models.
- `Ctrl+L` or `/model` — open the full model picker across every registered provider (subscription, API-key, custom).
- `Shift+Tab` — cycle the thinking level for the current model (subject to each model's `thinkingLevelMap`; see the model table below).

Mid-session switches between extension models and other Pi providers (OpenAI, Gemini, etc.) work as Pi normally handles them. Thinking-block continuity across switches is constrained by the rules in [Thinking-block replay across model switches](#thinking-block-replay-across-model-switches): same provider + same model id replays signed reasoning, cross-model or cross-provider preserves visible reasoning as plain assistant text, and foreign signatures are never replayed.

### 5. Inspecting subscription usage and cache behavior

The three in-process slash commands — `/claude-subscription-status`, `/claude-subscription-usage`, and `/claude-subscription-cache-diagnostics` — are documented in full under [§ 2 ▸ Slash-command reference](#slash-command-reference), including their exact output shapes and how to interpret each field. None of them record prompt text, tool arguments, file paths, model output, or credentials.

## Model metadata, thinking levels, and output caps

Pi exposes fixed thinking levels: `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. This extension registers its own model metadata, including context windows, default output caps, and model-specific `thinkingLevelMap` entries so Pi can hide or clamp unsupported levels:

| Model | Context window | Default `max_tokens` | Pi thinking levels | Request thinking behavior |
|---|---:|---:|---|---|
| `claude-haiku-4-5` | 200,000 | 48,000 | full Pi range | manual `budget_tokens`; no adaptive/effort mode |
| `claude-sonnet-4-6` | 200,000 | 48,000 | full Pi range | manual `budget_tokens`; adaptive thinking is available upstream but intentionally not used here |
| `claude-opus-4-6` | 1,000,000 | 64,000 | full Pi range | manual `budget_tokens`; adaptive thinking is available upstream but intentionally not used here |
| `claude-opus-4-7` | 1,000,000 | 64,000 | `minimal` hidden; `xhigh` maps to Claude `xhigh` | adaptive thinking is required by the API when thinking is enabled |

For manual-thinking models, Pi's `minimal`/`low`/`medium`/`high`/`xhigh` levels currently send `budget_tokens` of `1024`/`4096`/`10240`/`20480`/`32768`. Anthropic's [adaptive thinking docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) document manual `budget_tokens` as functional but deprecated on Sonnet 4.6 and Opus 4.6; this package keeps that path for now to preserve predictable per-turn token budgets. Haiku 4.5 supports extended thinking via manual `budget_tokens`, but not adaptive `effort`-based thinking.

Default `max_tokens` is intentionally capped below some upstream limits for token efficiency and to reduce accidental token dumps, following Anthropic's [prompting-efficiency guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices).

These defaults are owned by the extension's registered provider metadata in [`src/models.ts`](src/models.ts). Pi's `models.json` `modelOverrides` feature applies to built-in provider models, not to this extension-registered `claude-subscription` provider. If a default cap or context window hurts task performance, adjust the extension metadata itself (for example in a fork or local package checkout) and reload/reinstall the package; do not rely on Pi-native `modelOverrides` for this provider.

Operational note: Opus 4.7 must use adaptive thinking when thinking is enabled. Adaptive thinking uses `effort` as soft guidance, not a fixed budget: Anthropic's [adaptive thinking docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) state that medium/low effort may skip thinking on simple tasks, while high/default effort thinks or almost always thinks. Directly prompting the model about when to think is also documented as a way to tune adaptive-thinking behavior.

## Why both Opus 4.6 and Opus 4.7 are exposed

The provider registers `claude-opus-4-6` *and* `claude-opus-4-7` rather than silently rotating to whatever Anthropic currently labels "latest". The two snapshots differ in prompting ergonomics and in thinking-control surface, and in the spirit of this package — making harness/model boundaries controllable — both choices are left to the user, per task.

Public characterizations match what the package's own request shaping has to accommodate. [Amp's Opus 4.7 release note](https://ampcode.com/news/opus-4.7) describes 4.6 as *forgiving*: given a vague task it will "infer the missing pieces, make a plan, and start working", whereas 4.7 "follows prompts more closely … fills in fewer gaps … researches more". Anthropic's [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) point the same way: be explicit, state success criteria, give examples. Better prompts make 4.7 go further; weaker prompts make 4.6 still useful.

The two models are treated as complementary rather than mutually exclusive:

- **Continuity for existing workflows.** Repositories, agent loops, and slash-commands tuned against 4.6's gap-filling behavior do not have to be rewritten on Anthropic's release cadence. Same OAuth, same harness, same model id; nothing has to move just because a newer snapshot exists.
- **A controlled migration path to 4.7.** Moving a workflow to 4.7 is mostly a prompt-engineering exercise — tightening success criteria, supplying verification commands, replacing "do the thing" with "done means X, Y, Z". Exposing both snapshots under one provider makes that migration incremental: port one prompt at a time, run it on 4.7, compare against the 4.6 baseline on the same account and harness, retire the 4.6 entry point only when the 4.7 prompt is at least as good. This is the same harness-controlled A/B the rest of this README is built around, applied to a model upgrade.
- **4.6 as a distinct tool, not a deprecated one.** The same gap-filling that makes 4.6 weaker on rigorously specified verifier-driven tasks makes it useful for exploratory work, first-pass prompts, brainstorming, and tasks where the user *wants* the model to infer rather than pause. That is a different point on the prompt-strictness/inference trade-off, not an older version of the same point.
- **Different thinking-control surfaces.** This package sends manual `budget_tokens` for 4.6, so Pi's `off`/`minimal`/`low`/`medium`/`high`/`xhigh` levels map to predictable budget limits and cost envelopes. Anthropic now recommends adaptive thinking for Sonnet 4.6 and Opus 4.6 and marks manual `budget_tokens` as deprecated but still functional; this package has not migrated that request shape yet. 4.7 *requires* adaptive thinking when thinking is enabled (enforced by the upstream API, not chosen by this package), and as the operational note above states, adaptive thinking at low effort can skip thinking entirely on some tasks. Tasks that need a predictable, bounded amount of reasoning per turn may be better served by 4.6's manual budget path; open-ended tasks that benefit from the model dynamically allocating more reasoning to harder steps may be better served by adaptive thinking.
- **Complementary in one session.** Brainstorm or scaffold on 4.6, then hand a tightened, success-criteria-shaped prompt to 4.7 for execution; or use 4.6 with a fixed budget for a bounded refactor pass and 4.7 with adaptive thinking for an open-ended debugging step in the same conversation. Per-request model selection (`pi --model claude-subscription/claude-opus-4-6` vs. `…/claude-opus-4-7`, or model cycling scoped to this provider) makes the switch cheap, and the thinking-block replay rules above keep mid-conversation switches safe: signed reasoning is not replayed across model ids, but visible reasoning is preserved as plain assistant text.

This package does not recommend one Opus snapshot over the other. It exposes both, documents their request-shape and thinking-control differences in the model table above, and lets the user decide which one to point at a given problem.

#### Sources

- Anthropic, *Adaptive thinking*: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Anthropic, *Extended thinking*: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Anthropic, *Prompting best practices*: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Amp, *Opus 4.7*: https://ampcode.com/news/opus-4.7

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Directory containing Claude Code `.credentials.json` |
| `PI_CACHE_RETENTION` | unset | When set to `long`, requests use Anthropic 1-hour prompt-cache TTL where the selected model supports it, unless Pi passes an explicit `cacheRetention` option. |

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

### Token and cache optimization

The extension implements token optimization in the native provider rather than by hiding or rewriting user content. The goal is quota hygiene without changing what Claude can see or do.

- **Prompt-cache anchors:** by default, outgoing Anthropic payloads add `cache_control` markers to shaped system text blocks, the final block of the final user message when the request ends in a user turn, and the final tool schema. This mirrors Pi's Anthropic cache-control strategy: stable system/tool prefixes and repeated conversation prefixes can be read from cache on later turns instead of being billed as ordinary input again.
- **Cache-retention controls:** Pi's `cacheRetention` option is honored. `none` disables cache markers, `short` or unset uses Anthropic's normal ephemeral cache marker, and `long` uses `ttl: "1h"` only when model compatibility metadata says long cache retention is supported. Unset retention also honors `PI_CACHE_RETENTION=long`, matching Pi's native Anthropic behavior.
- **Stable payload shape:** deterministic request construction keeps equivalent requests byte-stable where possible. Tests cover stable payload serialization, cache-control preservation, and cache-anchor placement.
- **Output caps:** default `max_tokens` values are intentionally capped in the extension metadata to reduce accidental token dumps; see the model table above.
- **Usage telemetry:** successful native streams record local input, output, cache-read, cache-write, total-token, and cache-hit-ratio data. Use `/claude-subscription-usage` for a redacted in-process summary.
- **Cache-break diagnostics:** the provider fingerprints request shape sections — model, system, messages, tools, cache controls, and body config — with a per-process salt. If cache reads drop between comparable requests, `/claude-subscription-cache-diagnostics` reports which section changed without storing prompt text, tool arguments, file paths, or secrets.

### Thinking-block replay across model switches

Pi stores assistant reasoning as thinking blocks. Anthropic thinking signatures are provider/model-specific continuity payloads; replaying them to the wrong model can make the upstream API reject the request or pollute the next model's context. This provider therefore follows the same safety model as Pi's native provider transformations:

- **Same provider, same native API, same model id:** signed visible thinking is replayed as Anthropic `thinking` with its signature, and redacted thinking is replayed as `redacted_thinking` with the opaque provider payload.
- **Different provider or different model id:** visible, non-redacted thinking is preserved as ordinary assistant text so useful reasoning context is not lost, but the foreign signature is not replayed.
- **Redacted thinking from another model:** dropped. It is opaque encrypted provider state, not user-visible reasoning, and is only valid for the exact model that produced it.
- **Unsigned or partial thinking:** handled fail-closed rather than fabricating a signature. Same-model thinking blocks without a signature are not replayed as Anthropic thinking blocks.
- **Errored or aborted assistant turns:** skipped during replay so partial failed outputs do not become durable context.

This behavior is covered by deterministic tests for same-model replay, cross-provider replay, different-model Claude subscription replay, redacted thinking, unsigned thinking, and aborted/error turns.

## Safety and limitations

- Built-in Pi `anthropic` models may still appear in `pi --list-models`; this package does not rely on hiding them.
- Use the `claude-subscription` provider when you want the Claude Code OAuth path; Pi's built-in `anthropic` provider is independent and uses its own credentials. See [How to use](#how-to-use) for recommended scoping and credential isolation.
- The native stream rejects non-`claude-subscription` provider routing before loading Claude Code OAuth credentials.
- Pi currently treats `before_provider_request` hook errors as extension errors, so this package does not document that hook as a sole blocking boundary.
- Streaming uses the native Anthropic response body incrementally, but still performs local fail-closed lifecycle checks before emitting a final `done` event.
- Never commit `.credentials.json`, `.env`, OAuth tokens, API keys, logs, or runtime state.

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

- [`docs/current-status.md`](docs/current-status.md) — current implementation status, verification scope, and known limitations.
- [`docs/why-system-blocks.md`](docs/why-system-blocks.md) — compatibility notes for the required system-block shape.
- [`REPO_MAP.md`](REPO_MAP.md) — source layout and request-flow map.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor workflow and deterministic test expectations.
- [`SECURITY.md`](SECURITY.md) — security reporting and credential-handling expectations.

## License

MIT; see [`LICENSE`](LICENSE).
