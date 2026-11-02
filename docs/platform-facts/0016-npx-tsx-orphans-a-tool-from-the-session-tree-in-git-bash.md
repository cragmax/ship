---
status: current
platform: [node 24.19.0, tsx 4.21.0, bash 5.3.15, msys2-runtime 3.6.10, windows 10.0.26300]
last-verified: 2026-10-15
relied-on-by: [ship/src/workflow/calls/tool-calls.ts, ship/src/cli/commands/tsserver-restart.ts]
---

# Ship PF-16: In Git Bash, a tool run through `npx tsx` is orphaned from the session's process tree, and `node --import tsx` stays a descendant

From Claude Code's Bash tool (Git Bash) on win32, a script run as `npx tsx <script>` has an ancestor chain that ends at a missing parent pid before reaching the session's `claude.exe`. `npx`'s shell shim runs through a Cygwin exec that replaces its bash process, so the next process's `ParentProcessId` names a pid that no longer exists. The same script run as `node --import tsx <script>` from the same shell walks up to `claude.exe`.

## Implication

Anything that finds a tool's Claude Code session by walking its Windows ancestors never finds it under `npx tsx`. Launch the tool with `node --import tsx` instead. `toolWords` in `ship/src/workflow/calls/tool-calls.ts` has the runner launch every tool with `node --import tsx`.

## Scope

The shell was GNU bash 5.3.15(2)-release (x86_64-pc-cygwin) on MINGW64_NT-10.0-26300 3.6.10, under Windows 11 Pro 10.0.26300.

## Established

A local driver: a `.ts` script that reads every process's `ProcessId`, `ParentProcessId`, and `Name` from `Get-CimInstance Win32_Process` and walks up from `process.pid` until `claude.exe` or a pid with no process. It ran three times each way from the Bash tool, its working directory a worktree whose `node_modules` holds tsx. Deciding output (3 of 3 runs each, the missing pid varying):

```text
npx tsx:           node.exe <- node.exe <- cmd.exe <- node.exe <- bash.exe <- bash.exe <- gone:49728
node --import tsx: node.exe <- bash.exe <- bash.exe <- bash.exe <- claude.exe
```
