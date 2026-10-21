# Claude Code workflow runtime

Part of [Platform facts](readme.md) — see the readme for the admission bar and
the living / divergence rules. This category covers the **Claude Code workflow runtime** unattended runs execute in: saved workflows and their `agent()` calls. Facts here are version-stamped against the **Claude Code** release in
their **Platform** line, where one was recorded; a Claude Code release can move them, so re-verify before
relying on one.

## Ship PF-2 · A workflow `agent()` call starts in the launching session's current working directory and loads its CLAUDE.md

Formerly PF-94.

- **Claim.** A workflow `agent()` call starts with cwd set to the launching session's current working directory when the call is made (not a worktree the session made), and, started in the main checkout, loads that checkout's `CLAUDE.md`; no option moves it. A `cd` the session runs while the workflow is live moves the start directory of every later `agent()` call.
- **Implication.** An agent must `cd` by absolute path to the directory it works in, the main checkout included; it cannot rely on its starting cwd.
- **Platform.** Claude Code 2.1.296 workflow runtime.
- **Established.** Live workflow run: an `agent()` reported its cwd and whether `CLAUDE.md` loaded. Deciding output:

  ```text
  cwd /c/Users/maxim/source/paper-harness; CLAUDE.md loaded
  ```

  Then /ship run `wf_1ec9fddb-a82` (2026-10-15): the launching session ran `cd …/reports/ship-1172` mid-run, and a later runner that ran the worktree CLI by its relative path, as given, failed with:

  ```text
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\maxim\source\paper-harness\reports\ship-1172\tooling\worktree.ts'
  ```

- **Last verified.** 2026-10-15.
- **Relied on by.** `ship/src/workflow/runtime.types.ts`, the `Checkout:` line every agent prompt after a run's first call carries (`withCheckout`, `ship/src/workflow/calls/prompts.ts`) and every worktree agent file's absolute-path `cd`.

## Ship PF-3 · A workflow `agent()` honours per-call `model` and `effort`, including effort on a non-default model

Formerly PF-95.

- **Claim.** A workflow `agent()` call honours its per-call `model` and `effort` options; `effort` combined with a non-default `model` resolves to that model.
- **Implication.** Per-stage `model` / `effort` in workflow scripts take effect; no fallback to the session model.
- **Platform.** Claude Code 2.1.296 workflow runtime.
- **Established.** Live workflow run: `agent()` calls with `model` + `effort: 'low'`, each reporting its model id. Deciding output:

  ```text
  model:haiku  effort:low -> claude-haiku-5-5
  model:sonnet effort:low -> claude-sonnet-5-5
  ```

- **Last verified.** 2026-10-10.
- **Relied on by.** `ship/src/workflow/runtime.types.ts` (per-stage `model` / `effort`).

## Ship PF-4 · A saved workflow loads no code by any route: no `import`, no `require`, `process` or `fetch`, no `eval` or `new Function`

Formerly PF-112.

- **Claim.** A saved workflow script cannot load code at run time. A static `import` declaration is refused before launch (`SyntaxError: Unexpected token '{'. import call expects one or two arguments.`: the body is wrapped in a function); a dynamic `import()` of a relative `.mjs`, a relative `.ts` or an absolute `file:///` URL is refused before launch (`SyntaxError: import() is not available in workflow scripts.`); `require`, `process`, `fetch`, `Bun`, `Deno` and `module` are `undefined`; `eval('1+1')` and `new Function(...)` throw `Code generation from strings disallowed for this context`.
- **Implication.** Everything a saved workflow runs must be inside its own text: repo TypeScript reaches it only by rendering, and anything that needs git, `gh` or the filesystem runs as a CLI an `agent()` invokes.
- **Platform.** Claude Code workflow runtime, 2026-09-28; the release was not recorded.
- **Established.** #1026 Q1 ([verdict comment](https://github.com/cragmax/paper-harness/issues/1025#issuecomment-5869948581)): `.claude/workflows/ph-probe-import-static.js` run by `name` and by `scriptPath`, then dynamic-import and globals variants, each refused or `undefined` as above.
- **Last verified.** 2026-09-28.
- **Relied on by.** Ship ADR-0001 decision 1: the render (`ship/src/build/workflow-render.ts`) and `gate:codegen`.

