# AGENTS.md

This repo is a Pi extension for a native Claude subscription provider that uses Claude Code OAuth. Keep changes focused and deterministic; never use or commit real credentials, OAuth tokens, API keys, `Authorization` / `Bearer` logs, or `.credentials.json` contents.

## Read when relevant

- `REPO_MAP.md` / `INDEX.md` — codebase map.
- `CONTRIBUTING.md` — full contribution and testing rules.
- `docs/current-status.md` — current implementation notes and known follow-ups.

## Commands

- Install: `npm ci`
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Pre-PR gate: `npm run check`

## Workflow

1. Per-task worktree (parallel-agent safe):
   - Primary checkout is control-only: never edit files or switch branches there.
   - Preflight: `git status --short --branch && git worktree list && git fetch origin --prune`.
   - Create: `git worktree add ../minimalcc-pi-<slug> -b <branch> origin/main`.
   - Merge: `gh pr merge <N> --squash [--admin]` (no `--delete-branch`; the repo auto-deletes merged head branches).
   - Cleanup, from outside the worktree: `git worktree remove ../minimalcc-pi-<slug> && git branch -D <branch> && git fetch origin --prune && git worktree prune`.
2. For behavior changes, add/update deterministic tests first; no live Anthropic/API calls.
3. Run `npm run check` before PRs.
4. For user-visible changes, update `CHANGELOG.md` under `Unreleased` using Keep a Changelog/SemVer, or state `Changelog: not needed` for tiny/internal PRs.
5. For approved releases, align `package.json`, changelog, Git tag `vX.Y.Z`, and GitHub Release.
