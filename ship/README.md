# Ship

The application that performs **Unattended runs**: it takes epics or an issue
list from launch to one pull request per epic, with the PR as the only human
gate ([Ship ADR-0001](docs/adr/0001-unattended-runs-rendered-scheduler-reviewed-slices-pr-gate.md)).

## Launching

- `/ship epics N…` or `/ship issues N…`, with `--exclude`, `--preflight-only`,
  `--max-slices K` and `--attach ship/<slug>`: a run.
- `/resync ship/<slug>`: bring an open run branch level with `origin/master`.

Both are Saved workflows, which Claude Code also lists as skills.

## What the folder holds

Folders follow where the code runs (Ship ADR-0001 decision 2):

| Folder          | Runs                                  | Holds                                                                      |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `src/workflow/` | inside the Workflow runtime, rendered | the Workflow sources of `ship` and `resync`; render-safe only              |
| `src/core/`     | on both sides                         | pure decisions and shared constants (scheduler, run gate, run set); no I/O |
| `src/cli/`      | in a runner agent or a session        | the worktree CLI's commands and the run gate CLI; one JSON envelope out    |
| `src/schemas/`  | at codegen                            | the zod sources of the agent outputs and tool envelopes                    |
| `src/build/`    | at build and gate time                | the render, the schema emit and the codegen check                          |

Tests live in `test/`, under the subfolder of the file they test; the helpers they share live in `test/helpers/`.

## What Ship owns under `.claude/`

Claude Code finds these only under `.claude/`, so they stay there (Repo ADR-0006
decision 4):

- **Rendered:** `.claude/workflows/ship.js` and `resync.js`, the Saved
  workflows. `npm run codegen` renders them from `src/workflow/`;
  `gate:codegen` checks they match. Never edit them by hand.
- **Kept in place:** the stage agent files in `.claude/agents/` (`tdd`,
  `spec-review`, `test-review`, `standards-review`, `script-api-tsdoc`,
  `issue-readiness`, `issue-overlap`, `epic-review`, `retro`, `pr`,
  `resolve-index-conflicts`, `runner`) and the run-only `unattended-agent`
  skill.
- **The run layout,** gitignored: `.claude/worktrees/ship-*` (batch and slice
  worktrees) and `reports/ship-*` (run roots), `reports/kept/`.

Not Ship's, though its stage agents wrap them: every skill a stage agent
preloads but `unattended-agent` (`tdd`, the three reviews, `epic-review`,
`retro`, `pr` and the rest), since each is used by hand too, and the `github`
agent. They are the repo's.
