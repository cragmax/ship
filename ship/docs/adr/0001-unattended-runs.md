# Ship ADR-0001: Unattended runs — a rendered scheduler, a reviewed slice chain, the PR as the sole human gate

Date: 2026-10-16
Status: DRAFT. Supersedes ADR-0045.

> Restates [ADR-0045](../../../docs/adr/0045-unattended-runs.md) as Ship
> stands once Epic 2 of the tooling-split map (#1483) has moved it here.
> Decided on wayfinder ticket #1488, 2026-10-16; decision 2's layout on #1486. ADR-0045 holds the history and the old → new decision map.

## Context

AFK issue delivery once ran through maintainer-personal skills as one
long-lived LLM orchestrator session (PRD #1025). Nothing gated the repo
internals those skills hardcoded; about half the batch flow existed to keep the
orchestrator's context alive; plans written in bulk went stale before they were
built; and rung barriers idled finished slices (epic-986: four slices,
34 min). Ship is the application that replaces it: it performs **Unattended
runs**, each taking a **Run set** from launch to one pull request per epic with
no human gate between.

## Decision

### The machine

1. **Orchestration lives in the repo, rendered.** The **Workflow sources**
   render (`npm run codegen`) into the **Saved workflows** `ship.js` and
   `resync.js` in `.claude/workflows/`, where the Workflow tool finds them. A
   Saved workflow loads no code by any route
   ([PF-112](../../../docs/platform-facts/mcp-client.md)), so the render
   inlines the entry and the transitive closure of its relative value imports,
   and `gate:codegen` compares the committed file with a fresh render. Rendered
   code uses ECMAScript built-ins only: no imports, no `eval` or
   `new Function`, and (per the workflow-authoring reference, documented, not
   probed) no `Date.now()`, `Math.random()` or argless `new Date()`.
   - **Mechanical steps are commands; judgment steps are stage agents.** The
     worktree CLI's commands and the run gate do every git, `gh`, npm and file
     step; a **runner** agent invokes each from the main checkout with
     `node --import tsx` (an `npx tsx` tool is orphaned from the session's
     process tree, [PF-109](../../../docs/platform-facts/node-runtime.md)) and
     returns its JSON envelope, schema-validated. Every judgment is a **Stage
     agent** running one skill, resolved by `agentType` with an output schema
     ([PF-113](../../../docs/platform-facts/mcp-client.md)), its skill
     preloaded ([PF-107](../../../docs/platform-facts/mcp-client.md)).
   - **Rules and live docs state neutral invariants** and never name a
     maintainer-personal skill.
2. **Ship's layout follows where its code runs.** `ship/src/workflow/` runs
   inside the Workflow runtime, rendered; `core/` holds pure, render-safe
   decisions used on both sides; `cli/` is runner or session I/O
   (`commands/`, `envelope/`, `git/`); `schemas/` holds the zod sources for
   codegen; `build/` renders, emits and checks. A depcruise rule lets
   `workflow/` and `core/` value-import only each other, plus two named
   carve-outs the render closure inlines, neither importing anything:
   `server-pool/src/lease-timings.ts`, in place of the pool barrel
   ([Pool ADR-0001](../../../server-pool/docs/adr/0001-warm-pool-and-lock-file-leasing.md)
   decision 5), and `tooling/lib/platform-wide.ts`, whose `isPlatformWide`
   and `MAX_RELATED_FILES` the PR body's full-tiers line reads. Type-only
   imports are free, since the render erases them. So render-safety is held
   by folder, not by review. A file
   belongs to the home that imports it, and running a CLI is no import edge
   (ADR-0048 decision 2): the whole worktree CLI is Ship's, the interactive
   `commit` command included, and so are `comment-only` and `describe-error`.
   Ship's part of `.claude/` stays where Claude Code reads it and is listed in
   [Ship's README](../../README.md) (ADR-0048 decision 4).
3. **Instructions come from the main checkout.** Every agent instruction
   (`CLAUDE.md`, `.claude/rules/`, skills, agent files, the Saved workflow)
   comes from the main checkout's working tree when each agent starts; a
   slice's copies are its diff, never followed, so a run cannot change the
   rules its later agents obey before the PR is reviewed. Project docs
   (GLOSSARY, ADRs, platform facts) are read from the tree under review.
   - **The run layout makes it so.** Every run worktree is a direct child of
     `<main>/.claude/worktrees/`, which gets the main checkout's path-scoped
     rules and never its own `CLAUDE.md` or rules
     ([PF-104](../../../docs/platform-facts/mcp-client.md)): the **Batch
     worktree** `ship-<head>`, **Slice worktrees** `ship-<head>-<N>-<K>`
     (`ship-<head>-a<R>-<N>-<K>` for an **Attached run**). The run root, its
     report dir, is `<main>/reports/ship-<head>/`; an unlanded slice's work is
     kept under `<main>/reports/kept/`, outside every run root. All are
     gitignored. Windows' 260-character path limit sizes the names: the worst
     path is 235.
   - **Guards.** `provision-batch` refuses a report dir inside the batch or a
     slice; `retire-run` removes only a real `ship-*` directory directly under
     `<main>/reports/`; `teardown` and git refuse the main checkout, and
     teardown restarts the session's tsserver after it removes a worktree
     ([PF-110](../../../docs/platform-facts/mcp-client.md)). A dirty main
     checkout is recorded, never refused.
   - **Accepted residuals.** A slice missing its `node_modules` junction
     resolves modules from the main checkout's, silently; no tsconfig sets
     `typeRoots`; the main checkout's `gate:format` enumerates nested
     checkouts; a manual recursive clean there reaches live runs.

### Launch

4. **Pre-flight runs while the maintainer is present, collects every refusal
   and never pauses.** In order: the checks (master level, `gh` logged in,
   the **Warm set** warm), the **Run gate**, `live-runs`, the
   `issue-readiness` agent once over the run set (staleness and the
   `ready-for-agent` rubric), then the `issue-overlap` agent once over what is
   left and the unspent live runs' changed files. No check stops the phase
   early, and a missing or partial verdict is a refusal, never a pass. A
   leftover slice branch refuses unless its run is spent. Once pre-flight
   passes, the spent runs' batches are torn down and their runs retired
   (`--preflight-only` stops before).
5. **The run gate is rubric point 2 inside a run.** The run set is an epic's
   open children (the container is never gated) or an explicit list, several
   epics allowed. Each issue must be open and `ready-for-agent`, every
   `blocked_by` closed or inside the run set; in-set edges become scheduler
   edges and a cycle refuses. By default a failure refuses the launch, listing
   every failing issue; exclude mode drops the failures, a stale or not-ready
   verdict among them, with their transitive dependents. Each issue's label is
   re-checked when it becomes ready; a removed label skips it and its
   dependents.
6. **Overlap edges, estimated before anything is built.** The `issue-overlap`
   agent estimates which issues will touch the same files, from the issue text
   and the tree; when unsure, it adds the edge. A pair is directed along a
   topological order of the declared edges (ties by run-set order), so the
   union stays acyclic. A pair whose every shared path is a generated file
   (`eslint-suppressions.json`) adds none. An overlap between two epics,
   `unsure` included, refuses the launch, as does one with a live run: the
   epics of a run, and concurrent runs, are code-disjoint.

### The issues

7. **A deterministic scheduler with optimistic requeue.** Rendered JS, no
   LLM, no context budget: each issue starts as soon as its dependencies have
   landed, under one `MAX_SLICES` cap (4) across all the run's epics, with no
   rung barriers. The drive loop races un-awaited flights with `Promise.race`
   in completion order ([PF-115](../../../docs/platform-facts/mcp-client.md)).
   A slice holds its slot until it settles, the commit-queue wait included;
   epic ends run outside the cap. Four is known to have broken nothing on real
   runs, not measured to have headroom (#1038).
   - **On a harvest conflict** the slice is discarded and re-cut and re-built
     from the current epic head (the requeue); one confined to
     `eslint-suppressions.json` is regenerated instead
     (`eslint --prune-suppressions`). A dead agent is retried once from a
     fresh worktree, then its issue is blocked; a blocked issue skips only its
     transitive dependents.
   - **A landing that leaves the batch unverified** (a failed rollback, or a
     batch not clean afterwards) halts that epic: no further starts or
     landings, no epic end, no PR. Its in-flight slices are torn down and its
     unlanded issues cited `see #N`; the run's other epics carry on.
8. **The slice chain.** Each issue attempt runs, in its own Slice worktree
   cut from its epic's head: label re-check → cut → provision → tdd → **Spec
   review** → **Test review** → **Standards review** → Script API TSDoc → land.
   - **Planning happens at triage, not in the run.** The tdd builds from the
     issue, its triage brief the plan; sizing is the ticket-time **Slice
     budget**, judged when the ticket is cut. An issue the tree has overtaken,
     or whose named mechanism a probe falsifies, is blocked before any commit.
     The tdd makes the slice's one commit and chooses its line, `fixes` or
     `see` (`see` for an acceptance line that needs a human), and the values
     the issue asks it to record.
   - **Each review verifies its findings against the code, applies them once
     and amends the slice's one commit**: no re-review loop, so a slice's
     review has a fixed cost. After an amend, the slice's changed files are
     re-read from git, never carried stale. A blocked review stops the slice.
   - **Skips.** Test review is skipped on a trivial surface (no path under the
     code prefixes) or a commit `comment-only` proves comment-only;
     Script API TSDoc runs only when the slice changes `src/`.
   - **Each stage runs only the tests its change makes relevant**
     (`write-testing.md` § Which tests a change runs), beside its own
     red-green runs. Server-tier runs take **per-invocation leases** on the
     Warm set through `with-lease`, 600 s per lease.
9. **Probes inside a run** are pre-approved and lease-bound, under a cap of
   15 min per probe and 3 per stage: the tdd and each slice review may each run
   the full count, since no stage reports or receives another's probes. Each
   probe record carries its measured `seconds`; enforcement is the agent's. A
   command that can outlast a call's 10-minute cap goes to the background,
   polled by chained foreground `timeout 570 … until` calls, the turn never
   ended while it runs ([PF-114](../../../docs/platform-facts/mcp-client.md)).
   A cap hit or inconclusive probe records nothing and adds a PR follow-up.
   Rig-reconfiguring probes (a plugin jar swap, a compose or
   `server.properties` change, a Docker restart) are forbidden and block the
   issue. The 15 and 3 held on real runs (#1038): no probe reached the time
   cap, one issue the count.
10. **One branch and one commit queue per epic.** All of a run's work lands on
    the epic's `ship/<slug>` branch in its Batch worktree without per-commit
    consent: issue commits, the `origin/master` merge and the bump.
    Per-slice branches are scratch, never pushed or merged. The **Commit
    queue** lands one commit per issue, `fixes #N` or `see #N`, the staged set
    guarded equal to the slice's files, under lefthook. A failed pick, build or
    commit is rolled back with `git reset --hard HEAD` in the batch worktree
    only, never the main checkout (maintainer-approved 2026-09-28).
11. **The Warm set is 2 Paper + 2 Folia.** A run's slices are Pool ADR-0001's
    per-invocation consumer, on the four registry servers the batch's registry
    trim keeps; pre-flight requires all four warm. Four servers peaked at
    about 16.6 GiB together with no OOM and TPS never below 19.6
    ([PF-56](../../../docs/platform-facts/pool-capacity.md)).

### The epic end

12. **The epic end, in order.** Once an epic's last slice settles: the **epic
    review** over the batch → the master sync, under the run's repo lock (a
    merge of `origin/master` if it moved, never a rebase; a doc-index
    conflict goes to the `resolve-index-conflicts` agent, any other conflict
    stops the epic) → the bump → the **retro** and the `pr` agent, concurrently
    → the publish task, under the repo lock: a look at the main checkout, a
    forward-only check of `master` since launch, the push, the PR → a comment
    on each issue the run blocked, giving the reason and the PR or branch.
    - **The PR is the sole human gate.** No mid-run gate: the Workflow tool
      takes no mid-run input. A rejected or empty epic-review verdict opens
      the PR as a draft.
    - **The push is the server tier.** The epic end runs no server-tier step
      of its own: its push goes through the pre-push hook, which runs the
      server tier on both engines across the pool when the pushed range
      touches a Platform-wide path ([ADR-0051](../../../docs/adr/0051-change-scoped-pre-push.md)),
      so a red tier refuses the push and no PR opens; `npm run test:nightly`
      is the backstop.
    - **The retro runs for every entry that was cut** (shipped, halted,
      stopped or with nothing landed), and its findings go in the PR body. An
      epic end that stops after the retro re-runs it over the final report and
      keeps only the re-run's findings.
    - **Resync** shares the master sync: the `resync` Saved workflow brings an
      open run branch level with `origin/master` and pushes unforced through
      the pre-push hook after an open-PR check, never GitHub's server-side
      update.
    - The epic ends' fetch- and push-bearing steps are serialised run-wide by
      the one repo lock. A failed issue comment is recorded in the run report,
      never fails the run, and the run changes no label.
13. **The PR body.** Summary and Merge Danger from the `pr` agent over the
    PR's net diff; Evidence from each landed slice's tdd tracer record; the
    issue lines (`fixes`, `see`) visible, each with its `Test review:` line; a
    `## Recorded` section with each issue's recorded values as code spans; the
    lease timings; whether the full tiers ran at push; the run report folded.
    A `pr` agent that returns nothing still publishes, both its sections
    marked unavailable. A body over GitHub's 65,536-character limit moves the
    run report's Overlap edges, Schedule and Retro findings to PR comments,
    each leaving a pointer line; `publish` refuses a body still over the limit
    before the push.
14. **One net version bump per PR.** Issue commits never bump: per-slice bumps
    on concurrent branches conflict on the version line. The kind is `minor`
    when any of the branch's own non-merge commits since `origin/master` is a
    `feat`, else `patch`; the target is `origin/master`'s version bumped by
    that kind. A branch already at the target gets no commit, otherwise one
    more bump commit sets it. A resync merge sets the version to `master`'s
    bumped by the branch's own bump, also when both sides bumped to the same
    number, so the net stays one.
15. **Per-stage tiers are set in one table.** The tier table holds every
    stage's `agentType`, `model` and `effort`, passed on each `agent()` call
    ([PF-95](../../../docs/platform-facts/mcp-client.md)). Agent files carry
    no model pin: a frontmatter pin is honoured when no per-call `model` is
    passed ([PF-113](../../../docs/platform-facts/mcp-client.md)), so it could
    silently override the table, and interactive use without one inherits the
    session model.

### Attached runs and recovery

16. **Attached runs.** `/ship issues N… --attach ship/<slug>` lands issues on
    an open PR's existing branch and pushes onto that PR; `epics` with
    `--attach` is refused, and the run has one entry.
    - **Pre-flight** refuses the target on `no-open-pr` (a `gh` that cannot
      report the PR included), `slices-live` or `unpublished-commits`
      (first-parent non-merge commits `origin` lacks). `issue-readiness` and
      `issue-overlap` judge the PR head; the overlap check skips the target
      only.
    - **Setup** reuses the branch's Batch worktree or checks it out anew. The
      entry's base is the attached tip; the run takes the lowest number R no
      earlier `attach-<R>/` report folder or `a<R>-` slice branch holds.
    - **Epic end:** epic review over this run's slices, master sync, bump,
      retro (no `pr` agent), then a push onto the open PR. A PR closed
      meanwhile stops the epic and its issues stay open. After a push that
      succeeded, this run's report is posted folded as one PR comment, then
      one `## Attached run <R>` section is appended to the PR's body
      (`### Evidence`, `### Issues`, `### Recorded`, a link to the report
      comment). Everything already in the body stays byte for byte; the
      closing-keyword neutraliser runs over the new section, sparing this
      run's landed `fixes` issues, and over the report comment. A body or
      comment over the limit is refused before `gh`; a refused or failed push
      posts and edits nothing; a failed post or edit never fails the run.
17. **Resume only a one-flight run; recover every other by hand.** The
    Workflow runtime's resume replays cached results for the longest unchanged
    prefix of `agent()` calls, keyed by position (#1058). With more than one
    flight, the call order follows real settle timing, so a replay breaks the
    prefix at the first overlap and re-runs landed issues. Resume is supported
    only for a one-entry run launched with `--max-slices 1` whose script is
    unchanged, or changed only in code after the last finished call; the
    in-flight call re-runs live against whatever its first run did.
    - **Manual recovery:** stop the run; write a continuation script, the
      run's script with its entry point replaced by a direct `epicEnd` call
      whose input (`EpicEndInput`) is written in as literals copied from the
      run's journal (a script reads no files): the entry, the launch
      snapshot, each landed issue's stage outputs and land commit, every
      issue's outcome and schedule, the teardown residue, the overlap record
      and a fresh repo lock; run it.
    - **A stopped attached run leaves its fixes unpublished**; a later attached
      run's pre-flight and `/resync` refuse (`unpublished-commits`) until a
      continuation epic end pushes them with `publish --push-only` and appends
      its section.
    - Stopping a run neither ends its in-flight tool's process tree nor
      releases that tool's lease.

## Consequences

- **Earned:** a repo change and its orchestration consequences are reviewed
  and gated together; the scheduler has no context budget; finished work never
  idles behind a rung; each issue is built on what its predecessors landed;
  one human gate.
- **Accepted:** the scheduler exists twice, source and render, held together
  only by `gate:codegen`; a missed overlap estimate wastes one slice's build
  (the requeue); mid-run steering is limited to removing a label; `MAX_SLICES`
  and the probe caps were confirmed on real runs, not tuned by a controlled
  measurement; long commands need the background-and-poll idiom; a rejected PR
  rejects a whole epic's work at once; a run of more than one flight cannot be
  resumed once cut, only recovered by hand.

## Alternatives considered

- **Import the gate and scheduler into the Saved workflow.** Impossible
  ([PF-112](../../../docs/platform-facts/mcp-client.md)).
- **Rung-barrier scheduling.** Rejected: epic-986 idled four finished slices
  for 34 min.
- **Bulk planning before the run, or a planner inside each slice.** Bulk
  plans went stale against later landings (epic-978, epic-986); the
  per-slice planner and plan review were retired for the triage brief
  (6b627572).
- **Pessimistic overlap serialisation.** Rejected: the estimate precedes any
  build, so it would serialise most of an epic, and the requeue makes a miss
  self-heal.
- **Mid-run gates or per-commit consent.** Rejected: the Workflow tool takes
  no mid-run input, and either defeats AFK.
- **Model pins in agent files.** Rejected: 46 runs once ran a judgment agent
  on a different model than the session, and a pin can override the table.
- **An epic-end-only `/ship` mode fed from run state under `reports/`**
  (#1058). Deferred until parallel or multi-epic runs are routine; manual
  recovery covers them.
- **Deterministic replay for parallel runs** (#1058). Rejected: lockstep
  rounds would undo completion-order scheduling.
- **A run root outside the project, or under `tmp/` or an untracked
  dot-directory** (#1401). Rejected: outside the project no path-scoped rule
  loads ([PF-103](../../../docs/platform-facts/mcp-client.md)); inside but not
  under `.claude/worktrees/`, a worktree loads its own `CLAUDE.md` and rules
  (PF-104).
- **Full-slug worktree names** (#1401). Rejected: the longest list slug puts a
  slice's deepest path near 300 of Windows' 260 characters.

## Evidence

- PRD #1025's evidence base: 14 batch report sets, 4 timed batches, 91 sessions
  and 409 sub-agent transcripts (2026-09-19 → 09-28).
- The Workflow-runtime verdicts of #1026 and #1036, now PF-112 … PF-115.
- The #1038 recording of six real runs (2026-09-29 → 09-30), behind
  `MAX_SLICES` and the probe caps.
