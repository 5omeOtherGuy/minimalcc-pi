# Report: Claude/Anthropic `edit` Tool Errors in Recent Pi Sessions

## Purpose

This report explains the recurring `edit` tool failures seen while using Anthropic
Claude models (mainly `claude-subscription/claude-opus-4-8`) and maps each failure
to a concrete root cause and to the layer that owns it.

The investigation used the native Pi agent (`earendil-works/pi-mono`, `main` at
`89a92207`, ahead of the released `v0.78.1`) as reference context, and
cross-checked the conclusions against this checkout's locally installed
`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` `0.77.0`. Evidence
comes from prior redacted/static investigation artifacts, the `minimalcc-pi`
provider source, and the Pi-core `edit` tool / tool-validation code. Do not read
raw credential/session logs when updating this report.

## Executive summary (what changed from the first draft)

The original draft suspected the `minimalcc-pi` provider was corrupting tool
arguments (silent `{}`, transport-mangled JSON). The evidence does not support
that for the current code. After updating the reference repo and reading the raw
sessions, the corrected picture is:

- **Almost every reported `edit` failure is model behavior, not a provider
  transport bug.** The `edit` tool, its schema, its `prepareArguments`
  coercions, its argument validation, and its text matching all live in **Pi
  core**, not in `minimalcc-pi`. `minimalcc-pi` only streams the model's bytes
  and faithfully reconstructs the tool-call arguments.
- The native Pi Anthropic provider reconstructs tool arguments the **same way**
  we do (parse accumulated `input_json_delta` into `block.arguments`) and does
  **not** sanitize them. So switching providers would not change these outcomes.
- The two transport-adjacent risks the first draft worried about are **already
  fixed** in `minimalcc-pi` (see "Existing mitigations"), and they are guarded by
  regression tests.
- The dominant *remaining* live failure — extra annotation keys such as
  `newText_x` — is **valid JSON the model chose to emit**, rejected by Pi-core
  validation as a **recoverable** tool-result error that the model then
  self-corrects. There is no correct provider-side code fix for it; a provider
  "stripper" would diverge from native Pi and from Pi-core's deliberate
  reject-don't-strip philosophy, and would hide model bugs.

Outcome of this report:

- The report is corrected to reflect the above.
- A regression/anti-sanitizer test was added pinning the provider's pass-through
  contract (`tests/tool-json-arguments.test.ts` →
  `preservesModelEmittedExtraKeysInsteadOfStrippingThem`).
- **No behavioral provider change** is warranted; the existing deliberate
  divergences from native Pi are correct and are kept.

## How the reference (native Pi) handles tool input

Key reference files in `pi-mono`:

- `packages/ai/src/providers/anthropic.ts` — the Anthropic provider.
  - Reconstructs `tool_use` arguments from streamed `input_json_delta`
    fragments using `parseStreamingJson` for **both** incremental deltas and the
    **final** value at `content_block_stop`. `parseStreamingJson` **never
    throws**: it tries `JSON.parse` (+ a literal/escape repair), then the
    `partial-json` library, then repaired `partial-json`, then falls back to
    `{}`.
  - For standard Anthropic it sets `eager_input_streaming: true` per tool (the
    `fine-grained-tool-streaming-2025-05-14` beta header is the legacy
    equivalent). Eager / fine-grained streaming makes Anthropic emit **raw,
    possibly-incomplete** tool JSON instead of buffering until the JSON is valid;
    that is why the reference parses defensively.
- `packages/coding-agent/src/core/tools/edit.ts` — the Pi-core `edit` tool.
  - `prepareEditArguments` runs **before** validation and coerces two known
    model mistakes: a **stringified** `edits` (`typeof edits === "string"` →
    `JSON.parse` → array) and a **legacy** top-level `oldText`/`newText`
    (wrapped into `edits[]`). It does **not** strip unknown/extra keys.
  - Schema is `additionalProperties: false` on both the call object and each
    `edits[]` item, with descriptive prompt text/guidelines telling the model to
    emit exactly `oldText` and `newText`.
