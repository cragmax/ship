---
status: current
platform: [claude-code 2.1.296]
last-verified: 2026-10-15
relied-on-by: [ship/src/workflow/runtime.types.ts, ship/src/workflow/calls/prompts.ts, .claude/skills/unattended-agent/SKILL.md, ship/src/workflow/ship.meta.ts]
---

# Ship PF-2: A workflow `agent()` call starts in the launching session's current working directory and loads its CLAUDE.md

A workflow `agent()` call starts with its working directory set to the launching session's current working directory when the call is made, not a worktree the session made. Started in the main checkout, it loads that checkout's `CLAUDE.md`. No option moves it. A `cd` the session runs while the workflow is live moves the start directory of every later `agent()` call.

## Implication

An agent must `cd` by absolute path to the directory it works in, the main checkout included. It cannot rely on its starting working directory. `ship/src/workflow/runtime.types.ts` records this. `withCheckout` in `ship/src/workflow/calls/prompts.ts` adds the `Checkout:` line every agent prompt after a run's first call carries, and every worktree agent works by absolute path (`unattended-agent` § Where you work).

## Established

A live workflow run, in which an `agent()` reported its working directory and whether `CLAUDE.md` loaded. Deciding output:

```text
cwd /c/Users/maxim/source/paper-harness; CLAUDE.md loaded
```

Then /ship run `wf_1ec9fddb-a82` (2026-10-15): the launching session ran `cd …/reports/ship-1172` mid-run, and a later runner that ran the worktree CLI by its relative path, as given, failed with:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\maxim\source\paper-harness\reports\ship-1172\tooling\worktree.ts'
```
