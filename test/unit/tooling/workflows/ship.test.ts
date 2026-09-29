import { describe, expect, it } from 'vitest';

import { STAGES, type StageName, type StageRow } from '../../../../tooling/workflows/lib/stages.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import { fakeHooks, GATE_OK, LIVE_RUNS_NONE, PREFLIGHT_OK } from './_fake-hooks.js';

const EPIC_GRAPH = {
  runSet: [{ epic: 1025, issues: [1045, 1046] }],
  edges: [{ blocker: 1045, dependent: 1046 }],
};

const EPIC_FRESH = {
  'runner:run-gate': { ...GATE_OK, ...EPIC_GRAPH },
  scout: {
    issues: [
      { issue: 1045, stale: false, evidence: 'fresh' },
      { issue: 1046, stale: false, evidence: 'fresh' },
    ],
    overlaps: [],
  },
};

const THREE_REFUSALS = {
  'runner:preflight': {
    ...PREFLIGHT_OK,
    exitCode: 1,
    status: 'refused',
    reason: 'preflight-failed',
    problems: [{ check: 'master-ahead', message: 'local master is 2 commits ahead' }],
  },
  'runner:run-gate': {
    ...GATE_OK,
    exitCode: 1,
    verdict: 'refused',
    failures: [{ kind: 'missing-label', issue: 8, message: '#8 lacks ready-for-agent' }],
    runSet: [{ epic: null, issues: [7, 8] }],
  },
  scout: {
    issues: [
      { issue: 7, stale: true, evidence: 'parseFoo no longer exists' },
      { issue: 8, stale: false, evidence: 'fresh' },
    ],
    overlaps: [],
  },
};

const SEVEN_STALE_BLOCKS_EIGHT = {
  'runner:run-gate': {
    ...GATE_OK,
    runSet: [{ epic: null, issues: [7, 8, 9] }],
    edges: [{ blocker: 7, dependent: 8 }],
  },
  scout: {
    issues: [
      { issue: 7, stale: true, evidence: 'already implemented at abc123' },
      { issue: 8, stale: false, evidence: 'fresh' },
      { issue: 9, stale: false, evidence: 'fresh' },
    ],
    overlaps: [],
  },
};

/** Every run this file drives; the tier check runs over each. */
const SCENARIOS = [
  { name: 'pre-flight only', responses: EPIC_FRESH, args: 'epics 1025 --preflight-only' },
  { name: 'three refusals', responses: THREE_REFUSALS, args: { issues: [7, 8] } },
  {
    name: 'exclude mode',
    responses: SEVEN_STALE_BLOCKS_EIGHT,
    args: 'issues 7,8 #9 --exclude --preflight-only',
  },
  { name: 'full launch', responses: {}, args: 'issues 7' },
];

const isCutOrLand = (c: { label: string; argv: readonly string[] }): boolean =>
  /cut-batch|provision|land/.test(`${c.label} ${c.argv.join(' ')}`);

describe('runShip — pre-flight only', () => {
  it('returns preflight-ok with the run graph after the four pre-flight calls, before any cut-batch', async () => {
    const run = fakeHooks(EPIC_FRESH);

    const report = await runShip(run.hooks, 'epics 1025 --preflight-only');

    expect(report).toEqual({ status: 'preflight-ok', graph: EPIC_GRAPH, dropped: [], epics: [] });
    expect(run.calls.map((c) => c.label)).toEqual([
      'runner:preflight',
      'runner:run-gate',
      'runner:live-runs',
      'scout',
    ]);
    expect(run.calls.map((c) => c.argv)).toEqual([
      ['tooling/worktree.ts', 'preflight', '.'],
      ['tooling/run-gate.ts', 'epics', '1025'],
      ['tooling/worktree.ts', 'live-runs', '.'],
      [],
    ]);
    expect(run.phases).toEqual(['Pre-flight']);
  });
});

