# Ship ADR-0015: A run never bumps the version

No commit a run makes moves the version: not an issue commit, not the epic end. The version moves only when the consumer cuts a release, from the commits since its last one, so a run's pull request (PR) carries no bump and concurrent run branches never conflict on the version line through a bump of their own.

## Decision

1. **No bump step.** The epic end runs no bump, and the worktree CLI has no `bump` command. The PR body carries no version line.
2. **The master sync's version-line rule** acts only when both sides moved the version, which a run's branch no longer does.

## Alternatives considered

- **One net bump per PR**, set by the epic end from the branch's commit types: `minor` for any `feat`, else `patch`, over `origin/master`'s version. Rejected: the consumer's version names no release until one is cut, and the bump spent a CLI command, a merge-time version rule and a PR-body line on a number nothing published.
