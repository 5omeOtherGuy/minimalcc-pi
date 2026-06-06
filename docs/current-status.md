# Current status

Updated: 2026-06-06

## Stable public interface

- Provider id: `claude-subscription`
- Native API id: `claude-subscription-native`
- Model ids:
  - `claude-haiku-4-5`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6`
  - `claude-opus-4-7`
  - `claude-opus-4-7-300k`
  - `claude-opus-4-8`

## Implementation state

The current implementation is a native Pi `streamSimple` provider that builds Anthropic Messages requests directly and authenticates with Claude Code OAuth credentials loaded at request time.

The repository no longer contains proxy configuration or service helpers. Runtime does not depend on a local proxy, Python virtual environment, or background service.

Primary implementation pieces:

- `extensions/minimalcc-pi/index.ts` registers the Pi provider, models, request-shaping hooks, and the three local slash commands documented in [`slash-commands.md`](slash-commands.md). The directory-with-`index.ts` layout makes Pi label the extension `minimalcc-pi` in its loaded-extensions list.
- `src/credentials.ts` resolves Claude Code credentials from the credentials file or macOS Keychain fallback, refreshes expired or rejected OAuth tokens, coalesces in-process refreshes, and best-effort avoids stale credential-file overwrites when another process's refreshed token is observed before persistence.
- `src/native-headers.ts` builds OAuth-only Anthropic headers, including `Content-Type: application/json`, intentionally omits API-key headers, and can opt into Anthropic's Message Batches-only `output-300k-2026-03-24` beta header when a batch caller asks for it.
- `src/models.ts` lists the subscription-backed model ids and records batch-only 300,000-token output compatibility metadata for Sonnet 4.6 and Opus 4.6/4.7/4.8 without changing their synchronous streaming output caps.
- `src/native-request.ts` constructs Anthropic Messages requests, applies system-block shaping, and inserts prompt-cache anchors according to Pi cache-retention policy.
- `src/native-stream-simple.ts` maps Pi contexts/messages/tools into Anthropic payloads, emits standard Anthropic tool schemas (`name`, `description`, `input_schema`) without eager or fine-grained tool-input streaming request flags, and converts Anthropic SSE responses into Pi assistant events incrementally from the native response body.
- `src/native-usage-telemetry.ts` records in-process input/output/cache-read/cache-write/total-token totals per `claude-subscription` response and renders the redacted summary surfaced by `/claude-subscription-usage`.
- `src/native-cache-diagnostics.ts` fingerprints request-shape sections (model, system, messages, tools, cache controls, body config) with a per-process salted SHA-256 hash and reports cache-read drops between comparable requests through `/claude-subscription-cache-diagnostics`, without storing prompt content, tool arguments, or credentials.
- `src/native-tool-call-diagnostics.ts` records bounded in-process metadata-only tool-call outcomes for maintainers: model, response/session ids, tool name, argument byte length, delta chunk count, top-level key count, and final outcome. It never stores raw tool arguments, key names, file paths, command strings, prompt text, snippets, credentials, or raw JSON. No slash command exposes this yet.
- `src/anthropic-sse.ts` parses complete or incremental Anthropic SSE frames and fails closed on stream lifecycle violations.
- `src/extension-changelog.ts` parses versioned changelog entries and records per-user display state for best-effort startup/reload update notifications.

## Request-shape baseline

Streaming Anthropic Messages requests intentionally use Claude Code OAuth headers and the standard tool schema:

- `Authorization: Bearer <Claude Code OAuth token>` is sent.
- `x-api-key` / `anthropic-api-key` are never sent.
- `anthropic-version` is `2023-06-01`.
- Base `anthropic-beta` values are `oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14`.
- Streaming requests do not include eager/fine-grained tool streaming, token-efficient-tools, or Message Batches-only 300k-output betas.
- Tool entries contain only `name`, `description`, `input_schema`, and optional `cache_control` on the final cached tool.

`minimalcc-pi` intentionally sets `tool_choice: { type: "auto", disable_parallel_tool_use: true }` when tools are present. This diverges from Claude Code 2.1.165, which does not set `disable_parallel_tool_use` and therefore allows parallel tool calls by default. Keeping `type: "auto"` remains Anthropic-schema-compatible with extended thinking; the tradeoff is throughput, not correctness. The serial choice is kept to reduce provider/tool-call ambiguity unless future evidence shows safety is no longer worth the throughput cost.

## Safety boundaries

- Built-in `anthropic` models may still be visible in Pi; model-list visibility is not treated as a safety boundary.
- Subscription models use the isolated `claude-subscription-native` API id rather than replacing Pi's shared `anthropic-messages` API handler.
- The supported path is selecting the `claude-subscription` provider, for example via a provider-qualified model such as `claude-subscription/claude-sonnet-4-6`.
- The native stream rejects non-`claude-subscription` provider routing before loading Claude Code OAuth credentials.
- Known non-subscription Claude provider selections are blocked in the normal input path.
- Stale extension contexts fail closed for Claude-shaped request payloads instead of passing through silently.
- Pi currently swallows `before_provider_request` hook errors as extension errors, so that hook is documented only as a fallback shaping/checking layer, not as the only blocking boundary.

## Credential handling

- Reads `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json` and extracts `.claudeAiOauth.accessToken`; flat top-level `accessToken` remains accepted for compatibility with older observed credential shapes.
- Refreshes expired or near-expired Claude Code OAuth credentials before the model request when `refreshToken` is present, then persists the refreshed credential file.
- If Anthropic rejects a locally fresh token with a 401/authentication error, force-refreshes from the current credential store, rebuilds the request, and retries once.
- Coalesces concurrent in-process refreshes for the same credential path and best-effort avoids overwriting a credential file when another process's refreshed token is observed after token exchange and before persistence.
- On macOS, falls back to the `Claude Code-credentials` Keychain service when the credentials file is absent; if a Keychain credential needs refresh, the refreshed credentials are written to the standard credential-file path for subsequent requests.
- Never reads or sends `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `x-api-key`, or `anthropic-api-key`.
- Surfaced errors are redacted; tests assert fake OAuth tokens/API keys, malformed credential blobs, refresh-token response bodies, and Keychain contents/errors do not leak.
- The provider registration's `apiKey` is an inert placeholder; OAuth is loaded at request time and no `x-api-key` is sent. As of Pi 0.77.0 (#5095), Pi's config layer resolves provider key/header strings as literals but interprets a leading `$` as environment-variable interpolation (`$VAR` / `${VAR}`, with `$!` bang-escaping). The placeholder must therefore stay a non-`$` literal so it is never accidentally interpolated from the environment.

