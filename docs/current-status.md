# Current status

Updated: 2026-09-22

## Stable public interface

- Provider id: `claude-subscription`
- Native API id: `claude-subscription-native`
- Model ids: `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-7-300k`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-sonnet-5`
- Slash commands: `/claude-subscription-status`, `/claude-subscription-accounts`, `/claude-subscription-import`

## Implementation state

The provider is a native Pi `streamSimple` implementation that builds Anthropic Messages requests directly, authenticated with Claude Code OAuth credentials loaded at request time. Runtime does not depend on a local proxy, Python virtual environment, or background service. Module responsibilities: [`REPO_MAP.md`](../REPO_MAP.md) and [`src/INDEX.md`](../src/INDEX.md).

## Request-shape baseline

- `Authorization: Bearer <Claude Code OAuth token>` is sent; `x-api-key` / `anthropic-api-key` are never sent.
- `anthropic-version` is `2023-06-01`.
- Base `anthropic-beta` values are `oauth-2025-04-20,claude-code-20250219`. `interleaved-thinking-2025-05-14` is appended only for manual-budget thinking models (`thinking.type === "enabled"`). `server-side-fallback-2026-06-01` is appended only when the payload carries `fallbacks`.
- Streaming uses the synchronous `/v1/messages` endpoint. No eager/fine-grained tool streaming and no Message Batches-only betas.
- Tool entries contain only `name`, `description`, `input_schema`, and optional `cache_control` on the final cached tool.
- `tool_choice` is omitted, so Anthropic applies its `auto` default and parallel tool calls are allowed. Pi's `edit`/`write` tools serialize same-file mutations through a per-realpath queue; the remaining race exposure matches Pi's and Claude Code's defaults.
- The `system` field is an Anthropic content-block array with the Claude Code identity as a separate first block.

## Model compatibility matrix

This matrix mirrors the `MODELS` constants in `src/models.ts`; `tests/model-matrix.test.ts` asserts the two stay in sync.

| Pi model id | Native model id | Context window | Max streaming tokens | Thinking mode | Notes |
|---|---|---:|---:|---|---|
| `claude-haiku-4-5` | `claude-haiku-4-5` | 200k | 64k | manual budget | |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | 200k | 64k | manual budget; no selectable `max` | |
| `claude-opus-4-6` | `claude-opus-4-6` | 1M | 128k | manual budget; no selectable `max` | |
| `claude-opus-4-7` | `claude-opus-4-7` | 1M | 128k | adaptive | |
| `claude-opus-4-7-300k` | `claude-opus-4-7` | 300k | 128k | adaptive | soft-cap alias; native request uses `claude-opus-4-7` |
| `claude-opus-4-8` | `claude-opus-4-8` | 1M | 128k | adaptive | |
| `claude-opus-5` | `claude-opus-5` | 1M | 128k | adaptive | |
| `claude-opus-5-5` | `claude-opus-5-5` | 1M | 128k | adaptive, always on; no Pi `off` (clamps to `minimal`); explicit effort every request | no refusal fallback |
| `claude-fable-5` | `claude-fable-5` | 1M | 128k | adaptive, always on; `thinking` omitted when reasoning is off | refusal fallback to `claude-opus-4-8` |
| `claude-fable-5-1` | `claude-fable-5-1` | 1M | 128k | adaptive, always on; `thinking` omitted when reasoning is off | refusal fallback to `claude-opus-5` |
| `claude-sonnet-5` | `claude-sonnet-5` | 1M | 128k | adaptive | 1M is the only context variant |

All models retain zero API cost metadata. Only `claude-opus-4-7-300k` diverges between Pi id and native model id.

## Adaptive thinking levels

All adaptive models enable native `max` (`thinkingLevelMap.max`) and use `thinking: { type: "adaptive", display: "summarized" }` when reasoning is enabled. Pi `minimal`/`low`/`medium`/`high`/`xhigh`/`max` map to Claude effort `low`/`low`/`medium`/`high`/`xhigh`/`max` (soft guidance, not a fixed budget). Pi `off` omits `thinking` and `output_config`; it does not guarantee server-side thinking is disabled, particularly on Fable and newer models.

`claude-opus-5-5` cannot run without thinking (explicit `disabled` and `budget_tokens` both 400), and the API's default effort is `medium`. It therefore uses `off: null`: Pi hides `off`, a persisted `off` is clamped to `minimal` (Claude `low`), and `contextToPayload` applies the same clamp when a request arrives without a level, so every Opus 5.5 request carries explicit adaptive thinking and effort. No refusal fallback is configured; `cyber`/`bio`/`reasoning_extraction` refusals end the turn with a descriptive error. Live verification on 2026-09-22 used `tests/live-opus-5-5.test.ts` (`PI_LIVE_CLAUDE_OPUS55_TEST=1`): a level-less request was accepted with explicit `low` effort, and a `high`-effort tool-use turn's signed thinking block replayed verbatim on the next turn.

## Manual thinking budgets

Manual-budget models are `claude-haiku-4-5`, `claude-sonnet-4-6`, and `claude-opus-4-6`. `contextToPayload` sends `max_tokens = min(requestedOutputTokens + thinkingBudget, output_cap)`: `requestedOutputTokens` is the visible-output ask, `thinkingBudget` maps Pi `minimal`/`low`/`medium`/`high`/`xhigh` to `1024`/`4096`/`10240`/`20480`/`32768`, and `output_cap` is the model's `maxTokens` (`64000` Haiku 4.5/Sonnet 4.6; `128000` Opus 4.6). This prevents `budget_tokens >= max_tokens` (a 400) when output is clamped, e.g. during Pi compaction; if the cap forces an invalid payload, the budget drops to Anthropic's `1024` minimum or thinking is omitted. `max` is not selectable on these models.

## Safety boundaries

- Built-in `anthropic` models may remain visible; visibility is not a safety boundary.
- Subscription models use the isolated `claude-subscription-native` API id rather than replacing Pi's shared `anthropic-messages` handler.
- The native stream rejects non-`claude-subscription` routing before loading credentials, and the input path blocks known non-subscription Claude providers (`anthropic`, `custom-anthropic`, `meridian`).
- Stale extension contexts fail closed for Claude-shaped request payloads; Pi swallows `before_provider_request` hook errors, so that hook is a fallback layer, not the only boundary.

## Credential handling

- Reads `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` and extracts `.claudeAiOauth.accessToken`; flat top-level `accessToken` remains accepted.
- Refreshes expired or near-expired credentials before the model request when `refreshToken` is present, then persists the refreshed file.
- On a 401/authentication rejection of a locally fresh token, force-refreshes from the credential store, rebuilds the request, and retries once. If the force-refresh fails, the provider surfaces an actionable error and does not retry through an API-key lane.
- Coalesces concurrent in-process refreshes for the same path and best-effort avoids overwriting a credential file when another process's refreshed token is observed after exchange and before persistence.
- On macOS, falls back to the `Claude Code-credentials` Keychain service when the file is absent; refreshed credentials are written to the standard credential-file path.
- Never reads or sends `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or `anthropic-api-key`.
- The registration `apiKey` is an inert non-`$` literal placeholder; Pi's config layer interprets a leading `$` as environment-variable interpolation.
- `/claude-subscription-accounts` stores only the selected source descriptor in `pi-claude-subscription/credential-state.json`; `/claude-subscription-import` copies the selected blob to `pi-claude-subscription/imported-credentials.json`. Neither mutates Pi's generic `auth.json`.

