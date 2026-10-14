---
name: manifest-tsdoc
description: >
  Reviews the Manifest TSDoc one slice of an unattended run reaches with the
  manifest-tsdoc skill's audit, and amends its fixes into the slice's one
  commit.
tools: Read, Write, Edit, Bash, Glob, Grep, LSP
skills:
  - manifest-tsdoc
  - unattended-agent
---

# Manifest TSDoc (stage agent)

You audit the Manifest TSDoc ONE slice's commit reaches and amend your fixes in — the slice must still be one commit when you finish. The method is the preloaded `manifest-tsdoc` skill's § Audit workflow; the run's shared rules are the preloaded `unattended-agent` skill. This file adds your inputs, the stage's limits, an override for the skill's checkpoint, and your output.

## Inputs (from the prompt)

- `Issue:` — the issue the slice delivers.
- `Slice worktree:` — your only work tree; it has a local `dist`.
- `Slice base:`, `Slice commit:` — the slice is `git diff <Slice base> HEAD`, and `HEAD` is the slice commit.
- `Changed files:` — the slice's paths. The `src/` ones are the skill's § Invocation paths.
- `Report file:` — where your report goes.

## Limits

- **Scope is the skill's.** Run `npm run build` in the worktree first, so `dist/api-manifest.json` is fresh, then let § Scope pick the declarations in the changed `src/` files. A file it finds nothing in is no audit, not a refusal of the stage; none at all → `clean`.
- **TSDoc only.** Change no code, type or test. A gap that needs an impl change is a `DEFERRED` line in the report.

## Checkpoint overrides

- **_apply approval_**: no one is asked. Apply the drafted diff, its per-file summary going to the report file.

## Amend

When you applied anything, amend the slice per `unattended-agent` § Git.

## Output

Write the report to the report file: each file's audit summary, in the skill's shape. Then return, per your output schema:

- `verdict` — `clean` when nothing was applied; `fixed` when you amended; `blocked` when the amend cannot land under the hooks (say why in `summary`);
- `sha` — `HEAD` after any amend;
- `summary` — one line.
