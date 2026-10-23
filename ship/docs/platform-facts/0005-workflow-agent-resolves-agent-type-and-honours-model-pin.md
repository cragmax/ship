---
status: current
platform: [claude-code 2.1.281]
last-verified: 2026-09-28
relied-on-by: [Ship ADR-0001, ship/src/workflow/stages.ts, .claude/agents]
---

# Ship PF-5: A workflow `agent()` resolves a project agent by `agentType` and composes it with `schema`, and honours a frontmatter `model` pin when no per-call `model` is passed

`agent(prompt, { agentType, schema })` runs the project agent file `.claude/agents/<agentType>.md`, with its `tools` plus the schema's `StructuredOutput` tool, and returns the schema object. With no per-call `model`, the agent file's frontmatter `model:` pin decides the model.

## Implication

A stage is a project agent file plus an output schema. An agent file that pins a model can silently override the tier table, so agent files carry none. Ship ADR-0001 decisions 1 and 15 rest on this, as do `ship/src/workflow/stages.ts`, which names an `agentType` per stage, and the pin-free `.claude/agents/` files.

## Scope

Not tested: whether a per-call `model` overrides a frontmatter pin. The Claude Code release was not recorded. Facts probed on 2026-09-23 and 2026-10-01 bracket it between 2.1.281 and 2.1.286, and the `platform` stamp is the lower bound.

## Established

The #1026 Q3 probe ([verdict comment](https://github.com/cragmax/paper-harness/issues/1025#issuecomment-5869948581)): `agent(…, { agentType: 'gate-run', schema })` reported the agent file's heading and first instruction line, tools `Bash, Read, StructuredOutput`, and returned the schema object. The file's `model: sonnet` showed as `"model":"claude-sonnet-5"` in the transcript.
