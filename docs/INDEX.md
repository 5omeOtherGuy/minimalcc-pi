# Documentation index

- `rationale.md` — why this package exists, the harness-vs-model variable it isolates, comparison with the Claude Code CLI, and why a native Pi provider is preferred over a local proxy.
- `current-status.md` — current public status for the native provider, credential handling, cache-retention behavior, stream/tool-call guards, thinking-block replay rules, verification scope, and known limitations.
- `slash-commands.md` — exact output shape and interpretation for `/claude-subscription-status`.
- `model-selection.md` — when to choose between exposed Opus snapshots, manual-budget vs. adaptive-thinking control surfaces, and source citations.
- `why-system-blocks.md` — compatibility notes for the Claude Code identity system-block shape.
- `token-efficiency-todos.md` — candidate backlog for reducing Claude subscription quota pressure with required cost/gain evaluation and observability guardrails; items §2–§6 are completed in place with implementation evidence.
- `prompt-cache-live-verification.md` — fake-safe runbook for verifying warm prompt-cache reads in live repeated sessions without committing live logs.
- `verification-gates.md` — focused test gates by change type plus supply-chain/runtime drift policy for Pi, Claude Code, Anthropic API, and extraction artifacts.

Historical review notes, live verification outputs, local environment logs, and one-off progress files are intentionally kept outside this public repository.
