---
status: current
platform: [claude-code 2026-09-29]
last-verified: 2026-09-29
relied-on-by: [Ship ADR-0001, ship/src/workflow/drive.ts]
---

# Ship PF-7: Un-awaited workflow `agent()` calls run concurrently, and `Promise.race` over them resolves in completion order

In a workflow script, `agent()` promises left un-awaited run concurrently. `Promise.race` over them resolves with whichever finishes first. An `agent()` started while others are pending runs alongside them, and an async function chaining `agent()` calls races the same way. `parallel()` with worker thunks over a shared queue also completes, the workers splitting the jobs.

## Implication

A scheduler can keep a set of in-flight slices and start the next as soon as any settles, with no worker-pool fallback. The call order then follows real settle timing, which is why a resumed run with more than one flight replays out of order (Ship ADR-0001 decision 17). Ship ADR-0001 decision 7 and the race loop in `ship/src/workflow/drive.ts` rest on this.

## Scope

The Claude Code release was not recorded. The `platform` stamp is the probe date.

## Established

The #1036 P1 probe ([verdict comment](https://github.com/cragmax/paper-harness/issues/1036#issuecomment-5889677041)), inline run `wf_bd49f6ec-b19`, 7 agents at `effort: 'low'`. Event log:

```text
A:start, B1:start, A:done, race1-winner:A,
C:start, C:done, race2-winner:C,
B1:done, B2:start, B2:done
```
