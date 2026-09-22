# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- pi >= 0.87 passes providers a `TranscriptContext` whose system prompt and tool declarations live in transcript system messages; the provider read `context.systemPrompt` / `context.tools` and therefore sent every request with no tools and an empty system prompt (0 tool calls, tool calls faked as text, exit 0). The payload now resolves both from the transcript (`getCurrentTools` / `getCurrentSystemPrompt`, looked up at run time so older pi versions keep working) and skips system messages when converting conversation turns.

### Added

- Added `claude-opus-5-5` (1M context, 128k output, text/image): Pi `off` is hidden and a persisted `off` clamps to `minimal` (Claude `low`), every request sends explicit adaptive thinking/effort, `tool_choice` is never forced, and there is no refusal fallback; live-verified with opt-in `tests/live-opus-5-5.test.ts`.
- Added `claude-opus-5` and `claude-fable-5-1` (1M context, 128k output, adaptive mapping), with Opus 5 as Fable 5.1's refusal fallback; adapted from Pizzaface's fork without pricing/dependency changes.
- Added `/claude-subscription-accounts` (discover/select sources, store only the source descriptor in `credential-state.json`) and `/claude-subscription-import` (copy the selected blob to `imported-credentials.json`), without mutating Pi's generic `auth.json` or overriding built-in `anthropic`.
- Expanded `/claude-subscription-status` into local diagnostics for provider wiring, active provider, account, token freshness, refresh availability, and missing/expired credential errors.
- Improved auth-error surfacing: a failed forced OAuth refresh now reports an actionable error and states that no API-key fallback was attempted.
- Added `claude-sonnet-5` (1M context, 128k output, adaptive thinking, no fallback).
- Added `claude-fable-5` (1M context, 128k output, always-on adaptive thinking; `thinking` omitted when reasoning is off, sampling parameters never sent).
- Added Fable 5 server-side refusal fallback (`fallbacks: [{ model: "claude-opus-4-8" }]` + `server-side-fallback-2026-06-01`): one-round-trip retry, `fallback` block as replay boundary, `stop_details` category on terminal refusal, and retry-then-latch when the beta is rejected.
- Added `claude-opus-4-8` (1M context, 128k output, adaptive thinking, temperature omitted).
- Added an installed-vs-lockfile dependency-drift preflight (`src/dependency-drift.ts`) reporting `missing-from-lock`, `not-installed`, or `version-mismatch`, wired into `node --test` by `tests/dependency-drift.test.ts`.
- Added `docs/verification-gates.md` and `tests/dependency-drift.test.ts`, asserting Pi dependency lockstep, the Node `>=22.19.0` floor/`~22.19.0` typings, and the documented gate categories.
- Added a `SECURITY.md` threat model and the `docs/current-status.md` model compatibility matrix, with `tests/model-matrix.test.ts` asserting matrix/model sync and threat-model headings without secret-shaped values.

### Changed

