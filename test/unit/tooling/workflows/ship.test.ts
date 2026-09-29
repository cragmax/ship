import { describe, expect, it } from 'vitest';

import {
  reviewEffort,
  STAGES,
  type StageName,
  type StageRow,
} from '../../../../tooling/workflows/lib/stages.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  fakeHooks,
  GATE_OK,
  inTurn,
  LAND_OK,
  LIVE_RUNS_NONE,
  PLAN_CARD,
  PREFLIGHT_OK,
  REPORT_DIR,
  TDD_FILES,
  type FakeRun,
} from './_fake-hooks.js';

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

const LAND_CONFLICT = {
  ...LAND_OK,
  status: 'conflict',
  commit: null,
  conflicts: ['tooling/x.ts'],
  rolledBack: true,
  errors: [{ step: 'cherry-pick', message: 'tooling/x.ts would not apply' }],
};

const LAND_BATCH_DIRTY = {
  ...LAND_OK,
  status: 'refused',
  reason: 'batch-dirty',
  commit: null,
  batchClean: false,
  errors: [{ step: 'preconditions', message: 'the batch has uncommitted changes' }],
};

const PLANNER_STALE = {
  planner: { ...PLAN_CARD, verdict: 'stale', evidence: 'x already exists at abc123' },
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
  {
    name: 'land conflict',
    responses: { 'runner:land': inTurn(LAND_CONFLICT, LAND_OK) },
    args: 'issues 7',
  },
  { name: 'land batch-dirty', responses: { 'runner:land': LAND_BATCH_DIRTY }, args: 'issues 7' },
  { name: 'stale plan', responses: PLANNER_STALE, args: 'issues 7' },
  { name: 'dead tdd', responses: { tdd: null }, args: 'issues 7' },
];

const EPIC_END_COMMAND = /^runner:(server-tier|sync-master|bump|publish)/;

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
});

