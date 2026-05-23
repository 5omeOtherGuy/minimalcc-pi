# Token-efficiency optimization candidate backlog

This is a candidate TODO list for reducing Claude subscription quota pressure.

This list was updated after reviewing common mechanisms in a local ignored clone of `https://github.com/codeaashu/claude-code`. The review identified patterns around prompt-cache break detection, usage telemetry, deterministic tool/schema serialization, system prompt splitting, context compaction, and large tool-output handling.

Important guardrails:

- Not every item in this list must be implemented.
- Each item requires a cost/gain evaluation before implementation.
- Do not ship black-box optimizations that fundamentally change how Anthropic models interact with Pi or this extension.
- Prefer changes that keep model-visible content and tool behavior unchanged.
- Every implemented optimization must be observable and testable: prove token/cache impact and check that model/tool behavior is not degraded.
- Treat advanced/beta Anthropic features as unsupported until verified on the Claude subscription/OAuth route.

## Evaluation requirements for any optimization

Before implementing an item, define:

- Expected token/quota savings.
- Expected implementation and maintenance cost.
- Model-functionality risk: none, low, medium, or high.
- Observability: which metrics prove the change worked.
- Deterministic tests: payload shape, usage accounting, or behavior tests.
- Live verification plan, if needed, using fake-safe logs and no committed credentials.

Useful metrics:

