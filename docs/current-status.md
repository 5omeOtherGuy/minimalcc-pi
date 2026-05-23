# Current status

Updated: 2026-05-23

## Stable public interface

- Provider id: `claude-subscription`
- Native API id: `claude-subscription-native`
- Model ids:
  - `claude-haiku-4-5`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6`
  - `claude-opus-4-7`

## Implementation state

The current implementation is a native Pi `streamSimple` provider that builds Anthropic Messages requests directly and authenticates with Claude Code OAuth credentials loaded at request time.

The repository no longer contains proxy configuration or service helpers. Runtime does not depend on a local proxy, Python virtual environment, or background service.

Primary implementation pieces:

- `extensions/claude-subscription.ts` registers the Pi provider, models, request-shaping hooks, and status command.
- `src/credentials.ts` resolves Claude Code credentials from the credentials file or macOS Keychain fallback, refreshes expired or rejected OAuth tokens, coalesces in-process refreshes, and avoids stale credential-file overwrites when another process refreshes first.
- `src/native-headers.ts` builds OAuth-only Anthropic headers, including `Content-Type: application/json`, and intentionally omits API-key headers.
- `src/native-request.ts` constructs Anthropic Messages requests, applies system-block shaping, and inserts prompt-cache anchors according to Pi cache-retention policy.
- `src/native-stream-simple.ts` maps Pi contexts/messages/tools into Anthropic payloads, uses per-tool `eager_input_streaming` by default with the legacy fine-grained tool-streaming beta as a compatibility fallback, and converts Anthropic SSE responses into Pi assistant events incrementally from the native response body.
- `src/native-transport.ts` is a mocked-testable non-stream Anthropic Messages POST helper used by transport-level tests; it carries OAuth-only headers, surfaces JSON and plain-text non-2xx errors, and never depends on a localhost service.
- `src/native-usage-telemetry.ts` records in-process input/output/cache-read/cache-write/total-token totals per `claude-subscription` response and renders the redacted summary surfaced by `/claude-subscription-usage`.
- `src/native-cache-diagnostics.ts` fingerprints request-shape sections (model, system, messages, tools, cache controls, body config) with a per-process HMAC salt and reports cache-read drops between comparable requests through `/claude-subscription-cache-diagnostics`, without storing prompt content, tool arguments, or credentials.
- `src/anthropic-sse.ts` parses complete or incremental Anthropic SSE frames and fails closed on stream lifecycle violations.

## Safety boundaries

- Built-in `anthropic` models may still be visible in Pi; model-list visibility is not treated as a safety boundary.
- Subscription models use the isolated `claude-subscription-native` API id rather than replacing Pi's shared `anthropic-messages` API handler.
- The supported path is selecting the `claude-subscription` provider, for example via a provider-qualified model such as `claude-subscription/claude-sonnet-4-6`.
- The native stream rejects non-`claude-subscription` provider routing before loading Claude Code OAuth credentials.
- Known non-subscription Claude provider selections are blocked in the normal input path.
- Stale extension contexts fail closed for Claude-shaped request payloads instead of passing through silently.
- Pi currently swallows `before_provider_request` hook errors as extension errors, so that hook is documented only as a fallback shaping/checking layer, not as the only blocking boundary.

## Credential handling

- Reads `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` and extracts `.claudeAiOauth.accessToken`.
- Refreshes expired or near-expired Claude Code OAuth credentials before the model request when `refreshToken` is present, then persists the refreshed credential file.
- If Anthropic rejects a locally fresh token with a 401/authentication error, force-refreshes from the current credential store, rebuilds the request, and retries once.
- Coalesces concurrent in-process refreshes for the same credential path and avoids overwriting a credential file that another process refreshed while the token exchange was in flight.
- On macOS, falls back to the `Claude Code-credentials` Keychain service when the credentials file is absent; if a Keychain credential needs refresh, the refreshed credentials are written to the standard credential-file path for subsequent requests.
- Never reads or sends `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or `anthropic-api-key`.
- Surfaced errors are redacted; tests assert fake OAuth tokens/API keys do not leak.

## Manual thinking budgets

