# Documentation index

- [`current-status.md`](current-status.md) — public implementation status: model matrix, request shape, safety boundaries, credentials, thinking budgets/levels, cache retention, stream guards, replay rules, verification scope.
- [`verification-gates.md`](verification-gates.md) — focused test gates by change type plus supply-chain/runtime drift policy.
- [`slash-commands.md`](slash-commands.md) — exact output shape and interpretation for the three slash commands.
- [`model-selection.md`](model-selection.md) — choosing between exposed Opus snapshots and thinking-control trade-offs.
- [`why-system-blocks.md`](why-system-blocks.md) — compatibility notes for the Claude Code identity system-block shape.
- [`rationale.md`](rationale.md) — why this package exists, the harness-vs-model variable it isolates, and why a native provider over a proxy.
- [`prompt-cache-live-verification.md`](prompt-cache-live-verification.md) — opt-in runbook for verifying warm prompt-cache reads without committing live logs.
- [`token-efficiency-todos.md`](token-efficiency-todos.md) — candidate quota-reduction backlog with evaluation guardrails.

Historical review notes, live verification outputs, local environment logs, and one-off progress files are intentionally kept outside this public repository.
