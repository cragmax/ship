---
status: draft
---

# Ship ADR-0001: Unattended runs with a rendered scheduler, a reviewed slice chain, and the PR as the sole human gate

Ship performs unattended runs. Workflow sources are rendered into saved workflows, which drive a deterministic scheduler over an epic's issues. Each issue is built from its triage brief in a slice worktree, reviewed by stage agents that amend its one commit, and landed on the epic's branch. One pull request (PR) per epic is the only human gate. Ship replaces a long-lived orchestrator session. That session spent half its flow keeping its own context alive, and it hardcoded repo internals that no gate checked. It also planned in bulk, so its plans went stale, and it idled finished slices behind rung barriers. This record restates the retired root unattended-runs record (Framework ADR-0045).

## Decision

### The machine

1. **Orchestration lives in the repo, rendered.** The **Workflow sources** render (`npm run codegen`) into the **Saved workflows** `ship.js` and `resync.js` in `.claude/workflows/`. A Saved workflow loads no code by any route (Ship PF-4). So the render inlines the entry and the transitive closure of its relative value imports, and `gate:codegen` compares the committed file with a fresh render. Rendered code uses ECMAScript built-ins only. It has no imports, and no `eval` or `new Function`. It also has no `Date.now()`, no `Math.random()`, and no `new Date()` without arguments. These last three rules come from the workflow-authoring reference, and no probe has checked them. Mechanical steps are commands of the worktree command-line interface (CLI) and the run gate. A **runner** agent invokes each one from the main checkout with `node --import tsx`, and each one returns a schema-validated JSON envelope. The runner uses `node --import tsx` because an `npx tsx` tool is orphaned from the session's process tree (Ship PF-16). Judgment steps are **Stage agents**, one skill each. Each one is resolved by `agentType` with an output schema (Ship PF-5), and its skill is preloaded (Ship PF-15). Rules and live docs state neutral invariants, and never name a maintainer-personal skill.
2. **Ship's layout follows where its code runs.**
   - `ship/src/workflow/` runs inside the Workflow runtime, rendered.
   - `core/` holds pure, render-safe decisions that both sides use.
   - `cli/` is the input and output (I/O) of the runner or the session.
   - `schemas/` holds the zod sources for codegen.
   - `build/` renders, emits, and checks.

   A depcruise rule lets `workflow/` and `core/` value-import only each other, plus two carve-outs that the render inlines. Neither carve-out imports anything:
   - `server-pool/src/lease-timings.ts`, for `workflow/` only, in place of the pool barrel ([Pool ADR-0001](../../../server-pool/docs/adr/0001-warm-pool-and-lock-file-leasing.md) decision 5).
   - `tooling/hooks/lib/platform-wide.ts`, for the PR body's full-tiers line.

   Type-only imports are free, since the render erases them. So render-safety rests on the folder, not on review. The whole worktree CLI is Ship's, the interactive `commit` command included, since running a CLI is no import edge (Framework ADR-0045 decision 3). Ship's part of `.claude/` stays where Claude Code reads it, and [Ship's README](../../README.md) lists it (Framework ADR-0045 decision 5).

3. **Instructions come from the main checkout.** Every agent instruction (`CLAUDE.md`, `.claude/rules/`, skills, agent files, and the Saved workflow) comes from the main checkout's working tree when each agent starts. A slice's copies are its diff, and no agent follows them. So a run can't change the rules that its later agents obey before the PR is reviewed. Project docs (GLOSSARY, ADRs, and platform facts) are read from the tree under review.

   The run layout makes this so. Every run worktree is a direct child of `<main>/.claude/worktrees/`. A worktree there gets the main checkout's path-scoped rules, and never its own `CLAUDE.md` or rules (Ship PF-14). The run worktrees are the following:
   - The **Batch worktree** `ship-<head>`.
   - The **Slice worktrees** `ship-<head>-<N>-<K>`, or `ship-<head>-a<R>-<N>-<K>` for an **Attached run**.

   The run root, which is its report directory, is `<main>/reports/ship-<head>/`. An unlanded slice's work is kept under `<main>/reports/kept/`. All of these are gitignored, and Windows' 260-character path limit sizes the names. The guards are the following:
   - `provision-batch` refuses a report directory inside the batch or a slice.
   - `retire-run` removes only a real `ship-*` directory directly under `<main>/reports/`.
   - `teardown` and git refuse the main checkout. After it removes a worktree, teardown restarts the session's tsserver (Ship PF-17).

   A dirty main checkout is recorded, never refused. The accepted residuals are the following:
   - A slice that is missing its `node_modules` junction resolves modules from the main checkout's, silently.
   - A manual recursive clean in the main checkout reaches live runs.

### Launch

4. **Pre-flight runs while the maintainer is present, collects every refusal, and never pauses.** It runs these steps in order:
   1. The checks: master is level, `gh` is logged in, and the **Warm set** is warm.
   2. The **Run gate**.
   3. `live-runs`.
   4. The `issue-readiness` agent, once over the run set.
   5. The `issue-overlap` agent, once over what is left and the changed files of the unspent live runs.

   No check stops the phase early. A missing or partial verdict is a refusal, never a pass. A leftover slice branch refuses the launch unless its run is spent. Once pre-flight passes, the spent runs' batches are torn down and their runs retired. `--preflight-only` stops before this teardown.

5. **The run gate is rubric point 2 inside a run.** The run set is an epic's open children, or an explicit list, and several epics are allowed. The container is never gated. Each issue must be open and `ready-for-agent`, with every `blocked_by` closed or inside the run set. In an attached run (decision 16), a `blocked_by` also counts as satisfied when it has landed on the target branch: a first-parent, non-merge commit in `origin/master..origin/ship/<slug>` cites it `fixes #N` in its body. A `see #N` citation never counts, since the issue did not fully land. Edges inside the set become scheduler edges, and a cycle refuses the launch. A failure refuses the launch, and the refusal lists every failing issue. In exclude mode, the gate instead drops the failures, a stale or not-ready verdict among them, with their transitive dependents. Each issue's label is re-checked when the issue becomes ready. If the label was removed, the run skips the issue and its dependents.
6. **Overlap edges, estimated before anything is built.** From the issue text and the tree, the `issue-overlap` agent estimates which issues will touch the same files, each pair `likely` or `unsure`. Within an epic, only a `likely` pair adds an edge. An `unsure` pair orders no slices, and the run report's overlap record lists it with its shared paths and reason, so a retro can check it against harvest conflicts. A missed overlap still self-heals through the requeue (decision 7). Each pair is directed along a topological order of the declared edges, with ties broken by run-set order, so the union stays acyclic. A pair whose shared paths are all generated files adds no edge. An overlap between two epics refuses the launch, `unsure` included, and so does an overlap with a live run. This keeps the epics of a run, and concurrent runs, code-disjoint.

### The issues

7. **A deterministic scheduler with optimistic requeue.** The scheduler is rendered JavaScript, with no large language model (LLM) and no context budget. Each issue starts as soon as its dependencies have landed, under one `MAX_SLICES` cap (4) across all the run's epics, with no rung barriers. The drive loop races un-awaited flights with `Promise.race`, in completion order (Ship PF-7). A slice holds its slot until it settles, the wait in the commit queue included. Epic ends run outside the cap. On a harvest conflict, the slice is discarded and re-cut from the current epic head: this is the requeue. The re-cut attempt is handed its previous attempt's patch, the slice's one commit after every review amend. Its tdd agent applies that patch three-way and resolves the conflict instead of rebuilding from the issue, and the reviews run in full on the result. If the conflict is confined to `eslint-suppressions.json`, that file is regenerated instead. A dead agent is retried once from a fresh worktree, and then its issue is blocked. (amended 2026-10-24: an agent that dies after the tdd's commit hands its retry that commit, after every review amend that landed, as a patch the retry resumes as a requeued attempt does. A death before that commit retries from the issue, since the half-built work may be what killed it. The dead stage's uncommitted edits are never handed on. They are kept only for the maintainer.) An issue that settles without landing (blocked, retry-exhausted, or its label removed) skips only its declared dependents, transitively along declared edges. It releases its overlap edges, and those of each dependent it skips: an issue that lands nothing touches nothing, so each overlap edge's dependent starts as if the edge's blocker had landed. The run report's schedule names each released edge and how its blocker settled. A landing that leaves the batch unverified halts that epic. The epic gets no further starts or landings, no epic end, and no PR. Its in-flight slices are torn down, and its unlanded issues are cited `see #N`. The run's other epics carry on.
8. **The slice chain.** Each attempt runs in its own Slice worktree, cut from its epic's head, through these stages in order:
   1. Label re-check.
   2. Cut.
   3. Provision.
   4. tdd.
   5. **Spec review**.
   6. **Test review**.
   7. **Standards review**.
   8. Script API TSDoc.
   9. Land.

   Planning happened at triage. The tdd stage builds from the issue, whose brief is the plan, sized at ticket time by the **Slice budget**. If the tree has overtaken an issue, or a probe falsifies the issue's named mechanism, the issue is blocked before any commit. The tdd stage makes the slice's one commit and chooses `fixes` or `see`. It chooses `see` for an acceptance line that needs a human. Each review verifies its findings against the code, applies them once, and amends that commit. There is no re-review loop, so a review has a fixed cost. After an amend, the slice's changed files are re-read from git. (amended 2026-10-24: the standards review may amend a file outside the slice's changed files when the slice's own change made that file wrong, such as a doc that lists the exports the slice changed. Any other fix outside them blocks the slice. A clash with another slice over the extra file is caught at harvest and requeued, per decision 7.) A blocked review stops the slice. Test review is skipped on a trivial surface, one with no path under the code prefixes. It's also skipped when `comment-only` proves the commit comment-only. Script API TSDoc runs only when the slice changes `src/`. Each stage runs only the tests that its change makes relevant (`testing.md` § Which tests a change runs). (amended 2026-10-23: each check a slice runs has one owner. The commit hooks own the gates. Pre-commit runs them on every slice commit and amend, and pre-push runs `gate:core` at the epic end, so no stage agent runs a `gate:*` script. The tdd stage owns the run of the tests its change makes relevant. Test review owns mutation. The tdd stage runs only its inline proof's capped mutants.) Server-tier runs take **per-invocation leases** on the Warm set through `with-lease`, 600 s each.

9. **Probes inside a run** are pre-approved and lease-bound. Each probe is capped at 15 min, and each stage at 3 probes. Each record carries its measured `seconds`. The agent enforces these caps. A command that can outlast a call's 10-minute cap goes to the background. Chained foreground `timeout 570 … until` calls poll it, and the turn never ends while it runs (Ship PF-6). A probe that hits a cap, or is inconclusive, records nothing and adds a PR follow-up. A probe that reconfigures the rig (a plugin jar swap, a compose or `server.properties` change, or a Docker restart) blocks the issue.
10. **One branch and one commit queue per epic.** All of a run's work lands on the epic's `ship/<slug>` branch in its Batch worktree, without consent for each commit. That work is the issue commits, the `origin/master` merge, and the bump. Per-slice branches are scratch: they're never pushed or merged. The **Commit queue** lands one commit per issue, `fixes #N` or `see #N`, under lefthook. A guard holds the staged set equal to the slice's files. A failed pick, build, or commit is rolled back with `git reset --hard HEAD` in the batch worktree only, never in the main checkout (maintainer-approved 2026-09-28).
11. **The Warm set is 2 Paper and 2 Folia servers.** A run's slices are the per-invocation consumer of Pool ADR-0001, on the four registry servers that the batch's registry trim keeps. Pre-flight requires all four to be warm. Together, the four servers peaked at about 16.6 GiB with no out-of-memory (OOM) error, and their ticks per second (TPS) never fell below 19.6 (Pool PF-1). (amended 2026-10-23: the registry servers now run a 2G heap under Pool ADR-0001. Pool PF-1 measured these figures at 4G, and Pool PF-2 holds the 2G measurements.)

### The epic end

12. **The epic end, in order.** Once an epic's last slice settles, the epic end runs these steps:
    1. The **epic review** over the batch.
    2. The master sync, under the run's repo lock. If `origin/master` moved, the sync merges it, and never rebases. Any conflict stops the epic, except a conflict in the lockfile or the version line. (amended 2026-10-21: a doc-index conflict no longer goes to a resolver agent, which never ran in a recorded run.)
    3. The bump.
    4. The **retro** and the `pr` agent, concurrently.
    5. The publish task, under the repo lock: a look at the main checkout, a forward-only check of `master` since launch, the push, and the PR.
    6. A comment on each issue that the run blocked, giving the reason and the PR or branch.

    These points also apply to the epic end:
    - **The PR is the sole human gate.** The Workflow tool takes no input in the middle of a run. If the epic-review verdict is rejected or empty, the PR opens as a draft.
    - **The push is the server tier.** The epic end runs no server-tier step of its own. Its push goes through the pre-push hook, which runs the server tier on both engines when the pushed range touches a Platform-wide path ([Tooling ADR-0002](../../../tooling/docs/adr/0002-change-scoped-pre-push.md), amended by it 2026-10-16: before, the push ran the full server tier on every range). So a red tier refuses the push, and no PR opens. `npm run test:nightly` is the backstop.
    - **The retro runs for every entry that was cut**, whether it shipped, halted, stopped, or landed nothing. Its findings go in the PR body. An epic end that stops after the retro re-runs it over the final report, and keeps only the re-run's findings.
    - **Resync** shares the master sync. The `resync` Saved workflow brings an open run branch level with `origin/master`. After a check that the PR is open, it pushes unforced through the pre-push hook. It never uses GitHub's server-side update.
    - The one repo lock serialises the steps of every epic end that fetch or push. A failed issue comment is recorded, and never fails the run. The run changes no label.

13. **The PR body.** The body holds these parts:
    - Summary and Merge Danger, from the `pr` agent over the net diff.
    - Evidence, from each landed slice's tdd tracer record.
    - The issue lines (`fixes` and `see`), each with its `Test review:` line.
    - A `## Recorded` section of each issue's recorded values.
    - The lease timings.
    - Whether the full tiers ran at push.
    - The run report, folded.

    If the `pr` agent returns nothing, the run still publishes the PR, with that agent's sections marked unavailable. If a body is over GitHub's 65,536-character limit, the report's movable sections (`MOVABLE_SECTIONS` in `ship/src/workflow/pr/pr-body.ts`) move to PR comments in that order, and each one leaves a pointer line. If the body is still over the limit, `publish` refuses it before the push.

14. **One net version bump per PR.** Issue commits never bump, because per-slice bumps on concurrent branches conflict on the version line. If any of the branch's own non-merge commits since `origin/master` is a `feat`, the kind is `minor`. Otherwise it's `patch`. The target is `origin/master`'s version, bumped by that kind. If a branch is already at the target, it gets no commit. Otherwise, one bump commit sets it. A resync merge sets the version to `master`'s, bumped by the branch's own bump. It does so even when both sides bumped to the same number, so the net stays one.
15. **Per-stage tiers are set in one table.** The tier table holds every stage's `agentType`, `model`, and `effort`, and each `agent()` call passes them (Ship PF-3). Agent files carry no model pin. A frontmatter pin is honoured when a call passes no `model` of its own (Ship PF-5), so a pin could silently override the table.

### Attached runs and recovery

16. **Attached runs.** `/ship issues N… --attach ship/<slug>` lands issues on an open PR's existing branch, and pushes onto that PR. `epics` with `--attach` is refused, and the run has one entry. Pre-flight refuses the target on `no-open-pr`, `slices-live`, or `unpublished-commits` (first-parent non-merge commits that `origin` lacks). `issue-readiness` and `issue-overlap` judge the PR head, and the overlap check skips only the target. Setup reuses the branch's Batch worktree, or checks it out anew. The entry's base is the attached tip. The run takes the lowest number R that no earlier `attach-<R>/` report folder or `a<R>-` slice branch holds. The epic end runs these steps:
    1. Epic review over this run's slices.
    2. Master sync.
    3. Bump.
    4. Retro, with no `pr` agent.
    5. A push onto the open PR.

    If the PR closed in the meantime, the epic stops. After a successful push, the run posts its report, folded, as one PR comment. It also appends one `## Attached run <R>` section to the PR's body, with Evidence, Issues, Recorded, and a link to the comment. Everything already in the body is kept byte for byte, and the closing-keyword neutraliser runs over the new text. A body or comment over the limit is refused before `gh` runs. A refused or failed push posts and edits nothing. A failed post or edit never fails the run.

17. **Resume only a one-flight run, and recover every other by hand.** The Workflow runtime's resume replays cached results for the longest unchanged prefix of `agent()` calls, keyed by position. With more than one flight, the call order follows real settle timing. So a replay breaks the prefix at the first overlap, and re-runs landed issues. Resume is supported only for a one-entry run launched with `--max-slices 1` whose script is unchanged, or changed only in code after the last finished call. Manual recovery has two steps:
    1. Stop the run.
    2. Write and run a continuation script. This script is the run's script with its entry point replaced by a direct `epicEnd` call. That call's `EpicEndInput` is copied from the run's journal as literals, since a script reads no files.

    A stopped attached run leaves its fixes unpublished. A later attached run's pre-flight and `/resync` refuse (`unpublished-commits`) until a continuation epic end pushes the fixes with `publish --push-only` and appends its section. Stopping a run doesn't end its in-flight tool's process tree, and doesn't release that tool's lease.

## Alternatives considered

- **Import the gate and scheduler into the Saved workflow.** This is impossible (Ship PF-4).
- **Rung-barrier scheduling.** Rejected, because epic-986 idled four finished slices for 34 min.
- **Bulk planning before the run, or a planner inside each slice.** Bulk plans went stale against later landings. The per-slice planner and the plan review were retired in favour of the triage brief.
- **Pessimistic overlap serialisation.** Rejected. The estimate precedes any build, so this approach would serialise most of an epic. And the requeue makes a miss self-heal.
- **Mid-run gates or per-commit consent.** Rejected. The Workflow tool takes no input in the middle of a run, and either one defeats an away-from-keyboard (AFK) run.
- **Model pins in agent files.** Rejected, because 46 runs once ran a judgment agent on a model other than the session's, and a pin can override the table.
- **An epic-end-only `/ship` mode fed from run state under `reports/`.** Deferred until parallel or multi-epic runs are routine. Manual recovery covers those runs. **Deterministic replay for parallel runs.** Rejected, because lockstep rounds would undo completion-order scheduling.
- **A run root outside the project, or under `tmp/` or an untracked dot-directory.** Rejected. Outside the project, no path-scoped rule loads (Framework PF-90). Inside the project but not under `.claude/worktrees/`, a worktree loads its own `CLAUDE.md` and rules (Ship PF-14). **Full-slug worktree names.** Rejected, because the longest list slug puts a slice's deepest path near 300 characters, against Windows' limit of 260.

## Consequences

- The scheduler exists twice, as source and as render, and only `gate:codegen` holds the two together.
- A missed overlap estimate wastes one slice's build (the requeue). Steering in the middle of a run is limited to removing a label. A rejected PR rejects a whole epic's work at once.
- `MAX_SLICES` and the probe caps were confirmed on real runs, not tuned by a controlled measurement. Long commands need the background-and-poll idiom.
- A run of more than one flight can't be resumed once it's cut. It can only be recovered by hand.
