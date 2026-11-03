# Ship

The application that performs **Unattended runs** in Claude Code: it takes epics or an issue
list from launch to one pull request per epic, with the PR as the only human gate
([Ship ADR-0002](docs/adr/0002-unattended-runs-are-rendered-saved-workflows-behind-one-pr-gate.md)).

Ship is built for one consumer, `cragmax/paper-harness`, and names its conventions verbatim
(§ What Ship requires of a consumer). It has no configuration surface.

## Installing

```sh
npm install --save-dev @cragmax/ship
npx ship-install
```

`ship-install` writes Ship's part of `.claude/` (§ What Ship installs) from the package, and
`ship-install --check` exits 1 naming each installed copy that differs from the package's. The
consumer commits the copies, so a prompt change is reviewable there, and runs the check in its
commit gate.

## Launching

- `/ship epics N…` or `/ship issues N…`, with `--exclude`, `--preflight-only`,
  `--max-slices K` and `--attach ship/<slug>`: a run.
- `/resync ship/<slug>`: bring an open run branch level with `origin/master`.

Both are Saved workflows, which Claude Code also lists as skills.

## What Ship installs

Claude Code finds these only under `.claude/`, so `ship-install` copies them there, each with a
header line saying it is Ship's. It overwrites every copy wholesale, and removes a copy carrying
that header whose source is gone. A file there without the header is the consumer's own: the
install never writes, removes or checks it.

- **The Saved workflows:** `.claude/workflows/ship.js` and `resync.js`, rendered at build time
  from `src/workflow/` into the package's `workflows/`, with the header as their last line.
- **The stage agent files** in `.claude/agents/` (`tdd`, `spec-review`, `test-review`,
  `standards-review`, `script-api-tsdoc`, `issue-readiness`, `issue-overlap`, `epic-review`,
  `retro`, `pr`, `runner`), from `agents/`.
- **The run-only `unattended-agent` skill** in `.claude/skills/`, from `skills/`.

## What Ship requires of a consumer

- **The consumer skills:** each skill a stage agent preloads but `unattended-agent` (`tdd`,
  `spec-review`, `standards-review`, `test-review`, `epic-review`, `pr`, `retro`,
  `issue-overlap`, `issue-readiness`, `script-api-tsdoc` and `probe`), each at
  `.claude/skills/<name>/SKILL.md`. Ship ships none of them: each is used by hand too, and carries
  no run text. `ship-install` reads their names from the agent sources' `skills:` front matter
  and refuses, naming each, while one is missing.
- **The consumer's commands**, run from its main checkout with `node --import tsx`, so `tsx`
  must be among its dependencies:
  - `tooling/git/comment-only.ts`: the comment-only proof, run with `--json`.
  - `tooling/integration/run-integration.ts`: a slice's integration tiers.
  - `server-pool/src/with-lease.ts`: one server lease around a command.
- **The npm scripts** `build` (in a worktree after `npm ci`) and the commit hooks the consumer's
  gate runs; Ship's runs commit under them and never pass `--no-verify`.
- **The environment** a run sets for the consumer's tools: `PH_PROJECT_DIR` (the slice or batch
  being tested), `PH_POOL_REGISTRY` (the run's pool registry copy), `PH_TSSERVER_RESTART` and
  `PH_WORKTREE_POLL_MS`.
- **The pool contract:** the registry at `server-pool/src/registry/pool-registry.json` and the
  lease-log line, both recorded in the consumer's Pool ADR-0004.
- **The run layout and namespaces**, which the consumer keeps free for runs: branches under
  `ship/` and `slice/`, worktrees under `.claude/worktrees/ship-*`, run directories under
  `reports/ship-*` and `reports/kept/`.
- **The `github` agent** is the consumer's own, not Ship's.

## What the repository holds

Folders follow where the code runs (Ship ADR-0003):

| Folder          | Runs                                  | Holds                                                                      |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `src/workflow/` | inside the Workflow runtime, rendered | the Workflow sources of `ship` and `resync`; render-safe only              |
| `src/core/`     | on both sides                         | pure decisions and shared constants (scheduler, run gate, run set); no I/O |
| `src/cli/`      | in a runner agent or a session        | the worktree CLI's commands and the run gate CLI; one JSON envelope out    |
| `src/schemas/`  | at codegen                            | the zod sources of the agent outputs and tool envelopes                    |
| `src/build/`    | at build and install time             | the render, the schema emit, the install and the codegen check             |
| `agents/`       | in Claude Code, once installed        | the sources of the stage agent files                                       |
| `skills/`       | in Claude Code, once installed        | the source of the `unattended-agent` skill                                 |
| `workflows/`    | in Claude Code, once installed        | the rendered Saved workflows; gitignored build output                      |

Tests live in `test/`, under the subfolder of the file they test; the helpers they share live in
`test/helpers/`. Records live in `docs/adr/` and `docs/platform-facts/`, and the terms in
`docs/GLOSSARY.md`.

## Developing

- `npm run build` compiles `src/` into `dist/` and renders the workflows into `workflows/`.
- `npm run codegen` re-emits `src/workflow/schemas.generated.ts` and re-renders.
- `npm run gate` runs every check. The commit hooks run the fast ones; the push hook runs the
  integration tests.
- A push to `master` publishes the version in `package.json`. A `fix` commit on `master` takes
  the next patch version, a `feat` the next minor, and the commit-msg hook refuses one that
  doesn't.
