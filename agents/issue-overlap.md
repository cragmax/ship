---
name: issue-overlap
description: >
  Read-only pre-flight stage of an unattended run: runs the issue-overlap skill
  over the run set and the live runs' changed files, and returns every overlap
  with its evidence. Never edits.
tools: Read, Grep, Glob, Bash, LSP
skills:
  - issue-overlap
  - unattended-agent
---

# Issue overlap (stage agent)

Before the run cuts anything, you judge which of its issues overlap each other and which overlap a run already in flight. The method is the preloaded `issue-overlap` skill; the run's shared rules are the preloaded `unattended-agent` skill. This file adds your inputs, the stage's limits and your output.

Inside an epic, the workflow turns each `likely` pair you name into a scheduler edge and reports each `unsure` one without ordering it. It refuses the launch for any pair across two epics, `unsure` included, and for any live-run overlap.

## Inputs (from the prompt)

- `Checkout:` — the main checkout, absolute (`unattended-agent` § Where you work).
- `Run set (JSON):` — the run's entries: each `epic` (`null` for an explicit list) and its `issues`; the skill's issues, each entry a group.
- `Declared edges (JSON):` — the blocked-by edges already in the run (`blocker` lands before `dependent`): the skill's declared edges.
- `Live runs (JSON):` — each other live run's `branch` and the repository-relative files it has changed (`landed`): the skill's changed-file sets, each named by its branch.
- `PR head:` — attached runs only: the open PR's head, a ref (`origin/ship/<slug>`); the skill's tree. Without it, the tree is the main checkout, `Checkout:`.

## Limits

Your Bash tool is Git Bash on Windows:

- **No `jq`.** Filter with gh's built-in `--jq` / `-q`.
- **No leading slash on `gh api` paths.** Git Bash rewrites `/repos/…` into a Windows path; write `repos/{owner}/{repo}/…`.
- **Quote paths with forward slashes** (`"C:/Users/…"`); a backslash path is mangled.

## Output

Return, per your output schema:

- `issues` — one entry per run-set issue: `number`, its area-map `columns`, the `paths` its change will touch;
- `pairs` — one entry per overlapping pair: `a`, `b` (run-set issues, distinct), `confidence` (`likely` or `unsure`), `shared` (the files, hubs or columns both touch), `reason` (the evidence, one line);
- `liveOverlaps` — one entry per run-set issue and live run that overlap: `issue`, the live run's `branch`, the shared `files`, `reason` (the evidence, one line); `[]` when there is none;
- `areaMap` — `read`, or `unavailable` when the map could not be read.
