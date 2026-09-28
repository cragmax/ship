import { describe, it, expect } from 'vitest';

import type { GateVerdict, IssueCheck } from '../../../tooling/lib/run-gate.js';
import { exitCodeFor, parseRunGateArgs } from '../../../tooling/run-gate.js';

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