## Cache-retention behavior

Native requests add short ephemeral prompt-cache anchors by default to the shaped system blocks, the last user message block, and the last tool schema. Policy follows Pi's `cacheRetention` option: `short`/unset uses short ephemeral cache control; `long` uses `ttl: "1h"` only when `compat.supportsLongCacheRetention` is not `false`; `none` omits anchors while preserving the system-block shape. Unset also honors `PI_CACHE_RETENTION=long`.

## Stream and tool-call behavior

Parsing and application are fail-closed. The parser (`src/anthropic-sse.ts`) rejects malformed JSON, `error` frames, ordering/lifecycle violations (frames before `message_start`, duplicate `message_start`, block starts after `message_stop`, duplicate/unmatched starts and stops, end of stream without `message_stop`), `tool_use` blocks with empty `id`/`name` or non-object `input`, and `input_json_delta` outside a `tool_use` block. It emits a soft `contractViolation` for `stop_reason: "tool_use"` with no `tool_use` block. The applier (`src/native-stream-simple.ts`) re-checks the same invariants, rejects delta/block type mismatches and unsupported stop reasons, and surfaces a Pi `error` event instead of `done`.

Fine-grained tool-input deltas are parsed best-effort for live preview; the final parse fails closed when non-empty input is unparseable or not a JSON object. After the final parse, built-in `edit` arguments are normalized (`src/edit-tool-arguments.ts`) to exactly `{ path, edits: [{ oldText, newText }] }`; all other tools/keys pass through untouched.

Stream/transport errors include metadata-safe diagnostics only (status, ids, quota headers, event type, lifecycle flags, endpoint/auth, progress, usage) and never raw SSE, prompts, message text, tool schemas/arguments, paths, command strings, credentials, or authorization headers. Errored assistant messages drop incomplete tool-call blocks. Guard test coverage: [`tests/INDEX.md`](../tests/INDEX.md).

## Thinking-block replay across model switches

Signed thinking blocks are replayed only when the prior assistant message came from the exact same provider, native API id, and model id as the current model. Same model: signed visible thinking replays as `thinking` blocks and signed redacted thinking as `redacted_thinking`. Different subscription model or provider: visible thinking is preserved as ordinary assistant text and the signature is dropped. Redacted thinking from another model/provider is dropped. Same-model visible thinking without a `thinkingSignature` is dropped rather than replayed unsigned.

## Verification scope

Repository tests are deterministic: fake credentials/Keychain services/tokens, static fixtures, and mocked network boundaries. They do not make live Anthropic requests and do not read real credential files. They cover credential/config failures, multi-account discovery/selection/import, status diagnostics, refresh behavior, coalescing/stale-write avoidance, Keychain boundaries, OAuth-only headers, request/system shaping, cache retention, message conversion, auth retry, stream abort/error/timeout handling, SSE parsing, provider guardrails, package contents, and redaction. A full test inventory is in [`tests/INDEX.md`](../tests/INDEX.md).

```bash
npm test
npm run typecheck
npm run check
```

`npm run check` does not make live Anthropic requests. Focused gates and the Pi dependency lockstep policy: [`docs/verification-gates.md`](verification-gates.md).

## Known follow-ups

- Improve usage/converter parity with Pi's built-in Anthropic provider.
- Decide whether to surface silently dropped thinking-signature edge cases (cross-model redacted blocks; same-model blocks without a signature).
- Add session-stable latching if mid-session cache-retention changes hurt prompt-cache hit rates.