- `packages/ai/src/utils/validation.ts` — `validateToolArguments`.
  - Coerces primitive types, but for a TypeBox `additionalProperties: false`
    schema it **rejects** extra properties (it does not silently strip them).
  - On failure it throws a formatted `Validation failed for tool "edit": ...`
    error which the agent loop turns into a **recoverable tool-result error**
    (the model sees it and can retry), not a crash.

The installed `0.77.0` edit tool matches this (verified: `prepareEditArguments`
with stringified-`edits` coercion at `dist/core/tools/edit.js`, schema
`additionalProperties: false`, and `edits must contain at least one
replacement`).

## How `minimalcc-pi` handles tool input (and where it diverges, on purpose)

- `src/anthropic-sse.ts` parses Anthropic SSE into events, emitting
  `toolUseInputDelta { index, partialJson }` per `input_json_delta`.
- `src/native-stream-simple.ts` accumulates `partialJson` per content block and
  reconstructs `block.arguments`:
  - per-delta via `parseToolArgumentsFromJson` (best-effort; returns `{}` on
    unrecoverable input — used only for live preview);
  - at `content_block_stop` via `parseFinalToolArgumentsFromJson`.
- `src/tool-json-arguments.ts` implements a hand-rolled repair (string-literal
  escaping + container completion). Unlike the reference it does **not** depend
  on `partial-json`, and the **final** parser deliberately **fails closed**
  (throws) when a non-empty payload cannot be repaired/completed into a JSON
  object.
- `src/native-request.ts` / `src/native-headers.ts` deliberately do **not** send
  `eager_input_streaming` or the fine-grained streaming beta.

Both deliberate divergences from native Pi (no eager streaming; fail-closed final
parse) were introduced specifically because eager streaming produced malformed
final tool JSON for Opus 4.8 in live sessions. They are correct for this provider
and are kept. See "Existing mitigations".

## Error categories, mapped to root cause and owner

| Category | Reported count | Root cause | Owner | Provider-fixable? |
|---|---:|---|---|---|
| Extra keys in `edits[]` (`newText_x`, `newText_unused`, `oldText2`, …) | 16 | Model emits valid JSON with a stray key | Model + Pi-core validation | No |
| Empty `edit {}` | 10 | Model emitted empty tool input (historically could also be old-provider silent `{}`) | Model (+ historical provider) | Already mitigated |
| Stringified `edits` | 1 | Model sent `edits` as a JSON string | Model + Pi-core `prepareEditArguments` | Already handled upstream |
| `oldText` not found / not unique | 7 | Ordinary edit-matching / model precision | Model + Pi-core edit-diff | No |

### 1. Extra annotation keys in `edits[]` (dominant, still occurring)

This is the highest-signal and still-live category.

**Evidence (raw session `019e9730-855d-74fa-83d1-db4e6c1e079f`, Opus 4.8, smart,
thinking high, 2026-06-05).** The model emitted, verbatim:

```json
{
  "path": ".../todo-list-tool.ts",
  "edits": [
    { "oldText": "...", "newText": "<~30 lines>", "newText_unused": "" },
    { "oldText": "...", "newText": "..." }
  ]
}
```

Observed properties of the artifact, consistent across sessions:

- It is **valid JSON**. Nothing is corrupted in transport.
- The stray key is always on **`edits[0]`** (the first edit) of a **large,
  multi-edit** `edit` call.
- It is always the **last** key in that edit object.
- Its value is always an **empty string** (`""`).
- The key looks like a hallucinated trailing field: `newText_x`,
  `newText_unused`, `newText_comment`, `newText_note`, `newText_placeholder`,
  `newText_dummy`, `oldText2`, `newText2`, `x`.

**What happens.** Pi-core `validateToolArguments` rejects it:

```text
Validation failed for tool "edit":
  - edits.0: must not have additional properties
```

This is returned as a **recoverable** tool-result error. In the same session the
model immediately self-corrected:

> "I left a stray `newText_unused` key. Let me redo the edit cleanly:"

and the retry succeeded.

