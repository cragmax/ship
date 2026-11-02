# Ship

The application that performs **Unattended runs**: it takes epics or an issue
list from launch to one pull request per epic, with the PR as the only human
gate ([Ship ADR-0002](docs/adr/0002-unattended-runs-are-rendered-saved-workflows-behind-one-pr-gate.md)).

## Launching

- `/ship epics N…` or `/ship issues N…`, with `--exclude`, `--preflight-only`,
  `--max-slices K` and `--attach ship/<slug>`: a run.
- `/resync ship/<slug>`: bring an open run branch level with `origin/master`.

Both are Saved workflows, which Claude Code also lists as skills.

## What the folder holds

Folders follow where the code runs (Ship ADR-0003):

| Folder          | Runs                                  | Holds                                                                      |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `src/workflow/` | inside the Workflow runtime, rendered | the Workflow sources of `ship` and `resync`; render-safe only              |
| `src/core/`     | on both sides                         | pure decisions and shared constants (scheduler, run gate, run set); no I/O |
| `src/cli/`      | in a runner agent or a session        | the worktree CLI's commands and the run gate CLI; one JSON envelope out    |
| `src/schemas/`  | at codegen                            | the zod sources of the agent outputs and tool envelopes                    |
| `src/build/`    | at build and gate time                | the render, the schema emit, the install and the codegen check             |
| `agents/`       | in Claude Code, once installed        | the sources of the stage agent files                                       |
| `skills/`       | in Claude Code, once installed        | the source of the `unattended-agent` skill                                 |
| `workflows/`    | in Claude Code, once installed        | the rendered Saved workflows; gitignored                                   |

Tests live in `test/`, under the subfolder of the file they test; the helpers they share live in `test/helpers/`.

## What Ship owns under `.claude/`

Claude Code finds these only under `.claude/`, so Ship installs them there
(Framework ADR-0045 decision 3). The three installed locations each hold
installed copies of sources under `ship/`. `npm run codegen` copies each
source with a header line saying it is Ship's, and removes a copy with that
header whose source is gone; `gate:codegen` checks they match. Edit the
source, never the copy.

- **The Saved workflows:** `.claude/workflows/ship.js` and `resync.js`, from
  `src/workflow/`. `npm run codegen` renders them into `workflows/`, a
  gitignored build output like `dist/`, and installs each with the header
  as its last line.
- **The stage agent files** in `.claude/agents/` (`tdd`, `spec-review`,
  `test-review`, `standards-review`, `script-api-tsdoc`, `issue-readiness`,
  `issue-overlap`, `epic-review`, `retro`, `pr`, `runner`), from `agents/`.
  The repo's own `github` agent carries no header, and the install leaves
  it alone.
- **The run-only `unattended-agent` skill** in `.claude/skills/`, from
  `skills/`.

The run layout is Ship's too, though not installed: `.claude/worktrees/ship-*`
(batch and slice worktrees), `reports/ship-*` (run roots), and `reports/kept/`,
all gitignored.

## What Ship requires

The consumer skills: each skill a stage agent preloads but `unattended-agent`
(`tdd`, `spec-review`, `standards-review`, `test-review`, `epic-review`, `pr`,
`retro`, `issue-overlap`, `issue-readiness`, `script-api-tsdoc` and `probe`).
Ship ships none of them: each is used by hand too, and carries no run text,
since what a run adds lives in `unattended-agent` or in the stage agent's
file. The install reads their names from the agent sources' `skills:` front
matter and refuses, naming each, while one lacks its
`.claude/skills/<name>/SKILL.md`. The `github` agent is the repo's as well.
