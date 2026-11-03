---
status: current
platform: [node 24.19.0, typescript 5.9.3, typescript-language-server 6.0.2, claude-code 2.1.300, windows 10.0.26300]
last-verified: 2026-10-15
relied-on-by: [src/cli/commands/tsserver-restart.ts, src/cli/commands/teardown.ts]
---

# Ship PF-17: On Windows, a session's semantic tsserver burns about one core once a directory it watched is deleted, and killing it makes Claude Code respawn its language server clean

Four observations make one chain:

1. Node 24 on Windows: once a directory under `fs.watch` (recursive or flat) is deleted, the watcher fires about 120k `rename` events per second carrying the directory's own `\?\` path, never an `error`, until `close()`.
2. TypeScript 5.9 on Windows replaces such a watcher (`fsWatchHandlingExistenceOnHost`) only on an `error` event, so it keeps it and re-runs its invalidation on every event.
3. Claude Code's LSP client never sends `textDocument/didClose`, and tsserver drops an orphaned project only after a `didClose` and a later open. So the project of a deleted worktree whose files the session opened stays, and its semantic tsserver holds about 1.0 to 1.4 cores until the session ends.
4. Killing that semantic tsserver (`tsserver.js` without `--serverMode partialSemantic`) takes typescript-language-server down with it, and Claude Code respawns the server (`restartOnCrash` defaults to `true`). File watching comes back, the dead projects are gone, and CPU falls to about 0.01 cores. The respawn held for 20 consecutive kills in one session.

## Implication

Deleting a worktree whose files a session's LSP opened starts the burn. Nothing in the worktree or `tsconfig.json` prevents it: `TSC_WATCHDIRECTORY` and `watchOptions` were probed, and neither helps. The recovery is to kill the session's semantic tsserver after the deletion. `useClientFileWatcher: true` also stops the burn but blinds tsserver to on-disk changes, because Claude Code never registers `workspace/didChangeWatchedFiles`. `restartSessionTsserver` in `src/cli/commands/tsserver-restart.ts` does the kill, run by `teardown` after it removes a worktree.

## Scope

Claude Code ran with the `typescript-lsp` plugin, on Windows 11 Pro 10.0.26300.

## Established

#1396, 2026-10-15. A Node driver (`fs.watch` on a directory, then `rmSync` of it, CPU over 5 s) gave `events=597096 in 5s, cores=0.997` recursive and `642383 in 5s, cores=1.000` flat, with no `error` event. An LSP driver spawned typescript-language-server as the plugin does, opened files in fresh `git worktree add` roots, then deleted them, sampling the semantic tsserver:

```text
3 roots, open and idle:              0.110 / 0.015 cores
3 roots, after deletion:             1.397 / 1.324 cores
after deletion + didClose alone:     1.242 / 1.202 cores
after deletion + didClose + didOpen: 1.327 -> 0.011 cores (remove Project:: x3 in the TSS log)
```

Nested Claude Code 2.1.300 sessions (`claude -p`) edited a file in a throwaway worktree, deleted it, and sampled their own semantic tsserver over 15 s. With the official plugin it held 1.045 cores. After killing the tsserver it went 1.042 -> 0.008 cores, with fresh hovers and diagnostics after the respawn. In one session, 6 kills, then 20, all respawned.
