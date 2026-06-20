# Model selection: Opus snapshots

The provider registers fixed Opus snapshots rather than silently rotating to whatever Anthropic currently labels "latest". For Claude 4.6 and later, Anthropic's dateless model ids are pinned snapshots, not evergreen aliases, so exposing `claude-opus-4-6`, `claude-opus-4-7`, and `claude-opus-4-8` gives users a stable per-task choice.

The snapshots are treated as complementary:

- **Opus 4.6 for continuity and predictable thinking budgets.** This package keeps Opus 4.6 on manual `budget_tokens`, so Pi's thinking levels map to bounded token budgets. That remains useful for workflows tuned against 4.6's behavior or tasks that need predictable per-turn reasoning spend.
- **Opus 4.7 for adaptive-only Opus behavior with existing 4.7 baselines.** Opus 4.7 requires adaptive thinking when thinking is enabled. Public characterizations describe it as following prompts more closely and filling in fewer gaps than 4.6, so moving a workflow from 4.6 to 4.7 is often a prompt-tightening exercise: explicit success criteria, examples, and verification commands.
- **Opus 4.8 for the newest Opus snapshot.** Anthropic describes Opus 4.8 as its most capable generally available model for complex reasoning, long-horizon agentic coding, and high-autonomy work. It has the same implementation shape this provider already uses for 4.7: 1M context on the Claude API, 128k max synchronous output, adaptive thinking only, and no non-default `temperature` / `top_p` / `top_k`.
- **`claude-opus-4-7-300k` as a local soft-cap route.** This is not a separate Anthropic snapshot; Pi sees a 300,000-token context window while native requests still send `claude-opus-4-7`.

This package does not recommend one Opus snapshot for every task. Use 4.6 when its manual-budget behavior or established prompt compatibility matters, 4.7 when you need that snapshot specifically, and 4.8 when you want the newest Opus model exposed by this provider. Mid-session switches stay safe because signed reasoning is replayed only to the exact same provider/api/model id; cross-model visible reasoning is preserved as ordinary assistant text.

## Operational note on adaptive Opus thinking

Opus 4.7 and 4.8 must use adaptive thinking when thinking is enabled. Manual `thinking: {"type":"enabled","budget_tokens":N}` returns a 400 error on those models. Adaptive thinking uses `effort` as soft guidance, not a fixed budget: Anthropic documents `low`, `medium`, `high`, `xhigh`, and `max`, with `high` as Opus 4.8's default. This provider maps Pi `minimal`/`low`/`medium`/`high`/`xhigh` to Claude effort `low`/`medium`/`high`/`xhigh`/`max` for adaptive Opus models.

## Sources

- Anthropic, *Models overview*: https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic, *Model IDs and versioning*: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
- Anthropic, *What's new in Claude Opus 4.8*: https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8
- Anthropic, *Adaptive thinking*: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Anthropic, *Prompting best practices*: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- Amp, *Opus 4.7*: https://ampcode.com/news/opus-4.7
