---
status: current
platform: [claude-code 2.1.299]
last-verified: 2026-10-14
relied-on-by: [agents/tdd.md, skills/unattended-agent/SKILL.md, src/build/install.ts]
---

# Ship PF-15: An agent file's `skills:` preload injects each skill's full SKILL.md into a workflow `agent()`, its links resolving against the main checkout

A workflow `agent()` call with an `agentType` whose agent file lists `skills:` starts with each listed skill's full `SKILL.md` body in context, a `user-invocable: false` skill included, and the agent file's `tools` restriction still holds. The skill's supporting files are not preloaded. The preload carries a `Base directory for this skill: <main checkout>/.claude/skills/<name>` line, so the agent resolves the skill's relative links against the main checkout and Reads them on demand, from a worktree working directory too. A personal skill (`~/.claude/skills/<name>`) shadows a same-named project skill in the preload, name by name.

## Implication

A stage agent loads its skill by `skills:` preload, with no read by path and no Skill-tool step. The skill's relative links reach the main checkout's copies, as Ship ADR-0004 wants. A preloaded skill must not set `disable-model-invocation`, and no personal skill may share its name. `.claude/agents/tdd.md` preloads `tdd` and `unattended-agent` by `skills:`, and `unattended-agent` sets `user-invocable: false`.

## Scope

The probe ran in the workflow runtime on Linux, in a cloud container. Documented, not probed: a skill with `disable-model-invocation: true` is never preloaded, and a missing or disabled skill is skipped with only a debug-log warning.

## Established

Workflow `agent()` probes, 2026-10-14 (#1440 grilling). The probe agent file had `tools: Glob` (`Read, Glob` for the links probe) and `skills:` listing `probe-canary-a` and `probe-canary-b`. `probe-canary-a` held body token `CANARY-A-7Q3Z-PLAIN` and linked `extra.md`, which held `CANARY-A-EXTRA-K9W2`, and `../../rules/git.md`. `probe-canary-b` was `user-invocable: false`, with token `CANARY-B-4M8X-HIDDEN`. Each agent reported the tokens in its context and its tools. A control `agent()` with no `agentType` ran beside the first. The links probe ran one agent in the main checkout and one with `isolation: 'worktree'`, with `extra.md` untracked so absent from the worktree. Deciding output:

```text
preload agent:  canaries [CANARY-A-7Q3Z-PLAIN, CANARY-B-4M8X-HIDDEN]; tools [Glob, StructuredOutput]
control agent:  canaries []; tools [Artifact, Bash, Edit, Glob, Grep, …, Skill, …]
worktree agent: base_dir_line "Base directory for this skill: /home/user/paper-harness/.claude/skills/probe-canary-a"
                extra.md -> CANARY-A-EXTRA-K9W2 (main checkout); ../../rules/git.md read (main checkout)
personal skill ~/.claude/skills/probe-canary-a (CANARY-A-PERSONAL-5T1V) added:
                canaries [CANARY-A-PERSONAL-5T1V, CANARY-B-4M8X-HIDDEN]
```

A just-created agent file was not yet registered on the first `agent()` call (`agent type 'probe-preload' not found`). A re-run seconds later found it. Docs: [sub-agents](https://code.claude.com/docs/en/sub-agents) says "You can't preload skills that set `disable-model-invocation: true`". [skills](https://code.claude.com/docs/en/skills), in the `disable-model-invocation` row, says "Also prevents the skill from being preloaded into subagents".