Manual-thinking models (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`) compute the outgoing Anthropic `max_tokens` as `min(requestedOutputTokens + thinkingBudget, output_cap)`, where:

- `requestedOutputTokens` is the caller's `options.maxTokens` (treated as the visible-output ask, not the total request budget).
- `thinkingBudget` is the Pi thinking level mapped to `1024` / `4096` / `10240` / `20480` / `32768` (for `minimal` / `low` / `medium` / `high` / `xhigh`).
- `output_cap` is the per-model upper bound declared in `src/models.ts` (Haiku 4.5 and Sonnet 4.6: `64000`; Opus 4.6 and 4.7: `128000`).

This composition is what `contextToPayload` in `src/native-stream-simple.ts` actually sends. It exists so that Pi 0.75 compaction (which routes summary requests through the custom provider with `maxTokens ≈ 8192` while extension thinking budgets reach `20480`/`32768`) cannot produce `budget_tokens >= max_tokens`, which Anthropic rejects with `400 invalid_request_error`. When the per-model `output_cap` would force `max_tokens <= budget_tokens`, the thinking budget is reduced (down to Anthropic's `1024` minimum) or the thinking block is omitted entirely. Opus 4.7's adaptive-thinking path does not use this composition; the API allocates reasoning dynamically when thinking is enabled. Sonnet 4.6 intentionally keeps a 200,000-token context window because this package targets Claude Code subscription routing, not the larger Anthropic API-key window advertised by Pi's built-in metadata.

Covered by `manual-budget thinking ...` cases in `tests/native-stream-simple.test.ts`.

## Cache-retention behavior

Native requests add short ephemeral prompt-cache anchors by default to shaped system text blocks, the last user message block, and the last tool schema.

Cache policy follows Pi's `cacheRetention` option where available:

- `short` or unset: use Anthropic short ephemeral cache control.
- `long`: use `ttl: "1h"` only when the selected model's `compat.supportsLongCacheRetention` is not `false`.
- `none`: omit cache-control anchors while preserving the required Claude Code system-block shape.

For compatibility with Pi's built-in Anthropic provider, unset `cacheRetention` also honors `PI_CACHE_RETENTION=long`.

## Stream and tool-call behavior

Two layers of fail-closed guards protect every Anthropic Messages stream.

### Parser layer (`src/anthropic-sse.ts`, `parseAnthropicSse`, `parseAnthropicSseStream`)

`parseAnthropicSse` and the incremental `parseAnthropicSseStream` share the same parser state machine and reject the response with a redacted `AnthropicSseParseError` when any of the following occur:

- Malformed JSON in an SSE frame's `data:` payload.
- An `event: error` frame, or a frame whose JSON `type` is `error`.
- Any frame other than `message_start` arriving before any `message_start`.
- A duplicate `message_start` while a previous message is still open.
- A `content_block_start` after `message_stop`.
- A duplicate `content_block_start` for an already-open block index.
- A `tool_use` content block with empty `id` or `name`.
- A `tool_use` content block whose `input` is present and is not a JSON object.
- A `content_block_delta` without a matching `content_block_start`.
- An `input_json_delta` outside a `tool_use` block.
- A `content_block_stop` without a matching `content_block_start`.
- A `message_stop` while one or more content blocks are still open.
- End of stream without `message_stop`.

The parser additionally emits a soft `contractViolation` event (not a throw) when `stop_reason: "tool_use"` arrives without any `tool_use` content block; the stream applier promotes that to an error.

### Stream applier (`src/native-stream-simple.ts`, `streamNativeClaudeSubscription`)

After parsing, the applier re-checks the same lifecycle invariants while events are applied to the Pi assistant message and additionally rejects:

- A delta whose type does not match the open block (e.g. `text_delta` against a `tool_use` block, `signature_delta` outside a `thinking` block).
- A `content_block_stop` for an unknown internal block index.
- A `contractViolation` event surfaced by the parser.
- A final `stopReason` mapped to `error` or any unsupported value, surfaced as "Anthropic stream ended with an unsupported stop reason".

Fine-grained tool-input deltas preserve raw partial JSON and are converted with best-effort repair/partial completion for Pi tool-call arguments. Any guard above surfaces a Pi `error` event in place of a `done` event.

### Test coverage map

| Guard | Test |
|---|---|
| Anthropic `error` SSE frame | `tests/anthropic-sse.test.ts: throwsOnAnthropicSseErrorEventWithRedaction`, `throwsOnAnthropicSseTypeErrorWithoutEventName` |
| Truncated stream without `message_stop` (parser) | `throwsOnTruncatedStreamWithoutMessageStop` |
| Stream without any `message_start` | `throwsOnStreamWithoutMessageStart` |
| Duplicate `message_start` | `throwsOnDuplicateMessageStartBeforeMessageStop` |
| `content_block_start` after `message_stop` | `throwsOnContentBlockStartAfterMessageStop` |
| `input_json_delta` outside tool_use | `throwsOnInputJsonDeltaForTextBlock` |
| `tool_use` empty id or name (parser) | `throwsOnToolUseMissingIdOrName` |
| Open block at `message_stop` (parser) | `throwsOnToolUseMissingContentBlockStopBeforeMessageStop` |
| Malformed SSE without secret leakage | `handlesMalformedSseWithoutSecretLeakage` |
| `stop_reason=tool_use` without tool_use block (soft event) | `handlesToolUseStopWithNoToolUseBlock` |
| Best-effort partial-JSON tolerance (parser) | `preservesMalformedFineGrainedToolInputDeltasWithoutFailingSseParse` |
| Applier rejects parser `contractViolation` | `tests/native-stream-simple.test.ts: failsClosedWhenParserReportsContractViolation` |
| Applier rejects missing `message_stop` | `failsClosedWhenParsedEventsMissMessageStop` |
| Applier rejects open content block at `message_stop` | `failsClosedWhenParsedToolCallMissesContentBlockStop` |
| Applier rejects `tool_use` empty id/name | `failsClosedOnParsedToolCallMissingRequiredIdOrName` |
| Applier wraps parser errors with redaction | `emitsErrorWhenSseParserFailsWithoutSecretLeakage` |
| Applier redacts bare OAuth tokens via `knownSecrets` | `redactsBareOauthTokenFromStreamErrorsViaKnownSecrets` |
| Applier tolerates malformed partial-JSON in tool args | `toleratesMalformedFineGrainedToolInputJsonFromParsedEvents` |

Guards not listed in the mapping table above — duplicate `content_block_start` for an open index, `tool_use` non-object input, `content_block_delta` / `content_block_stop` without a matching start, signature/text/tool delta on the wrong block type, and the post-loop missing-`message_start` check — are exercised indirectly through fixture-driven scenarios in the same two test files.

The default transport path reads `response.body` and feeds SSE frames to the parser incrementally. The legacy `streamNativeMessagesSse` helper still returns full SSE text for tests or external callers that need the older string contract.

## Verification scope

Repository tests are deterministic. They use fake credential files, fake tokens, static fixtures, and mocked network/transport boundaries; they do not make live Anthropic requests and do not intentionally read real credential files.

The suite covers credential/config failure modes, expired and force-refreshed OAuth tokens, concurrent refresh coalescing, stale-write avoidance when another process refreshes first, macOS Keychain and non-darwin boundaries, OAuth-only header construction, request/system shaping, cache-retention policy, Pi message conversion edges (empty turns, images, coalesced tool results, thinking replay), one-shot auth-error retry, stream abort/error handling, incremental and full-text Anthropic SSE parsing, provider/model guardrails, package manifest integrity, and redaction of OAuth/API-key-shaped secrets.

Maintainer checks:

```bash
npm test
npm run typecheck
npm run check
```

`npm run check` is deterministic and does not make live Anthropic requests. Live verification procedures and machine-specific verification logs are intentionally kept outside tracked public files; use ignored local paths such as `.local/` when needed.

## Known follow-ups

- Continue improving usage/converter parity with Pi's built-in Anthropic provider.
- Decide how to surface the thinking-signature edge cases that are currently silently dropped during Anthropic replay (`src/native-stream-simple.ts: convertAssistantMessage`):
  - Cross-provider or different-model `redacted` thinking blocks (no visible text, opaque signature cannot be replayed safely).
  - Same-model thinking blocks without a `thinkingSignature`, e.g. from partial or aborted prior responses.
  Both are intentional fail-closed behaviors; the open question is whether Pi should expose them (diagnostic event, warning, or opt-in replay) rather than dropping them silently.
- Add session-stable latching if cache-retention policy changes within a live session prove to break prompt-cache hit rates.
