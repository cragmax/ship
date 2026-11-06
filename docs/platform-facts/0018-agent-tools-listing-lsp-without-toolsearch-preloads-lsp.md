---
status: current
platform: [claude-code 2.1.296, windows 11]
last-verified: 2026-10-10
relied-on-by: [agents/tdd.md, agents/spec-review.md, agents/standards-review.md, agents/test-review.md, agents/epic-review.md, agents/issue-readiness.md, agents/issue-overlap.md]
---

# Ship PF-18: An agent file whose `tools:` lists `LSP` without `ToolSearch` gets the LSP tool preloaded

An agent whose frontmatter `tools:` names `LSP` and not `ToolSearch` starts with the `LSP` tool directly callable. With `ToolSearch` also listed, `LSP` stays deferred until one ToolSearch call loads it. With neither, the agent has no `LSP`: a workflow `agent()` with `agentType: 'tdd'` then had exactly its listed tools.

## Implication

A code-reading agent file lists `LSP` alone, never `LSP, ToolSearch`. The `tools:` line of each code-reading agent in `.claude/agents/` does so: `tdd.md`, the review agents, `issue-readiness.md`, and `issue-overlap.md`.

## Scope

The `typescript-lsp` plugin was installed at user scope. The probe ran through a nested `claude -p`, not an interactive workflow run.

## Established

Nested `claude -p` sessions with probe agent files, 2026-10-10. With `tools: Read, Grep, LSP, ToolSearch`, LSP was deferred, one ToolSearch loaded it, and goToDefinition answered. With `tools: Read, Grep, LSP`, LSP was preloaded and answered. A just-started server answered goToDefinition with the import line, not the definition.
