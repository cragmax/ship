# Node runtime & OS

This category covers the **Node runtime and the OS** as Ship's worktree provisioning and tool launching rely on them: npm through links, child-process lifetimes and junction walks, Windows-specific throughout. Facts here are stamped against the Node release in their **Platform** line.

## Ship PF-9 · npm ci in a tree whose node_modules is a link empties the link target

- **Claim.** `npm ci` run where `node_modules` is a directory junction removes the target's whole contents (not just the link) and leaves `node_modules` a real directory.
- **Implication.** Never run `npm ci` (or any removal) in a worktree whose `node_modules` links to another checkout's: the other checkout's dependencies are destroyed. Refuse first.
- **Platform.** npm 11.17.0, Node v24.19.0, Windows 11 Pro 10.0.26300.
- **Established.** Local driver: a project depending on `file:./dep`, lockfile generated, `node_modules` replaced by a junction to `nm-target/` holding `SENTINEL.txt` and `other/x.txt`, then `npm ci --ignore-scripts`. Deciding output:

  ```text
  before: other,SENTINEL.txt,other\x.txt
  added 1 package, and audited 3 packages in 594ms
  after: (empty)
  node_modules LinkType: (none)   SENTINEL.txt exists: False
  ```

- **Last verified.** 2026-10-10.
- **Relied on by.** `ship/src/cli/commands/provision-batch.ts` (pre-install guards), `ship/src/cli/commands/sync-master.ts` (the other-worktree link check).

## Ship PF-10 · win32 execaSync timeout kills only the direct child (npm chain, MSYS fork children, git launcher + hook survive)