describe('runShip — pre-flight refusals', () => {
  it('lists master-ahead, the gate failure and the stale issue in one refused report, cutting nothing', async () => {
    const run = fakeHooks(THREE_REFUSALS);

    const report = await runShip(run.hooks, { issues: [7, 8] });

    expect(report).toEqual({
      status: 'refused',
      refusals: [
        { kind: 'master-ahead', message: 'local master is 2 commits ahead' },
        { kind: 'missing-label', issue: 8, message: '#8 lacks ready-for-agent' },
        { kind: 'stale', issue: 7, message: 'parseFoo no longer exists' },
      ],
      dropped: [],
      epics: [],
    });
    expect(run.calls.filter(isCutOrLand)).toEqual([]);
  });

  it('refuses a clean full launch full-run-unavailable, cutting nothing', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7');

    expect(report).toEqual({
      status: 'refused',
      refusals: [{ kind: 'full-run-unavailable', message: expect.any(String) }],
      dropped: [],
      epics: [],
    });
    expect(run.calls.filter(isCutOrLand)).toEqual([]);
  });
});

describe('runShip — every tool failure is a refusal', () => {
  const OTHER_RUN = { branch: 'ship/epic-9', landed: ['src/a.ts'], spent: false };

  it.each([
    [
      'a runner that returned nothing',
      { 'runner:preflight': null },
      'issues 7 --preflight-only',
      [{ kind: 'preflight-error', message: 'the runner returned nothing for preflight' }],
    ],
    [
      'a pre-flight usage error',
      {
        'runner:preflight': { exitCode: 2, envelopePath: 'p', stderrTail: 'worktree: bad target' },
      },
      'issues 7 --preflight-only',
      [{ kind: 'preflight-error', message: 'worktree: bad target' }],
    ],
    [
      'a refused pre-flight naming no problem',
      {
        'runner:preflight': {
          exitCode: 1,
          envelopePath: 'p',
          status: 'refused',
          reason: 'preflight-failed',
        },
      },
      'issues 7 --preflight-only',
      [{ kind: 'preflight-error', message: 'preflight-failed' }],
    ],
    [
      'a refused gate naming no failure',
      {
        'runner:run-gate': {
          exitCode: 1,
          envelopePath: 'g',
          verdict: 'refused',
          runSet: [{ epic: null, issues: [7] }],
          edges: [],
        },
      },
      'issues 7 --preflight-only',
      [{ kind: 'gate-error', message: 'run gate exited 1 with no usable verdict' }],
    ],
    [
      'an ok gate without its edges',
      {
        'runner:run-gate': {
          exitCode: 0,
          envelopePath: 'g',
          verdict: 'ok',
          runSet: [{ epic: null, issues: [7] }],
        },
      },
      'issues 7 --preflight-only',
      [{ kind: 'gate-error', message: 'run gate exited 0 with no usable verdict' }],
    ],
    [
      'an ok gate without its run set',
      { 'runner:run-gate': { exitCode: 0, envelopePath: 'g', verdict: 'ok', edges: [] } },
      'issues 7 --preflight-only',
      [{ kind: 'gate-error', message: 'run gate exited 0 with no usable verdict' }],
    ],
    [
      'an ok live-runs without its runs list',
      { 'runner:live-runs': { exitCode: 0, envelopePath: 'l', status: 'ok', errors: [] } },
      'issues 7 --preflight-only',
      [{ kind: 'live-runs-failed', message: 'live-runs exited 0 with no usable verdict' }],
    ],
    [
      'a failed live-runs',
      {
        'runner:live-runs': {
          ...LIVE_RUNS_NONE,
          exitCode: 1,
          status: 'failed',
          errors: [{ step: 'pr-state', message: 'gh pr list failed for ship/epic-9' }],
        },
      },
      'issues 7 --preflight-only',
      [{ kind: 'live-runs-failed', message: 'gh pr list failed for ship/epic-9' }],
    ],
    [
      'an unknown PR state, never read as no PR',
      {
        'runner:live-runs': {
          ...LIVE_RUNS_NONE,
          runs: [{ ...OTHER_RUN, pr: { state: 'unknown', number: null } }],
        },
      },
      'issues 7 --preflight-only',
      [{ kind: 'live-runs-failed', message: 'pull request state unknown for ship/epic-9' }],
    ],
    [
      'a scout that returned nothing',
      { scout: null },
      'issues 7 --preflight-only',
      [{ kind: 'scout-unavailable', message: 'no scout verdict for #7' }],
    ],
    [
      'a code overlap, even in exclude mode',
      {
        scout: {
          issues: [{ issue: 7, stale: false, evidence: 'fresh' }],
          overlaps: [
            {
              issue: 7,
              branch: 'ship/epic-9',
              files: ['src/a.ts'],
              evidence: 'both edit src/a.ts',
            },
          ],
        },
      },
      'issues 7 --exclude --preflight-only',
      [{ kind: 'overlap', issue: 7, message: 'ship/epic-9: both edit src/a.ts' }],
    ],
    [
      'exclude mode dropping every issue',
      { scout: { issues: [{ issue: 7, stale: true, evidence: 'done in abc123' }], overlaps: [] } },
      'issues 7 --exclude --preflight-only',
      [{ kind: 'empty-run-set', message: 'no issue is left after the stale drops' }],
    ],
  ])('refuses %s', async (_name, responses, args, refusals) => {
    const run = fakeHooks(responses);

    const report = await runShip(run.hooks, args);

    expect(report.status).toBe('refused');
    expect(report.refusals).toEqual(refusals);
  });

  it('refuses a gate with no verdict, and skips the scout for want of a run set', async () => {
    const run = fakeHooks({
      'runner:run-gate': { exitCode: 2, envelopePath: 'g', stderrTail: 'run-gate: schema error' },
    });

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(report.refusals).toEqual([{ kind: 'gate-error', message: 'run-gate: schema error' }]);
    expect(run.calls.map((c) => c.label)).not.toContain('scout');
  });

  it('shows the scout only the unspent live runs', async () => {
    const run = fakeHooks({
      'runner:live-runs': {
        ...LIVE_RUNS_NONE,
        runs: [
          {
            branch: 'ship/epic-8',
            landed: ['src/old.ts'],
            pr: { state: 'merged', number: 3 },
            spent: true,
          },
          { ...OTHER_RUN, pr: { state: 'open', number: 4 } },
        ],
      },
    });

    await runShip(run.hooks, 'issues 7 --preflight-only');

    const scoutPrompt = run.calls.find((c) => c.label === 'scout')?.prompt ?? '';
    expect(scoutPrompt).toContain('#7');
    expect(scoutPrompt).toContain('"branch":"ship/epic-9","landed":["src/a.ts"]');
    expect(scoutPrompt).not.toContain('ship/epic-8');
  });

  it('reports the gate’s exclude-mode drops with their reasons', async () => {
    const run = fakeHooks({
      'runner:run-gate': {
        ...GATE_OK,
        failures: [{ kind: 'missing-label', issue: 8, message: '#8 lacks ready-for-agent' }],
        excluded: [
          { issue: 8, cause: 'failed' },
          { issue: 9, cause: 'dependent', blockers: [8] },
        ],
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8 9 --exclude --preflight-only');

    expect(report.dropped).toEqual([
      { issue: 8, cause: 'gate', message: '#8 lacks ready-for-agent' },
      { issue: 9, cause: 'dependent', message: 'blocked by dropped #8' },
    ]);
  });
});

describe('runShip — exclude mode', () => {
  it('drops the stale issue and its dependent, keeping the rest of the graph', async () => {
    const run = fakeHooks(SEVEN_STALE_BLOCKS_EIGHT);

    const report = await runShip(run.hooks, 'issues 7,8 #9 --exclude --preflight-only');

    expect(report).toEqual({
      status: 'preflight-ok',
      graph: { runSet: [{ epic: null, issues: [9] }], edges: [] },
      dropped: [
        { issue: 7, cause: 'stale', message: 'already implemented at abc123' },
        { issue: 8, cause: 'dependent', message: 'blocked by a stale issue' },
      ],
      epics: [],
    });
    expect(run.calls[1]?.argv).toEqual([
      'tooling/run-gate.ts',
      'issues',
      '7',
      '8',
      '9',
      '--exclude',
    ]);
  });
});

describe('agent-call tiers', () => {
  it('holds the planned tier per stage', () => {
    expect(STAGES).toEqual({
      runner: { agentType: 'runner', model: 'sonnet', effort: 'low' },
      scout: { agentType: 'scout' },
    });
  });

  it.each(SCENARIOS)(
    'gives every agent call of the $name run its STAGES row',
    async ({ responses, args }) => {
      const run = fakeHooks(responses);

      await runShip(run.hooks, args);

      expect(run.calls.length).toBeGreaterThan(0);
      for (const call of run.calls) {
        const stage = call.label.split(':')[0] ?? '';
        expect(Object.keys(STAGES)).toContain(stage);
        const row: StageRow = STAGES[stage as StageName];
        expect({ agentType: call.agentType, model: call.model, effort: call.effort }).toEqual({
          agentType: row.agentType,
          model: row.model,
          effort: row.effort,
        });
      }
    },
  );
});
