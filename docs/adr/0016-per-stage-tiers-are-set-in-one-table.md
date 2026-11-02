# Ship ADR-0016: Per-stage model tiers are set in one table, and agent files carry no model pin

The tier table holds every stage's `agentType`, `model`, and `effort`, and each `agent()` call passes them (Ship PF-3). Agent files carry no model pin. If a call passes no `model` of its own, a frontmatter pin is honoured (Ship PF-5), so a pin could silently override the table.

## Alternatives considered

- **Model pins in agent files.** Rejected, because 46 runs once ran a judgment agent on a model other than the session's, and a pin can override the table.