- Terminal safety-classifier refusals now suggest switching "to a different model" instead of "to an Opus model".
- Aligned adaptive levels with Pi's names: `minimal`→Claude `low`, and `low`/`medium`/`high`/`xhigh`/`max` map directly; requires Pi ≥ 0.80.6, and old shifted-level users move up one Pi level (old `xhigh` → `max`).
- Trimmed native stream error diagnostics to load-bearing safe fields, removing request-shape/body/tool-schema telemetry.
- Corrected an overstated README safety guarantee: OAuth-only routing protects API-account billing only, extra usage is the subscription's own overage drawn through the same OAuth lane, and the account toggle at <https://claude.ai/settings/usage> is the only control.
- Documented the retry-path request-rebuild assessment in `docs/current-status.md`: both paths are bounded-rare and cheap, and it is not worth optimizing.
- Scoped the `interleaved-thinking-2025-05-14` beta to manual-budget thinking via a payload-driven header option; request bodies are unchanged.
- Memoized per-message Anthropic conversion with per-message `WeakMap`s (user messages, tool-result content, and tool-call-free assistant turns per model), leaving tool-call turns uncached and output byte-identical.
- Throttled incremental tool-input partial parsing: up to 16 KiB parses every delta, larger inputs re-parse only after 25% growth, with every delta still emitted and exact final parsing.
- Tool-input parsing now tries raw JSON before repaired/completed candidates.
- Native streaming uses one body no-progress watchdog per response and scans SSE frames without a full line array per frame.
- Credential loading caches a token by path (finite numeric `expiresAt` only, within the 5-minute near-expiry margin), invalidates on 401 force-refresh, and loads concurrently with payload conversion.
- Native tool requests now omit `tool_choice` (Anthropic `auto` default, parallel calls allowed) instead of forcing `disable_parallel_tool_use`.
- Deferred the cache-diagnostics fingerprint until after the response stream, removing it from time-to-first-token while keeping recorded fingerprints byte-identical.
- Added an explicit npm `files` allowlist and `npm pack --dry-run` assertions limiting the package to runtime source, extension entry, docs, README, changelog, and license.
- Advanced the dev/test toolchain in lockstep to Pi `0.78.1` (both Pi packages and the lockfile; `tsx` `^4.22.4`), because the nested `pi-ai` copy's private types fail `tsc` if only one is bumped.
- Startup/reload changelog notifications use Pi 0.78.1's optional `ctx.mode` to stay visible in the TUI without unsolicited RPC notifications, falling back to `ctx.hasUI`.
- Extracted partial `tool_use` JSON repair/parsing into `src/tool-json-arguments.ts` with unit tests, refreshing the indexes and `REPO_MAP.md`.
- Removed the unused `src/native-transport.ts` helper and its test.
- Tightened model/provider typing: exported the native compat type, removed the `MODELS as any` cast, and shared the `isRecord` guard.
- Pinned the dev/test toolchain to Pi `0.77.0` with an explicit `@earendil-works/pi-ai` devDependency and `peerDependencies` left `*`.
- Skipped the provider guard for mid-stream steers/queued follow-ups (`InputEvent.streamingBehavior`) while still guarding idle prompts.
- Documented that the registration placeholder `apiKey` must stay a non-`$` literal because Pi interpolates a leading `$`.
- Remapped adaptive-only Opus levels (`claude-opus-4-7`, `claude-opus-4-7-300k`, `claude-opus-4-8`) so Pi `minimal`/`low`/`medium`/`high`/`xhigh` send effort `low`/`medium`/`high`/`xhigh`/`max`.
- Moved the extension entry to `extensions/minimalcc-pi/index.ts` so Pi labels it `minimalcc-pi`, with no runtime behavior change.

### Fixed

- Omitted empty and whitespace-only text blocks alongside images while preserving nonempty text/image content.
- On macOS, Keychain credentials recover from a stale `.credentials.json` when file-based refresh fails, fixing the `HTTP 400` refresh loop, with refreshed credentials still persisted to the file.
- Normalized streamed `edit` tool calls into Pi's exact `{ path, edits: [{ oldText, newText }] }` schema, fixing `Validation failed for tool "edit"` aborts from stray item keys or a stringified `edits` array.
- Stream-stall errors now include safe progress diagnostics (ids, open-block count, active tool name, tool-input counts, usage) with no raw arguments, key names, paths, command strings, prompts, or credentials.
- SSE streams no longer abort active long tool-input generations at Pi's `timeoutMs` boundary; `timeoutMs` applies only to response-start aborts, with the body no-progress watchdog afterwards.
- Same-model assistant replay sends signed `thinking`/`redacted_thinking` byte-for-byte without sanitizing, trimming, or dropping signed-but-empty blocks.
- Tool requests use the standard Anthropic schema without `eager_input_streaming` or the fine-grained tool-streaming beta.
- Streamed tool input fails closed when the final non-empty `input_json_delta` is unparseable or not a JSON object, instead of collapsing to `{}`.
- `onResponse` now runs inside the request cleanup `try`, so a throwing hook releases the no-progress timeout and abort listener.

### Removed

- Removed the unused diagnostics/telemetry commands and modules (`/claude-subscription-usage`, `/claude-subscription-cache-diagnostics`, unreleased `/claude-subscription-microcompaction`, `src/native-usage-telemetry.ts`, `src/native-cache-diagnostics.ts`, `src/native-microcompaction*.ts`, `src/native-tool-call-diagnostics.ts`, their tests, the `PI_CLAUDE_MICROCOMPACT*` variables, and post-stream recording); redaction, the URL guard, the billing guard, and inline failure diagnostics are retained.
- Removed the undici keep-alive dispatcher (`src/native-fetch-dispatcher.ts`, `PI_CLAUDE_HTTP_KEEPALIVE_MS`) and the `undici` dependency; requests use `globalThis.fetch`.
- Removed Message Batches-only 300,000-token output beta plumbing (`output-300k-2026-03-24`).
- Removed the unused `CLAUDE_SUBSCRIPTION_OPUS_4_7_THINKING_LEVEL_MAP` alias.

## [0.1.0] - 2026-05-24

### Added

