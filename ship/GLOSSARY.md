# Ship

The terms of the `ship/` home (ADR-0048). The product's terms live in the root [GLOSSARY.md](../GLOSSARY.md), among them the reviews a slice runs (**Spec review**, **Test review**, **Standards review**), **Checkpoint** and **Slice budget**, which sessions use with no run involved; the pool's, **Lease** among them, in [server-pool/GLOSSARY.md](../server-pool/GLOSSARY.md).

## Language

### The application

**Ship**:
The application that performs **Unattended runs**: the `ship/` home, its **Saved workflows** and its stage agents.
_Avoid_: "the ship machine", "the workflow" (for the whole application).

**Workflow source**:
The typed TypeScript under `ship/src/workflow/` that renders into a **Saved workflow**: the entry plus every file its relative value imports reach.
_Avoid_: bare "the workflow" (ambiguous between this, the **Saved workflow** and the **Workflow runtime**).

**Saved workflow**:
A rendered, import-free JS script in `.claude/workflows/` that the **Workflow tool** runs by name: `ship.js` and `resync.js`. Generated from its **Workflow source**, never edited by hand.
_Avoid_: "workflow script" (Claude Code's term for any script, saved or inline); bare "the workflow".

**Workflow tool**:
Claude Code's tool that runs a workflow script; the **Workflow runtime** is what executes the script and its `agent()` calls. Capitalised: they are the platform's, not Ship's.
_Avoid_: "workflow engine"; "CI workflow" is a GitHub Actions file in `.github/workflows/`, unrelated.

### Runs

**Unattended run**:
An AFK delivery run that ships a **Run set** from launch to PR with no human gate in between. Pre-flight runs while the maintainer is present and fails fast; it never pauses. Its work lands on the epic's feature branch — one commit per landed issue — and the PR (feature → `master`) is the only human gate ([Ship ADR-0001](docs/adr/0001-unattended-runs.md)).
_Avoid_: "batch" for the run (collides with the `batch:N` labels and RCON batching).

**Run set**:
The issues one **Unattended run** ships: an epic's open children (closed ones are done and omitted; the container is never a member; several epics may be combined) or an explicit issue list. Shape `{ epic | null, issues }[]`, one entry per epic.
_Avoid_: "epic" for the set (a set may span several epics, or none).

**Run gate**:
The launch check that decides whether an **Unattended run** may start. Each issue must be open and `ready-for-agent`, with every `blocked_by` closed or inside the **Run set** (in the same epic when the set spans several — epics are disjoint) — the `ready-for-agent` rubric's "unblocked" point, relaxed inside a run. By default it refuses and lists every failure; an explicit exclude mode drops the failures and their transitive dependents. Each issue's label is re-checked when that issue becomes ready.
_Avoid_: "pre-flight" for the gate (pre-flight is the whole launch phase; the gate is one check in it).

**Overlap edge**:
A scheduler edge pre-flight adds between two issues of one epic that are likely to touch the same files, so they land one after the other rather than race to a harvest conflict. Estimated from the issue text and the tree; when unsure, the edge is added. A generated file (`eslint-suppressions.json`) shared alone adds none. Its direction follows a topological order of the declared edges, so the graph stays acyclic. An overlap between two epics refuses the launch — the epics of one run are code-disjoint.
_Avoid_: "dependency" for it (a dependency is a declared `blocked_by`).

**Warm set**:
The four registry servers, 2 Paper + 2 Folia, that a batch's registry trim keeps for an **Unattended run**'s slices to lease, and that pre-flight requires warm.
_Avoid_: "the pool" for it (the pool is the whole registry; the warm set is Ship's subset of it).

**Batch worktree**:
The per-epic git worktree on the epic's `ship/<slug>` feature branch, with a real `node_modules` and `dist`. The **Commit queue** lands commits here, and the epic-end steps run here: `origin/master` merge, bump, push. The epic end's epic review reads the batch once the last slice has landed, before the merge and bump, and commits nothing. Lives until its PR merges or closes. The next `/ship` launch or a **Resync** tears it down then, once the run's tip is in that PR's head, and retires the run: its branch, slice branches and report dir (`retire-run`). An epic end that raised a PR never tears it down: while the PR is open, the worktree is how the next launch's pre-flight sees the run. An unattached run that landed nothing has no PR, so its epic end tears its batch down and retires the run itself. A **Resync** or an **Attached run** re-attaches it if it was torn down while the PR is open. Its folder is `.claude/worktrees/ship-<head>/` inside the main checkout, its run's report dir `reports/ship-<head>/` — `<head>` is the slug of an epic run, the lowest issue of an explicit list; the name "batch" is historical, from the earlier parallel batch flow.
_Avoid_: "main tree" (that is the maintainer's own checkout).

**Slice worktree**:
The throwaway worktree cut from the epic branch head, one per issue attempt on a `slice/<slug>/<N>-<K>` branch (an **Attached run** R's on `slice/<slug>/a<R>-<N>-<K>`), provisioned by script: `node_modules` junctioned to the **Batch worktree**, a real `dist`. Its folder sits beside the batch's in `.claude/worktrees/`, named after it: `ship-<head>-<N>-<K>`, with `a<R>-` before the id for an attached run. One issue is authored and reviewed in it; it is harvested through the **Commit queue**, then removed by a guarded teardown that never follows the junction.
_Avoid_: bare "worktree" wherever the two kinds could be confused.

**Commit queue**:
The per-epic serialization point that turns slices into commits — one `land` step and one commit per slice: it harvests one **Slice worktree**'s single commit at a time into the **Batch worktree**, guards that the staged set equals the slice's files, and commits under lefthook with a real `<type>(<scope>)` message and `fixes #N` or `see #N`, the tdd's choice. A harvest conflict requeues the slice on the new branch head — except one confined to `eslint-suppressions.json`, which the harvest regenerates. A landing that leaves the batch unverified halts the epic: no more starts or landings, no epic end, no PR.
_Avoid_: "harvest" for the whole thing (harvest is its cherry-pick step).

**Resync**:
Bringing an open run branch level with `origin/master` through the epic end's merge step and a lefthook-gated, never-forced push — never a rebase or GitHub's server-side update. It also tears down spent **Batch worktrees** and retires their runs.
_Avoid_: "update branch" (GitHub's server-side merge, which lefthook never gates).

**Attached run**:
An **Unattended run** of issues — never epics — launched with `--attach ship/<slug>`: it lands them on an open PR's existing run branch and pushes onto that PR instead of raising one. Pre-flight refuses the target when its PR is not open, a slice still links into its **Batch worktree**, or the branch holds commits of its own that `origin` lacks; `issue-readiness` and `issue-overlap` judge the PR head. It reuses the branch's **Batch worktree** or checks it out anew, starts from the attached tip, and takes a run number R that names its report folder `reports/attach-<R>/` and its **Slice worktrees**. Its epic end runs the epic review, merge, bump and retro — no PR writer — pushes onto the PR, posts its run report as a PR comment, then appends its own section to the PR's body, its profiled epic-review verdict first, leaving the rest of the body and the PR's draft state as they are; a PR closed meanwhile stops it (Ship ADR-0001 decision 16).
_Avoid_: "follow-up run", "fixup run", "onto run".

**Stage agent**:
A sub-agent of an **Unattended run** that runs one interactive skill as a person would, plus only what the run adds: the inputs its prompt hands it, the output it returns, an override for each of the skill's **Checkpoints**, and the run's shared boilerplate. It holds no method of its own and is named after its skill; a stage with no method (the runner) has no skill.
_Avoid_: "container" (the Minecraft window), "ship agent" (the `ship-` prefix is retired).

## Relationships

- **Ship** performs **Unattended runs**; each run is one **Saved workflow** invocation in the **Workflow runtime**, rendered from its **Workflow source**.
- A **Run set** has one entry per epic; each entry gets one **Batch worktree**, one **Commit queue** and one PR.
- Each issue attempt gets one **Slice worktree**, built by the tdd **Stage agent** and reviewed by the review stage agents, then landed through the **Commit queue**.
- A slice's server-tier runs take per-invocation **Leases** on the **Warm set**.
- An **Attached run** reuses an open PR's **Batch worktree**; a **Resync** re-levels its branch.

## Flagged ambiguities

- **"Workflow" — source, render, runtime** (resolved 2026-10-16, wayfinder #1488; Ship ADR-0001) — "the workflow" named the typed sources in `ship/src/workflow/`, the rendered JS in `.claude/workflows/` and Claude Code's tool alike, about 67 ambiguous uses across agents, skills and ADR-0045. Now the **Workflow source** renders into the **Saved workflow**, which the **Workflow tool** runs in the **Workflow runtime**; a GitHub Actions file is a "CI workflow".
