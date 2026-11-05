# Ship ADR-0004: A run's agent instructions come from the main checkout, never from the tree under review

Every agent instruction (`CLAUDE.md`, `.claude/rules/`, skills, agent files, and the Saved workflow) comes from the main checkout's working tree when each agent starts. A slice's copies are its diff, and no agent follows them, so a run can't change the rules that its later agents obey before the pull request (PR) is reviewed. Project docs (GLOSSARY, ADRs, and platform facts) are read from the tree under review.

## Decision

1. **The run layout makes this so.** Every run worktree is a direct child of `<main>/.claude/worktrees/`. A worktree there gets the main checkout's path-scoped rules, and never its own `CLAUDE.md` or rules (Ship PF-14). The run worktrees are the following:
   - The **Batch worktree** `ship-<head>`.
   - The **Slice worktrees** `ship-<head>-<N>-<K>`, or `ship-<head>-a<R>-<N>-<K>` for an **Attached run**.
2. **Run state sits in the main checkout's `reports/`.** The run root, which is its report directory, is `<main>/reports/ship-<head>/`. An unlanded slice's work is kept under `<main>/reports/kept/`. All of these are gitignored, and Windows' 260-character path limit sizes the names.
3. **The guards.**
   - `provision-batch` refuses a report directory inside the batch or a slice.
   - `retire-run` removes only a real `ship-*` directory directly under `<main>/reports/`.
   - `teardown` and git refuse the main checkout. After it removes a worktree, teardown restarts the session's tsserver (Ship PF-17).
4. **A dirty main checkout is recorded, never refused.** The accepted residuals are the following:
   - A slice that is missing its `node_modules` junction resolves modules from the main checkout's, silently.
   - A manual recursive clean in the main checkout reaches live runs.

## Alternatives considered

- **A run root outside the project, or under `tmp/` or an untracked dot-directory.** Rejected. Outside the project, no path-scoped rule loads. Inside the project but not under `.claude/worktrees/`, a worktree loads its own `CLAUDE.md` and rules (Ship PF-14).
- **Full-slug worktree names.** Rejected, because the longest list slug puts a slice's deepest path near 300 characters, against Windows' limit of 260.
