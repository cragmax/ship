---
status: current
platform: [claude-code 2.1.296]
last-verified: 2026-10-13
relied-on-by: [ship/src/cli/git/run-layout.ts]
---

# Ship PF-14: A worktree directly under `.claude/worktrees/` gets the main checkout's path-scoped rules on a read, never its own `CLAUDE.md` or rules

A sub-agent whose working directory is the main checkout (a workflow `agent()` or an Agent-tool sub-agent, Ship PF-2) reads a file of a git worktree nested in the project. If the worktree is a direct child of `.claude/worktrees/`, the sub-agent loads only the main checkout's `paths:` rules, matched on the file's path relative to the worktree, and never the worktree's own `CLAUDE.md` or `.claude/rules/`. A worktree anywhere else in the project (`tmp/x`, an untracked dot-directory, or two levels under `.claude/worktrees/`, the last seen with the Agent tool only) loads its own `CLAUDE.md`, unconditional rules, and matching scoped rules, plus any root scoped rule whose glob matches the nested path: `src/**` matched `<worktree>/src/a.ts`, and `src/**/*.ts` did not.

## Implication

A run worktree must be a direct child of `.claude/worktrees/` for its agents to follow the main checkout's instructions (Ship ADR-0004). `WORKTREES_DIR` in `ship/src/cli/git/run-layout.ts` places every run worktree there.

## Scope

The probes ran on Linux. Windows is unverified.

## Established

Workflow `agent()` and Agent-tool sub-agent probes over detached `git worktree add` checkouts, 2026-10-13 ([#1401 grill outcome](https://github.com/cragmax/paper-harness/issues/1401#issuecomment-6154407401)), each verdict read from the `nested_memory` attachments in the agent's transcript. Deciding output:

```text
tmp/probe-wt                          -> its CLAUDE.md, its 6 unconditional rules, its matching scoped rules, root lean.md
.probe-wt                             -> same as tmp/
.claude/worktrees/probe-wt            -> root lean, framework-dev, comments-tsdoc (src/); root write-testing (test/); nothing of its own
.claude/worktrees/probe-run/slice-1-1 -> same as tmp/
```

Docs: [worktrees § Isolate subagents with worktrees](https://code.claude.com/docs/en/worktrees) says the subagent "doesn't load the `CLAUDE.md` file or `.claude/rules/` directory at the worktree's root as it reads files there".
