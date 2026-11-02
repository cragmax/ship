# Ship ADR-0015: A PR carries one net version bump, and issue commits never bump

Issue commits never bump the version, because per-slice bumps on concurrent branches conflict on the version line. The epic end bumps once, so each pull request (PR) carries one net bump.

## Decision

1. **The kind.** If any of the branch's own non-merge commits since `origin/master` is a `feat`, the kind is `minor`. Otherwise it's `patch`.
2. **The target** is `origin/master`'s version, bumped by that kind. If a branch is already at the target, it gets no commit. Otherwise, one bump commit sets it.
3. **A resync merge** sets the version to `master`'s, bumped by the branch's own bump. It does so even when both sides bumped to the same number, so the net stays one.
