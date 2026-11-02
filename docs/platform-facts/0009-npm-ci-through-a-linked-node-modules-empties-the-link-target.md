---
status: current
platform: [npm 11.17.0, node 24.19.0, windows 10.0.26300]
last-verified: 2026-10-10
relied-on-by: [ship/src/cli/commands/provision-batch.ts, ship/src/cli/commands/sync-master.ts]
---

# Ship PF-9: `npm ci` in a tree whose `node_modules` is a link empties the link target

`npm ci` run where `node_modules` is a directory junction removes the target's whole contents, not just the link, and leaves `node_modules` a real directory.

## Implication

Never run `npm ci`, or any removal, in a worktree whose `node_modules` links to another checkout's: the other checkout's dependencies are destroyed. Refuse first. The pre-install guards in `ship/src/cli/commands/provision-batch.ts` and the other-worktree link check in `ship/src/cli/commands/sync-master.ts` do so.

## Scope

The probe ran on Windows 11 Pro 10.0.26300.

## Established

A local driver: a project depending on `file:./dep`, its lockfile generated, `node_modules` replaced by a junction to `nm-target/` holding `SENTINEL.txt` and `other/x.txt`, then `npm ci --ignore-scripts`. Deciding output:

```text
before: other,SENTINEL.txt,other\x.txt
added 1 package, and audited 3 packages in 594ms
after: (empty)
node_modules LinkType: (none)   SENTINEL.txt exists: False
```