**Reference comparison.** Native Pi behaves **identically**: its Anthropic
provider passes the same valid JSON through, and Pi-core validation rejects the
same way. Native Pi's `prepareEditArguments` does **not** strip extra keys; it
only coerces stringified `edits` and the legacy single-edit form.

**Why no provider fix.** `minimalcc-pi` is transport/provider code and does not
own the `edit` schema. A provider-side stripper would (a) diverge from the
reference, (b) contradict Pi-core's intentional "reject, don't strip"
`additionalProperties: false` policy, (c) require the provider to walk each
tool's JSON schema to know which keys are "extra", and (d) risk silently mutating
legitimate tool calls and hiding a real model defect. The right lever, if any, is
**upstream Pi-core prompt/tool-description hardening**, not provider argument
mutation.

This pass-through behavior is now pinned by a regression test
(`preservesModelEmittedExtraKeysInsteadOfStrippingThem`) so a future "helpful"
sanitizer cannot silently change it.

### 2. Empty `edit {}` calls

**Evidence (raw session `019e73f5-8645-7cfd-b673-fc06cdac59b6`, Opus 4.8, smart,
thinking medium, 2026-05-29, Pi `0.77.0`).** The model emitted `edit` with
`arguments: {}` ~9 times in a row; each was rejected with:

```text
Validation failed for tool "edit":
  - path: must have required properties path, edits

Received arguments:
{}
```

The model's own thinking blamed "large content / regex backslashes breaking
serialization," and a prior session wrote drafts blaming our
`parseToolArgumentsFromJson` silently returning `{}`.

**Corrected analysis.** This cluster predates the current provider code. Two
distinct things were conflated:

- *Historical provider risk:* an older `minimalcc-pi` collapsed any unparseable
  **final** tool JSON to `{}` silently. That path is now closed (see "Existing
  mitigations": the final parser fails closed instead of producing a misleading
  `{}`).
- *Model behavior:* the model can also genuinely emit a `tool_use` block with no
  input. In the current code, a final payload of length 0 (no `input_json_delta`
  at all) is the only way to reach `{}`, which then surfaces as the same Pi-core
  "missing required properties" error.

We cannot distinguish "explicit model `{}`" from "old-provider collapse" purely
from Pi session JSONL (that only records the reconstructed arguments, not the raw
Anthropic SSE). Either way, the current provider no longer hides a non-empty
malformed payload behind `{}`.

**Reference comparison.** Native Pi's `parseStreamingJson` returns `{}` for an
empty/unrecoverable final payload, and the `edit` tool then rejects it with the
same class of "missing required properties / edits must contain at least one
replacement" message. So downstream behavior matches; `minimalcc-pi` additionally
fails closed (louder) for the non-empty-but-unparseable case.

### 3. Stringified `edits`

**Evidence (raw session `019e7d22-7d9b-7825-9bbd-5576c8b6078c`, Opus 4.8,
thinking medium, Pi `0.77.0`).**

```json
{ "path": ".../async-task-registry.ts",
  "edits": "[{\"oldText\": \"...\", \"newText\": \"...\"}]" }
```

→ `Validation failed for tool "edit": - edits.0: must be object`.

**Analysis / reference.** This is a model shape mistake. The current Pi-core
`edit` tool (`prepareEditArguments`, present in the installed `0.78.1`) **already
coerces** a stringified `edits` value back into an array before validation, so on
current Pi this no longer fails. It is owned entirely by Pi core and benefits any
provider, including `minimalcc-pi`. No provider change applies.

### 4. `oldText` not found / not unique

Ordinary edit-matching failures (the model's `oldText` did not match the file
exactly, or matched more than once). This is model precision plus Pi-core
`edit-diff` matching. Not transport, not provider. No change applies.

## Existing mitigations in `minimalcc-pi` (already shipped, regression-tested)

From `CHANGELOG.md` (Unreleased) and verified in source/tests:

