# Token-efficiency optimization backlog

Candidate work for reducing Claude subscription quota pressure. Not a plan: each item requires a cost/gain evaluation before implementation.

Guardrails:

- Prefer changes that keep model-visible content and tool behavior unchanged.
- Every implemented optimization must be observable and testable, with token/cache impact proven and behavior checked.
- Treat advanced/beta Anthropic features as unsupported until verified on the Claude subscription/OAuth route.
- Do not ship black-box optimizations that fundamentally change how models interact with Pi or this extension.

Evaluation requirements: expected token/quota savings, implementation/maintenance cost, model-functionality risk, observability metrics, deterministic tests, and a live-verification plan with fake-safe logs. Useful metrics: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, cache hit ratio `cacheRead / (input + cacheRead + cacheWrite)`, total request tokens before/after, a stable request/prefix fingerprint, and tool-call/answer-quality regressions.

## Status

Items 1–6 are implemented and covered by deterministic tests: live prompt-cache behavior confirmed in aggregate (undated per-turn runbook available at [`prompt-cache-live-verification.md`](prompt-cache-live-verification.md)); deterministic payload prefixes and byte-stable golden request-body snapshots for every registered model; cache-anchor/usage-accounting regression tests. Item 8 is partially implemented: Pi `cacheRetention` (`short`/`long`/`none`) and `PI_CACHE_RETENTION=long` are honored, with long TTL gated by model compatibility; session-stable latching remains open.

## Open items

7. Split stable and dynamic system-prompt blocks more deliberately, with distinct cache treatment. Risk: low, if visible instructions remain equivalent.
8. Add session-stable cache-retention latching so a mid-session config/eligibility change cannot flip the TTL and bust the cache.
9. Improve tool-schema stability and hygiene without semantic compression (dedupe, deterministic order, no volatile metadata). Risk: low.
10. Add quota-aware warnings (large request, low cache hit, high cache-write pressure) without silent truncation. Risk: none if warning-only.
11. Deduplicate only byte-identical accidental prompt/system/tool material; never fuzzy-dedupe. Risk: low.
12. Add safe local token/context estimation for diagnostics and warnings only, never silent truncation. Risk: none if diagnostic-only.
13. User-visible large tool-output handling (full/head-tail/artifact/ask). Risk: medium-high if automatic.
14. Auditable context compaction only with explicit approval or visible checkpoints. Risk: high if hidden.
15. Deferred or dynamic tool loading. Risk: medium; changes tool visibility.
16. Advanced cache-editing / `cache_reference` experiments behind an explicit flag. Risk: medium-high.
17. Optional model-routing policy (cheaper models for low-risk tasks), explicit and user-visible. Risk: medium.
18. Optional output-length controls (lower `max_tokens` / concise mode). Risk: medium.
19. Optional reasoning-effort controls. Risk: medium-high if automatic.

## Avoid by default

Hidden summarization/compaction, hidden model or reasoning-effort downgrade, dropping tool schemas/results, removing tool descriptions, fuzzy prompt deduplication, aggressive prompt rewriting, unverified first-party/beta cache features on the subscription route, and any optimizer that cannot report token/cache and behavior impact.
