# Ship ADR-0018: Resume only a one-flight run, and recover every other run by hand

The Workflow runtime's resume replays cached results for the longest unchanged prefix of `agent()` calls, keyed by position. With more than one flight, the call order follows real settle timing, so a replay breaks the prefix at the first overlap and re-runs landed issues.

## Decision

1. **Resume is supported only for a one-entry run launched with `--max-slices 1`** whose script is unchanged, or changed only in code after the last finished call.
2. **Manual recovery has two steps.**
   1. Stop the run.
   2. Write and run a continuation script. This script is the run's script with its entry point replaced by a direct `epicEnd` call. That call's `EpicEndInput` is copied from the run's journal as literals, since a script reads no files.
3. **A stopped attached run leaves its fixes unpublished.** A later attached run's pre-flight and `/resync` refuse (`unpublished-commits`) until a continuation epic end pushes the fixes with `publish --push-only` and appends its section.
4. **Stopping a run doesn't end its in-flight tool's process tree,** and doesn't release that tool's lease.

## Alternatives considered

- **An epic-end-only `/ship` mode fed from run state under `reports/`.** Deferred until parallel or multi-epic runs are routine. Manual recovery covers those runs.
- **Deterministic replay for parallel runs.** Rejected, because lockstep rounds would undo completion-order scheduling.

## Consequences

- A run of more than one flight can't be resumed once it's cut. It can only be recovered by hand.
