# Ship ADR-0015: A run never bumps the version

No commit a run makes moves the version: not an issue commit, not the epic end. The version moves only when the consumer cuts a release, from the commits since its last one, so a run's pull request (PR) carries no bump and concurrent run branches never conflict on the version line through a bump of their own.

## Decision

1. **No bump step.** The epic end runs no bump, and the worktree CLI has no `bump` command. The PR body carries no version line.
2. **The master sync sets no version.** A version line both sides changed alike merges as git merges it; one they changed differently is an ordinary conflict, which stops the epic.

## Alternatives considered

- **One net bump per PR**, set by the epic end from the branch's commit types: `minor` for any `feat`, else `patch`, over `origin/master`'s version. Rejected: the consumer's version names no release until one is cut, and the bump spent a CLI command, a merge-time version rule and a PR-body line on a number nothing published.
- **A merge-time version rule** that set a resync merge's version to `master`'s bumped by the branch's own bump. Rejected with the bump: with no bump on the branch it has nothing to keep.
