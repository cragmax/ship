---
status: current
platform: [node 24.19.0, execa 9.6.1, npm 11.17.0, git 2.56.0.windows.1, windows 10.0.26300]
last-verified: 2026-10-10
relied-on-by: [ship/src/cli/git/exec.ts, ship/src/cli/git/hooked.ts]
---

# Ship PF-10: On win32, an `execaSync` timeout kills only the direct child, and the npm chain, MSYS fork children, and git launcher and hook survive

On win32 an `execaSync` `timeout` kill reaches only the direct child. (1) `npm run`: the script's `cmd.exe` and `node.exe` outlive it. (2) An MSYS-forked child (`bash -c 'sleep N &'`) has a Windows parent PID outside the tree, so `taskkill /T /F` on bash leaves it running. An `exec`'d program stays in the tree and dies. (3) Killing Git's `cmd\git.exe` launcher leaves the real `git.exe` and the hook's `sleep.exe` running. Killing the real `git.exe` directly (Git Bash's PATH) kills it, but the hook's `sleep.exe` survives.

## Implication

A budget timeout on a spawned tool chain does not reap descendants: report survivors rather than assuming the kill cleaned up. The TSDoc of `runCaptured` in `ship/src/cli/git/exec.ts` says survivors are reported, not reaped (`outputOf`, `orphanWarning`).

## Scope

The node → node chain exception, #1048, was not re-probed. The probe ran on Windows 11 Pro 10.0.26300.

## Established

Local drivers, each with a unique marker in the child's command line and a CIM query for survivors after the timeout (3000 ms):

1. `execaSync('npm',['run','hang'],{timeout:3000})`.
2. `spawn(bash -c ...)` then `taskkill /T /F /PID`.
3. `execaSync(<git.exe>,['-C','gk','commit'],{timeout:3000})` with a `pre-commit` hook `sleep 40.0001`.

Deciding output:

```text
A  timedOut true; survivors: cmd.exe#39332, node.exe#37796
B  "sleep 40.0002 & wait": before bash#38932, sleep#10200 parent=47996; taskkill /T /F bash -> after: sleep#10200 still running
B  "exec sleep 40.0002": taskkill /T kills sleep#51376 (parent=bash) -> after: none
C  cmd\git.exe launcher: git.exe#50344 and sleep.exe#50572 survive
C  ucrt64\bin\git.exe direct: git dies, sleep.exe#51300 survives
```
