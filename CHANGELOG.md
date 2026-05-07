# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Changed

- README now links Anthropic's adaptive/extended thinking docs and clarifies that Haiku 4.5 uses manual thinking budgets, Sonnet/Opus 4.6 still use the extension's manual-budget path despite Anthropic's adaptive-thinking recommendation, and Opus 4.7 uses adaptive thinking when thinking is enabled.
- README now explains why both `claude-opus-4-6` and `claude-opus-4-7` are exposed, framing them as complementary (continuity for existing 4.6-tuned workflows, controlled migration path to 4.7, distinct prompt-strictness/inference trade-off, different thinking-control surfaces — manual `budget_tokens` on 4.6 vs. required adaptive thinking on 4.7); cites Anthropic's prompting-best-practices guidance and Amp's Opus 4.7 release note.
- README now explains native token/cache optimizations and thinking-block replay behavior when switching models, including parity with Pi's native safety model.
- Lowered the default Haiku 4.5 output cap from 64,000 to 48,000 tokens.
- README now documents context windows, output caps, thinking metadata, and request behavior for every registered model; clarified that Pi-native `modelOverrides` do not override this extension-registered provider.
- Restored Opus model context windows to 1,000,000 tokens while keeping Sonnet and Haiku at 200,000 tokens.
- Native Anthropic requests now send `Content-Type: application/json` and use per-tool `eager_input_streaming` by default, falling back to the legacy fine-grained tool-streaming beta only when eager input streaming is unsupported.
- Claude Code OAuth handling now force-refreshes and retries once when Anthropic rejects a locally fresh token with a 401/authentication error, coalesces concurrent refreshes in-process, and avoids overwriting credentials refreshed by another process mid-refresh.
