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

1. Start with `git status --short --branch` and `git worktree list`. Do not `git checkout` in a worktree you do not own; create a dedicated worktree for the task: `git worktree add ../minimalcc-pi-<task-slug> -b <branch> origin/main`. After PR approval, push from the worktree, then merge from the primary `main` checkout in this order: `git worktree remove ../minimalcc-pi-<task-slug>` → `gh pr merge <N> --squash --delete-branch [--admin]` → `git pull --ff-only origin main` → `git worktree prune`. Removing the worktree before `gh pr merge --delete-branch` avoids `fatal: '<base>' is already used by worktree at …`, which fires when gh's local cleanup tries to `git checkout <base>` in a worktree where the primary checkout already holds it.
2. For behavior changes, add/update deterministic tests first; no live Anthropic/API calls.
3. Run `npm run check` before PRs.
4. For user-visible changes, update `CHANGELOG.md` under `Unreleased` using Keep a Changelog/SemVer, or state `Changelog: not needed` for tiny/internal PRs.
5. For approved releases, align `package.json`, changelog, Git tag `vX.Y.Z`, and GitHub Release.
