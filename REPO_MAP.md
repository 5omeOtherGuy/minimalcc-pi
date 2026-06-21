# Repository map

Updated: 2026-05-24

## What this repo is

`minimalcc-pi` is a public Pi package that registers a native `claude-subscription` provider for Claude Code subscription/OAuth credentials. The repository intentionally stores no credentials.

The provider uses isolated native API id `claude-subscription-native` and a custom `streamSimple` implementation. It does not require a local proxy, Python virtual environment, or background service.

## Current request flow

```text
Pi CLI/session
  |
  | loads package extension from package.json -> pi.extensions: ./extensions/minimalcc-pi
  v
extensions/minimalcc-pi/index.ts
  |  - attempts best-effort unregister of built-in anthropic provider
  |  - registers claude-subscription provider on isolated claude-subscription-native API
  |  - registers native streamSimple implementation
  |  - registers the local status slash command
  |  - blocks known non-subscription Claude providers in the normal input path
  |  - shapes Anthropic request payloads before provider requests as a fallback layer
  v
src/native-stream-simple.ts
  |  - rejects non-claude-subscription providers before credential loading
  |  - builds native payloads and uses src/native-message-conversion.ts for Pi message conversion
  |  - loads Claude Code OAuth credentials at request time
  |  - force-refreshes and retries once on 401/authentication errors
  |  - builds native Anthropic request
  |  - streams and parses Anthropic SSE response-body chunks
  v
src/native-request.ts / src/native-headers.ts / src/system-shape.ts
  |  - sends OAuth-only Anthropic headers; no x-api-key
  |  - makes system an Anthropic content-block array
  |  - places Claude Code identity as a separate first text block
  |  - preserves Pi prompt/cache-control on the following block
  v
https://api.anthropic.com/v1/messages
  |
  v
Anthropic Claude models via Claude Code subscription/OAuth path
```

## Critical invariants

- Provider id remains `claude-subscription`.
- Native API id remains `claude-subscription-native`.
- Current model ids remain `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-7-300k`, and `claude-opus-4-8`.
- No credentials, OAuth tokens, API keys, `.credentials.json`, `.env`, runtime configs, or logs belong in git.
- Native requests use Claude Code OAuth from `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` or macOS Keychain fallback at runtime, refresh expired/near-expired OAuth tokens when a refresh token is available, force-refresh and retry once on 401/authentication errors, and must not send `x-api-key`.
- Built-in Pi `anthropic` models may remain visible/selectable. Safety relies on provider/API isolation and runtime guards, not built-in removal.
- Pi currently swallows `before_provider_request` hook errors; that hook must not be documented as the sole safety boundary.
- The first Anthropic `system` block must be exactly: `You are Claude Code, Anthropic's official CLI for Claude.`
- The Claude Code identity must be a separate first text block, not concatenated with the Pi system prompt.
- Runtime must not depend on a local proxy, Python virtual environment, or background service.
- Public docs must not include live verification runbooks, one-off verification logs, or machine-specific setup notes.

## Component map

### Package and extension registration

- `package.json` exposes `./extensions/minimalcc-pi` as the Pi extension entry; Pi displays it as `minimalcc-pi` in its loaded-extensions list because the directory-with-`index.ts` layout compacts to the parent directory name.
- `extensions/minimalcc-pi/index.ts` is the runtime entry point used by Pi.
- `src/models.ts` lists current subscription-backed model IDs and the isolated native API id.

### Native provider path