1. **No eager / fine-grained tool-input streaming.** Tool requests use the
   standard Anthropic schema (`name`, `description`, `input_schema`, optional
   `cache_control`) without `eager_input_streaming` and without the
   `fine-grained-tool-streaming-2025-05-14` beta. This stops asking Opus 4.8 for
   the fragile streamed-tool-input mode that produced malformed *final* tool JSON
   in live sessions. Guarded by request-shape tests
   (`tests/native-stream-simple.test.ts`, `tests/live-opus46-routing.test.ts`).
   *Note:* this reduces transport-induced malformed JSON; it does **not** affect
   valid-but-schema-invalid content like `newText_x` (that is semantic model
   output, not transport).
2. **Fail-closed final parse.** `parseFinalToolArgumentsFromJson` throws when the
   final payload is non-empty but cannot be parsed/repaired or is not a JSON
   object, instead of collapsing to `{}` and producing a misleading "missing
   required properties" validation error. Error diagnostics report only safe
   metadata (payload length), never tool arguments. Guarded by
   `tests/tool-json-arguments.test.ts` and `tests/native-stream-simple.test.ts`.
   - Precise boundary (verified empirically): cleanly-truncated fragments that
     complete to an object **are** recovered (e.g. `{"path":"/tmp/x"` →
     `{"path":"/tmp/x"}`); a bare `{` or empty string → `{}` (a recoverable
     "missing required properties"); only genuinely unparseable non-empty input
     (e.g. `{"path":"/tmp/x",` or a non-object like `[]`) fails closed.
3. **Serial tool choice.** Requests set
   `tool_choice: { type: "auto", disable_parallel_tool_use: true }` whenever
   tools are present, preventing batches of dependent tool calls that Pi might
   run concurrently. (Unrelated to extra keys, but part of the tool-call
   hardening surface.)

## What was changed by this investigation

- **Report corrected** (this file): the dominant issue is model-emitted, valid,
  schema-invalid arguments handled recoverably by Pi-core validation — not a
  provider transport bug. The empty-`{}` section is corrected to separate the
  historical provider-collapse risk (now closed) from explicit model `{}`.
- **Regression test added** —
  `tests/tool-json-arguments.test.ts::preservesModelEmittedExtraKeysInsteadOfStrippingThem`
  pins the provider's pass-through contract using the real
  `newText_x`/`newText_unused`/`oldText2` examples, so the provider can never be
  "fixed" into a silent argument sanitizer.
- **No behavioral provider change.** The existing deliberate divergences from
  native Pi (no eager streaming; fail-closed final parse; serial tool choice) are
  correct and retained.

## When to revisit

Open a follow-up only if:

- raw Anthropic SSE (not just Pi session JSONL) proves the provider corrupts
  complete, valid tool JSON;
- extra-key failures stop self-correcting and cause repeated loops in a turn;
- native Pi adds a core-level mitigation for extra tool-call keys (then mirror it
  in Pi core, not in the provider);
- Anthropic changes tool-streaming semantics or the eager/fine-grained
  guarantees.

The advanced path, if ever needed, is **Pi-core `edit` prompt/schema wording
hardening**, not provider-side argument mutation.

## Appendix: sessions referenced

- `019e9730-855d-74fa-83d1-db4e6c1e079f` — extra keys `newText_unused`,
  `newText_x` (Opus 4.8, smart, high; 2026-06-05); model self-corrected.
- `019e73f5-8645-7cfd-b673-fc06cdac59b6` — empty `{}` cluster (Opus 4.8, smart,
  medium; Pi `0.77.0`; 2026-05-29).
- `019e7d22-7d9b-7825-9bbd-5576c8b6078c` — stringified `edits` (Opus 4.8, medium;
  Pi `0.77.0`).
- `019e7486-77c5-769d-afab-f9adaf126d69` — extra keys (`newText_comment`,
  `newText_note`, `newText_placeholder`) and an `oldText` mismatch.
- `019e7211`, `019e7423`, `019e7475`, `019e74fe`, `019e7537`, `019e7d26` —
  additional extra-key incidents (`newText2`, `oldText2`, `newText_dummy`,
  `newText_unused`, `newText_x`, `x`).
