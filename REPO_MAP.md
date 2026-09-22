# Repository map

Updated: 2026-09-22

## What this repo is

`minimalcc-pi` is a public Pi package that registers a native `claude-subscription` provider for Claude Code subscription/OAuth credentials. It stores no credentials. The provider uses the isolated native API id `claude-subscription-native` and a custom `streamSimple` implementation; it does not require a local proxy, Python virtual environment, or background service.

## Request flow

```text
Pi CLI/session
  | loads package extension from package.json -> pi.extensions: ./extensions/minimalcc-pi
  v
extensions/minimalcc-pi/index.ts
  |  - best-effort unregister of built-in anthropic provider
  |  - registers claude-subscription on claude-subscription-native with native streamSimple
  |  - registers the status/account/import slash commands
  |  - blocks known non-subscription Claude providers in the input path
  |  - shapes request payloads via the before_provider_request fallback
  v
src/native-stream-simple.ts
  |  - rejects non-claude-subscription providers before credential loading
  |  - loads Claude Code OAuth credentials; force-refreshes and retries once on 401
  |  - delegates payload shaping, raw fetch/SSE transport, and event application
  v
src/native-payload.ts / src/native-message-conversion.ts / src/native-request.ts / src/native-headers.ts / src/system-shape.ts
  |  - converts Pi context/messages/tools/thinking into Anthropic payload fields
  |  - sends OAuth-only headers (no x-api-key)
  |  - builds system as a content-block array with the Claude Code identity first
  v
src/native-stream-transport.ts
  |  - refuses non-Anthropic Messages URLs before fetch
  |  - applies response-start/no-progress watchdogs
  |  - fetches and parses Anthropic SSE response-body chunks
  v
https://api.anthropic.com/v1/messages -> Anthropic Claude models via the subscription/OAuth path
```

## Critical invariants

- Provider id is `claude-subscription`; native API id is `claude-subscription-native`.
- Registered model ids: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-7-300k`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-sonnet-5`.
- No credentials, OAuth tokens, API keys, `.credentials.json`, `.env`, runtime configs, or logs belong in git.
- Native requests use Claude Code OAuth from `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` or the macOS Keychain fallback, refresh expired/near-expired tokens, force-refresh and retry once on 401, and must not send `x-api-key`.
- Built-in Pi `anthropic` models may remain visible/selectable; safety relies on provider/API isolation and runtime guards, not built-in removal.
- Pi swallows `before_provider_request` hook errors; that hook must not be documented as the sole safety boundary.
- The first Anthropic `system` block must be exactly `You are Claude Code, Anthropic's official CLI for Claude.`, as a separate first text block (not concatenated with the Pi prompt).
- Runtime must not depend on a local proxy, Python virtual environment, or background service.
- Public docs must not include live verification runbooks, one-off verification logs, or machine-specific setup notes.

## Component map

Module-by-module responsibilities are in [`src/INDEX.md`](src/INDEX.md); the test inventory is in [`tests/INDEX.md`](tests/INDEX.md). Registration and request flow are shown above.

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
│   ├── verification-gates.md
│   └── why-system-blocks.md
├── extensions/
│   ├── INDEX.md
│   └── minimalcc-pi/
│       └── index.ts
├── src/
│   ├── INDEX.md
│   ├── anthropic-sse.ts
│   ├── constants.ts
│   ├── credential-accounts.ts
│   ├── credentials.ts
│   ├── dependency-drift.ts
│   ├── edit-tool-arguments.ts
│   ├── extension-changelog.ts
│   ├── models.ts
│   ├── native-headers.ts
│   ├── native-message-conversion.ts
│   ├── native-payload.ts
│   ├── native-request.ts
│   ├── native-stream-events.ts
│   ├── native-stream-simple.ts
│   ├── native-stream-transport.ts
│   ├── native-tool-sequencing.ts
│   ├── redaction.ts
│   ├── system-shape.ts
│   ├── tool-json-arguments.ts
│   └── type-guards.ts
└── tests/
    ├── INDEX.md
    ├── anthropic-sse.test.ts
    ├── credential-accounts.test.ts
    ├── current-provider-system-shape.test.ts
    ├── dependency-drift.test.ts
    ├── edit-tool-arguments.test.ts
    ├── extension-changelog.test.ts
    ├── live-opus-5-5.test.ts
    ├── live-opus46-routing.test.ts
    ├── model-matrix.test.ts
    ├── native-convert-messages-memo.test.ts
    ├── native-credentials.test.ts
    ├── native-fable-5.test.ts
    ├── native-new-models.test.ts
    ├── native-opus-5-5.test.ts
    ├── native-request-golden.test.ts
    ├── native-request.test.ts
    ├── native-stream-simple.test.ts
    ├── native-thinking-levels.test.ts
    ├── native-tool-sequencing.test.ts
    ├── package-manifest.test.ts
    ├── redaction.test.ts
    ├── system-shape.test.ts
    └── tool-json-arguments.test.ts
```

## Verification entry points

- `npm test` — deterministic Node tests with fake credentials, fixtures, and mocked network boundaries.
- `npm run typecheck` — TypeScript compile check.
- `npm run check` — tests plus typecheck.

None of these is a live Anthropic request test.

## Ignored/generated paths

- `node_modules/`, `.runtime/`, `.local/`, `docs/internal/`, `scripts/local/`, `.credentials.json`, `.claude/`, `.env*`, `*.log`, `*.pid`.
