# Model selection: Opus snapshots

The provider registers fixed Opus snapshots rather than rotating to whatever Anthropic currently labels "latest". For Claude 4.6 and later, Anthropic's dateless model ids are pinned snapshots, so `claude-opus-4-6`, `claude-opus-4-7`, and `claude-opus-4-8` give a stable per-task choice.

- **Opus 4.6 — continuity and predictable thinking budgets.** Kept on manual `budget_tokens`, so Pi levels map to bounded token budgets. Useful for workflows tuned to 4.6 or tasks needing predictable per-turn reasoning spend.
- **Opus 4.7 — adaptive thinking with existing 4.7 baselines.** Requires adaptive thinking when thinking is enabled. Often a prompt-tightening exercise when moving from 4.6: explicit success criteria, examples, verification commands.
- **Opus 4.8 — newer Opus snapshot.** Same request shape as 4.7 (1M context on the Claude API, 128k synchronous output, adaptive thinking, no non-default `temperature`/`top_p`/`top_k`).
- **`claude-opus-4-7-300k` — local soft-cap route.** Not a separate Anthropic snapshot: Pi sees a 300,000-token context window while native requests send `claude-opus-4-7`.

No single snapshot is recommended for every task. Mid-session switches stay safe because signed reasoning is replayed only to the exact same provider/API/model id; cross-model visible reasoning becomes ordinary assistant text.

## Thinking levels for adaptive models

Adaptive models accept Pi `minimal`/`low`/`medium`/`high`/`xhigh`/`max` and send Claude effort `low`/`low`/`medium`/`high`/`xhigh`/`max`, with `thinking: { type: "adaptive", display: "summarized" }`. Effort is soft guidance, not a fixed token budget. This applies to Opus 4.7 (including the 300k alias), 4.8, 5, and 5.5; Fable 5 and 5.1; and Sonnet 5.

`claude-opus-5-5` cannot run without thinking. It does not offer Pi `off`, and every request sends an explicit effort; a request without a level is clamped like Pi clamps `off`, to `minimal`, which sends Claude `low`, so the API's default effort (`medium`) is never used silently.

Pi `off` on the other adaptive models omits `thinking` and `output_config`; it does not guarantee the server skips thinking, particularly on Fable and newer models. Haiku 4.5, Sonnet 4.6, and Opus 4.6 remain manual: `minimal`/`low`/`medium`/`high`/`xhigh` retain budgets `1024`/`4096`/`10240`/`20480`/`32768`, and `max` is not selectable. Pi ≥ 0.80.6 is required for native `max`.

## Sources

- Anthropic, *Models overview*: https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic, *Model IDs and versioning*: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
- Anthropic, *Adaptive thinking*: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Anthropic, *Prompting best practices*: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
