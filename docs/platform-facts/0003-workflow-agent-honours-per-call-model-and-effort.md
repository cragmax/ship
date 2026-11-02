---
status: current
platform: [claude-code 2.1.296]
last-verified: 2026-10-10
relied-on-by: [ship/src/workflow/runtime.types.ts]
---

# Ship PF-3: A workflow `agent()` honours per-call `model` and `effort`, including effort on a non-default model

A workflow `agent()` call honours its per-call `model` and `effort` options. An `effort` combined with a non-default `model` resolves to that model.

## Implication

Per-stage `model` and `effort` in workflow scripts take effect, with no fallback to the session model. `ship/src/workflow/runtime.types.ts` declares them per stage.

## Established

A live workflow run of `agent()` calls with `model` + `effort: 'low'`, each reporting its model id. Deciding output:

```text
model:haiku  effort:low -> claude-haiku-5-5
model:sonnet effort:low -> claude-sonnet-5-5
```