- `src/credentials.ts` resolves, loads, refreshes, and persists Claude Code OAuth credentials from fake-testable paths, with macOS Keychain fallback, in-process refresh coalescing, and stale-write avoidance when another process refreshes first.
- `src/native-headers.ts` builds OAuth-only Anthropic headers and intentionally omits API-key headers.
- `src/native-request.ts` builds native Anthropic Messages request parts, applies system shaping, and handles prompt-cache retention policy.
- `src/native-message-conversion.ts` holds pure Pi message to Anthropic message-block conversion, including surrogate sanitization/memoization, same-model signed-thinking replay, safe tool-use id mapping, and immediate tool-result sequencing.
- `src/native-stream-simple.ts` guards provider identity before auth, builds native payloads with converted messages, streams/parses SSE, maps Pi assistant events, and fails closed on parser/contract errors.
- `src/native-tool-sequencing.ts` holds the shared Anthropic tool-sequencing predicates (which tool results are safe to send) consumed by `convertMessages` so the sequencing rules stay in one place.
- `src/tool-json-arguments.ts` is the pure repair/parser for partial Anthropic `tool_use` input JSON fragments, extracted from the stream path; incremental parsing remains best-effort, while final parsing fails closed when non-empty input is unparseable or not a JSON object.
- `src/edit-tool-arguments.ts` is a conservative, `edit`-specific argument normalizer applied after final tool-input parsing: it parses a stringified `edits` array and reduces each `{oldText, newText, ...}` item to exactly `{oldText, newText}`, so Anthropic-only malformed-but-recoverable `edit` calls satisfy Pi's `additionalProperties: false` edit schema instead of aborting; all other tools and top-level keys pass through untouched.
- `src/type-guards.ts` centralizes shared runtime type guards for unknown JSON/object inputs used across the native provider modules.
- `src/anthropic-sse.ts` exports `parseAnthropicSse`, the first fail-closed safeguard layer that consumes Anthropic SSE bodies and reports redacted contract violations. See `docs/current-status.md` § "Stream and tool-call behavior" for the enumerated guard list and test coverage map.
- `src/redaction.ts` centralizes credential/header redaction.
- `src/extension-changelog.ts` parses versioned changelog entries and tracks per-user startup/reload changelog notifications.

### Test coverage map

- `tests/native-credentials.test.ts` covers fake credential-file loading, malformed/missing/empty tokens, expired-token and force-refresh persistence, concurrent refresh coalescing, stale-write avoidance, macOS Keychain fallback boundaries, ANTHROPIC_* non-fallback behavior, and OAuth-only header construction.
- `tests/native-request.test.ts` covers native request construction, model IDs, system-block shaping, cache-control preservation, and no API-key headers.
- `tests/native-stream-simple.test.ts` covers provider guardrails, system prompt shaping through the stream path, Pi text/image/tool/thinking conversion, cache-retention policy, one-shot auth-error refresh/retry, incremental SSE streaming, usage mapping, abort/error handling, secret redaction, and fail-closed parser/contract integration.
- `tests/tool-json-arguments.test.ts` covers partial `tool_use` JSON argument repair/parsing in isolation: complete/empty input, truncated string/container recovery, control-character escaping, escape preservation/rewrite, partial-parser non-object/unrecoverable fallback to `{}`, final-parser fail-closed behavior, and reverse-order container completion.
- `tests/edit-tool-arguments.test.ts` covers the `edit`-specific argument normalizer in isolation: stripping stray per-item keys, parsing a stringified `edits` array, leaving malformed items/non-array edits unchanged, preserving empty edits and other top-level keys, and not mutating the input.
- `tests/native-tool-sequencing.test.ts` covers the shared tool-sequencing predicates and the `sentToolResultIndices` eligibility set (complete immediate sequences, orphans, non-replayable turns).
- `tests/live-opus46-routing.test.ts` is an opt-in live-credential routing check for Opus 4.6 and is skipped by default; the deterministic suite never runs it.
- `tests/anthropic-sse.test.ts` covers fixture-driven SSE parsing, malformed JSON, out-of-order lifecycle frames, fine-grained tool-input deltas, contract violations, usage, thinking, and redaction.
- `tests/current-provider-system-shape.test.ts` covers extension/provider registration, isolated native API id, input/request guardrails, stale context behavior, status command messaging, stable model constants, and system shaping hooks.
- `tests/extension-changelog.test.ts` covers versioned changelog parsing, per-user display state, same-version entry signatures, and package-root resolution from the extension entry path.
- `tests/system-shape.test.ts` covers pure prompt sanitizing and system-block shaping helpers.
- `tests/package-manifest.test.ts` covers Pi extension discovery metadata and credential-pattern absence in `package.json`.
- `tests/redaction.test.ts` covers direct redaction helper behavior for OAuth/API-key header patterns, exact known secrets, and bare-token limitations.

