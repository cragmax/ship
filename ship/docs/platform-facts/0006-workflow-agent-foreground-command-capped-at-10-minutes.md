---
status: current
platform: [claude-code 2026-09-28]
last-verified: 2026-09-28
relied-on-by: [Ship ADR-0001, .claude/skills/unattended-agent/SKILL.md]
---

# Ship PF-6: A workflow agent's single foreground command is capped at 10 minutes, and a longer one runs only in the background, polled by chained foreground calls

Inside a workflow `agent()`, a foreground Bash command runs to just under the tool's 600,000 ms timeout: a 510 s command returned normally. A longer command cannot run in one foreground call. Run with `run_in_background: true`, it completes while the agent keeps its turn open with chained foreground `timeout 570 bash -c "until grep -q <done> <outfile>; do sleep 5; done"` polls. A background task is terminated when the agent gives its final response, so the agent cannot end its turn and wait for a notification. `Monitor` returns at once, its notifications arriving only between tool calls.

## Implication

A stage whose command can outlast 10 minutes backgrounds it and polls in the foreground, never ending its turn while it runs (the background-and-poll idiom). Ship ADR-0001 decision 9 and the 10-minute rule in `.claude/skills/unattended-agent/SKILL.md` rest on this.

## Scope

The Claude Code release was not recorded. The `platform` stamp is the probe date.

## Established

The #1026 Q6 probe ([verdict comment](https://github.com/cragmax/paper-harness/issues/1025#issuecomment-5869948581)): `done-fg elapsed_ms=510018` in the foreground. A 660 s command was backgrounded, the first poll exiting 124 after 570 s and the second finding `done-bg elapsed_ms=660013`.
