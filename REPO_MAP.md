# Repository map

Updated: 2026-05-06

## What this repo is

`minimalcc-pi` is a public Pi package that registers a native `claude-subscription` provider for Claude Code subscription/OAuth credentials. The repository intentionally stores no credentials.

The provider uses isolated native API id `claude-subscription-native` and a custom `streamSimple` implementation. It does not require a local proxy, Python virtual environment, or background service.

## Current request flow

```text
Pi CLI/session
  |
  | loads package extension from package.json -> pi.extensions: ./extensions
  v
extensions/claude-subscription.ts
  |  - attempts best-effort unregister of built-in anthropic provider
  |  - registers claude-subscription provider on isolated claude-subscription-native API
  |  - registers native streamSimple implementation
  |  - blocks known non-subscription Claude providers in the normal input path
  |  - shapes Anthropic request payloads before provider requests as a fallback layer
  v
src/native-stream-simple.ts
  |  - rejects non-claude-subscription providers before credential loading
  |  - converts Pi context/messages/tools/images/thinking into Anthropic Messages payloads
  |  - loads Claude Code OAuth credentials at request time
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
- Current model ids remain `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, and `claude-opus-4-7`.
- No credentials, OAuth tokens, API keys, `.credentials.json`, `.env`, runtime configs, or logs belong in git.
- Native requests use Claude Code OAuth from `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` or macOS Keychain fallback at runtime, refresh expired/near-expired OAuth tokens when a refresh token is available, and must not send `x-api-key`.
- Built-in Pi `anthropic` models may remain visible/selectable. Safety relies on provider/API isolation and runtime guards, not built-in removal.
- Pi currently swallows `before_provider_request` hook errors; that hook must not be documented as the sole safety boundary.
- The first Anthropic `system` block must be exactly: `You are Claude Code, Anthropic's official CLI for Claude.`
- The Claude Code identity must be a separate first text block, not concatenated with the Pi system prompt.
- Runtime must not depend on a local proxy, Python virtual environment, or background service.
- Public docs must not include live verification runbooks, one-off verification logs, or machine-specific setup notes.

## Component map

### Package and extension registration

- `package.json` exposes `./extensions` as the Pi extension directory.
- `extensions/claude-subscription.ts` is the runtime entry point used by Pi.
- `src/models.ts` lists current subscription-backed model IDs and the isolated native API id.

### Native provider path

- `src/credentials.ts` resolves, loads, refreshes, and persists Claude Code OAuth credentials from fake-testable paths, with macOS Keychain fallback.
- `src/native-headers.ts` builds OAuth-only Anthropic headers and intentionally omits API-key headers.
- `src/native-request.ts` builds native Anthropic Messages request parts, applies system shaping, and handles prompt-cache retention policy.
- `src/native-stream-simple.ts` converts Pi context to Anthropic payloads, guards provider identity before auth, streams/parses SSE, maps Pi assistant events, and fails closed on parser/contract errors.
- `src/native-transport.ts` is a mocked-testable non-stream POST helper used by tests.
- `src/anthropic-sse.ts` exports `parseAnthropicSse`, the first fail-closed safeguard layer that consumes Anthropic SSE bodies and reports redacted contract violations. See `docs/current-status.md` § "Stream and tool-call behavior" for the enumerated guard list and test coverage map.
- `src/redaction.ts` centralizes credential/header redaction.

### Test coverage map

- `tests/native-credentials.test.ts` covers fake credential-file loading, malformed/missing/empty tokens, expired-token refresh and persistence, macOS Keychain fallback boundaries, ANTHROPIC_* non-fallback behavior, and OAuth-only header construction.
- `tests/native-request.test.ts` covers native request construction, model IDs, system-block shaping, cache-control preservation, and no API-key headers.
- `tests/native-stream-simple.test.ts` covers provider guardrails, system prompt shaping through the stream path, Pi text/image/tool/thinking conversion, cache-retention policy, incremental SSE streaming, usage mapping, abort/error handling, secret redaction, and fail-closed parser/contract integration.
- `tests/native-transport.test.ts` covers mocked HTTP POST behavior, OAuth headers, non-2xx JSON/plain-text failures, fetch-level failures, request-id handling, redaction, and no localhost dependency.
- `tests/anthropic-sse.test.ts` covers fixture-driven SSE parsing, malformed JSON, out-of-order lifecycle frames, fine-grained tool-input deltas, contract violations, usage, thinking, and redaction.
- `tests/current-provider-system-shape.test.ts` covers extension/provider registration, isolated native API id, input/request guardrails, stale context behavior, status command messaging, stable model constants, and system shaping hooks.
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
- `docs/prompt-cache-live-verification.md` is a live, opt-in prompt-cache verification runbook.
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
│   ├── prompt-cache-live-verification.md
│   ├── token-efficiency-todos.md
│   └── why-system-blocks.md
├── extensions/
│   ├── INDEX.md
│   └── claude-subscription.ts
├── src/
│   ├── INDEX.md
│   ├── anthropic-sse.ts
│   ├── constants.ts
│   ├── credentials.ts
│   ├── models.ts
│   ├── native-headers.ts
│   ├── native-request.ts
│   ├── native-stream-simple.ts
│   ├── native-transport.ts
│   ├── redaction.ts
│   └── system-shape.ts
└── tests/
    ├── INDEX.md
    ├── anthropic-sse.test.ts
    ├── current-provider-system-shape.test.ts
    ├── native-credentials.test.ts
    ├── native-request.test.ts
    ├── native-stream-simple.test.ts
    ├── native-transport.test.ts
    ├── package-manifest.test.ts
    ├── redaction.test.ts
    └── system-shape.test.ts
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
