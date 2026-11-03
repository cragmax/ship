# Ship ADR-0014: The PR body has fixed parts, and its overflow moves to PR comments

A run's pull request (PR) body carries everything the maintainer reviews the epic by, in a fixed set of parts. A body over GitHub's 65,536-character limit moves its movable sections to PR comments. If it still does not fit, it is refused before the push.

## Decision

1. **The parts.**
   - Summary and Merge Danger, from the `pr` agent over the net diff.
   - Evidence, from each landed slice's tdd tracer record.
   - The issue lines (`fixes` and `see`), each with its `Test review:` line.
   - A `## Recorded` section of each issue's recorded values.
   - The lease timings.
   - Whether the full tiers ran at push.
   - The run report, folded.
2. **A missing `pr` agent result never blocks the PR.** The run still publishes it, with that agent's sections marked unavailable.
3. **Overflow moves in a fixed order.** The report's movable sections (`MOVABLE_SECTIONS` in `src/workflow/pr/pr-body.ts`) move to PR comments in that order, and each one leaves a pointer line. If the body is still over the limit, `publish` refuses it before the push.