- **Claim.** On win32 an `execaSync` `timeout` kill reaches only the direct child. (1) `npm run`: the script's `cmd.exe` and `node.exe` outlive it. (2) An MSYS-forked child (`bash -c 'sleep N &'`) has a Windows parent PID outside the tree, so `taskkill /T /F` on bash leaves it running; an `exec`'d program stays in the tree and dies. (3) Killing Git's `cmd\git.exe` launcher leaves the real `git.exe` and the hook's `sleep.exe` running; killing the real `git.exe` directly (Git Bash's PATH) kills it but the hook's `sleep.exe` survives.
- **Implication.** A budget timeout on a spawned tool chain does not reap descendants: report survivors rather than assuming the kill cleaned up. (The node → node chain exception, #1048, was not re-probed.)
- **Platform.** Node v24.19.0, execa 9.6.1, npm 11.17.0, git version 2.56.0.windows.1, Windows 11 Pro 10.0.26300.
- **Established.** Local drivers, each with a unique marker in the child's command line and a CIM query for survivors after the timeout (3000 ms): (1) `execaSync('npm',['run','hang'],{timeout:3000})`; (2) `spawn(bash -c ...)` then `taskkill /T /F /PID`; (3) `execaSync(<git.exe>,['-C','gk','commit'],{timeout:3000})` with a `pre-commit` hook `sleep 40.0001`. Deciding output:

  ```text
  A  timedOut true; survivors: cmd.exe#39332, node.exe#37796
  B  "sleep 40.0002 & wait": before bash#38932, sleep#10200 parent=47996; taskkill /T /F bash -> after: sleep#10200 still running
  B  "exec sleep 40.0002": taskkill /T kills sleep#51376 (parent=bash) -> after: none
  C  cmd\git.exe launcher: git.exe#50344 and sleep.exe#50572 survive
  C  ucrt64\bin\git.exe direct: git dies, sleep.exe#51300 survives
  ```

- **Last verified.** 2026-10-10.
- **Relied on by.** `ship/src/cli/git/exec.ts` (header: survivors are reported, not reaped; `outputOf`, `orphanWarning`).

## Ship PF-11 · tsx runs esbuild.exe from the checkout's node_modules; a running exe cannot be deleted or overwritten on win32

- **Claim.** A script run through the checkout's `tsx` keeps `node_modules\@esbuild\win32-x64\esbuild.exe` running for its lifetime. A running `.exe` on win32 refuses deletion (EPERM) and overwrite (EBUSY); rename succeeds.
- **Implication.** `npm ci` or removing that `node_modules` fails (or half-applies) while a tsx-hosted CLI runs from it, so such a CLI must refuse to mutate its own checkout.
- **Platform.** tsx 4.21.0, esbuild 0.27.4, Node v24.19.0, Windows 11 Pro 10.0.26300.
- **Established.** Local drivers: (1) `node node_modules/tsx/dist/cli.mjs sleep.ts` in the background, CIM query for `esbuild.exe`; (2) copy of the same `esbuild.exe` spawned with `--service=0.27.4`, then `unlinkSync` / `writeFileSync` / `renameSync` on it. Deciding output:

  ```text
  ExecutablePath : C:\Users\maxim\source\paper-harness\node_modules\@esbuild\win32-x64\esbuild.exe   (while tsx ran)
  unlink EPERM
  rename OK
  overwrite EBUSY
  unlink after exit OK
  ```

- **Last verified.** 2026-10-10.
- **Relied on by.** `ship/src/cli/git/git.ts` (`assertNotSelfHosted`).

## Ship PF-12 · fs.readdirSync(dir, { recursive: true }) descends into directory junctions on win32

- **Claim.** On win32, `readdirSync(dir, { recursive: true })` lists the entries beneath a directory junction inside `dir`, as if the link target were a real subdirectory.
- **Implication.** A recursive walk or count over a tree that holds junctions sees (and a cleanup would reach) the link target's contents; walk manually with `lstat` and stop at links.
- **Platform.** Node v24.19.0, Windows 11 Pro 10.0.26300.
- **Established.** Local driver: junction `dir/lnk` -> a directory holding `inner/f.txt` and `t.txt`. Deciding output:

  ```text
  recursive readdir of dir: [ 'lnk', 'lnk\\inner', 'lnk\\t.txt', 'lnk\\inner\\f.txt' ]
  ```

- **Last verified.** 2026-10-10.
- **Relied on by.** `ship/src/cli/git/links.ts` (every walk is a manual `lstat` walk).

## Ship PF-16 · Git Bash: a tool run through `npx tsx` is orphaned from the session's process tree; `node --import tsx` stays a descendant

- **Claim.** From Claude Code's Bash tool (Git Bash) on win32, a script run as `npx tsx <script>` has an ancestor chain that ends at a missing parent pid before reaching the session's `claude.exe`: `npx`'s shell shim runs through a Cygwin exec that replaces its bash process, so the next process's `ParentProcessId` names a pid that no longer exists. The same script run as `node --import tsx <script>` from the same shell walks up to `claude.exe`.
- **Implication.** Anything that finds a tool's Claude Code session by walking its Windows ancestors never finds it under `npx tsx`; launch the tool with `node --import tsx` instead.
- **Platform.** Node v24.19.0, tsx 4.21.0, GNU bash 5.3.15(2)-release (x86_64-pc-cygwin), MINGW64_NT-10.0-26300 3.6.10, Windows 11 Pro 10.0.26300.
- **Established.** Local driver: a `.ts` script that reads every process's `ProcessId`, `ParentProcessId` and `Name` from `Get-CimInstance Win32_Process` and walks up from `process.pid` until `claude.exe` or a pid with no process, run three times each way from the Bash tool, cwd a worktree whose `node_modules` holds tsx. Deciding output (3 of 3 runs each, the missing pid varying):

  ```text
  npx tsx:           node.exe <- node.exe <- cmd.exe <- node.exe <- bash.exe <- bash.exe <- gone:49728
  node --import tsx: node.exe <- bash.exe <- bash.exe <- bash.exe <- claude.exe
  ```

- **Last verified.** 2026-10-15.
- **Relied on by.** `ship/src/workflow/calls/tool-calls.ts` (`toolWords`: the runner launches every tool with `node --import tsx`).
