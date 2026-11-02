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

Claude Code finds these only under `.claude/`, so they stay there (Framework ADR-0045
decision 3):

Each but the run layout is an installed copy. `npm run codegen` copies each from its
source under `ship/`, with a header line saying it is Ship's, and removes a
copy with that header whose source is gone; `gate:codegen` checks they
match. Edit the source, never the copy.

- **The Saved workflows:** `.claude/workflows/ship.js` and `resync.js`.
  `npm run codegen` renders them from `src/workflow/` into `workflows/`, a
  gitignored build output like `dist/`, and installs each with the header
  as its last line.
- **The stage agent files** in `.claude/agents/` (`tdd`, `spec-review`,
  `test-review`, `standards-review`, `script-api-tsdoc`, `issue-readiness`,
  `issue-overlap`, `epic-review`, `retro`, `pr`, `runner`), from `agents/`.
  The repo's own `github` agent carries no header, and the install leaves
  it alone.
- **The run-only `unattended-agent` skill,** from `skills/`.
- **The run layout,** gitignored: `.claude/worktrees/ship-*` (batch and slice
  worktrees) and `reports/ship-*` (run roots), `reports/kept/`.

Not Ship's, though its stage agents wrap them: every skill a stage agent
preloads but `unattended-agent` (`tdd`, the three reviews, `epic-review`,
`retro`, `pr` and the rest), since each is used by hand too, and the `github`
agent. They are the repo's, and they carry no run text: what a run adds to
one lives in `unattended-agent` or in the stage agent's file.
