/**
 * Restart the semantic tsserver of the Claude Code session a `teardown` runs under. On Windows a
 * tsserver that watched a now-deleted worktree burns about one core until its session ends, and
 * killing it is the recovery: Claude Code respawns the language server without the dead projects
 * (Ship PF-17). The session is found up the process tree, which reaches `claude.exe` only when the
 * CLI runs under `node --import tsx`, never `npx tsx` from Git Bash (Ship PF-16).
 */

import { tmpdir } from 'node:os';

import { z } from 'zod';

import { describeError } from '../../core/describe-error.js';
import { runCaptured } from '../git/exec.js';
import type { TsserverRestart, TsserverSkipReason } from '../envelope/types.js';

/** One row of the process table. */
export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** The image name, as Windows reports it (`claude.exe`, `node.exe`). */
  readonly name: string;
  /** `null` when Windows withholds it. */
  readonly commandLine: string | null;
}

/** Seams of {@link restartSessionTsserver}. */
export interface RestartDeps {
  /** Production: `PH_TSSERVER_RESTART=off` in the environment, read at the call. */
  readonly disabled: boolean;
  /** Production: `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** The process whose ancestors are searched (production: this one). */
  readonly selfPid: number;
  /** The session's image name, matched case-insensitively (production: `claude.exe`). */
  readonly sessionImage: string;
  /** Production: {@link listWindowsProcesses}. */
  readonly listProcesses: () => readonly ProcessEntry[];
  /** Production: `process.kill`. */
  readonly kill: (pid: number) => void;
}

/** The environment variable, set to `off`, that disables the restart (the test configs set it). */
const RESTART_SWITCH = 'PH_TSSERVER_RESTART';

function defaultDeps(): RestartDeps {
  return {
    disabled: process.env[RESTART_SWITCH] === 'off',
    platform: process.platform,
    selfPid: process.pid,
    sessionImage: 'claude.exe',
    listProcesses: listWindowsProcesses,
    kill: (pid) => process.kill(pid),
  };
}

/**
 * Kill every semantic tsserver (a `node` running `tsserver.js`, never with
 * `--serverMode partialSemantic`) among the descendants of the nearest
 * {@link RestartDeps.sessionImage} ancestor of {@link RestartDeps.selfPid}; no other process is
 * touched.
 *
 * @silences A failed process lookup (`lookup-failed`) and failed kills (`kill-failed` when none
 *   succeeded; a partial failure records only the pids killed): the restart is best effort.
 */
export function restartSessionTsserver(deps: Partial<RestartDeps> = {}): TsserverRestart {
  const { disabled, platform, selfPid, sessionImage, listProcesses, kill } = {
    ...defaultDeps(),
    ...deps,
  };
  if (disabled) return skipped('disabled');
  if (platform !== 'win32') return skipped('not-windows');
  let table: readonly ProcessEntry[];
  try {
    table = listProcesses();
  } catch (err) {
    return skipped('lookup-failed', describeError(err));
  }
  const session = nearestAncestor(table, selfPid, sessionImage.toLowerCase());
  if (session === null) return skipped('no-session');
  const targets = descendants(table, session).filter(isSemanticTsserver);
  if (targets.length === 0) return skipped('no-tsserver');
  return killAll(session, targets, kill);
}

/** Kill each target, recording the pids killed, or `kill-failed` when none was. */
function killAll(
  session: number,
  targets: readonly ProcessEntry[],
  kill: (pid: number) => void,
): TsserverRestart {
  const killed: number[] = [];
  const failures: string[] = [];
  for (const { pid } of targets) {
    try {
      kill(pid);
      killed.push(pid);
    } catch (err) {
      failures.push(`${String(pid)}: ${describeError(err)}`);
    }
  }
  if (killed.length === 0) return skipped('kill-failed', failures.join('; '));
  return { outcome: 'restarted', session, killed };
}

/** A skip record. */
export function skipped(reason: TsserverSkipReason, detail: string | null = null): TsserverRestart {
  return { outcome: 'skipped', reason, detail };
}

/** The pid of the nearest strict ancestor of `pid` named `image`, or `null`. */
function nearestAncestor(
  table: readonly ProcessEntry[],
  pid: number,
  image: string,
): number | null {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const seen = new Set<number>([pid]);
  let parent = byPid.get(pid)?.ppid;
  while (parent !== undefined && !seen.has(parent)) {
    const entry = byPid.get(parent);
    if (entry === undefined) return null;
    if (entry.name.toLowerCase() === image) return entry.pid;
    seen.add(parent);
    parent = entry.ppid;
  }
  return null;
}

/** Every process below `root`, breadth first. */
function descendants(table: readonly ProcessEntry[], root: number): ProcessEntry[] {
  const found: ProcessEntry[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of table) {
      if (child.ppid !== pid || seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

function isSemanticTsserver({ name, commandLine }: ProcessEntry): boolean {
  if (name.toLowerCase() !== 'node.exe' || commandLine === null) return false;
  return (
    commandLine.includes('tsserver.js') && !/--serverMode\s+partialSemantic/u.test(commandLine)
  );
}

const CimRowSchema = z.object({
  ProcessId: z.int(),
  ParentProcessId: z.int(),
  Name: z.string(),
  CommandLine: z.string().nullable(),
});

const LIST_COMMAND =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';

/**
 * Windows' process table, from `Win32_Process`.
 *
 * @throws Error when PowerShell fails or prints what the row schema rejects.
 */
function listWindowsProcesses(): ProcessEntry[] {
  const r = runCaptured(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', LIST_COMMAND],
    {
      cwd: tmpdir(),
    },
  );
  if (r.exitCode !== 0) throw new Error(`process lookup exited ${String(r.exitCode)}: ${r.tail}`);
  return z
    .array(CimRowSchema)
    .parse(JSON.parse(r.stdout))
    .map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      name: row.Name,
      commandLine: row.CommandLine,
    }));
}