## Ship PF-5 · A workflow `agent()` resolves a project agent by `agentType` and composes it with `schema`; a frontmatter `model` pin is honoured when no per-call `model` is passed

Formerly PF-113.

- **Claim.** `agent(prompt, { agentType, schema })` runs the project agent file `.claude/agents/<agentType>.md`, its `tools` plus the schema's `StructuredOutput` tool, and returns the schema object. With no per-call `model`, the agent file's frontmatter `model:` pin decides the model. Not tested: whether a per-call `model` overrides a frontmatter pin.
- **Implication.** A stage is a project agent file plus an output schema. An agent file that pins a model can silently override the tier table, so agent files carry none.
- **Platform.** Claude Code workflow runtime, 2026-09-28; the release was not recorded.
- **Established.** #1026 Q3 ([verdict comment](https://github.com/cragmax/paper-harness/issues/1025#issuecomment-5869948581)): `agent(…, { agentType: 'gate-run', schema })` reported the agent file's heading and first instruction line, tools `Bash, Read, StructuredOutput`, and returned the schema object; the file's `model: sonnet` showed as `"model":"claude-sonnet-5"` in the transcript.
- **Last verified.** 2026-09-28.
- **Relied on by.** Ship ADR-0001 decisions 1 and 15; `ship/src/workflow/stages.ts` (`agentType` per stage); the pin-free `.claude/agents/` files.

## Ship PF-6 · A workflow agent's single foreground command is capped at 10 minutes; a longer one runs only in the background, polled by chained foreground calls

Formerly PF-114.

- **Claim.** Inside a workflow `agent()`, a foreground Bash command runs to just under the tool's 600,000 ms timeout (a 510 s command returned normally). A longer command cannot run in one foreground call. Run with `run_in_background: true`, it completes while the agent keeps its turn open with chained foreground `timeout 570 bash -c "until grep -q <done> <outfile>; do sleep 5; done"` polls. A background task is terminated when the agent gives its final response, so the agent cannot end its turn and wait for a notification, and `Monitor` returns at once, its notifications arriving only between tool calls.
- **Implication.** A stage whose command can outlast 10 minutes backgrounds it and polls in the foreground, never ending its turn while it runs (the background-and-poll idiom).
- **Platform.** Claude Code workflow runtime, 2026-09-28; the release was not recorded.
- **Established.** #1026 Q6 ([verdict comment](https://github.com/cragmax/paper-harness/issues/1025#issuecomment-5869948581)): `done-fg elapsed_ms=510018` in the foreground; a 660 s command backgrounded, the first poll exiting 124 after 570 s and the second finding `done-bg elapsed_ms=660013`.
- **Last verified.** 2026-09-28.
- **Relied on by.** Ship ADR-0001 decision 9; `.claude/skills/unattended-agent/SKILL.md` (the 10-minute rule).

## Ship PF-7 · Un-awaited workflow `agent()` calls run concurrently, and `Promise.race` over them resolves in completion order

Formerly PF-115.

- **Claim.** In a workflow script, `agent()` promises left un-awaited run concurrently; `Promise.race` over them resolves with whichever finishes first; an `agent()` started while others are pending runs alongside them; and an async function chaining `agent()` calls races the same way. `parallel()` with worker thunks over a shared queue also completes, the workers splitting the jobs.
- **Implication.** A scheduler can keep a set of in-flight slices and start the next as soon as any settles, with no worker-pool fallback; the call order then follows real settle timing, which is why a resumed run with more than one flight replays out of order (Ship ADR-0001 decision 17).
- **Platform.** Claude Code workflow runtime, 2026-09-29; the release was not recorded.
- **Established.** #1036 P1 ([verdict comment](https://github.com/cragmax/paper-harness/issues/1036#issuecomment-5889677041)), inline run `wf_bd49f6ec-b19`, 7 agents at `effort: 'low'`. Event log:

  ```text
  A:start, B1:start, A:done, race1-winner:A,
  C:start, C:done, race2-winner:C,
  B1:done, B2:start, B2:done
  ```

- **Last verified.** 2026-09-29.
- **Relied on by.** Ship ADR-0001 decisions 7 and 17; `ship/src/workflow/drive.ts` (the race loop).
