# Ship

The terms of the `ship/` subproject (Framework ADR-0045). The repo-wide terms live in the root [docs/GLOSSARY.md](../../docs/GLOSSARY.md), among them the reviews a slice runs (**Spec review**, **Test review**, **Standards review**), **Checkpoint** and **Slice budget**, which sessions use with no run involved; the product's in [docs/GLOSSARY.md](../../docs/GLOSSARY.md); the pool's, **Lease** among them, in [server-pool/docs/GLOSSARY.md](../../server-pool/docs/GLOSSARY.md).

## Language

### The application

**Ship**:
The application that performs **Unattended runs**: the `ship/` subproject, its **Saved workflows** and its **Stage agents**.
_Avoid_: "the ship machine"; "the workflow" (for the whole application).

**Workflow source**:
The typed TypeScript under `ship/src/workflow/` that renders into a **Saved workflow**: the entry plus every file its relative value imports reach.
_Avoid_: bare "the workflow" (ambiguous with the **Saved workflow** and the **Workflow runtime**).

**Saved workflow**:
A rendered, import-free JS script in `.claude/workflows/` that the **Workflow tool** runs by name: `ship.js` and `resync.js`. Generated from its **Workflow source**, never edited by hand.
_Avoid_: "workflow script" (Claude Code's term for any script); bare "the workflow".

**Workflow tool**:
Claude Code's tool that runs a workflow script; the **Workflow runtime** executes the script and its `agent()` calls. Capitalised: both are the platform's, not Ship's.
_Avoid_: "workflow engine"; "CI workflow" (a GitHub Actions file, unrelated).

### Runs

**Unattended run**:
A run that ships a **Run set** from launch to pull request unattended: pre-flight fails fast while the maintainer is present, then one commit per landed issue on the run's branch, then the PR, its only human gate (Ship ADR-0001).
_Avoid_: "batch" for the run (collides with the `batch:N` labels and RCON batching).

**Run set**:
The issues one **Unattended run** ships: an epic's open children (never the epic itself; several epics may combine) or an explicit issue list; one entry per epic, each with its own **Batch worktree**, **Commit queue** and PR.
_Avoid_: "epic" for the set (a set may span several epics, or none).

**Run gate**:
The launch check that every **Run set** issue is open and `ready-for-agent` with each `blocked_by` closed or inside the set, in the same epic. It refuses and lists every failure, or in exclude mode drops the failures and their dependents.
_Avoid_: "pre-flight" for it (pre-flight is the whole launch phase; the gate is one check in it).

**Overlap edge**:
A scheduler edge pre-flight adds between two issues of one epic likely to touch the same files, so they land in sequence; added when unsure, directed along the declared edges. An overlap across epics refuses the launch (Ship ADR-0001).
_Avoid_: "dependency" for it (a dependency is a declared `blocked_by`).

**Warm set**:
The four registry servers, two Paper and two Folia, that a batch's registry trim keeps for an **Unattended run**'s slices to **lease**, and that pre-flight requires warm.
_Avoid_: "the pool" for it (the pool is the whole registry; the warm set is Ship's subset).

**Batch worktree**:
The per-epic worktree on the run's `ship/<slug>` branch at `.claude/worktrees/ship-<head>/`, where the **Commit queue** lands and the epic end merges, bumps and pushes. It lives while its PR is open; the next launch or a **Resync** retires it (Ship ADR-0001).
_Avoid_: "main tree" (the maintainer's own checkout); "batch" as a live concept (a historical name).

**Slice worktree**:
The throwaway worktree one issue attempt is authored and reviewed in, cut from the epic branch head on a `slice/<slug>/<N>-<K>` branch, its `node_modules` junctioned to the **Batch worktree**; harvested through the **Commit queue**, then torn down.
_Avoid_: bare "worktree" wherever the two kinds could be confused.

**Commit queue**:
The per-epic serialisation point that lands one **Slice worktree**'s commit at a time into the **Batch worktree** under lefthook, the staged set guarded to the slice's files; a conflict requeues the slice, an unverified landing halts the epic (Ship ADR-0001).
_Avoid_: "harvest" for the whole thing (harvest is its cherry-pick step).

**Resync**:
Bringing an open run branch level with `origin/master` through the epic end's merge step and a lefthook-gated, never-forced push; it also retires spent **Batch worktrees** (Ship ADR-0001).
_Avoid_: "update branch" (GitHub's server-side merge, which lefthook never gates); rebase.

**Attached run**:
An **Unattended run** of issues, never epics, launched with `--attach ship/<slug>`: it lands them on an open PR's run branch, reusing its **Batch worktree**, and pushes onto that PR instead of raising one (Ship ADR-0001 decision 16).
_Avoid_: "follow-up run", "fixup run", "onto run".

**Stage agent**:
A sub-agent of an **Unattended run** that runs one interactive skill as a person would, plus only what the run adds: inputs, output, an override per **Checkpoint**, shared boilerplate. Named after its skill; the runner stage has none.
_Avoid_: "container" (the Minecraft window); "ship agent" (the `ship-` prefix is retired).

## Flagged ambiguities

- **"Workflow" — source, render, runtime** (resolved 2026-10-16, Ship ADR-0001) — "the workflow" named the typed sources, the rendered JS and Claude Code's tool alike. Now the **Workflow source** renders into the **Saved workflow**, which the **Workflow tool** runs in the **Workflow runtime**.
