# Ship platform facts

The `ship/` home's series of platform facts: the Claude Code workflow runtime
unattended runs execute in, and the tools Ship drives. Facts here are cited
`Ship PF-N`, inside this home too. The admission bar, the record format and
the living-ness and staleness rules are the root's:
[docs/platform-facts/readme.md](../../../docs/platform-facts/readme.md).

## Categories

| Category                                            | Facts                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Toolchain & library behaviour](toolchain-libs.md)  | Ship PF-1             | `gh issue view --json blockedBy,subIssues` nodes carry no repository                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [Claude Code workflow runtime](workflow-runtime.md) | Ship PF-2 … Ship PF-7 | a workflow `agent()` starts in the session's cwd, which a `cd` moves, with its CLAUDE.md; it honours per-call `model` and `effort`; a saved workflow loads no code by any route; `agentType` resolves a project agent and composes with `schema`, a frontmatter `model` pin honoured when no per-call `model` is passed; one foreground command is capped at 10 min, a longer one backgrounded and polled; un-awaited `agent()` calls run concurrently and `Promise.race` resolves in completion order |
