# Ship ADR-0006: The run gate is rubric point 2 inside a run

The **Run gate** holds every issue of a run to rubric point 2: open, `ready-for-agent`, and unblocked by anything outside the run. A failure refuses the launch, and the refusal lists every failing issue.

## Decision

1. **The run set** is an epic's open children, or an explicit list, and several epics are allowed. The container is never gated.
2. **Each issue must be open and `ready-for-agent`,** with every `blocked_by` closed or inside the run set.
3. **An attached run** (Ship ADR-0017) also accepts a `blocked_by` that has landed on the target branch: if a first-parent, non-merge commit in `origin/master..origin/ship/<slug>` cites it `fixes #N` in its body, it counts as satisfied. A `see #N` citation never counts, since the issue did not fully land.
4. **Edges inside the set become scheduler edges,** and a cycle refuses the launch.
5. **Exclude mode drops instead of refusing.** The gate drops the failures, a stale or not-ready verdict among them, with their transitive dependents.
6. **The label is re-checked when each issue becomes ready.** If the label was removed, the run skips the issue and its dependents.

## Consequences

- Steering in the middle of a run is limited to removing a label.
