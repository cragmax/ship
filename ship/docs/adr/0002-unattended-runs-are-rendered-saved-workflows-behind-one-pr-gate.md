# Ship ADR-0002: Unattended runs are rendered Saved workflows that land reviewed slices behind one PR gate

Ship performs unattended runs. Workflow sources in the repo render into Saved workflows, which drive a deterministic scheduler over an epic's issues, build each issue from its triage brief in a Slice worktree, have Stage agents review and amend its one commit, and land it on the epic's branch, with one pull request (PR) per epic as the only human gate. This replaces a long-lived orchestrator session, which spent half its flow keeping its own context alive and hardcoded repo internals that no gate checked.

## Decision

1. **Orchestration lives in the repo, rendered.** The **Workflow sources** render (`npm run codegen`) into the **Saved workflows** `ship.js` and `resync.js` in `.claude/workflows/`. A Saved workflow loads no code by any route (Ship PF-4). So the render inlines the entry and the transitive closure of its relative value imports, and `gate:codegen` compares the committed file with a fresh render.
2. **Rendered code uses ECMAScript built-ins only.** It has no imports, and no `eval` or `new Function`. It also has no `Date.now()`, no `Math.random()`, and no `new Date()` without arguments. These last three rules come from the workflow-authoring reference, and no probe has checked them.
3. **Mechanical steps are commands.** Each is a command of the worktree command-line interface (CLI) or the run gate. A runner agent invokes each one from the main checkout with `node --import tsx`, and each one returns a schema-validated JSON envelope. The runner uses `node --import tsx` because an `npx tsx` tool is orphaned from the session's process tree (Ship PF-16).
4. **Judgment steps are Stage agents, one skill each.** Each one is resolved by `agentType` with an output schema (Ship PF-5), and its skill is preloaded (Ship PF-15).
5. **Rules and live docs state neutral invariants.** They never name a maintainer-personal skill.

## Alternatives considered

- **Import the gate and scheduler into the Saved workflow.** This is impossible (Ship PF-4).

## Consequences

- The scheduler exists twice, as source and as render, and only `gate:codegen` holds the two together.
