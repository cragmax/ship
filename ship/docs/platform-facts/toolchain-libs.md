# Toolchain & library behaviour

Part of [Platform facts](readme.md) — see the readme for the admission bar and
the living / divergence rules. This category covers the **tools** Ship drives (`gh`); facts here are stamped against the version in their **Platform** line, and a release can move them.

## Ship PF-1 · `gh issue view --json blockedBy,subIssues` nodes carry no repository field

Formerly PF-92.

- **Claim.** The nodes of `gh issue view --json blockedBy` and `subIssues` carry only `id`, `number`, `state`, `title`, `url`; no repository field. A cross-repo link could not be created read-only; gh requests one fixed field set per node, so a cross-repo node would have the same shape, the repo inferable only from `url`.
- **Implication.** The run gate reads a node's `number` as a same-repo issue (#1031); a cross-repo blocker would be misread unless `url` is parsed.
- **Platform.** `gh version 2.102.0` (the comment cites 2.101.0).
- **Established.** Read-only `gh issue view 1328 --json blockedBy` and `gh issue view 1325 --json subIssues` against this repo (a same-repo link only):

  ```text
  {"blockedBy":{"nodes":[{"id":"I_kwDO...","number":1327,"state":"OPEN","title":"...","url":"https://github.com/cragmax/paper-harness/issues/1327"}],"totalCount":1}}
  ```

- **Last verified.** 2026-10-10.
- **Relied on by.** `ship/src/cli/run-gate-gh.ts` (same-repo assumption).
