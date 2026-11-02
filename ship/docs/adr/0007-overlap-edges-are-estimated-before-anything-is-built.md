# Ship ADR-0007: Overlap edges are estimated before anything is built, and only a likely overlap orders slices

From the issue text and the tree, the `issue-overlap` agent estimates which issues will touch the same files, and marks each pair `likely` or `unsure`. Within an epic, only a `likely` pair adds an edge, because a missed overlap self-heals through the requeue (Ship ADR-0008).

## Decision

1. **An `unsure` pair orders no slices.** The run report's overlap record lists it with its shared paths and reason, so a retro can check it against harvest conflicts.
2. **Each pair is directed along a topological order of the declared edges,** with ties broken by run-set order, so the union stays acyclic.
3. **A pair whose shared paths are all generated files adds no edge.**
4. **Epics and concurrent runs stay code-disjoint.** An overlap between two epics refuses the launch, `unsure` included, and so does an overlap with a live run.

## Alternatives considered

- **Pessimistic overlap serialisation.** Rejected. The estimate precedes any build, so this approach would serialise most of an epic. And the requeue makes a miss self-heal.

## Consequences

- A missed overlap estimate wastes one slice's build (the requeue).