describe('runShip — one issue from launch to PR', () => {
  it('runs the chain through test review before one land, tears the slice down before committed, then the epic end', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7');

    expect(run.calls.map((c) => c.label)).toEqual([
      'runner:preflight',
      'runner:run-gate',
      'runner:live-runs',
      'scout',
      'runner:cut-batch:list',
      'runner:provision-batch:list',
      'runner:check:7-1',
      'runner:cut-slice:7-1',
      'runner:provision:7-1',
      'planner:7-1',
      'planReviewer:7-1',
      'tdd:7-1',
      'reviewer:7-1',
      'testReview:7-1',
      'runner:land:7-1',
      'runner:teardown:7-1',
      'runner:server-tier:paper',
      'runner:server-tier:folia',
      'runner:sync-master:list',
      'runner:bump:list',
      'runner:publish:list',
      'runner:preflight:list',
    ]);
    const at = (entry: string): number => run.timeline.indexOf(entry);
    expect(at('call runner:teardown:7-1')).toBeGreaterThan(-1);
    expect(at('call runner:teardown:7-1')).toBeLessThan(at('log fed committed #7'));
    expect(run.phases).toEqual(['Pre-flight', 'Issues', 'Epic end']);
    expect(report).toMatchObject({
      status: 'done',
      dropped: [],
      epics: [
        {
          epic: null,
          branch: 'ship/7',
          outcome: 'pr',
          pr: 42,
          mainUntouched: true,
          issues: [{ issue: 7, outcome: 'landed', cite: 'fixes', commit: 'landed1' }],
        },
      ],
    });
  });

  it('hands each command its paths from the envelopes before it', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const argvOf = (label: string): readonly string[] =>
      run.calls.find((c) => c.label === label)?.argv ?? [];
    expect(argvOf('runner:cut-batch:list')).toEqual([
      'tooling/worktree.ts',
      'cut-batch',
      '.',
      '--issues',
      '7',
    ]);
    expect(argvOf('runner:cut-slice:7-1')).toEqual([
      'tooling/worktree.ts',
      'cut-slice',
      BATCH,
      '--issue',
      '7',
      '--attempt',
      '1',
    ]);
    expect(argvOf('runner:provision:7-1')).toEqual([
      'tooling/worktree.ts',
      'provision',
      'C:/src/ph-runs/7/slice-7-1',
      '--batch',
      BATCH,
      '--server',
    ]);
    expect(argvOf('runner:land:7-1')).toEqual([
      'tooling/worktree.ts',
      'land',
      BATCH,
      'slice1',
      '--base',
      'cut1',
      '--message-file',
      `${REPORT_DIR}/commit-7-1.txt`,
      '--log',
      `${REPORT_DIR}/land-7-1.log`,
    ]);
    expect(argvOf('runner:publish:list')).toEqual([
      'tooling/worktree.ts',
      'publish',
      BATCH,
      '--title',
      'feat(build): add the x tool',
      '--body-file',
      `${REPORT_DIR}/pr-body.md`,
      '--log',
      `${REPORT_DIR}/publish.log`,
    ]);
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

/**
 * The recorded labels, in call order.
 *
 * @param run - The fake run.
 * @returns Each call's label.
 */
const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

/**
 * Where an entry sits on the timeline.
 *
 * @param run - The fake run.
 * @param entry - `call <label>` or `log <message>`.
 * @returns Its first index; fails the test when absent.
 */
const when = (run: FakeRun, entry: string): number => {
  const at = run.timeline.indexOf(entry);
  expect(at, `${entry} on the timeline`).toBeGreaterThan(-1);
  return at;
};

describe('runShip — an attempt that does not land', () => {
  it('re-cuts attempt 2 and plans again after a land conflict, tearing attempt 1 down first', async () => {
    const run = fakeHooks({ 'runner:land': inTurn(LAND_CONFLICT, LAND_OK) });

    const report = await runShip(run.hooks, 'issues 7');

    expect(when(run, 'call runner:land:7-1')).toBeLessThan(when(run, 'call runner:teardown:7-1'));
    expect(when(run, 'call runner:teardown:7-1')).toBeLessThan(
      when(run, 'log fed harvest-conflict #7'),
    );
    expect(when(run, 'log fed harvest-conflict #7')).toBeLessThan(
      when(run, 'call runner:cut-slice:7-2'),
    );
    expect(run.calls.find((c) => c.label === 'runner:cut-slice:7-2')?.argv).toEqual([
      'tooling/worktree.ts',
      'cut-slice',
      BATCH,
      '--issue',
      '7',
      '--attempt',
      '2',
    ]);
    expect(labels(run)).toContain('planner:7-2');
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      issues: [{ issue: 7, outcome: 'landed', cite: 'fixes' }],
    });
  });

  it('halts the epic on a land batch-dirty: teardown, epic-halt then blocked, no epic end, the issue cited see', async () => {
    const run = fakeHooks({ 'runner:land': LAND_BATCH_DIRTY });

    const report = await runShip(run.hooks, 'issues 7');

    expect(when(run, 'call runner:teardown:7-1')).toBeLessThan(
      when(run, 'log fed epic-halt the issue list'),
    );
    expect(when(run, 'log fed epic-halt the issue list')).toBeLessThan(
      when(run, 'log fed blocked #7'),
    );
    expect(labels(run).filter((l) => EPIC_END_COMMAND.test(l))).toEqual([]);
    expect(labels(run).filter((l) => l.startsWith('runner:land'))).toEqual(['runner:land:7-1']);
    expect(report.epics).toEqual([
      {
        epic: null,
        branch: 'ship/7',
        outcome: 'halted',
        issues: [
          {
            issue: 7,
            outcome: 'halted',
            cite: 'see',
            reason: expect.stringMatching(/batch-dirty/),
          },
        ],
        residue: [],
      },
    ]);
  });

  it('tears the slice down before feeding blocked for a stale plan, landing nothing', async () => {
    const run = fakeHooks(PLANNER_STALE);

    const report = await runShip(run.hooks, 'issues 7');

    expect(when(run, 'call runner:teardown:7-1')).toBeLessThan(when(run, 'log fed blocked #7'));
    expect(labels(run).filter((l) => /^(tdd|runner:land)/.test(l))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      issues: [
        { issue: 7, outcome: 'blocked', cite: 'see', reason: expect.stringMatching(/stale/) },
      ],
    });
  });

  it('blocks the issue when the tdd returns nothing twice, each slice torn down, and ends nothing-landed', async () => {
    const run = fakeHooks({ tdd: null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^(tdd|runner:teardown)/.test(l))).toEqual([
      'tdd:7-1',
      'runner:teardown:7-1',
      'tdd:7-2',
      'runner:teardown:7-2',
    ]);
    expect(labels(run).filter((l) => EPIC_END_COMMAND.test(l))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      issues: [{ issue: 7, outcome: 'blocked', cite: 'see' }],
    });
  });

  it('records a teardown that threw as residue and still lands the issue', async () => {
    const run = fakeHooks({
      'runner:teardown': () => {
        throw new Error('runner crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      issues: [{ issue: 7, outcome: 'landed' }],
      residue: ['the runner returned nothing for teardown'],
    });
  });

  it('reports an epic end whose call threw as stopped, never rejecting the run', async () => {
    const run = fakeHooks({
      'runner:bump': () => {
        throw new Error('runner crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:publish'))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: 'the epic end threw: runner crashed',
      issues: [{ issue: 7, outcome: 'landed' }],
    });
  });

  it('stops the epic end on a code conflict: no bump, no push', async () => {
    const run = fakeHooks({
      'runner:sync-master': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'code-conflict',
        errors: [{ step: 'merge', message: 'src/a.ts conflicts' }],
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^runner:(bump|publish)/.test(l))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: expect.stringMatching(/code-conflict/),
    });
  });
});

