---
status: current
platform: [gh 2.102.0]
last-verified: 2026-10-10
relied-on-by: [src/cli/run-gate-gh.ts]
---

# Ship PF-1: `gh issue view --json blockedBy,subIssues` nodes carry no repository field

The nodes of `gh issue view --json blockedBy` and `subIssues` carry only `id`, `number`, `state`, `title`, and `url`, with no repository field.

## Implication

The run gate (`src/cli/run-gate-gh.ts`) reads a node's `number` as a same-repo issue (#1031). A cross-repo blocker would be misread unless `url` is parsed.

## Scope

A cross-repo link could not be created read-only. gh requests one fixed field set per node, so a cross-repo node would have the same shape, the repo inferable only from `url`.

## Established

Read-only `gh issue view 1328 --json blockedBy` and `gh issue view 1325 --json subIssues` against this repo, which holds a same-repo link only:

```text
{"blockedBy":{"nodes":[{"id":"I_kwDO...","number":1327,"state":"OPEN","title":"...","url":"https://github.com/cragmax/paper-harness/issues/1327"}],"totalCount":1}}
```
