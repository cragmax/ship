import { describe, expect, it, vi } from 'vitest';

import { runCaptured } from '../../../tooling/worktree/exec.js';
import {
  restartSessionTsserver,
  type ProcessEntry,
  type RestartDeps,
} from '../../../tooling/worktree/tsserver-restart.js';

// The production process lookup's PowerShell, faked so a failed lookup is deterministic.
vi.mock('../../../tooling/worktree/exec.js', () => ({ runCaptured: vi.fn() }));

const SEMANTIC_CMD =
  '"C:\\nodejs\\node.exe" C:/repo/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot';
const SYNTAX_CMD =
  '"C:\\nodejs\\node.exe" C:/repo/node_modules/typescript/lib/tsserver.js --serverMode partialSemantic';
const LSP_CMD = '"C:\\nodejs\\node.exe" C:/npm/typescript-language-server/lib/cli.mjs --stdio';

function proc(
  pid: number,
  ppid: number,
  name: string,
  commandLine: string | null = null,
): ProcessEntry {
  return { pid, ppid, name, commandLine };
}

/** One session's LSP subtree, as Claude Code spawns it: `cmd.exe → language server → tsservers`. */
function lspTree(session: number, base: number): ProcessEntry[] {
  return [
    proc(base, session, 'cmd.exe', 'cmd.exe /d /s /c typescript-language-server --stdio'),
    proc(base + 1, base, 'node.exe', LSP_CMD),
    proc(base + 2, base + 1, 'node.exe', SEMANTIC_CMD),
    proc(base + 3, base + 1, 'node.exe', SYNTAX_CMD),
  ];
}

// The teardown (150) runs under session 100's Bash; session 200 is another Claude Code session.
const TWO_SESSIONS: ProcessEntry[] = [
  proc(4, 0, 'explorer.exe'),
  proc(100, 4, 'claude.exe'),
  ...lspTree(100, 110),
  proc(140, 100, 'bash.exe'),
  proc(150, 140, 'node.exe', 'node --import tsx tooling/worktree.ts teardown C:/wt'),
  proc(200, 4, 'claude.exe'),
  ...lspTree(200, 210),
];

/** Deps over a fake process table; each kill is recorded, failing when `failing` names it. */
function fakeDeps(
  table: readonly ProcessEntry[],
  over: Partial<RestartDeps> = {},
  failing: readonly number[] = [],
): { deps: Partial<RestartDeps>; kills: number[] } {
  const kills: number[] = [];
  return {
    kills,
    deps: {
      disabled: false,
      platform: 'win32',
      selfPid: 150,
      sessionImage: 'claude.exe',
      listProcesses: () => table,
      kill: (pid) => {
        kills.push(pid);
        if (failing.includes(pid))
          throw Object.assign(new Error('Access is denied'), { code: 'EPERM' });
      },
      ...over,
    },
  };
}

