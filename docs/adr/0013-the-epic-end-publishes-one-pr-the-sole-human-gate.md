# Ship ADR-0013: The epic end reviews, syncs, and publishes one PR, the sole human gate

Once an epic's last slice settles, the epic end runs a fixed sequence that ends in one pull request (PR). The PR is the sole human gate, because the Workflow tool takes no input in the middle of a run.

## Decision

1. **The steps, in order.**
   1. The epic review over the batch.
   2. The master sync, under the run's repo lock. If `origin/master` moved, the sync merges it, and never rebases. Any conflict stops the epic, except a conflict in the lockfile or the version line.
   3. The retro and the `pr` agent, concurrently.
   4. The publish task, under the repo lock: a look at the main checkout, a forward-only check of `master` since launch, the push, and the PR.
   5. A comment on each issue that the run blocked, giving the reason and the PR or branch.
2. **A rejected or empty epic-review verdict opens the PR as a draft.**
3. **The push is the server tier.** The epic end runs no server-tier step of its own. Its push goes through the pre-push hook. If the pushed range touches a Platform-wide path, that hook runs the server tier on both engines (Tooling ADR-0002). So a red tier refuses the push, and no PR opens. `npm run test:nightly` is the backstop.
4. **The retro runs for every entry that was cut,** whether it shipped, halted, stopped, or landed nothing. Its findings go in the PR body. An epic end that stops after the retro re-runs it over the final report, and keeps only the re-run's findings.
5. **Resync shares the master sync.** The `resync` Saved workflow brings an open run branch level with `origin/master`. After a check that the PR is open, it pushes unforced through the pre-push hook. It never uses GitHub's server-side update.
6. **The one repo lock serialises** the steps of every epic end that fetch or push.
7. **A failed issue comment is recorded,** and never fails the run. The run changes no label.

## Alternatives considered

- **Mid-run gates or per-commit consent.** Rejected. The Workflow tool takes no input in the middle of a run, and either one defeats an away-from-keyboard (AFK) run.

## Consequences

- A rejected PR rejects a whole epic's work at once.