- `input_tokens`
- `output_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- cache hit ratio: `cacheRead / (input + cacheRead + cacheWrite)`
- total request tokens before/after for comparable tasks
- stable in-process request/prefix fingerprint before/after for identical contexts
- tool-call success and answer-quality regressions for comparable tasks

## Findings from Claude Code review

Useful mechanisms found in the reference clone:

- Usage telemetry: `cost-tracker.ts` accumulates and displays input, output, cache read, and cache write by model/session.
- Cache-break detection: `promptCacheBreakDetection.ts` hashes prompt/tool/beta/cache-control state before calls and compares `cache_read_input_tokens` after calls.
- Stream usage handling: `claude.ts` treats Anthropic stream usage as cumulative and avoids overwriting nonzero input/cache counts with later zero deltas.
- Stable schema/prefix handling: `toolSchemaCache.ts`, `toolToAPISchema()`, `assembleToolPool()`, and `mergeAndFilterTools()` freeze or sort tool/schema bytes for prompt-cache stability.
- System prompt splitting: `splitSysPromptPrefix()` separates stable and dynamic system blocks and varies cache scope.
- Token/context estimation: `tokenCountWithEstimation()` anchors on last API usage and estimates messages added since.
- Large output controls: tool-result budgeting/persistence and bash output caps reduce runaway prompt size, but can affect model-visible context.

Important caveat: the reviewed clone exposes a `toolToAPISchema(..., cacheControl)` overlay and comments that tool schemas can carry cache markers, but the visible main request-building call did not pass `cacheControl`. Do not copy that behavior blindly; verify against Anthropic docs and our own payload tests.

## MUST DO

The MUST DO items are safety and observability work only. They must not be interpreted as approval to change model-visible prompts, message content, tool availability, tool descriptions, tool ordering semantics, model choice, reasoning effort, context length, or output limits. If an implementation would change what Anthropic can see or do, move it out of MUST DO and evaluate it separately with explicit risk review.

Status summary (2026-05-07): items §2–§6 are implemented and remain documented below for auditable history; the only remaining open MUST DO item is §1 (run the live prompt-cache verification runbook). §8 in SHOULD DO is partially implemented and tracks the remaining session-stable cache-retention latching work.

Implementation notes for the current native provider:

- Local usage telemetry is available in-process and via `/claude-subscription-usage`.
- Local cache-read drop diagnostics are available in-process and via `/claude-subscription-cache-diagnostics`.
- Native SSE is parsed incrementally from `response.body`; the legacy full-text helper remains for tests/external callers.
- Pi `cacheRetention` is honored for `short`, `long`, and `none`; unset retention also honors `PI_CACHE_RETENTION=long`.
- Long prompt-cache TTL is gated by model compatibility metadata.
- Deterministic tests remain mocked and do not make live Anthropic requests.
- Live prompt-cache confirmation is documented in `docs/prompt-cache-live-verification.md` and should be run only when quota-consuming live checks are explicitly desired.

### 1. Verify prompt caching works in real sessions

Mechanism: Anthropic explicit `cache_control` breakpoints on stable prefixes: tools -> system -> messages.

Claude Code finding: cache impact is verified by usage fields, not by payload shape alone. The reference code compares live `cache_read_input_tokens` across calls and treats drops as cache breaks.

Quality risk: very low; the model sees the same content with cache hints.

Before implementation/expansion:

- Confirm current payload anchors produce real `cacheRead > 0` in live repeated sessions.
- Confirm first warmup requests show expected `cacheWrite` behavior.
- Confirm subsequent comparable turns shift repeated prefix tokens from normal input to cache read.

Tests/observability:

- Deterministic payload tests assert cache anchors are present.
- Stream usage tests assert `cacheRead` and `cacheWrite` are preserved.
- Live benchmark reports `input`, `cacheRead`, `cacheWrite`, and `output` per turn.

### 2. Add local cache/token telemetry

**Status: completed.** Implemented as a per-process, command-driven, redacted summary; never logs prompt content, tool arguments, or credentials.

Evidence:

- `src/native-usage-telemetry.ts` exports `recordNativeUsage`, `getNativeUsageTelemetrySnapshot`, `formatNativeUsageSummary`, and `resetNativeUsageTelemetry`.
- `extensions/claude-subscription.ts` registers the `/claude-subscription-usage` slash command.
- `tests/native-usage-telemetry.test.ts` covers accumulation, redacted formatting, and reset behavior; redaction tests in `tests/redaction.test.ts` cover the surrounding helpers.

Original rationale (kept for audit history):

Mechanism: record per-request and per-session token/cache usage and cache hit ratio without logging prompt contents or secrets.

Claude Code finding: `cost-tracker.ts` surfaces usage by model: input, output, cache read, cache write. This is a low-risk observability pattern we can adapt.

Quality risk: none.

### 3. Add cache-break diagnostics

**Status: completed.** Read-only fingerprinting that never mutates outgoing payloads; per-process HMAC salt; reports cache-read drops with a `changedSections` classification.

Evidence:

- `src/native-cache-diagnostics.ts` exports `fingerprintNativeRequestShape`, `recordNativeCacheDiagnosticSample`, `getNativeCacheDiagnosticsSnapshot`, `formatNativeCacheDiagnosticsSummary`, and `resetNativeCacheDiagnostics`; per-section SHA-256 hashes are HMAC-salted with per-process random bytes so fingerprints never leak prompt content and are not comparable across processes.
- Integrated into `src/native-stream-simple.ts` so successful native streams record samples for both pre-auth and post-retry payloads.
- `extensions/claude-subscription.ts` registers the `/claude-subscription-cache-diagnostics` slash command.
- `tests/native-cache-diagnostics.test.ts` covers stable fingerprinting, salt boundaries, drop detection, redacted summary formatting, and the seven `changedSections` cases (`model`, `system`, `messages`, `tools`, `cacheControl`, `bodyConfig`, `none`).

Original rationale (kept for audit history):

Mechanism: compare stable request-shape fingerprints and usage deltas across turns to explain why cache reads drop. Diagnostics must be read-only: they may observe/hash/report request shape, but must not mutate outgoing payloads.

Claude Code finding: `promptCacheBreakDetection.ts` hashes system blocks, tool schemas, cache-control state, beta headers, model, effort, global cache strategy, and extra body params. It then compares cache-read drops to likely causes.

Quality risk: none if diagnostics do not affect payloads.

### 4. Add a repeatable token/cache benchmark runbook

**Status: completed.** A live, opt-in runbook lives at `docs/prompt-cache-live-verification.md` with a minimal Node harness, warm-up/repeat pattern, per-turn JSON output, diagnostic interpretation, and an explicit no-committed-secrets policy. Running it remains a manual local exercise; the manual verification step is tracked as the remaining open MUST DO item in §1 above.

Evidence:

- `docs/prompt-cache-live-verification.md` contains the harness and instructions; every symbol it imports (`CLAUDE_SUBSCRIPTION_PROVIDER_ID`, `MODELS`, `streamNativeClaudeSubscription`, `formatNativeUsageSummary`, `getNativeUsageTelemetrySnapshot`, `resetNativeUsageTelemetry`, `getNativeCacheDiagnosticsSnapshot`, `resetNativeCacheDiagnostics`) is exported by the listed source files.

Original rationale (kept for audit history):

Mechanism: run the same model, tools, and task pattern across multiple turns to verify warm-cache behavior.

Claude Code finding: analytics-only detection is not enough for local development; we need a repeatable local/live runbook for this provider.

Quality risk: none if benchmark-only.

### 5. Keep cacheable payload prefixes deterministic without changing semantics

**Status: substantially completed.** Deterministic stringification + stable per-section fingerprints are in place; the remaining gap is full byte-equality golden snapshots of every request body shape.

Evidence:

- `src/native-cache-diagnostics.ts` implements `stableStringify` and `sectionHash` for byte-stable per-section fingerprints; `src/native-stream-simple.ts` captures fingerprints before and after auth retry so accidental churn surfaces immediately as a `changedSections` event.
- `tests/native-request.test.ts` covers byte-stable repeated payloads, cache-control preservation, and tool-schema serialization.

Remaining work (low priority): explicit full-body golden-payload snapshot tests for the registered models would catch cross-cutting churn that section-level fingerprints might miss.

Original rationale (kept for audit history):

Mechanism: keep stable serialization for tools, system blocks, message conversion, headers/betas, and thinking/output config. Avoid volatile fields before cache anchors only when doing so is semantically inert. This item is about preventing accidental byte churn, not about optimizing by removing, rewriting, reordering, or compressing model-visible content.

Claude Code finding: tool/schema byte stability is treated as a first-class cache concern. The reference code uses session-scoped schema caching, partition-sorted built-in/MCP tools, and beta-header latching to avoid accidental cache-key churn.

Quality risk: very low only when semantic content and behavior are unchanged.

### 6. Add cache-regression guardrails

**Status: completed.** Deterministic, mocked tests cover the required cache-anchor and usage-accounting invariants; no test makes a live Anthropic request.

Evidence:

- `tests/native-stream-simple.test.ts` asserts `cache_control` is absent when `cacheRetention=none` and present when caching is enabled, and asserts that nonzero `cacheRead`/`cacheWrite` values are not overwritten by later zero-valued deltas.
- `tests/native-request.test.ts` asserts cache anchors are placed on shaped system blocks, the last user-turn block, and the last tool schema, and that pre-existing `cache_control` markers on Pi inputs are preserved.
- The full deterministic suite is mocked and runs through `npm test` / `npm run check`; no test issues a live Anthropic request.

Original rationale (kept for audit history):

Mechanism: tests that fail if cache anchors or cache usage accounting regress.

Claude Code finding: the reference code has runtime break detection; for our repo, deterministic unit tests should be the first guardrail because our test suite is mocked and does not make live Anthropic requests.

Quality risk: none.

## SHOULD DO

### 7. Split stable and dynamic system prompt blocks more deliberately

Mechanism: keep long, stable instruction blocks early and cached; keep short dynamic/session-specific content later.

Claude Code finding: `splitSysPromptPrefix()` uses a deliberate stable/dynamic boundary and distinct cache treatment for stable vs dynamic sections.

Quality risk: low if visible instructions remain equivalent.

Before implementation:

- Prove reconstructed model-visible system text is equivalent.
- Evaluate whether changing block boundaries could affect behavior.
- Avoid first-party-only `scope: 'global'` unless verified on our route.

Tests/observability:

- Unit tests for system block shaping and visible text equivalence.
- Live A/B benchmark for cache hit ratio and tool behavior.
- Cache-break diagnostics should report when dynamic content moves into stable prefix.

### 8. Support explicit cache retention policy with session-stable latching

Status: partially implemented. The provider now supports Pi `cacheRetention` values `short`, `long`, and `none`, honors `PI_CACHE_RETENTION=long` when unset, and uses long TTL only when model compatibility allows it. Session-stable latching and live long-TTL validation remain TODO.

Mechanism: configurable cache retention such as `short`, `long`, or `none`, using long TTL only where supported and latched for the session.

Claude Code finding: 1-hour TTL eligibility and allowlists are latched to avoid mid-session TTL flips that bust prompt cache.

Quality risk: none to low; TTL should not change visible prompt content.

Before implementation:

- Confirm Anthropic OAuth/subscription route accepts the TTL for target models.
- Evaluate write-cost/quota tradeoff for longer TTL.
- Decide TTL once per session/request family and avoid flip-flopping.

Tests/observability:

- Payload tests for short vs long cache-control shape.
- Latching test: config/eligibility change mid-session does not change cache-control TTL unexpectedly.
- Live benchmark across sessions separated by more than the short TTL.

### 9. Improve tool schema stability and hygiene without semantic compression

Mechanism: prevent accidental tool schema bloat or churn: duplicate tools, volatile metadata, unstable schema rendering, or nondeterministic property order where order is not semantically meaningful.

Claude Code finding: rendered tool schemas are cached per session to prevent mid-session feature-flag/tool-prompt drift from changing cache bytes. Tool pools are partition-sorted and deduplicated for cache stability.

Quality risk: low if no descriptions/parameters are removed and tool order semantics are preserved.

Before implementation:

- Measure actual tool schema token contribution.
- Confirm any normalization is semantically equivalent.
- Verify whether Pi already provides stable tool ordering/schema serialization.

Tests/observability:

- Payload token estimate before/after.
- Golden tests for stable schema serialization.
- Tool-call regression tests.
- Same context and tool list should produce byte-stable tool payloads.

### 10. Add quota-aware warnings, not automatic truncation

Mechanism: warn when a request is unusually large, cache hits are unexpectedly low, or cache-write pressure is high. Do not silently modify prompts.

Claude Code finding: context warning states and model-upgrade tips exist, but for our provider the safer first step is warning-only quota/cache telemetry.

Quality risk: none if warning-only.

Before implementation:

- Define warning thresholds.
- Ensure warnings are actionable and not noisy.
- Prefer measured usage over rough token estimates when available.

Tests/observability:

- Mock token estimates/usage and assert warning triggers.
- Assert the outgoing payload remains unchanged.
- Assert warning text is redacted and does not include prompt/tool contents.

### 11. Deduplicate exact duplicate prompt/system/tool material

Mechanism: remove only byte-identical accidental duplicates introduced by extension plumbing.

Claude Code finding: tool deduplication by name exists for merged built-in/MCP pools. No fuzzy prompt deduplication was found; that is a good safety boundary.

Quality risk: low, but only if exact duplicates are removed and ordering semantics are preserved.

Before implementation:

- Prove duplicates are accidental and semantically redundant.
- Avoid fuzzy or semantic deduplication.
- Avoid removing repeated user content or tool outputs unless they are mechanical duplicates created by our code.

Tests/observability:

- Payload token estimate before/after.
- Tests prove only exact duplicates are removed.
- Tool availability and system instruction behavior remain unchanged.

### 12. Add safe token/context estimation for diagnostics

Mechanism: estimate request/context size locally to power warnings, benchmark summaries, and before/after comparisons. Do not use estimates to silently truncate or summarize.

Claude Code finding: `tokenCountWithEstimation()` anchors on last API usage and rough-estimates new messages; token estimation treats JSON, images, documents, and tool blocks differently.

Quality risk: none if diagnostic-only.

Before implementation:

- Decide whether estimates are used only for warnings/diagnostics or also for future user-visible decisions.
- Document estimation limits.

Tests/observability:

- Unit tests for text, JSON-like content, images/documents, tool results, and tool-use blocks.
- Compare estimated request size with actual API usage in live benchmarks.

## COULD DO

### 13. User-visible large tool-output handling

Mechanism: for very large command/file outputs, offer explicit options: include full output, include head/tail, save as artifact and reference path, or ask the user before sending.

Claude Code finding: large tool results can be persisted to disk and replaced with references; bash output has hard caps. This saves tokens but changes what the model sees, so it is higher risk.

Quality risk: medium to high if automatic.

Before implementation:

- Must not silently drop relevant tool results.
- Prefer user-visible choices.
- Preserve original output outside the model prompt when possible.

Tests/observability:

- Token estimate before/after.
- Tool-result fidelity tests.
- User confirmation path tests.
- Regression tests for tasks requiring exact output.

### 14. Auditable context compaction

Mechanism: summarize or compact old conversation/tool output only with explicit approval or at visible checkpoints.

Claude Code finding: autocompact, microcompact, cached microcompact, and session-memory compaction are powerful, but they can affect model-visible context and require careful UX/observability.

Quality risk: high if hidden.

Before implementation:

- Must be transparent and reversible/auditable.
- Preserve original context outside the model prompt when possible.
- Show token savings and summary provenance.

Tests/observability:

- Token estimate before/after.
- Compare task success before/after.
- Store original and summary for audit.
- Tests for user-visible approval/checkpoint flow.

### 15. Deferred or dynamic tool loading

Mechanism: send fewer tool schemas initially and expose/discover additional tools only when needed.

Claude Code finding: tool-search/deferred loading can reduce tool-schema token spend and improve cache stability, especially with many MCP tools. It also changes which tools are directly visible to the model.

Quality risk: medium because tool availability/prompting changes.

Before implementation:

- Must be explicit and heavily tested.
- Measure how much tool schema size actually contributes to our quota pressure.
- Avoid if it degrades tool discovery or increases extra turns.

Tests/observability:

- Tool schema token reduction before/after.
- Tool-call success and latency/turn-count comparison.
- Regression tests for tools that should be immediately available.

### 16. Advanced cache editing / `cache_reference` experiments

Mechanism: use cache-editing/cache-reference features to avoid re-tokenizing or retaining old tool results in cached prefixes.

Claude Code finding: cached microcompact uses cache references and cache edits, but these are advanced route/model/beta-dependent features.

Quality risk: medium to high; API support and semantics may differ on the Claude subscription/OAuth route.

Before implementation:

- Verify feature support with controlled live tests.
- Keep behind an explicit experimental flag.
- Define rollback behavior if the API rejects the fields.

Tests/observability:

- Payload shape tests for experimental mode only.
- Mock API rejection tests.
- Live benchmark showing reduced cache write/read pressure without behavior regression.

### 17. Optional model-routing policy

Mechanism: choose cheaper/lower-quota models for low-risk tasks and reserve Opus for tasks that need it.

Quality risk: medium because model choice changes behavior.

Before implementation:

- Must be explicit and user-visible, not hidden.
- Evaluate success rates per task class.

Tests/observability:

- Usage by model.
- Task success comparison across models.
- User-visible opt-in/override tests.

### 18. Optional output-length controls

Mechanism: lower `max_tokens` or expose concise-mode settings.

Quality risk: medium; may reduce completeness.

Before implementation:

- Must be user-visible or task-specific.
- Evaluate tasks that require long outputs.

Tests/observability:

- Output token reduction.
- Regression checks for detailed-answer tasks.
- User override tests.

### 19. Optional reasoning-effort controls

Mechanism: use lower reasoning for simple tasks and higher reasoning for complex tasks.

Quality risk: medium to high if automatic.

Before implementation:

- Prefer explicit user settings over hidden automatic changes.
- Evaluate correctness/tool-use impact.

Tests/observability:

- Track token changes by reasoning level.
- Compare correctness and tool-call success.
- User override tests.

## Avoid by default

- Hidden summarization or compaction.
- Hidden model downgrade.
- Hidden reasoning-effort downgrade.
- Dropping tool schemas or tool results.
- Removing tool descriptions to save tokens.
- Fuzzy/semantic prompt deduplication.
- Aggressive prompt rewriting.
- First-party/beta cache features on the subscription route without live support verification.
- Any optimizer that cannot report token/cache impact and behavior impact.