describe('restartSessionTsserver', () => {
  it("kills only the session's semantic tsserver, sparing its syntax one and another session's", () => {
    const { deps, kills } = fakeDeps(TWO_SESSIONS);

    expect(restartSessionTsserver(deps)).toEqual({
      outcome: 'restarted',
      session: 100,
      killed: [112],
    });
    expect(kills).toEqual([112]);
  });

  it('finds the nearest claude.exe ancestor in a nested session', () => {
    // Session 300 runs a Bash that started session 320; the teardown runs under 320.
    const nested = [
      proc(300, 4, 'claude.exe'),
      ...lspTree(300, 310),
      proc(305, 300, 'bash.exe'),
      proc(320, 305, 'claude.exe'),
      ...lspTree(320, 330),
      proc(340, 320, 'bash.exe'),
      proc(150, 340, 'node.exe', 'node --import tsx tooling/worktree.ts teardown C:/wt'),
    ];
    const { deps, kills } = fakeDeps(nested);

    expect(restartSessionTsserver(deps)).toEqual({
      outcome: 'restarted',
      session: 320,
      killed: [332],
    });
    expect(kills).toEqual([332]);
  });

  it("takes the teardown's own parent when it is the session", () => {
    // Session 320 spawned the teardown directly, inside a Bash of session 300.
    const nested = [
      proc(300, 4, 'claude.exe'),
      ...lspTree(300, 310),
      proc(305, 300, 'bash.exe'),
      proc(320, 305, 'claude.exe'),
      ...lspTree(320, 330),
      proc(150, 320, 'node.exe', 'node --import tsx tooling/worktree.ts teardown C:/wt'),
    ];
    const { deps, kills } = fakeDeps(nested);

    expect(restartSessionTsserver(deps)).toEqual({
      outcome: 'restarted',
      session: 320,
      killed: [332],
    });
    expect(kills).toEqual([332]);
  });

  it('matches the session and node image names case-insensitively', () => {
    const table = TWO_SESSIONS.map((p) => {
      if (p.pid === 100) return { ...p, name: 'Claude.EXE' };
      if (p.pid === 112) return { ...p, name: 'NODE.EXE' };
      return p;
    });
    const { deps, kills } = fakeDeps(table, { sessionImage: 'CLAUDE.exe' });

    expect(restartSessionTsserver(deps)).toEqual({
      outcome: 'restarted',
      session: 100,
      killed: [112],
    });
    expect(kills).toEqual([112]);
  });

  it('records the pids killed when only some kills fail', () => {
    const table = [...TWO_SESSIONS, proc(119, 111, 'node.exe', SEMANTIC_CMD)];
    const { deps, kills } = fakeDeps(table, {}, [112]);

    expect(restartSessionTsserver(deps)).toEqual({
      outcome: 'restarted',
      session: 100,
      killed: [119],
    });
    expect(kills).toEqual([112, 119]);
  });

  it.each([
    {
      name: 'disabled by its switch',
      over: { disabled: true },
      table: TWO_SESSIONS,
      expected: { outcome: 'skipped', reason: 'disabled', detail: null },
    },
    {
      name: 'not on Windows',
      over: { platform: 'linux' as const },
      table: TWO_SESSIONS,
      expected: { outcome: 'skipped', reason: 'not-windows', detail: null },
    },
    {
      name: 'with no claude.exe ancestor (a missing parent ends the walk)',
      over: {},
      table: TWO_SESSIONS.filter((p) => p.pid !== 140),
      expected: { outcome: 'skipped', reason: 'no-session', detail: null },
    },
    {
      name: 'with a cycle in the parent links',
      over: {},
      table: [...TWO_SESSIONS.filter((p) => p.pid !== 140), proc(140, 150, 'bash.exe')],
      expected: { outcome: 'skipped', reason: 'no-session', detail: null },
    },
    {
      name: 'with no semantic tsserver in the session',
      over: {},
      table: TWO_SESSIONS.filter((p) => p.pid !== 112),
      expected: { outcome: 'skipped', reason: 'no-tsserver', detail: null },
    },
  ])('skips, killing nothing, $name', ({ over, table, expected }) => {
    const { deps, kills } = fakeDeps(table, over);

    expect(restartSessionTsserver(deps)).toEqual(expected);
    expect(kills).toEqual([]);
  });

  it('skips as lookup-failed, with the error, when the process table cannot be read', () => {
    const { deps, kills } = fakeDeps(TWO_SESSIONS, {
      listProcesses: () => {
        throw new Error('process lookup exited 1: Get-CimInstance failed');
      },
    });

    expect(restartSessionTsserver(deps)).toEqual({
      outcome: 'skipped',
      reason: 'lookup-failed',
      detail: 'process lookup exited 1: Get-CimInstance failed',
    });
    expect(kills).toEqual([]);
  });

  it('skips as lookup-failed when the PowerShell process lookup exits non-zero', () => {
    vi.mocked(runCaptured).mockReturnValueOnce({
      exitCode: 1,
      stdout: '',
      tail: 'Get-CimInstance : Access denied',
    });
    const { deps, kills } = fakeDeps(TWO_SESSIONS);
    const real = { ...deps };
    delete real.listProcesses;

    expect(restartSessionTsserver(real)).toEqual({
      outcome: 'skipped',
      reason: 'lookup-failed',
      detail: 'process lookup exited 1: Get-CimInstance : Access denied',
    });
    expect(kills).toEqual([]);
  });

  it('skips as lookup-failed when the PowerShell process lookup prints a malformed row', () => {
    vi.mocked(runCaptured).mockReturnValueOnce({
      exitCode: 0,
      stdout: '[{"ProcessId":"150","ParentProcessId":140,"Name":"node.exe","CommandLine":null}]',
      tail: '',
    });
    const { deps, kills } = fakeDeps(TWO_SESSIONS);
    const real = { ...deps };
    delete real.listProcesses;

    expect(restartSessionTsserver(real)).toMatchObject({
      outcome: 'skipped',
      reason: 'lookup-failed',
    });
    expect(kills).toEqual([]);
  });

  it('skips as kill-failed, naming each pid and its error, when every kill fails', () => {
    const table = [...TWO_SESSIONS, proc(119, 111, 'node.exe', SEMANTIC_CMD)];
    const { deps } = fakeDeps(table, {}, [112, 119]);

    expect(restartSessionTsserver(deps)).toEqual({
      outcome: 'skipped',
      reason: 'kill-failed',
      detail: '112: Access is denied [EPERM]; 119: Access is denied [EPERM]',
    });
  });

  it('is disabled by PH_TSSERVER_RESTART=off, which the test configs set', () => {
    const { deps, kills } = fakeDeps(TWO_SESSIONS);
    const fromEnv = { ...deps };
    delete fromEnv.disabled;

    expect(process.env.PH_TSSERVER_RESTART).toBe('off');
    expect(restartSessionTsserver(fromEnv)).toEqual({
      outcome: 'skipped',
      reason: 'disabled',
      detail: null,
    });
    expect(kills).toEqual([]);
  });
});
