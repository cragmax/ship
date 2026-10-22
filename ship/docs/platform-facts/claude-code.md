# Claude Code as the session

This category covers **Claude Code** as the session a run's agents work in: what a worktree's agents load, how an agent file preloads skills, and the language server a teardown leaves behind. Facts here are version-stamped against the **Claude Code** release in their **Platform** line; a release can move them, so re-verify before relying on one.

## Ship PF-14 · A worktree directly under `.claude/worktrees/` gets the main checkout's path-scoped rules on a read, never its own `CLAUDE.md` or rules

- **Claim.** A sub-agent with cwd the main checkout (a workflow `agent()` or an Agent-tool sub-agent, Ship PF-2) that reads a file of a git worktree nested in the project loads, for a worktree that is a direct child of `.claude/worktrees/`, only the main checkout's `paths:` rules, matched on the file's path relative to the worktree — never the worktree's own `CLAUDE.md` or `.claude/rules/`. A worktree anywhere else in the project (`tmp/x`, an untracked dot-directory, or two levels under `.claude/worktrees/`, the last seen with the Agent tool only) loads its own `CLAUDE.md`, unconditional rules and matching scoped rules, plus any root scoped rule whose glob matches the nested path (`src/**` matched `<worktree>/src/a.ts`; `src/**/*.ts` did not).
- **Implication.** A run worktree must be a direct child of `.claude/worktrees/` for its agents to follow the main checkout's instructions (Ship ADR-0001 decision 3).
- **Platform.** Claude Code 2.1.296, Linux. Windows unverified.
- **Established.** Workflow `agent()` and Agent-tool sub-agent probes over detached `git worktree add` checkouts, 2026-10-13 ([#1401 grill outcome](https://github.com/cragmax/paper-harness/issues/1401#issuecomment-6154407401)), each verdict read from the `nested_memory` attachments in the agent's transcript. Deciding output:

  ```text
  tmp/probe-wt                          -> its CLAUDE.md, its 6 unconditional rules, its matching scoped rules, root lean.md
  .probe-wt                             -> same as tmp/
  .claude/worktrees/probe-wt            -> root lean, framework-dev, comments-tsdoc (src/); root write-testing (test/); nothing of its own
  .claude/worktrees/probe-run/slice-1-1 -> same as tmp/
  ```

  Docs: [worktrees § Isolate subagents with worktrees](https://code.claude.com/docs/en/worktrees) — the subagent "doesn't load the `CLAUDE.md` file or `.claude/rules/` directory at the worktree's root as it reads files there".

- **Last verified.** 2026-10-13.
- **Relied on by.** `ship/src/cli/git/run-layout.ts` (`WORKTREES_DIR`).

## Ship PF-15 · An agent file's `skills:` preload injects each skill's full SKILL.md into a workflow `agent()`, its links resolving against the main checkout

- **Claim.** A workflow `agent()` call with an `agentType` whose agent file lists `skills:` starts with each listed skill's full `SKILL.md` body in context, a `user-invocable: false` skill included, and the agent file's `tools` restriction still holds. The skill's supporting files are not preloaded, but the preload carries a `Base directory for this skill: <main checkout>/.claude/skills/<name>` line, so the agent resolves the skill's relative links against the main checkout and Reads them on demand, from a worktree cwd too. A personal skill (`~/.claude/skills/<name>`) shadows a same-named project skill in the preload, name by name. Documented, not probed: a skill with `disable-model-invocation: true` is never preloaded, and a missing or disabled skill is skipped with only a debug-log warning.
- **Implication.** A stage agent loads its skill by `skills:` preload, with no read by path and no Skill-tool step; the skill's relative links reach the main checkout's copies, as Ship ADR-0001 decision 3 wants. A preloaded skill must not set `disable-model-invocation`, and no personal skill may share its name.
- **Platform.** Claude Code 2.1.299 workflow runtime, Linux (cloud container).
- **Established.** Workflow `agent()` probes, 2026-10-14 (#1440 grilling). The probe agent file had `tools: Glob` (`Read, Glob` for the links probe) and `skills:` listing `probe-canary-a` (body token `CANARY-A-7Q3Z-PLAIN`, linking `extra.md`, which held `CANARY-A-EXTRA-K9W2`, and `../../rules/git.md`) and `probe-canary-b` (`user-invocable: false`, token `CANARY-B-4M8X-HIDDEN`). Each agent reported the tokens in its context and its tools; a control `agent()` with no `agentType` ran beside the first. The links probe ran one agent in the main checkout and one with `isolation: 'worktree'`, `extra.md` untracked so absent from the worktree. Deciding output:

  ```text
  preload agent:  canaries [CANARY-A-7Q3Z-PLAIN, CANARY-B-4M8X-HIDDEN]; tools [Glob, StructuredOutput]
  control agent:  canaries []; tools [Artifact, Bash, Edit, Glob, Grep, …, Skill, …]
  worktree agent: base_dir_line "Base directory for this skill: /home/user/paper-harness/.claude/skills/probe-canary-a"
                  extra.md -> CANARY-A-EXTRA-K9W2 (main checkout); ../../rules/git.md read (main checkout)
  personal skill ~/.claude/skills/probe-canary-a (CANARY-A-PERSONAL-5T1V) added:
                  canaries [CANARY-A-PERSONAL-5T1V, CANARY-B-4M8X-HIDDEN]
  ```

  A just-created agent file was not yet registered on the first `agent()` call (`agent type 'probe-preload' not found`); a re-run seconds later found it. Docs: [sub-agents](https://code.claude.com/docs/en/sub-agents) — "You can't preload skills that set `disable-model-invocation: true`"; [skills](https://code.claude.com/docs/en/skills), the `disable-model-invocation` row — "Also prevents the skill from being preloaded into subagents".

- **Last verified.** 2026-10-14.
- **Relied on by.** `.claude/agents/tdd.md`'s `skills:` preload of `tdd` and `unattended-agent`; `unattended-agent`'s `user-invocable: false`.

## Ship PF-17 · On Windows a session's semantic tsserver burns about one core once a directory it watched is deleted; killing it makes Claude Code respawn its language server clean

- **Claim.** Four observations, one chain:
  1. Node 24 on Windows: once a directory under `fs.watch` (recursive or flat) is deleted, the watcher fires about 120k `rename` events per second carrying the directory's own `\?\` path, never an `error`, until `close()`.
  2. TypeScript 5.9 on Windows replaces such a watcher (`fsWatchHandlingExistenceOnHost`) only on an `error` event, so it keeps it and re-runs its invalidation on every event.
  3. Claude Code's LSP client never sends `textDocument/didClose`, and tsserver drops an orphaned project only after a `didClose` and a later open; so the project of a deleted worktree whose files the session opened stays, and its semantic tsserver holds about 1.0 to 1.4 cores until the session ends.
  4. Killing that semantic tsserver (`tsserver.js` without `--serverMode partialSemantic`) takes typescript-language-server down with it, and Claude Code respawns the server (`restartOnCrash` defaults to `true`): file watching comes back, the dead projects are gone, and CPU falls to about 0.01 cores. The respawn held for 20 consecutive kills in one session.
- **Implication.** Deleting a worktree whose files a session's LSP opened starts the burn; nothing in the worktree or `tsconfig.json` prevents it (`TSC_WATCHDIRECTORY` and `watchOptions` were probed, neither helps). The recovery is to kill the session's semantic tsserver after the deletion. `useClientFileWatcher: true` also stops the burn but blinds tsserver to on-disk changes, because Claude Code never registers `workspace/didChangeWatchedFiles`.
- **Platform.** Node v24.19.0, TypeScript 5.9.3, typescript-language-server 6.0.2, Claude Code 2.1.300 with the `typescript-lsp` plugin, Windows 11 Pro 10.0.26300.
- **Established.** #1396, 2026-10-15. A Node driver (`fs.watch` on a directory, then `rmSync` of it, CPU over 5 s): `events=597096 in 5s, cores=0.997` recursive, `642383 in 5s, cores=1.000` flat, no `error` event. An LSP driver spawning typescript-language-server as the plugin does, opening files in fresh `git worktree add` roots, then deleting them, sampling the semantic tsserver:

  ```text
  3 roots, open and idle:              0.110 / 0.015 cores
  3 roots, after deletion:             1.397 / 1.324 cores
  after deletion + didClose alone:     1.242 / 1.202 cores
  after deletion + didClose + didOpen: 1.327 -> 0.011 cores (remove Project:: x3 in the TSS log)
  ```

  Nested Claude Code 2.1.300 sessions (`claude -p`) that edited a file in a throwaway worktree, deleted it and sampled their own semantic tsserver over 15 s: 1.045 cores with the official plugin; after killing the tsserver 1.042 -> 0.008 cores, with fresh hovers and diagnostics after the respawn; 6, then 20, kills in one session all respawned.

- **Last verified.** 2026-10-15.
- **Relied on by.** `ship/src/cli/commands/tsserver-restart.ts` (`restartSessionTsserver`, run by `teardown` after it removes a worktree).
