# Ship ADR-0011: Each epic lands on one branch through one commit queue, without per-commit consent

All of a run's work for an epic lands on the epic's `ship/<slug>` branch in its Batch worktree, without consent for each commit. That work is the issue commits, the `origin/master` merge, and the bump.

## Decision

1. **Per-slice branches are scratch.** They're never pushed or merged.
2. **The Commit queue lands one commit per issue,** `fixes #N` or `see #N`, under lefthook. A guard holds the staged set equal to the slice's files.
3. **A failed pick, build, or commit is rolled back** with `git reset --hard HEAD` in the batch worktree only, never in the main checkout (maintainer-approved 2026-09-28).
