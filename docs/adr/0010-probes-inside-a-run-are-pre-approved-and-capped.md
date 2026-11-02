# Ship ADR-0010: Probes inside a run are pre-approved, lease-bound, and capped

No one approves a probe in the middle of an unattended run, so a run's probes are pre-approved and bounded instead. Each probe is capped at 15 min, and each stage at 3 probes. The agent enforces these caps.

## Decision

1. **Each probe record carries its measured `seconds`.**
2. **A long command goes to the background.** A command that can outlast a call's 10-minute cap is backgrounded. Chained foreground `timeout 570 … until` calls poll it, and the turn never ends while it runs (Ship PF-6).
3. **A probe that hits a cap, or is inconclusive, records nothing** and adds a pull request (PR) follow-up.
4. **A probe that reconfigures the rig blocks the issue.** Reconfiguring includes a plugin jar swap, a compose or `server.properties` change, and a Docker restart.

## Consequences

- The probe caps were confirmed on real runs, not tuned by a controlled measurement.
- Long commands need the background-and-poll idiom.
