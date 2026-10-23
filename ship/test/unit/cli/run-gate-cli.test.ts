import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import type { GhJson } from '../../../src/cli/run-gate-gh.js';
import type { GateVerdict, IssueCheck } from '../../../src/core/gate/run-gate.js';
import { exitCodeFor, main, parseRunGateArgs } from '../../../src/cli/run-gate.js';

describe('parseRunGateArgs', () => {
  it('epics with space-separated numbers', () => {
    expect(parseRunGateArgs(['epics', '1025', '1041'])).toEqual({
      kind: 'gate',
      spec: { kind: 'epics', epics: [1025, 1041] },
      mode: 'refuse',
    });
  });

  it('issues with comma- and space-separated numbers mixed', () => {
    expect(parseRunGateArgs(['issues', '1027,1030', '1031'])).toEqual({
      kind: 'gate',
      spec: { kind: 'issues', issues: [1027, 1030, 1031] },
      mode: 'refuse',
    });
  });

  it('a comma followed by a space (two tokens) still parses', () => {
    expect(parseRunGateArgs(['issues', '1027,', '1030'])).toEqual({
      kind: 'gate',
      spec: { kind: 'issues', issues: [1027, 1030] },
      mode: 'refuse',
    });
  });

  it('a leading # is accepted', () => {
    expect(parseRunGateArgs(['issues', '#1031'])).toEqual({
      kind: 'gate',
      spec: { kind: 'issues', issues: [1031] },
      mode: 'refuse',
    });
  });

  it.each([[['issues', '--exclude', '5', '6']], [['issues', '5', '6', '--exclude']]])(
    '--exclude before or after the numbers: %j',
    (argv) => {
      expect(parseRunGateArgs(argv)).toEqual({
        kind: 'gate',
        spec: { kind: 'issues', issues: [5, 6] },
        mode: 'exclude',
      });
    },
  );

  it('check with one number', () => {
    expect(parseRunGateArgs(['check', '1031'])).toEqual({ kind: 'check', issue: 1031 });
  });
});

describe('parseRunGateArgs usage errors', () => {
  it('no subcommand', () => {
    expect(() => parseRunGateArgs([])).toThrow(/subcommand/);
  });

  it.each([
    [['run', '1'], "'run'"],
    [['issues', '--force', '1'], "'--force'"],
    [['epics'], "'epics'"],
    [['issues', 'abc'], "'abc'"],
    [['issues', '0'], "'0'"],
    [['issues', '1.5'], "'1.5'"],
    [['issues', '-3'], "'-3'"],
    [['issues', '5', '#5'], "'#5'"],
    [['issues', '7,7'], "'7,7'"],
    [['check', '1', '--exclude'], "'--exclude'"],
    [['check', '1', '2'], "'2'"],
  ])('%j names %s', (argv, token) => {
    expect(() => parseRunGateArgs(argv)).toThrow(token);
  });
});

describe('exitCodeFor', () => {
  const verdict = (kind: GateVerdict['verdict']): GateVerdict => ({
    verdict: kind,
    mode: 'refuse',
    runSet: [],
    edges: [],
    failures: [],
    excluded: [],
  });
  const check = (ready: boolean): IssueCheck => ({ issue: 1, ready, failures: [] });

  it('ok → 0', () => {
    expect(exitCodeFor(verdict('ok'))).toBe(0);
  });

  it('refused → 1', () => {
    expect(exitCodeFor(verdict('refused'))).toBe(1);
  });

  it('ready → 0', () => {
    expect(exitCodeFor(check(true))).toBe(0);
  });

  it('not ready → 1', () => {
    expect(exitCodeFor(check(false))).toBe(1);
  });
});

describe('main', () => {
  let stdout: string[];
  let stderr: string[];
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    savedExitCode = process.exitCode;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));

      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));

      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
  });

  const facts = (labels: readonly string[]): unknown => ({
    number: 7,
    state: 'OPEN',
    labels: labels.map((name) => ({ name })),
    body: '',
    blockedBy: { nodes: [], totalCount: 0 },
  });

  it('a usage error exits 2, stdout empty, the diagnostic on stderr', async () => {
    await main(['issues', 'abc'], () => Promise.reject(new Error('gh must not be called')));
    expect(process.exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain("'abc'");
    expect(stderr.join('')).toContain(
      'usage: npx tsx ship/src/cli/run-gate.ts epics|issues N... [--exclude] | check N',
    );
  });

  it('a gh failure exits 2, stdout empty, the diagnostic on stderr', async () => {
    await main(['check', '7'], () => Promise.reject(new Error('gh view 7 failed: boom')));
    expect(process.exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('boom');
  });

  it('a refused verdict exits 1 and prints only the pretty-printed verdict', async () => {
    const gh: GhJson = () => Promise.resolve(facts(['bug']));
    await main(['issues', '7'], gh);
    expect(process.exitCode).toBe(1);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const parsed: unknown = JSON.parse(stdout[0] ?? '');
    expect(parsed).toEqual({
      verdict: 'refused',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [7] }],
      edges: [],
      failures: [{ kind: 'missing-label', issue: 7, message: expect.any(String) }],
      excluded: [],
    });
    expect(stdout[0]).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it('a ready check exits 0', async () => {
    await main(['check', '7'], () => Promise.resolve(facts(['ready-for-agent'])));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual({ issue: 7, ready: true, failures: [] });
  });
});