## Manual thinking budgets

Manual-thinking models (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`) compute the outgoing Anthropic `max_tokens` as `min(requestedOutputTokens + thinkingBudget, output_cap)`, where:

- `requestedOutputTokens` is the caller's `options.maxTokens` (treated as the visible-output ask, not the total request budget).
- `thinkingBudget` is the Pi thinking level mapped to `1024` / `4096` / `10240` / `20480` / `32768` (for `minimal` / `low` / `medium` / `high` / `xhigh`).
- `output_cap` is the per-model upper bound declared in `src/models.ts` (Haiku 4.5 and Sonnet 4.6: `64000`; Opus 4.6, 4.7, and 4.8: `128000`).

This composition is what `contextToPayload` in `src/native-stream-simple.ts` actually sends. It exists so that Pi 0.75 compaction (which routes summary requests through the custom provider with `maxTokens ≈ 8192` while extension thinking budgets reach `20480`/`32768`) cannot produce `budget_tokens >= max_tokens`, which Anthropic rejects with `400 invalid_request_error`. When the per-model `output_cap` would force `max_tokens <= budget_tokens`, the thinking budget is reduced (down to Anthropic's `1024` minimum) or the thinking block is omitted entirely. Opus 4.7 and 4.8 adaptive-thinking paths do not use this composition; the API allocates reasoning dynamically when thinking is enabled. Anthropic's `output-300k-2026-03-24` beta applies to the Message Batches API, not this streaming `/v1/messages` path, so these output caps remain the enforced synchronous caps. Sonnet 4.6 intentionally keeps a 200,000-token context window because this package targets Claude Code subscription routing, not the larger Anthropic API-key window advertised by Pi's built-in metadata.

Covered by `manual-budget thinking ...` cases in `tests/native-stream-simple.test.ts`.

Adaptive-only Opus models (`claude-opus-4-7`, `claude-opus-4-7-300k`, `claude-opus-4-8`) use `thinking: { type: "adaptive", display: "summarized" }` when Pi reasoning is enabled and map Pi `minimal` / `low` / `medium` / `high` / `xhigh` to Claude `effort` `low` / `medium` / `high` / `xhigh` / `max`.

## Cache-retention behavior

Native requests add short ephemeral prompt-cache anchors by default to shaped system text blocks, the last user message block, and the last tool schema.

Cache policy follows Pi's `cacheRetention` option where available:

- `short` or unset: use Anthropic short ephemeral cache control.
- `long`: use `ttl: "1h"` only when the selected model's `compat.supportsLongCacheRetention` is not `false`.
- `none`: omit cache-control anchors while preserving the required Claude Code system-block shape.

For compatibility with Pi's built-in Anthropic provider, unset `cacheRetention` also honors `PI_CACHE_RETENTION=long`.

## Stream and tool-call behavior

Two layers of fail-closed guards protect every Anthropic Messages stream. Tool-call diagnostics are deliberately metadata-only and local/in-process; slash-command surfacing is deferred until there is a concrete maintainer UX need.

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
| Malformed SSE without secret/payload leakage | `handlesMalformedSseWithoutSecretOrPayloadLeakage` |
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

## Thinking-block replay across model switches

Anthropic thinking signatures are provider/model continuity data, not generic Pi message metadata. The native converter in `src/native-stream-simple.ts` therefore replays signed thinking blocks only when the prior assistant message came from the exact same provider, native API id, and model id as the currently selected subscription model.

Replay rules:

- Same provider + same native API id + same model id: replay signed visible thinking as Anthropic `thinking` blocks and signed redacted thinking as `redacted_thinking` blocks.
- Same provider but different subscription model, or any other provider/API: preserve non-redacted visible thinking as ordinary assistant text and drop the original signature.
- Redacted thinking from another provider/model is dropped because it has no visible text and its opaque signature cannot be replayed safely.
- Same-model visible thinking without a `thinkingSignature` is dropped rather than replayed unsigned; this can happen after partial or aborted prior responses.

This keeps mid-session switches safe: visible reasoning can remain available as plain text across providers/models, but foreign or incomplete Anthropic signatures are never sent back to the API.

## Verification scope

Repository tests are deterministic. They use fake credential files, fake tokens, static fixtures, and mocked network/transport boundaries; they do not make live Anthropic requests and do not intentionally read real credential files.

The suite covers credential/config failure modes, expired and force-refreshed OAuth tokens, concurrent refresh coalescing, best-effort stale-write avoidance when another process refreshes first and is observed before persistence, macOS Keychain and non-darwin boundaries, OAuth-only header construction, request/system shaping, cache-retention policy, Pi message conversion edges (empty turns, images, coalesced tool results, thinking replay), one-shot auth-error retry, stream abort/error handling, incremental and full-text Anthropic SSE parsing, provider/model guardrails, package manifest integrity, and redaction of OAuth/API-key-shaped secrets.

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
