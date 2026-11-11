# Ship

The terms of the `ship/` subproject (Framework ADR-0045). The repo-wide terms and the product's live in the root [docs/GLOSSARY.md](../../docs/GLOSSARY.md), among them the reviews a slice runs (**Spec review**, **Test review**, and **Standards review**), **Checkpoint**, and **Slice budget**, which sessions use with no run involved. The pool's terms, **Lease** among them, live in [server-pool/docs/GLOSSARY.md](../../server-pool/docs/GLOSSARY.md).

## Language

### The application

**Ship**:
The application that performs **Unattended runs**: the `ship/` subproject, its **Saved workflows**, and its **Stage agents**.
_Avoid_: "the ship machine"; "the workflow" (for the whole application).

**Workflow source**:
The typed TypeScript under `src/workflow/` that renders into a **Saved workflow**: the entry plus every file its relative value imports reach.
_Avoid_: bare "the workflow" (ambiguous with the **Saved workflow** and the **Workflow runtime**).

**Saved workflow**:
A rendered, import-free JS script in `.claude/workflows/` that the **Workflow tool** runs by name: `ship.js` and `resync.js`. Rendered from its **Workflow source** into `workflows/`, then installed there, never edited by hand.
_Avoid_: "workflow script" (Claude Code's term for any script); bare "the workflow".

**Workflow tool**:
Claude Code's tool that runs a workflow script. The **Workflow runtime** executes the script and its `agent()` calls. Capitalised, because both are the platform's, not Ship's.
_Avoid_: "workflow engine"; "CI workflow" (a GitHub Actions file, unrelated).

### Runs

**Unattended run**:
A run that ships a **Run set** from launch to pull request: pre-flight while the maintainer is present, then one commit per landed issue on the run's branch, then the PR, its only human gate (Ship ADR-0002).
_Avoid_: "batch" for the run (collides with the `batch:N` labels and RCON batching).

**Run set**:
The issues one **Unattended run** ships: an epic's open children (never the epic itself, and several epics may combine) or an explicit issue list. One entry per epic, each with its own **Batch worktree**, **Commit queue**, and PR.
_Avoid_: "epic" for the set (a set may span several epics, or none).

**Run gate**:
The launch check that every **Run set** issue is open and `ready-for-agent`, each `blocked_by` closed, inside the set in the same epic, or landed on an **Attached run**'s target branch. A failure refuses the launch (Ship ADR-0006).
_Avoid_: "pre-flight" for it (pre-flight is the whole launch phase, and the gate is one check in it).

**Overlap edge**:
A scheduler edge pre-flight adds between two issues of one epic likely to touch the same files, so they land in sequence. An `unsure` pair is reported, not ordered, and an overlap across epics refuses the launch (Ship ADR-0007).
_Avoid_: "dependency" for it (a dependency is a declared `blocked_by`).

**Warm set**:
The four registry servers, two Paper and two Folia, that a batch's registry trim keeps for an **Unattended run**'s slices to **lease**, and that pre-flight requires warm.
_Avoid_: "the pool" for it (the pool is the whole registry, and the warm set is Ship's subset).

**Batch worktree**:
The per-epic worktree on the run's `ship/<slug>` branch at `.claude/worktrees/ship-<head>/`, where the **Commit queue** lands and the epic end merges and pushes. It lives while its PR is open (Ship ADR-0011).
_Avoid_: "main tree" (the maintainer's own checkout); "batch" as a live concept (a historical name).

**Slice worktree**:
The throwaway worktree one issue attempt is authored and reviewed in, cut from the epic branch head on a `slice/<slug>/<N>-<K>` branch, its `node_modules` junctioned to the **Batch worktree**. It is harvested through the **Commit queue**, then torn down.
_Avoid_: bare "worktree" wherever the two kinds could be confused.

**Commit queue**:
The per-epic serialisation point that lands one **Slice worktree**'s commit at a time into the **Batch worktree** under lefthook, the staged set guarded to the slice's files. A conflict requeues the slice (Ship ADR-0011, Ship ADR-0008).
_Avoid_: "harvest" for the whole thing (harvest is its cherry-pick step).

**Resync**:
Bringing an open run branch level with `origin/master` through the epic end's merge step and a lefthook-gated, never-forced push. It also retires spent **Batch worktrees** (Ship ADR-0013 decision 5).
_Avoid_: "update branch" (GitHub's server-side merge, which lefthook never gates); rebase.

**Attached run**:
An **Unattended run** of issues, never epics, launched with `--attach ship/<slug>`. It lands them on an open PR's run branch, reusing its **Batch worktree**, and pushes onto that PR instead of raising one (Ship ADR-0017).
_Avoid_: "follow-up run"; "fixup run"; "onto run".

**Stage agent**:
A sub-agent of an **Unattended run** that runs one interactive skill as a person would, plus only what the run adds: inputs, output, and an override per **Checkpoint**. Named after its skill, and the runner stage has none.
_Avoid_: "container" (the Minecraft window); "ship agent" (the `ship-` prefix is retired).

## Flagged ambiguities

- **"Workflow": source, render, or runtime** (resolved 2026-10-16, Ship ADR-0002). "The workflow" named the sources, the rendered JS, and Claude Code's tool. Now the **Workflow source** renders into the **Saved workflow**, which the **Workflow tool** runs in the **Workflow runtime**.
