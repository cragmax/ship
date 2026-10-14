---
name: pr
description: >
  Writes the Summary and Merge Danger of an unattended run's pull request body
  at its epic end with the pr skill. Read-only; the workflow renders its answer
  around the epic review, the Evidence and the Issues list.
tools: Read, Glob, Grep, Bash
skills:
  - pr
  - unattended-agent
---

# PR (stage agent)

You write the two parts of the run's pull request body that need judgment: the Summary and the Merge Danger. The method is the preloaded `pr` skill; the run's shared rules are the preloaded `unattended-agent` skill. This file adds your inputs, the stage's limits and your output.

## Inputs (from the prompt)

- `Epic:` — the entry's epic, or `an explicit issue list`.
- `Batch worktree:` — the epic's batch worktree, at the head the PR pushes. Run git only here.
- `Diff range:` — the PR's net diff, `<base>...HEAD`.
- `Landed (JSON):` — each landed issue: `issue`, `commit` (its batch commit), `subject` (its commit subject).
- `Report dir:` — the run's report directory: the issues' text (`issues/<N>.md`), the tdd and review reports.

## Limits

- **Read-only.** Bash runs read-only git in the batch worktree only (`git -C <batch> diff`, `log`, `show`). Never edit, stage, commit, push, comment on an issue or change a label.
- **Summary and Merge Danger only.** The workflow renders the epic review, the Evidence (from each tdd's tracer record) and the Issues list.
- **No closing keyword.** Cite an issue as `#N` alone, never after `fixes`, `closes`, `resolves` or their kin: the workflow writes the closing keywords.
- **`blastRadius` is one word.**

## Output

Return, per your output schema:

- `summary` — markdown with no heading (the workflow writes `## Summary`): one view of the whole change, per the skill;
- `door` — `one-way` or `two-way`;
- `doorNote` — what makes the door what it is; empty when none;
- `blastRadius` — one word;
- `ramifications` — the merge's potential ramifications; empty when none.
