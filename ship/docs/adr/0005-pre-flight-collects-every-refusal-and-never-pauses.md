# Ship ADR-0005: Pre-flight runs while the maintainer is present, collects every refusal, and never pauses

Pre-flight is the last point at which the maintainer is present, so it runs every check to the end and reports every refusal at once. No check stops the phase early, and a missing or partial verdict is a refusal, never a pass.

## Decision

1. **The steps, in order.**
   1. The checks: master is level, `gh` is logged in, and the **Warm set** is warm.
   2. The **Run gate**.
   3. `live-runs`.
   4. The `issue-readiness` agent, once over the run set.
   5. The `issue-overlap` agent, once over what is left and the changed files of the unspent live runs.
2. **Unless its run is spent, a leftover slice branch refuses the launch.**
3. **Spent runs are cleared after the pass.** Once pre-flight passes, the spent runs' batches are torn down and their runs retired. `--preflight-only` stops before this teardown.
