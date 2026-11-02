# Ship ADR-0017: An attached run lands issues on an open PR's existing branch

`/ship issues N… --attach ship/<slug>` lands issues on an open pull request's (PR's) existing branch, and pushes onto that PR. `epics` with `--attach` is refused, and the run has one entry.

## Decision

1. **Pre-flight refuses the target** on `no-open-pr`, `slices-live`, or `unpublished-commits` (first-parent non-merge commits that `origin` lacks). `issue-readiness` and `issue-overlap` judge the PR head, and the overlap check skips only the target.
2. **Setup reuses the branch's Batch worktree,** or checks it out anew. The entry's base is the attached tip.
3. **The run number.** The run takes the lowest number R that no earlier `attach-<R>/` report folder or `a<R>-` slice branch holds.
4. **The epic end runs these steps.** If the PR closed in the meantime, the epic stops.
   1. Epic review over this run's slices.
   2. Master sync.
   3. Bump.
   4. Retro, with no `pr` agent.
   5. A push onto the open PR.
5. **After a successful push, the run reports on the PR.** It posts its report, folded, as one PR comment. It also appends one `## Attached run <R>` section to the PR's body, with Evidence, Issues, Recorded, and a link to the comment. Everything already in the body is kept byte for byte, and the closing-keyword neutraliser runs over the new text.
6. **Limits and failures.** A body or comment over the limit is refused before `gh` runs. A refused or failed push posts and edits nothing. A failed post or edit never fails the run.