- Added best-effort startup/reload changelog notifications: the last seen package version is recorded under Pi's agent directory, fresh installs are skipped, and new versioned `CHANGELOG.md` sections display once after an update.
- Added a manifest/changelog regression test requiring the current `package.json` version to have a matching `## [x.y.z]` section.
- Added changelog-entry signatures so same-version Git package updates and legacy state still display the current versioned changelog once.
- Added `docs/rationale.md`, `docs/model-selection.md`, and `docs/slash-commands.md`, and listed them in `docs/INDEX.md`.

### Changed

- Added `claude-opus-4-7-300k`, a provider-local route with a 300,000-token Pi context window that sends native `claude-opus-4-7`.
- Audited public docs: refreshed index dates, documented all three slash commands, restored the thinking-block replay section, updated `REPO_MAP.md`'s docs tree, and corrected the `docs/rationale.md` `modelOverrides` note.
- Tightened `@types/node` to `~22.19.0`, added a Dependabot ignore rule for its minor/major updates, and pinned it from `^25.9.0` so typechecking cannot allow Node 25-only APIs (lockfile: `22.19.19`).
- Restructured the README from 17 H2 sections (~390 lines) to 10 focused sections (~190 lines), and set its content: tightened the intro, adopted Pi's *Pi package*/*extension* terminology (updating the package description and removing the `pi-extension` keyword), led verification with `/claude-subscription-status`, replaced `Use` with `How to use` (`/reload`, OAuth-vs-`/login`, credential isolation, the usage toggle, model verification, scoped cycling, mid-session switching, local commands), replaced the intermediate detailed slash-command/`changedSections` reference with a table linking to `docs/slash-commands.md`, consolidated the model list into the single `Model reference` table, pointed troubleshooting at `pi list`, updated the Node.js badge to `>=22`, and moved the rationale/comparison/native-provider/principles/Opus-4.6-vs-4.7/safety/token-cache/replay/inspecting-usage sections to `docs/rationale.md`, `docs/model-selection.md`, and `docs/current-status.md`.
- Documented model context windows, output caps, thinking metadata, request behavior, manual-vs-adaptive thinking (with Anthropic docs links), adaptive effort mapping, token/cache optimizations, thinking-block replay, and that `modelOverrides` do not override extension-registered providers; renamed the model-table column to `Output cap` and documented `max_tokens = min(requestedOutputTokens + thinkingBudget, output_cap)`.
- Updated the `docs/current-status.md` `Updated:` stamp from `2026-05-07` to `2026-05-18`.
- Raised the `engines.node` floor to `>=22.19.0` (from `>=20.6.0` via `>=22.0.0`), bumped `.nvmrc` to `22.19.0`, updated the README badge, and asserted the floor in tests.
- Migrated the upstream Pi scope from `@mariozechner/*` to `@earendil-works/*` across `package.json`, Dependabot config, docs, imports, and the lockfile.
- Appended the underlying `error.cause` to fetch-failure transport errors while still redacting secrets.
- Updated `REPO_MAP.md`, `INDEX.md`, and `docs/current-status.md` to include previously missing modules, tests, docs, `AGENTS.md`, and `CHANGELOG.md`, and annotated `docs/token-efficiency-todos.md` MUST DO items §2–§6 as completed in place.
- Updated registered output caps to Pi metadata (Haiku 4.5/Sonnet 4.6 at 64,000, Opus 4.6/4.7 at 128,000, Sonnet 4.6 kept at a 200,000-token context) while preserving the subscription-context policy, and added `compat.forceAdaptiveThinking` for Opus 4.7.
- Restored Opus context windows to 1,000,000 tokens while keeping Sonnet and Haiku at 200,000.
- Native requests now send `Content-Type: application/json` and standard Anthropic tool schemas.
- OAuth handling now force-refreshes and retries once on a 401, coalesces concurrent refreshes, and avoids overwriting another process's refreshed credentials.

### Fixed

- Fixed startup/reload changelog option resolution from the nested extension entry path.
- Corrected cache-diagnostics documentation to describe per-process salted SHA-256 fingerprints rather than HMAC.
- Documented Pi subagent usage and that bundled example agents specifying `claude-sonnet-4-5` must be changed to a supported provider-qualified model.
- Response-start watchdogs now default to 120s while the post-response body watchdog stays at 45s, avoiding false-positive startup timeouts.
- Native replay drops assistant `toolCall` blocks unless every call has a matching immediately-following `toolResult`, and skips orphan results.
- Native streams treat tool calls as provisional until a clean `message_stop`: failed streams drop `toolCall` blocks while preserving partial text, and no-progress handling covers stalled bodies and missing headers.
- Manual-budget models no longer send `budget_tokens >= max_tokens` when output is clamped, by reducing the budget to the `1024` minimum or omitting thinking.
