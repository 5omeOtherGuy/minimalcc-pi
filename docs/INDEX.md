# Documentation index

- `rationale.md` — why this package exists, the harness-vs-model variable it isolates, comparison with the Claude Code CLI, and why a native Pi provider is preferred over a local proxy.
- `current-status.md` — current public status for the native provider, credential handling, cache-retention behavior, stream/tool-call guards, thinking-block replay rules, verification scope, and known limitations.
- `slash-commands.md` — exact output shapes and per-field interpretation for `/claude-subscription-status`, `/claude-subscription-usage`, and `/claude-subscription-cache-diagnostics`.
- `model-selection.md` — when to choose `claude-opus-4-6` vs `claude-opus-4-7`, prompt-strictness trade-offs, manual-budget vs. adaptive-thinking control surfaces, and source citations.
- `why-system-blocks.md` — compatibility notes for the Claude Code identity system-block shape.
- `token-efficiency-todos.md` — candidate backlog for reducing Claude subscription quota pressure with required cost/gain evaluation and observability guardrails; items §2–§6 are completed in place with implementation evidence.
- `prompt-cache-live-verification.md` — fake-safe runbook for verifying warm prompt-cache reads in live repeated sessions without committing live logs.

Historical review notes, live verification outputs, local environment logs, and one-off progress files are intentionally kept outside this public repository.
