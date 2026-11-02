# Ship ADR-0008: A deterministic scheduler starts each issue once its dependencies land, and requeues a slice on a harvest conflict

The scheduler is rendered JavaScript, with no large language model (LLM) and no context budget. Each issue starts as soon as its dependencies have landed, under one `MAX_SLICES` cap (4) across all the run's epics, with no rung barriers.

## Decision

1. **Completion-order scheduling.** The drive loop races un-awaited flights with `Promise.race`, in completion order (Ship PF-7). A slice holds its slot until it settles, the wait in the commit queue included. Epic ends run outside the cap.
2. **The requeue.** On a harvest conflict, the slice is discarded and re-cut from the current epic head. The re-cut attempt is handed its previous attempt's patch, the slice's one commit after every review amend. Its tdd agent applies that patch three-way and resolves the conflict instead of rebuilding from the issue, and the reviews run in full on the result. If the conflict is confined to `eslint-suppressions.json`, that file is regenerated instead.
3. **A dead agent is retried once from a fresh worktree, and then its issue is blocked.** An agent that dies after the tdd's commit hands its retry that commit, after every review amend that landed, as a patch the retry resumes as a requeued attempt does. A death before that commit retries from the issue, since the half-built work may be what killed it. The dead stage's uncommitted edits are never handed on. They are kept only for the maintainer.
4. **An issue that settles without landing** (blocked, retry-exhausted, or its label removed) skips only its declared dependents, transitively along declared edges. It releases its overlap edges, and those of each dependent it skips: an issue that lands nothing touches nothing, so each overlap edge's dependent starts as if the edge's blocker had landed. The run report's schedule names each released edge and how its blocker settled.
5. **A landing that leaves the batch unverified halts that epic.** The epic gets no further starts or landings, no epic end, and no pull request (PR). Its in-flight slices are torn down, and its unlanded issues are cited `see #N`. The run's other epics carry on.

## Alternatives considered

- **Rung-barrier scheduling.** Rejected, because it once idled four finished slices for 34 min.

## Consequences

- `MAX_SLICES` was confirmed on real runs, not tuned by a controlled measurement.
