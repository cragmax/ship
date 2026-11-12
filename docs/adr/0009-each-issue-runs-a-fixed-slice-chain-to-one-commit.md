# Ship ADR-0009: Each issue runs a fixed slice chain that builds and reviews one commit

Each attempt runs in its own Slice worktree, cut from its epic's head, through a fixed chain of stages. The tdd stage builds from the issue, whose triage brief is the plan, and makes the slice's one commit. Each review applies its findings once and amends that commit, so a review has a fixed cost.

## Decision

1. **The stages, in order.**
   1. Label re-check.
   2. Cut.
   3. Provision.
   4. tdd.
   5. **Spec review**.
   6. **Test review**.
   7. **Standards review**.
   8. Land.
2. **Planning happened at triage.** The issue is sized at ticket time by the **Slice budget**. If the tree has overtaken an issue, or a probe falsifies the issue's named mechanism, the issue is blocked before any commit.
3. **The tdd stage chooses `fixes` or `see`.** It chooses `see` for an acceptance line that needs a human.
4. **Reviews amend once, with no re-review loop.** Each review verifies its findings against the code, applies them once, and amends the commit. After an amend a later review reads, the slice's changed files are re-read from git. A blocked review stops the slice.
5. **The standards review may amend a file the slice's own change made wrong,** even outside the slice's changed files. If the slice changed exports, a doc that lists them is such a file. Any other fix outside them blocks the slice. A clash with another slice over the extra file is caught at harvest and requeued (Ship ADR-0008).
6. **Some stages are skipped.** If the surface is trivial, one with no path under the code prefixes, test review is skipped. If `comment-only` proves the commit comment-only, it's also skipped.
7. **Each check a slice runs has one owner.** Each stage runs only the tests that its change makes relevant (`testing.md` § Which tests a change runs). The commit hooks own the gates. Pre-commit runs them on every slice commit and amend, and pre-push runs `gate` at the epic end, so no stage agent runs a `gate` or `gate:*` script. The tdd stage owns the run of the tests its change makes relevant. Test review owns mutation. The tdd stage runs only its inline proof's capped mutants.
8. **Server-tier runs take per-invocation leases** on the Warm set through `with-lease`, 600 s each.

## Alternatives considered

- **A Script API TSDoc review after the standards review.** It held a reached declaration to the consumer's TSDoc standard. Retired once that standard became a consumer rule, which the standards review already reads.
- **Bulk planning before the run, or a planner inside each slice.** Bulk plans went stale against later landings. The per-slice planner and the plan review were retired in favour of the triage brief.