describe('runShip — a failed cut', () => {
  // A cross-entry edge (the gate refuses one; the drop must still hold) lets
  // the failed cut of epic 1 drop #2 from epic 2.
  const failedCut = (epicTwo: readonly number[]): FakeRun =>
    fakeHooks({
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [
          { epic: 1, issues: [1] },
          { epic: 2, issues: epicTwo },
        ],
        edges: [{ blocker: 1, dependent: 2 }],
      },
      scout: {
        issues: [1, ...epicTwo].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
        overlaps: [],
      },
      'runner:cut-batch:epic-1': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'worktree', message: 'worktree add failed' }],
      },
    });

  it('reports an entry the drop emptied nothing-landed, driving nothing', async () => {
    const run = failedCut([2]);

    const report = await runShip(run.hooks, 'epics 1 2');

    expect(labels(run).filter((l) => l.startsWith('runner:check'))).toEqual([]);
    expect(report.epics).toMatchObject([
      { epic: 1, outcome: 'stopped' },
      {
        epic: 2,
        outcome: 'nothing-landed',
        issues: [{ issue: 2, outcome: 'skipped', cite: 'see' }],
      },
    ]);
  });

  it('drives the surviving entry by its epic key and cites the dropped dependent see', async () => {
    const run = failedCut([2, 3]);

    const report = await runShip(run.hooks, 'epics 1 2');

    expect(labels(run).filter((l) => l.startsWith('runner:check'))).toEqual(['runner:check:3-1']);
    expect(report.epics).toMatchObject([
      { epic: 1, outcome: 'stopped', issues: [{ issue: 1, outcome: 'blocked', cite: 'see' }] },
      {
        epic: 2,
        outcome: 'pr',
        issues: [
          { issue: 2, outcome: 'skipped', cite: 'see' },
          { issue: 3, outcome: 'landed' },
        ],
      },
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
      planner: { agentType: 'planner' },
      applier: { agentType: 'planner' },
      planReviewer: { agentType: 'ship-plan-reviewer' },
      tdd: { agentType: 'ship-tdd', model: 'opus' },
      reviewer: { agentType: 'reviewer', model: 'opus' },
      resolver: { agentType: 'reviewer', model: 'opus' },
      testReview: { agentType: 'ship-test-review', model: 'opus' },
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
        // The reviewer's effort is per slice; every fake tdd commits TDD_FILES.
        const effort = stage === 'reviewer' ? reviewEffort(TDD_FILES) : row.effort;
        expect({ agentType: call.agentType, model: call.model, effort: call.effort }).toEqual({
          agentType: row.agentType,
          model: row.model,
          effort,
        });
      }
    },
  );
});
