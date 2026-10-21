# Ship ADRs

The decisions of the `ship/` home (Repo ADR-0006). The criteria, workflow and
status legend are the Repo series': [docs/adr/readme.md](../../../docs/adr/readme.md).
Records here are always cited `Ship ADR-NNNN`, inside this home too; every
citation names its series (Repo ADR-0007).

## Index

1. [Ship ADR-0001 — Unattended runs: a rendered scheduler, a reviewed slice
   chain, the PR as the sole human gate](0001-unattended-runs.md) — Workflow
   sources rendered into Saved workflows under `gate:codegen`; Ship's
   five-folder layout with render-safety held by folder; instructions from
   the main checkout, run worktrees under `.claude/worktrees/`; pre-flight
   collecting every refusal (run gate, `issue-readiness`, `issue-overlap`);
   a deterministic scheduler (`MAX_SLICES` 4, optimistic requeue); the slice
   chain tdd → spec, test and standards review → Script API TSDoc → land, each
   review amending the one commit; probes 15 min and 3 per stage; one branch
   and commit queue per epic; the 2 + 2 warm set; the epic end (epic review,
   master sync, bump, retro ‖ `pr`, publish; the push is the server tier);
   the PR body; one net bump per PR; one tier table, no pins; attached runs;
   resume for one-flight runs only, manual recovery otherwise. Restates the
   root unattended-runs record, retired by Repo ADR-0007. Status: DRAFT.
   Formerly ADR-0045, the retired root record it restates.

## Cross-references

- **Ship #0001 ↔ Pool #0001:** a run's slices are the pool's per-invocation
  consumer, on a warm set Ship trims from the registry; the render closure
  inlines the pool's `lease-timings`, a named depcruise carve-out.
- **Ship #0001 ↔ Repo ADR-0006:** Ship is the top home; it imports tooling,
  server-pool and src, and nothing imports it.
- **Ship #0001 ↔ Tooling ADR-0002:** the epic end's push is its server tier, run only
  when the pushed range touches a Platform-wide path; the nightly is the
  backstop.
- **Ship #0001 ↔ Tooling ADR-0001:** the push's server tier is the runner's `pool`
  mode across the full registry, which can wait on the warm set while slices
  hold it.