### System prompt shaping

- `src/constants.ts` contains the Claude Code identity string and doc-routing prefixes stripped from Pi prompts.
- `src/system-shape.ts` contains pure TypeScript shaping helpers used by the Pi extension and native request builder.
- `tests/system-shape.test.ts` covers pure helper behavior.
- `tests/current-provider-system-shape.test.ts` covers extension registration, request guards, visibility caveats, and provider hook behavior.

### Documentation

- `README.md` is the primary public user-facing document.
- `CONTRIBUTING.md` documents contributor workflow and deterministic test expectations.
- `SECURITY.md` documents security reporting and credential-handling expectations.
- `docs/current-status.md` is the public status/source of truth for implementation state, safety boundaries, verification scope, and known limitations.
- `docs/model-selection.md` explains why both Opus 4.6 and Opus 4.7 are exposed and how their thinking-control surfaces differ.
- `docs/prompt-cache-live-verification.md` is a live, opt-in prompt-cache verification runbook.
- `docs/rationale.md` records the harness-vs-model rationale and intended-use boundaries.
- `docs/slash-commands.md` is the exact output reference for the local `/claude-subscription-status` command.
- `docs/token-efficiency-todos.md` tracks candidate token/cache optimization work and implementation status.
- `docs/why-system-blocks.md` records compatibility notes for the required system-block shape.

## Source tree at a glance

```text
.
├── .editorconfig
├── .gitattributes
├── .github/
├── .gitignore
├── .nvmrc
├── AGENTS.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── INDEX.md
├── LICENSE
├── README.md
├── REPO_MAP.md
├── SECURITY.md
├── package.json
├── package-lock.json
├── tsconfig.json
├── docs/
│   ├── INDEX.md
│   ├── current-status.md
│   ├── model-selection.md
│   ├── prompt-cache-live-verification.md
│   ├── rationale.md
│   ├── slash-commands.md
│   ├── token-efficiency-todos.md
│   └── why-system-blocks.md
├── extensions/
│   ├── INDEX.md
│   └── minimalcc-pi/
│       └── index.ts
├── src/
│   ├── INDEX.md
│   ├── anthropic-sse.ts
│   ├── constants.ts
│   ├── credentials.ts
│   ├── models.ts
│   ├── native-headers.ts
│   ├── native-message-conversion.ts
│   ├── native-request.ts
│   ├── native-stream-simple.ts
│   ├── native-tool-sequencing.ts
│   ├── redaction.ts
│   ├── system-shape.ts
│   ├── edit-tool-arguments.ts
│   ├── tool-json-arguments.ts
│   ├── type-guards.ts
│   └── extension-changelog.ts
└── tests/
    ├── INDEX.md
    ├── anthropic-sse.test.ts
    ├── current-provider-system-shape.test.ts
    ├── extension-changelog.test.ts
    ├── live-opus46-routing.test.ts
    ├── native-credentials.test.ts
    ├── native-request.test.ts
    ├── native-stream-simple.test.ts
    ├── native-tool-sequencing.test.ts
    ├── package-manifest.test.ts
    ├── redaction.test.ts
    ├── system-shape.test.ts
    ├── edit-tool-arguments.test.ts
    └── tool-json-arguments.test.ts
```

## Verification entry points

- `npm test` — deterministic Node tests with fake credentials, static fixtures, mocked network/transport boundaries, and package/redaction guardrails.
- `npm run typecheck` — TypeScript compile check.
- `npm run check` — safe public gate: tests plus typecheck.

No verification command documented here is a live Anthropic request test.

## Ignored/generated paths

- `node_modules/` — npm dependencies.
- `.runtime/` — local runtime scratch state.
- `.local/`, `docs/internal/`, `scripts/local/` — ignored local/internal runbooks and helper material.
- `.credentials.json`, `.claude/`, `.env*`, `*.log`, `*.pid` — local config/secrets/runtime files.
