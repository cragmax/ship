import { describe, expect, it } from 'vitest';

import { createCommitQueue } from '../../../../tooling/workflows/lib/commit-queue.js';
import { runAttempt } from '../../../../tooling/workflows/lib/slice-chain.js';
import {
  reviewEffort,
  STAGES,
  type StageName,
  type StageRow,
} from '../../../../tooling/workflows/lib/stages.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  DIFF_REVIEW_OK,
  fakeHooks,
  GATE_OK,
  inTurn,
  LAND_OK,
  LIVE_RUNS_NONE,
  liveRuns,
  PLAN_CARD,
  PREFLIGHT_OK,
  REPORT_DIR,
  TDD_FILES,
  TDD_GREEN,
  type FakeRun,
} from './_fake-hooks.js';
import { epicRun, holdable, idle } from './_fake-parallel.js';

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

const TEARDOWN_SHRANK = {
  exitCode: 1,
  envelopePath: 'e.json',
  status: 'refused',
  reason: 'source-shrank',
  removed: false,
  registered: true,
  errors: [{ step: 'gate', message: 'node_modules lost 40 entries' }],
};

const PLANNER_STALE = {
  planner: { ...PLAN_CARD, verdict: 'stale', evidence: 'x already exists at abc123' },
};

const ADR_INDEX = 'docs/adr/readme.md';

// The two `sync-master` envelopes the CLI's own tests pin for a doc-index
// conflict: the start stops for a resolver, `--continue` commits the merge.
const DOC_INDEX_CONFLICT = {
  'runner:sync-master:list': {
    exitCode: 1,
    envelopePath: 'e.json',
    status: 'conflict',
    outcome: 'needs-resolution',
    commit: null,
    upstream: null,
    conflicts: [{ path: ADR_INDEX, kind: 'doc-index', landedBy: ['docs: theirs'] }],
    version: null,
    pending: [ADR_INDEX],
    errors: [],
  },
  resolver: { verdict: 'resolved', summary: 'kept both rows' },
  'runner:sync-master:list-continue': {
    exitCode: 0,
    envelopePath: 'e.json',
    status: 'ok',
    outcome: 'merged',
    commit: 'merge1',
    upstream: 'origin1',
    conflicts: [],
    version: null,
    pending: [],
    errors: [],
  },
};

const PLAN_REVIEW_FINDINGS = {
  planReviewer: {
    verdict: 'changes',
    findings: 2,
    findingsPath: `${REPORT_DIR}/plan-review-7-1.md`,
  },
  applier: {
    ...PLAN_CARD,
    summary: 'add the x tool, reviewed',
    commit: { ...PLAN_CARD.commit, subject: 'add the reviewed x tool' },
  },
};

// Two issues bring in the overlap estimator (one pair), an applied critic and a retro finding.
const TWO_ISSUES = {
  'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
  scout: {
    issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
    overlaps: [],
  },
  overlapEstimator: {
    issues: [{ number: 7, columns: ['tooling'], paths: ['tooling/x.ts'] }],
    pairs: [{ a: 7, b: 8, confidence: 'likely', shared: ['tooling/x.ts'], reason: 'both edit x' }],
    areaMap: 'read',
  },
  critic: {
    outcome: 'applied',
    sha: 'critic1',
    files: ['tooling/x.ts'],
    commit: { type: 'refactor', scope: 'build', subject: 'share x' },
    findings: [{ lens: 'duplication', summary: 'two x helpers', applied: true }],
    checks: 'build, eslint, vitest related, prettier',
  },
  retro: {
    findings: [{ title: 't', evidence: 'e', kind: 'genuine', suggestion: 's' }],
  },
};

/** The runs the tier check drives. */
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
  { name: 'plan-review findings', responses: PLAN_REVIEW_FINDINGS, args: 'issues 7' },
  { name: 'doc-index conflict', responses: DOC_INDEX_CONFLICT, args: 'issues 7' },
  { name: 'two issues', responses: TWO_ISSUES, args: 'issues 7 8' },
  {
    name: 'two epics',
    responses: epicRun([
      { epic: 1, issues: [1, 2] },
      { epic: 2, issues: [3] },
    ]),
    args: 'epics 1 2',
  },
];

const EPIC_END_COMMAND = /^runner:(sync-master|bump|publish)/;

const isCutOrLand = (c: { label: string; argv: readonly string[] }): boolean =>
  /cut-batch|provision|land/.test(`${c.label} ${c.argv.join(' ')}`);

describe('runShip — pre-flight only', () => {
  it('returns preflight-ok with the run graph after the five pre-flight calls, before any cut-batch', async () => {
    const run = fakeHooks(EPIC_FRESH);

    const report = await runShip(run.hooks, 'epics 1025 --preflight-only');

    expect(report).toEqual({
      status: 'preflight-ok',
      graph: EPIC_GRAPH,
      overlap: { added: [], sequenced: [], areaMap: 'read' },
      dropped: [],
      epics: [],
    });
    expect(run.calls.map((c) => c.label)).toEqual([
      'runner:preflight',
      'runner:run-gate',
      'runner:live-runs',
      'scout',
      'overlapEstimator',
    ]);
    expect(run.calls.map((c) => c.argv)).toEqual([
      ['tooling/worktree.ts', 'preflight', '.', '--slug', 'epic-1025'],
      ['tooling/run-gate.ts', 'epics', '1025'],
      ['tooling/worktree.ts', 'live-runs', '.'],
      [],
      [],
    ]);
    expect(run.phases).toEqual(['Pre-flight']);
  });

  it.each([
    {
      args: 'issues 9 7 8 --preflight-only',
      slugs: '7-8-9',
      argv: ['tooling/worktree.ts', 'preflight', '.', '--slug', '7-8-9'],
    },
    {
      args: 'epics 1025 1030 --preflight-only',
      slugs: 'epic-1025,epic-1030',
      argv: ['tooling/worktree.ts', 'preflight', '.', '--slug', 'epic-1025,epic-1030'],
    },
  ])('passes --slug $slugs for $args', async ({ args, argv }) => {
    const run = fakeHooks();

    await runShip(run.hooks, args);

    expect(run.calls.find((c) => c.label === 'runner:preflight')?.argv).toEqual(argv);
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

const STALE_7 = {
  check: 'stale-slice-branch',
  message: 'slice/7/1212-1 is left over from a run of ship/7',
};

const STALE_PREFLIGHT = {
  ...PREFLIGHT_OK,
  exitCode: 1,
  status: 'refused',
  reason: 'preflight-failed',
  problems: [STALE_7],
};

describe('runShip — leftover slice branches', () => {
  it('refuses a stale-slice-branch problem though the scout finds #7 fresh, cutting nothing', async () => {
    const run = fakeHooks({ 'runner:preflight': STALE_PREFLIGHT });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.status).toBe('refused');
    expect(report.refusals).toEqual([{ kind: 'stale-slice-branch', message: STALE_7.message }]);
    expect(run.calls.map((c) => c.label)).toContain('scout');
    expect(run.calls.filter(isCutOrLand)).toEqual([]);
  });

  it.each([
    { name: 'a spent run of a longer slug', live: { branch: 'ship/77' } },
    {
      name: 'an open run of the same slug',
      live: { branch: 'ship/7', spent: false, pr: { state: 'open', number: 100 } },
    },
  ])('still refuses for $name', async ({ live }) => {
    const run = fakeHooks({ 'runner:preflight': STALE_PREFLIGHT, ...liveRuns(live) });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.refusals).toEqual([{ kind: 'stale-slice-branch', message: STALE_7.message }]);
    expect(run.calls.map((c) => c.label)).not.toContain('runner:teardown:spent-1');
  });

  it('still refuses a slice branch of ship/77 beside a spent ship/7', async () => {
    const stale77 = {
      check: 'stale-slice-branch',
      message: 'slice/77/1-1 is left over from a run of ship/77',
    };
    const run = fakeHooks({
      'runner:preflight': { ...STALE_PREFLIGHT, problems: [stale77] },
      ...liveRuns({ branch: 'ship/7' }),
    });

    const report = await runShip(run.hooks, 'issues 77 --preflight-only');

    expect(report.refusals).toEqual([{ kind: 'stale-slice-branch', message: stale77.message }]);
  });

  it('drops the problem of a spent ship/7 and retires that run before cutting', async () => {
    const run = fakeHooks({
      'runner:preflight': STALE_PREFLIGHT,
      ...liveRuns({ branch: 'ship/7' }),
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.status).toBe('done');
    expect(report.refusals).toBeUndefined();
    expect(report.cleanup).toEqual({
      tornDown: ['C:/src/ph-runs/old-0/batch'],
      retired: ['ship/7'],
      skipped: [],
      residue: [],
      blocked: null,
      stop: null,
    });
    expect(report.epics[0]?.mainUntouched).toBe(true);
  });

  it('keeps master-ahead when it drops the spent run’s problem', async () => {
    const run = fakeHooks({
      'runner:preflight': {
        ...STALE_PREFLIGHT,
        problems: [{ check: 'master-ahead', message: 'local master is 2 commits ahead' }, STALE_7],
      },
      ...liveRuns({ branch: 'ship/7' }),
    });

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(report.refusals).toEqual([
      { kind: 'master-ahead', message: 'local master is 2 commits ahead' },
    ]);
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
      'diffReview:7-1',
      'reviewer:7-1',
      'testReview:7-1',
      'runner:land:7-1',
      'runner:teardown:7-1',
      'runner:sync-master:list',
      'runner:bump:list',
      'retro:list',
      'prWriter:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
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
          masterCheck: {
            passed: true,
            local: { launch: 'local0', current: 'local0', move: 'equal' },
            remote: { launch: 'origin0', current: 'origin0', move: 'equal' },
          },
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
    const shaSeenBy = (label: string): string | undefined =>
      run.calls
        .find((c) => c.label === label)
        ?.prompt.split('\n')
        .find((l) => l.startsWith('Slice commit: '));
    // Each amend moves the slice commit: review sees the tdd's, test review the reviewer's.
    expect(shaSeenBy('reviewer:7-1')).toBe('Slice commit: slice1');
    expect(shaSeenBy('testReview:7-1')).toBe('Slice commit: slice2');
    expect(argvOf('runner:land:7-1')).toEqual([
      'tooling/worktree.ts',
      'land',
      BATCH,
      'slice3',
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
  const OTHER_RUN = {
    branch: 'ship/epic-9',
    landed: ['src/a.ts'],
    spent: false,
    path: 'C:/src/ph-runs/epic-9/batch',
    dirty: false,
    nested: [],
    spentUnverified: false,
  };

  const refuses = async (run: FakeRun, args: string, refusals: unknown): Promise<void> => {
    const report = await runShip(run.hooks, args);

    expect(report.status).toBe('refused');
    expect(report.refusals).toEqual(refusals);
  };

  it.each([
    [
      'a runner that returned nothing',
      { 'runner:preflight': null },
      'issues 7 --preflight-only',
      [{ kind: 'preflight-error', message: 'the runner returned nothing for preflight' }],
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
    await refuses(fakeHooks(responses), args, refusals);
  });

  it.each([
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
  ])('refuses %s', async (_name, responses, args, refusals) => {
    await refuses(fakeHooks(responses, { offSchema: true }), args, refusals);
  });

  it('refuses a gate with no verdict, and skips the scout for want of a run set', async () => {
    const run = fakeHooks(
      {
        'runner:run-gate': { exitCode: 2, envelopePath: 'g', stderrTail: 'run-gate: schema error' },
      },
      { offSchema: true },
    );

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
            path: 'C:/src/ph-runs/epic-8/batch',
            dirty: false,
            nested: [],
            spentUnverified: false,
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

/**
 * The prompt of a recorded call.
 *
 * @param run - The fake run.
 * @param label - The call's label.
 * @returns Its prompt; fails the test when there is no such call.
 */
const promptOf = (run: FakeRun, label: string): string => {
  const call = run.calls.find((c) => c.label === label);
  expect(call, `a ${label} call`).toBeDefined();
  return call?.prompt ?? '';
};

/** A closing keyword before `#7`, as GitHub reads one. */
const CLOSES_SEVEN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[\s:]*#7\b/i;

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
        schedule: [
          {
            issue: 7,
            blockers: [],
            attempts: 1,
            startedAt: '2026-09-29T10:00:00.000Z',
            committedAt: null,
            size: null,
          },
        ],
        residue: [],
        retro: [],
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

  describe('a blocked issue hears why', () => {
    const COMMENT_FILE = `${REPORT_DIR}/issue-comment-7.md`;

    it('posts the reason on the issue from the main checkout, the comment written first, after the slice is torn down', async () => {
      const run = fakeHooks(PLANNER_STALE);

      const report = await runShip(run.hooks, 'issues 7');

      const call = run.calls.find((c) => c.label === 'runner:post-issue-comment:7');
      expect(call?.argv).toEqual([
        'tooling/worktree.ts',
        'post-issue-comment',
        'C:/src/main',
        '--issue',
        '7',
        '--comment-file',
        COMMENT_FILE,
      ]);
      expect(when(run, 'call runner:teardown:7-1')).toBeLessThan(
        when(run, 'call runner:post-issue-comment:7'),
      );
      const lines = call?.prompt.split('\n') ?? [];
      const from = lines.indexOf(`Write first: ${COMMENT_FILE}`);
      expect(lines.slice(from, from + 8)).toEqual([
        `Write first: ${COMMENT_FILE}`,
        '----- BEGIN FILE -----',
        '> *Posted by an unattended `/ship` run. It changed nothing on this issue; the labels stand.*',
        '',
        '**Not landed: blocked.** planner stale: x already exists at abc123',
        '',
        `Run: branch \`ship/7\`, no pull request. Report dir: \`${REPORT_DIR}\`.`,
        '----- END FILE -----',
      ]);
      expect(report.epics[0]).toMatchObject({
        outcome: 'nothing-landed',
        issueComments: [{ issue: 7, url: 'https://x/issues/7#issuecomment-2' }],
      });
    });

    it('names the PR when the run opened one, on the shipping path', async () => {
      const run = fakeHooks({
        ...TWO_ISSUES,
        'planner:8-1': { ...PLAN_CARD, verdict: 'stale', evidence: 'done at abc123' },
      });

      const report = await runShip(run.hooks, 'issues 7 8');

      const posted = run.calls.find((c) => c.label === 'runner:post-issue-comment:8')?.prompt ?? '';
      expect(report.epics[0]?.outcome).toBe('pr');
      expect(posted).toContain(`Run: PR #${String(report.epics[0]?.pr)}. Report dir:`);
      expect(report.epics[0]?.issueComments).toEqual([
        { issue: 8, url: 'https://x/issues/7#issuecomment-2' },
      ]);
      expect(labels(run).filter((l) => l.startsWith('runner:post-issue-comment'))).toEqual([
        'runner:post-issue-comment:8',
      ]);
    });

    it.each([
      [
        'a failed post',
        {
          exitCode: 1,
          envelopePath: 'e.json',
          status: 'failed',
          url: null,
          errors: [{ step: 'issue-comment', message: 'gh issue comment 7 exited 1' }],
        },
        'post-issue-comment failed: gh issue comment 7 exited 1',
      ],
      [
        'a runner that returned nothing',
        null,
        'the runner returned nothing for post-issue-comment',
      ],
      [
        'an ok post without a url',
        { ...LAND_OK, url: null },
        'post-issue-comment ok without a url',
      ],
    ])(
      'records %s as the comment’s problem and still ends the entry',
      async (_name, answer, problem) => {
        const run = fakeHooks({ ...PLANNER_STALE, 'runner:post-issue-comment': answer });

        const report = await runShip(run.hooks, 'issues 7');

        expect(report.epics[0]).toMatchObject({
          outcome: 'nothing-landed',
          issueComments: [{ issue: 7, url: null, problem: expect.stringContaining(problem) }],
        });
      },
    );

    it('comments on no issue, and reports no comments, when every issue landed', async () => {
      const run = fakeHooks();

      const report = await runShip(run.hooks, 'issues 7');

      expect(labels(run).filter((l) => l.startsWith('runner:post-issue-comment'))).toEqual([]);
      expect(report.epics[0]).not.toHaveProperty('issueComments');
    });
  });

  it('blocks the issue when the tdd returns nothing twice, each slice torn down, and ends nothing-landed', async () => {
    const run = fakeHooks({ tdd: null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^(tdd|runner:teardown):\d/.test(l))).toEqual([
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

  it('retries the issue when the diff reviewer returns nothing, never calling the reviewer, then blocks it', async () => {
    const run = fakeHooks({ diffReview: null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^(diffReview|reviewer|runner:teardown):\d/.test(l))).toEqual([
      'diffReview:7-1',
      'runner:teardown:7-1',
      'diffReview:7-2',
      'runner:teardown:7-2',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      issues: [
        { issue: 7, outcome: 'blocked', cite: 'see', reason: 'its agent died on the retry too' },
      ],
    });
  });

  it('blocks the issue, with no retry and no reviewer call, when the diff review call throws', async () => {
    const run = fakeHooks({
      diffReview: () => {
        throw new Error('runtime crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^(diffReview|reviewer|runner:teardown):\d/.test(l))).toEqual([
      'diffReview:7-1',
      'runner:teardown:7-1',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      issues: [
        { issue: 7, outcome: 'blocked', cite: 'see', reason: 'a stage threw: runtime crashed' },
      ],
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
        outcome: null,
        commit: null,
        upstream: null,
        conflicts: [],
        version: null,
        pending: [],
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

const SLICE_7 = 'C:/src/ph-runs/7/slice-7-1';
const CUT_FAILED = {
  exitCode: 1,
  envelopePath: 'e.json',
  status: 'failed',
  branch: 'slice/7/7-1',
  base: null,
  slice: SLICE_7,
  at: '2026-09-29T10:00:00.000Z',
  errors: [{ step: 'worktree', message: 'worktree add failed' }],
};
const UP_TO_PLAN = [
  'runner:check:7-1',
  'runner:cut-slice:7-1',
  'runner:provision:7-1',
  'planner:7-1',
];
const BUILD_CALL =
  /^(runner:(check|cut-slice|provision|teardown|land)|planner|planReviewer|applier|tdd|diffReview):\d/;
const BUILD_ENDINGS: [
  string,
  Readonly<Record<string, unknown>>,
  string[],
  Readonly<Record<string, unknown>>,
][] = [
  [
    'not ready at the re-check',
    {
      'runner:check': { exitCode: 1, envelopePath: 'e.json', issue: 7, ready: false, failures: [] },
    },
    ['runner:check:7-1'],
    { outcome: 'removed', reason: 'no longer open and ready-for-agent' },
  ],
  [
    'blocked by a failed cut that named its slice',
    { 'runner:cut-slice': CUT_FAILED },
    ['runner:check:7-1', 'runner:cut-slice:7-1', 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'cut-slice failed: worktree add failed' },
  ],
  [
    'blocked by a failed cut that named no slice',
    { 'runner:cut-slice': { ...CUT_FAILED, slice: null } },
    ['runner:check:7-1', 'runner:cut-slice:7-1'],
    { outcome: 'blocked', reason: 'cut-slice failed: worktree add failed' },
  ],
  [
    'blocked by a failed provision',
    {
      'runner:provision': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'install', message: 'npm ci failed' }],
        env: { PH_PROJECT_DIR: BATCH },
      },
    },
    ['runner:check:7-1', 'runner:cut-slice:7-1', 'runner:provision:7-1', 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'provision failed: npm ci failed' },
  ],
  [
    'blocked by the planner',
    { planner: { ...PLAN_CARD, verdict: 'blocked', evidence: 'needs a human answer' } },
    [...UP_TO_PLAN, 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'planner blocked: needs a human answer' },
  ],
  [
    'stale by the applier',
    {
      ...PLAN_REVIEW_FINDINGS,
      applier: { ...PLAN_CARD, verdict: 'stale', evidence: 'done at abc123' },
    },
    [...UP_TO_PLAN, 'planReviewer:7-1', 'applier:7-1', 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'planner stale: done at abc123' },
  ],
  [
    'blocked by the tdd',
    {
      tdd: { ...TDD_GREEN, verdict: 'BLOCKED', sha: '', reason: 'the plan names a missing symbol' },
    },
    [...UP_TO_PLAN, 'planReviewer:7-1', 'tdd:7-1', 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'tdd BLOCKED: the plan names a missing symbol' },
  ],
  [
    'blocked by a tdd that committed nothing',
    { tdd: { ...TDD_GREEN, sha: '' } },
    [...UP_TO_PLAN, 'planReviewer:7-1', 'tdd:7-1', 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'tdd GREEN: no commit' },
  ],
  [
    'blocked by a planner that threw',
    {
      planner: () => {
        throw new Error('runtime crashed');
      },
    },
    [...UP_TO_PLAN, 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'a stage threw: runtime crashed' },
  ],
];

describe('runShip — an attempt through the build', () => {
  it.each(BUILD_ENDINGS)(
    'ends the attempt %s, tearing down only a slice the cut named',
    async (_name, responses, calls, ending) => {
      const run = fakeHooks(responses);

      const report = await runShip(run.hooks, 'issues 7');

      expect(labels(run).filter((l) => BUILD_CALL.test(l))).toEqual(calls);
      expect(report.epics[0]).toMatchObject({
        outcome: 'nothing-landed',
        issues: [{ issue: 7, cite: 'see', ...ending }],
      });
    },
  );

  it('retries the issue in a fresh slice when the plan reviewer returns nothing, then blocks it', async () => {
    const run = fakeHooks({ planReviewer: null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(runner:(cut-slice|teardown)|planReviewer|tdd):\d/.test(l)),
    ).toEqual([
      'runner:cut-slice:7-1',
      'planReviewer:7-1',
      'runner:teardown:7-1',
      'runner:cut-slice:7-2',
      'planReviewer:7-2',
      'runner:teardown:7-2',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      issues: [
        { issue: 7, outcome: 'blocked', cite: 'see', reason: 'its agent died on the retry too' },
      ],
      schedule: [{ issue: 7, attempts: 2 }],
    });
  });
});

const AFTER_BUILD_CALL = /^(tdd|diffReview|reviewer|testReview|runner:(land|teardown)):\d/;
const UP_TO_REVIEW = ['tdd:7-1', 'diffReview:7-1', 'reviewer:7-1'];
const UP_TO_LAND = [...UP_TO_REVIEW, 'testReview:7-1', 'runner:land:7-1'];
const AFTER_BUILD_ENDINGS: [string, Readonly<Record<string, unknown>>, string[], string][] = [
  [
    'blocked by the reviewer',
    {
      reviewer: {
        verdict: 'blocked',
        sha: '',
        summary: 'the fix needs a design call',
        leaseLines: [],
      },
    },
    [...UP_TO_REVIEW, 'runner:teardown:7-1'],
    'review: the fix needs a design call',
  ],
  [
    'blocked by a reviewer that threw',
    {
      reviewer: () => {
        throw new Error('runtime crashed');
      },
    },
    [...UP_TO_REVIEW, 'runner:teardown:7-1'],
    'a stage threw: runtime crashed',
  ],
  [
    'blocked by the test reviewer',
    {
      testReview: {
        verdict: 'blocked',
        sha: '',
        survivors: 0,
        summary: 'a test cannot be made to fail',
        leaseLines: [],
      },
    },
    [...UP_TO_REVIEW, 'testReview:7-1', 'runner:teardown:7-1'],
    'test review: a test cannot be made to fail',
  ],
  [
    'blocked by a landing refused as more than one commit',
    {
      'runner:land': {
        ...LAND_OK,
        status: 'refused',
        reason: 'slice-not-single-commit',
        commit: null,
        errors: [{ step: 'preconditions', message: 'the slice is 2 commits' }],
      },
    },
    [...UP_TO_LAND, 'runner:teardown:7-1'],
    'land refused (slice-not-single-commit): the slice is 2 commits',
  ],
  [
    'blocked by a landing whose build rolled back',
    {
      'runner:land': {
        ...LAND_OK,
        status: 'failed',
        commit: null,
        rolledBack: true,
        errors: [{ step: 'build', message: 'tsc failed' }],
      },
    },
    [...UP_TO_LAND, 'runner:teardown:7-1'],
    'land failed: tsc failed',
  ],
];

describe('runShip — an attempt after the build', () => {
  it.each(AFTER_BUILD_ENDINGS)(
    'ends the attempt %s, its slice torn down, nothing landed',
    async (_name, responses, calls, reason) => {
      const run = fakeHooks(responses);

      const report = await runShip(run.hooks, 'issues 7');

      expect(labels(run).filter((l) => AFTER_BUILD_CALL.test(l))).toEqual(calls);
      expect(report.epics[0]).toMatchObject({
        outcome: 'nothing-landed',
        issues: [{ issue: 7, outcome: 'blocked', cite: 'see', reason }],
        schedule: [
          {
            issue: 7,
            attempts: 1,
            startedAt: '2026-09-29T10:00:00.000Z',
            committedAt: null,
            size: null,
          },
        ],
      });
    },
  );

  it.each(['reviewer', 'testReview'])(
    'retries the issue in a fresh slice when the %s returns nothing, then blocks it',
    async (agent) => {
      const run = fakeHooks({ [agent]: null });

      const report = await runShip(run.hooks, 'issues 7');

      expect(
        labels(run).filter((l) =>
          new RegExp(`^(runner:(cut-slice|land|teardown)|${agent}):\\d`).test(l),
        ),
      ).toEqual([
        'runner:cut-slice:7-1',
        `${agent}:7-1`,
        'runner:teardown:7-1',
        'runner:cut-slice:7-2',
        `${agent}:7-2`,
        'runner:teardown:7-2',
      ]);
      expect(report.epics[0]).toMatchObject({
        outcome: 'nothing-landed',
        issues: [
          { issue: 7, outcome: 'blocked', cite: 'see', reason: 'its agent died on the retry too' },
        ],
        schedule: [{ issue: 7, attempts: 2, committedAt: null, size: null }],
      });
    },
  );

  it('halts the entry when the land call throws: teardown, epic-halt then blocked, the issue halted', async () => {
    const run = fakeHooks({
      'runner:land': () => {
        throw new Error('runner crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(when(run, 'call runner:land:7-1')).toBeLessThan(when(run, 'call runner:teardown:7-1'));
    expect(when(run, 'call runner:teardown:7-1')).toBeLessThan(
      when(run, 'log fed epic-halt the issue list'),
    );
    expect(when(run, 'log fed epic-halt the issue list')).toBeLessThan(
      when(run, 'log fed blocked #7'),
    );
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [{ issue: 7, outcome: 'halted', cite: 'see', reason: 'land threw: runner crashed' }],
    });
  });
});

describe('runShip — what an attempt hands on', () => {
  it.each([
    ['fixes', 'fixes #7'],
    ['see', 'see #7'],
  ] as const)(
    'writes a %s card’s closing choice into the tdd’s commit message and the run report',
    async (closes, line) => {
      const run = fakeHooks({ planner: { ...PLAN_CARD, closes } });

      const report = await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, 'tdd:7-1')).toContain(
        [
          `Commit message file: ${REPORT_DIR}/commit-7-1.txt`,
          '----- BEGIN FILE -----',
          'feat(build): add the x tool',
          '',
          line,
          '',
          'Co-Authored-By: Claude <noreply@anthropic.com>',
          '----- END FILE -----',
        ].join('\n'),
      );
      expect(report.epics[0]?.issues).toEqual([
        { issue: 7, outcome: 'landed', cite: closes, commit: 'landed1' },
      ]);
      expect(CLOSES_SEVEN.test(promptOf(run, 'runner:publish:list'))).toBe(closes === 'fixes');
    },
  );

  it('applies plan-review findings once through the applier, authoring from its card', async () => {
    const run = fakeHooks(PLAN_REVIEW_FINDINGS);

    await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^(planner|planReviewer|applier|tdd):/.test(l))).toEqual([
      'planner:7-1',
      'planReviewer:7-1',
      'applier:7-1',
      'tdd:7-1',
    ]);
    const applier = promptOf(run, 'applier:7-1');
    expect(applier).toContain('Mode: apply');
    expect(applier).toContain(`Findings file: ${REPORT_DIR}/plan-review-7-1.md`);
    expect(promptOf(run, 'tdd:7-1')).toContain('feat(build): add the reviewed x tool\n\nfixes #7');
    expect(run.calls.find((c) => c.label === 'runner:publish:list')?.argv).toContain(
      'feat(build): add the reviewed x tool',
    );
  });

  it.each(['planner:7-1', 'applier:7-1', 'reviewer:7-1', 'testReview:7-1'])(
    'hands %s the tdd’s lease recipe',
    async (label) => {
      // A provisioned project dir unlike the batch, so a recipe built from the batch shows.
      const projectDir = 'C:/src/ph-runs/7/project-7-1';
      const run = fakeHooks({
        ...PLAN_REVIEW_FINDINGS,
        'runner:provision': {
          exitCode: 0,
          envelopePath: 'e.json',
          status: 'ok',
          errors: [],
          env: { PH_PROJECT_DIR: projectDir },
        },
      });

      await runShip(run.hooks, 'issues 7');

      const tddLines = promptOf(run, 'tdd:7-1').split('\n');
      const recipe = ['Lease command: ', 'Lease version: '].map(
        (key) => tddLines.find((l) => l.startsWith(key)) ?? key,
      );
      const registry = `${REPORT_DIR}/pool-registry.batch.json`;
      expect(recipe).toEqual([
        `Lease command: PH_PROJECT_DIR=${projectDir} PH_POOL_REGISTRY=${registry} npx tsx C:/src/main/tooling/with-lease.ts --type <paper|folia> --version <version> --registry ${registry} --timeout 600000 -- npx vitest run --config vitest.worktree.integration.config.ts <files>`,
        `Lease version: the version of the chosen type's entry in ${registry}`,
      ]);
      expect(promptOf(run, label).split('\n')).toEqual(expect.arrayContaining(recipe));
    },
  );

  // Hand-written: the plan-time allowance #1071 decided, and the tdd's #1038 confirmed.
  const PLAN_CAPS = 'Probe caps: 5 min per probe, 2 probes per issue';
  const TDD_CAPS = 'Probe caps: 15 min per probe, 3 probes per issue';

  it.each([
    ['planner:7-1', PLAN_CAPS],
    ['applier:7-1', PLAN_CAPS],
    ['planReviewer:7-1', PLAN_CAPS],
    ['tdd:7-1', TDD_CAPS],
    ['reviewer:7-1', TDD_CAPS],
    ['testReview:7-1', TDD_CAPS],
  ])('hands %s its stage’s probe caps', async (label, line) => {
    const run = fakeHooks(PLAN_REVIEW_FINDINGS);

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, label)
        .split('\n')
        .filter((l) => l.startsWith('Probe caps: ')),
    ).toEqual([line]);
  });

  // Hand-written: the slice budget set 2026-10-08 from the landed history (ADR-0045 decision 4).
  const BUDGET = 'Slice budget: 15 files in scope, 12 tasks, 1000 lines landed';

  it.each(['planner:7-1', 'applier:7-1', 'planReviewer:7-1', 'retro:list'])(
    'hands %s the slice budget, once',
    async (label) => {
      const run = fakeHooks(PLAN_REVIEW_FINDINGS);

      await runShip(run.hooks, 'issues 7');

      expect(
        promptOf(run, label)
          .split('\n')
          .filter((l) => l.startsWith('Slice budget: ')),
      ).toEqual([BUDGET]);
    },
  );

  it.each(['tdd:7-1', 'diffReview:7-1', 'reviewer:7-1', 'testReview:7-1'])(
    'hands %s no slice budget: the plan it builds or checks is already within it',
    async (label) => {
      const run = fakeHooks(PLAN_REVIEW_FINDINGS);

      await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, label)).not.toContain('Slice budget: ');
    },
  );

  it('carries the land envelope’s files and lines into the run report’s schedule as the slice’s size', async () => {
    const run = fakeHooks({
      'runner:land': { ...LAND_OK, files: ['a.ts', 'b.ts', 'c.ts'], lines: 912 },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.schedule[0]?.size).toEqual({ files: 3, lines: 912 });
  });

  it('records no size for a landing whose envelope carries no lines', async () => {
    const run = fakeHooks({ 'runner:land': { ...LAND_OK, lines: null } });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.schedule[0]).toMatchObject({ committedAt: LAND_OK.at, size: null });
  });

  it.each(['planner:7-1', 'planReviewer:7-1', 'applier:7-1', 'diffReview:7-1'])(
    'hands %s the command that fetches the issue as markdown into the report dir',
    async (label) => {
      const run = fakeHooks(PLAN_REVIEW_FINDINGS);

      await runShip(run.hooks, 'issues 7');

      const lines = promptOf(run, label).split('\n');
      expect(lines).toContain(`Issue file: ${REPORT_DIR}/issues/7.md`);
      expect(lines).toContain(
        `Issue command: mkdir -p ${REPORT_DIR}/issues && gh issue view 7 --json title,state,labels,body,comments --jq '"# \\(.title)", "state: \\(.state)", "labels: \\([.labels[].name] | join(", "))", "", .body, (.comments[] | "", "----- comment by \\(.author.login) at \\(.createdAt) -----", .body)' > ${REPORT_DIR}/issues/7.md`,
      );
    },
  );

  it.each(['planner:7-1', 'planReviewer:7-1', 'applier:7-1', 'tdd:7-1'])(
    'hands %s the slice worktree the cut named',
    async (label) => {
      const run = fakeHooks(PLAN_REVIEW_FINDINGS);

      await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, label).split('\n')).toContain(`Slice worktree: ${SLICE_7}`);
    },
  );

  it.each(['tdd:7-1', 'reviewer:7-1', 'testReview:7-1'])(
    'hands %s the slice base the cut answered',
    async (label) => {
      const run = fakeHooks();

      await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, label).split('\n')).toContain('Slice base: cut1');
    },
  );

  it.each<[string, string[], string[]]>([
    ['reviewer:7-1', ['Mode'], ['Findings file']],
    ['testReview:7-1', [], []],
  ])(
    'orders %s’s prompt: the slice’s lines, the report and findings files, then the server-tier recipe',
    async (label, head, own) => {
      const run = fakeHooks();

      await runShip(run.hooks, 'issues 7');

      const keys = promptOf(run, label)
        .split('\n')
        .map((l) => l.slice(0, l.indexOf(': ')));
      expect(keys).toEqual([
        ...head,
        'Issue',
        'Slice worktree',
        'Slice base',
        'Plan file',
        'Slice commit',
        'Changed files',
        'Report file',
        ...own,
        'Lease command',
        'Lease version',
        'Probe caps',
      ]);
    },
  );

  it('hands the diff reviewer the tdd’s commit, its findings file and the issue’s lines, nothing else', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const lines = promptOf(run, 'diffReview:7-1').split('\n');
    expect(lines.slice(0, -1)).toEqual([
      'Issue: #7',
      'Slice worktree: C:/src/ph-runs/7/slice-7-1',
      'Slice base: cut1',
      `Plan file: ${REPORT_DIR}/plans/7.md`,
      'Slice commit: slice1',
      'Changed files: tooling/x.ts, test/unit/tooling/x.test.ts',
      `Findings file: ${REPORT_DIR}/diff-review-7-1.md`,
      `Issue file: ${REPORT_DIR}/issues/7.md`,
    ]);
    expect(lines.at(-1)).toMatch(/^Issue command: /);
  });

  it.each([
    ['diffReview:7-1', 'diff-review-7-1.md'],
    ['reviewer:7-1', 'diff-review-7-1.md'],
    ['diffReview:7-2', 'diff-review-7-2.md'],
    ['reviewer:7-2', 'diff-review-7-2.md'],
  ])('hands %s its attempt’s diff review findings file, %s', async (label, file) => {
    // A land conflict re-cuts the issue, so attempt 2's hand-off shows beside attempt 1's.
    const run = fakeHooks({ 'runner:land': inTurn(LAND_CONFLICT, LAND_OK) });

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, label)
        .split('\n')
        .filter((l) => l.startsWith('Findings file: ')),
    ).toEqual([`Findings file: ${REPORT_DIR}/${file}`]);
  });

  it('skips the test review for a slice that changes no code, landing the reviewer’s commit', async () => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files: ['docs/x.md'] } });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('testReview'))).toEqual([]);
    expect(run.calls.find((c) => c.label === 'runner:land:7-1')?.argv[3]).toBe('slice2');
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Test review: skipped — trivial surface',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr' });
  });

  it('skips the test review for a slice proven comment-only, landing the reviewer’s commit', async () => {
    const run = fakeHooks({
      tdd: { ...TDD_GREEN, files: ['src/a.ts', 'eslint-suppressions.json'] },
      'runner:comment-only': {
        exitCode: 0,
        envelopePath: 'e.json',
        notCompared: ['eslint-suppressions.json'],
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(reviewer|runner:comment-only|testReview):/.test(l)),
    ).toEqual(['reviewer:7-1', 'runner:comment-only:7-1']);
    expect(run.calls.find((c) => c.label === 'runner:comment-only:7-1')?.argv).toEqual([
      'tooling/comment-only.ts',
      '--json',
      'cut1..slice2',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:land:7-1')?.argv[3]).toBe('slice2');
    const lines = promptOf(run, 'runner:publish:list').split('\n');
    expect(lines).toContain('- Test review: skipped — comment-only');
    expect(lines).not.toContain('- Test review: skipped — trivial surface');
    expect(report.epics[0]).toMatchObject({ outcome: 'pr' });
  });

  it.each<[string, string[], unknown, boolean, boolean]>([
    [
      'a test/ path',
      ['src/a.ts', 'test/unit/a.test.ts'],
      { exitCode: 0, envelopePath: 'e.json', notCompared: [] },
      false,
      false,
    ],
    [
      'a not-compared tooling/x.cts',
      ['src/a.ts', 'tooling/x.cts'],
      { exitCode: 0, envelopePath: 'e.json', notCompared: ['tooling/x.cts'] },
      true,
      false,
    ],
    [
      'a not-compared src/b.js',
      ['src/a.ts', 'src/b.js'],
      { exitCode: 0, envelopePath: 'e.json', notCompared: ['src/b.js'] },
      true,
      false,
    ],
    [
      'a proof exit of 1',
      ['src/a.ts'],
      { exitCode: 1, envelopePath: 'e.json', notCompared: [] },
      true,
      false,
    ],
    [
      'a proof exit of 2',
      ['src/a.ts'],
      {
        exitCode: 2,
        envelopePath: 'e.json',
        stderrTail: 'comment-only: usage: comment-only [--cached] [<base>] | <base>..<head>',
      },
      true,
      true,
    ],
    ['a runner that returned nothing', ['src/a.ts'], null, true, false],
  ])(
    'runs the test review on a slice with %s',
    async (_name, files, proof, proofCalled, offSchema) => {
      const run = fakeHooks(
        { tdd: { ...TDD_GREEN, files }, 'runner:comment-only': proof },
        { offSchema },
      );

      await runShip(run.hooks, 'issues 7');

      expect(labels(run).filter((l) => /^(runner:comment-only|testReview):/.test(l))).toEqual(
        proofCalled ? ['runner:comment-only:7-1', 'testReview:7-1'] : ['testReview:7-1'],
      );
      expect(run.calls.find((c) => c.label === 'runner:land:7-1')?.argv[3]).toBe('slice3');
      expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
        '- Test review: hardened, 0 surviving mutants — pinned a bound',
      );
    },
  );

  it('runs the diff review on a slice that changes no code, though test review is skipped', async () => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files: ['docs/x.md'] } });

    await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^(tdd|diffReview|reviewer|testReview):/.test(l))).toEqual([
      'tdd:7-1',
      'diffReview:7-1',
      'reviewer:7-1',
    ]);
  });
});

describe('runShip — the epic end', () => {
  it('resolves a doc-index conflict, then continues the merge, before the bump', async () => {
    const run = fakeHooks(DOC_INDEX_CONFLICT);

    const report = await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(runner:(sync-master|bump|publish)|resolver)/.test(l)),
    ).toEqual([
      'runner:sync-master:list',
      'resolver:list',
      'runner:sync-master:list-continue',
      'runner:bump:list',
      'runner:publish:list',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:sync-master:list-continue')?.argv).toEqual([
      'tooling/worktree.ts',
      'sync-master',
      BATCH,
      '--continue',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:check-master:list')?.argv.slice(-2)).toEqual([
      '--synced',
      'origin1',
    ]);
    const resolver = promptOf(run, 'resolver:list');
    expect(resolver).toContain(`Batch worktree: ${BATCH}`);
    expect(resolver).toContain(`Pending paths: ${ADR_INDEX}`);
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Master sync: resolved at merge1',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 42 });
  });

  it('leaves the merge in progress when the resolver cannot resolve: no --continue, no bump', async () => {
    const run = fakeHooks({
      ...DOC_INDEX_CONFLICT,
      resolver: { verdict: 'unresolvable', summary: 'the rows contradict' },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^runner:(sync-master|bump|publish)/.test(l))).toEqual([
      'runner:sync-master:list',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: `master sync failed: the resolver said the rows contradict; merge left in progress in ${BATCH}`,
    });
  });

  it.each([
    ['its HEAD moved', { ...PREFLIGHT_OK.snapshot, head: 'moved1' }],
    ['it turned dirty', { ...PREFLIGHT_OK.snapshot, dirty: true }],
  ])('reports the main checkout touched when %s', async (_name, snapshot) => {
    const run = fakeHooks({ 'runner:preflight:list': { ...PREFLIGHT_OK, snapshot } });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({ outcome: 'pr', mainUntouched: false });
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Main checkout: touched since pre-flight (HEAD or dirtiness changed)',
    );
  });
});

/**
 * Issues 7 and 8 of one issue list: 7's teardown (`teardownKey`) shrinks a
 * source and settles first, so 8's held landing commits after the entry halted.
 */
async function haltRace(teardownKey: string) {
  const hold = holdable(/^runner:(teardown:7-1|land:8-1)$/);
  const run = fakeHooks(
    {
      'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
      scout: {
        issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
        overlaps: [],
      },
      [teardownKey]: TEARDOWN_SHRANK,
      'runner:land:8-1': { ...LAND_OK, commit: 'landed8' },
    },
    { gate: hold.gate },
  );

  const done = runShip(run.hooks, 'issues 7 8');
  await idle();
  expect(hold.held()).toEqual(['runner:teardown:7-1', 'runner:land:8-1']);
  hold.release('runner:teardown:7-1');
  await idle();
  expect(run.timeline).toContain('log fed epic-halt the issue list');
  hold.releaseAll();
  const report = await done;

  expect(run.timeline.filter((e) => e.startsWith('log fed'))).toEqual([
    'log fed epic-halt the issue list',
    'log fed blocked #7',
    'log fed blocked #8',
  ]);
  return { run, report };
}

describe('runShip — a halting entry', () => {
  it('feeds one epic-halt when two in-flight issues of the entry stop for it', async () => {
    const run = fakeHooks({
      'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
      scout: {
        issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
        overlaps: [],
      },
      'runner:land': LAND_BATCH_DIRTY,
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(run.calls.find((c) => c.label === 'runner:cut-batch:list')?.argv).toEqual([
      'tooling/worktree.ts',
      'cut-batch',
      '.',
      '--issues',
      '7,8',
    ]);
    expect(labels(run).filter((l) => l.startsWith('tdd'))).toEqual(['tdd:7-1', 'tdd:8-1']);
    expect(labels(run).filter((l) => l.startsWith('runner:land'))).toEqual(['runner:land:7-1']);
    expect(run.timeline.filter((e) => e.startsWith('log fed epic-halt'))).toEqual([
      'log fed epic-halt the issue list',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [
        { issue: 7, outcome: 'halted', cite: 'see' },
        { issue: 8, outcome: 'halted', cite: 'see' },
      ],
    });
  });

  it('runs no queued landing of the entry after a land call that throws', async () => {
    const run = fakeHooks({
      'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
      scout: {
        issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
        overlaps: [],
      },
      'runner:land': () => {
        throw new Error('runner crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(labels(run).filter((l) => l.startsWith('tdd'))).toEqual(['tdd:7-1', 'tdd:8-1']);
    expect(labels(run).filter((l) => l.startsWith('runner:land'))).toEqual(['runner:land:7-1']);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [
        { issue: 7, outcome: 'halted', cite: 'see', reason: 'land threw: runner crashed' },
        { issue: 8, outcome: 'halted', cite: 'see', reason: 'its epic halted' },
      ],
    });
  });

  it('reports a landing its teardown halts landed-then-halted, with its commit, and no epic end', async () => {
    const run = fakeHooks({ 'runner:teardown': TEARDOWN_SHRANK });

    const report = await runShip(run.hooks, 'issues 7');

    expect(when(run, 'log fed epic-halt the issue list')).toBeLessThan(
      when(run, 'log fed blocked #7'),
    );
    expect(run.timeline).not.toContain('log fed committed #7');
    expect(labels(run).filter((l) => EPIC_END_COMMAND.test(l))).toEqual([]);
    expect(report.epics).toEqual([
      {
        epic: null,
        branch: 'ship/7',
        outcome: 'halted',
        issues: [{ issue: 7, outcome: 'landed-then-halted', cite: 'see', commit: 'landed1' }],
        schedule: [
          {
            issue: 7,
            blockers: [],
            attempts: 1,
            startedAt: '2026-09-29T10:00:00.000Z',
            committedAt: '2026-09-29T10:20:00.000Z',
            size: { files: 2, lines: 40 },
          },
        ],
        residue: ['teardown refused (source-shrank): node_modules lost 40 entries'],
        retro: [],
      },
    ]);
  });

  it('reports a landing that commits after its epic halted landed-then-halted, fed blocked, never committed', async () => {
    const { run, report } = await haltRace('runner:teardown:7-1');

    expect(labels(run).filter((l) => EPIC_END_COMMAND.test(l))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [
        { issue: 7, outcome: 'landed-then-halted', cite: 'see', commit: 'landed1' },
        { issue: 8, outcome: 'landed-then-halted', cite: 'see', commit: 'landed8' },
      ],
    });
  });

  it('feeds no second epic-halt when a teardown halts an entry already halted', async () => {
    const { report } = await haltRace('runner:teardown');

    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [
        { issue: 7, outcome: 'landed-then-halted', cite: 'see', commit: 'landed1' },
        { issue: 8, outcome: 'landed-then-halted', cite: 'see', commit: 'landed8' },
      ],
      residue: [
        'teardown refused (source-shrank): node_modules lost 40 entries',
        'teardown refused (source-shrank): node_modules lost 40 entries',
      ],
    });
  });

  it('names the landing’s halt, not its teardown’s, when both call for one', async () => {
    const run = fakeHooks({ 'runner:land': LAND_BATCH_DIRTY, 'runner:teardown': TEARDOWN_SHRANK });

    const report = await runShip(run.hooks, 'issues 7');

    expect(run.timeline.filter((e) => e.startsWith('log fed epic-halt'))).toEqual([
      'log fed epic-halt the issue list',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      issues: [
        { issue: 7, outcome: 'halted', cite: 'see', reason: expect.stringMatching(/batch-dirty/) },
      ],
      residue: ['teardown refused (source-shrank): node_modules lost 40 entries'],
    });
  });

  it('reports an issue that blocks while its entry is halting, before the halt is fed, blocked', async () => {
    const hold = holdable(/^(planner:8-1|runner:teardown:7-1)$/);
    const run = fakeHooks(
      {
        'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
        scout: {
          issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
          overlaps: [],
        },
        'runner:land:7-1': LAND_BATCH_DIRTY,
        'planner:8-1': PLANNER_STALE.planner,
      },
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'issues 7 8');
    await idle();
    expect(hold.held()).toEqual(['planner:8-1', 'runner:teardown:7-1']);
    hold.release('planner:8-1');
    await idle();
    hold.releaseAll();
    const report = await done;

    expect(run.timeline.filter((e) => e.startsWith('log fed'))).toEqual([
      'log fed blocked #8',
      'log fed epic-halt the issue list',
      'log fed blocked #7',
    ]);
    expect(report.epics[0]?.issues).toEqual([
      {
        issue: 7,
        outcome: 'halted',
        cite: 'see',
        reason: 'land refused (batch-dirty): the batch has uncommitted changes',
      },
      {
        issue: 8,
        outcome: 'blocked',
        cite: 'see',
        reason: 'planner stale: x already exists at abc123',
      },
    ]);
  });
});

describe('runAttempt — how an attempt ends', () => {
  const entry = (run: FakeRun, halting: boolean): Parameters<typeof runAttempt>[0] => ({
    epic: null,
    tag: 'list',
    branch: 'ship/7',
    main: 'C:/main',
    batch: BATCH,
    base: 'base0',
    reportDir: REPORT_DIR,
    registry: 'registry.json',
    attachedRun: null,
    hooks: run.hooks,
    queue: createCommitQueue(),
    isHalting: () => halting,
    markHalting: () => undefined,
    priorSlices: () => [],
  });
  const ENDINGS: [string, Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>][] =
    [
      [
        'landed',
        {},
        {
          kind: 'landed',
          work: {
            card: PLAN_CARD,
            tdd: TDD_GREEN,
            diffReview: DIFF_REVIEW_OK,
            review: {
              verdict: 'fixed',
              sha: 'slice2',
              summary: 'renamed a helper',
              leaseLines: [],
            },
            testReview: {
              verdict: 'hardened',
              sha: 'slice3',
              survivors: 0,
              summary: 'pinned a bound',
              leaseLines: [],
            },
          },
          commit: 'landed1',
          committedAt: LAND_OK.at,
          size: { files: 2, lines: 40 },
          halt: null,
          residue: null,
          startedAt: '2026-09-29T10:00:00.000Z',
        },
      ],
      [
        'conflicted on landing',
        { 'runner:land': LAND_CONFLICT },
        {
          kind: 'unlanded',
          primary: { kind: 'harvest-conflict', issue: 7 },
          conflicts: ['tooling/x.ts'],
          halt: null,
          residue: null,
          startedAt: '2026-09-29T10:00:00.000Z',
        },
      ],
      [
        'failed its cut, naming its slice',
        { 'runner:cut-slice': CUT_FAILED },
        {
          kind: 'unlanded',
          primary: { kind: 'blocked', issue: 7, reason: 'cut-slice failed: worktree add failed' },
          conflicts: [],
          halt: null,
          residue: null,
          startedAt: '2026-09-29T10:00:00.000Z',
        },
      ],
    ];

  it.each(ENDINGS)(
    'ends an attempt that %s with exactly its kind’s fields',
    async (_name, responses, ending) => {
      const run = fakeHooks(responses);

      const note = await runAttempt(entry(run, false), 7, 1);
      const end = note.kind === 'authored' ? await note.landing : note;

      expect(end).toEqual({ kind: 'ended', issue: 7, ending });
    },
  );

  it('stops an attempt of a halting entry at its first stage boundary, before the re-check', async () => {
    const run = fakeHooks();

    const note = await runAttempt(entry(run, true), 7, 1);

    expect(labels(run)).toEqual([]);
    expect(note).toMatchObject({
      kind: 'ended',
      ending: { primary: { kind: 'epic-halt', epic: null, reason: 'its epic halted' } },
    });
  });

  it('ends with the landing’s halt, not its teardown’s, when both call for one', async () => {
    const run = fakeHooks({ 'runner:land': LAND_BATCH_DIRTY, 'runner:teardown': TEARDOWN_SHRANK });

    const note = await runAttempt(entry(run, false), 7, 1);
    const end = note.kind === 'authored' ? await note.landing : note;

    expect(end).toMatchObject({
      kind: 'ended',
      ending: {
        halt: {
          kind: 'epic-halt',
          epic: null,
          reason: 'land refused (batch-dirty): the batch has uncommitted changes',
        },
        residue: 'teardown refused (source-shrank): node_modules lost 40 entries',
      },
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
        worktree: 'C:/src/main',
        branch: null,
        base: null,
        batch: null,
        reportDir: null,
        attach: null,
      },
    });

  it('reports an entry the drop emptied nothing-landed, driving nothing', async () => {
    const run = failedCut([2]);

    const report = await runShip(run.hooks, 'epics 1 2');

    expect(labels(run).filter((l) => l.startsWith('runner:check:'))).toEqual([]);
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

    expect(labels(run).filter((l) => l.startsWith('runner:check:'))).toEqual(['runner:check:3-1']);
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
      overlap: { added: [], sequenced: [], areaMap: 'read' },
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
      overlapEstimator: { agentType: 'overlap-estimator' },
      planner: { agentType: 'planner' },
      applier: { agentType: 'planner' },
      planReviewer: { agentType: 'ship-plan-reviewer' },
      tdd: { agentType: 'ship-tdd', model: 'opus' },
      diffReview: { agentType: 'diff-reviewer', model: 'opus' },
      reviewer: { agentType: 'reviewer', model: 'opus' },
      resolver: { agentType: 'reviewer', model: 'opus' },
      testReview: { agentType: 'ship-test-review', model: 'opus' },
      critic: { agentType: 'critic' },
      retro: { agentType: 'retro', model: 'sonnet' },
      prWriter: { agentType: 'pr-writer' },
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
        // The diff reviewer's and the reviewer's effort is per slice;
        // every fake tdd commits TDD_FILES.
        const effort =
          stage === 'diffReview' || stage === 'reviewer' ? reviewEffort(TDD_FILES) : row.effort;
        expect({ agentType: call.agentType, model: call.model, effort: call.effort }).toEqual({
          agentType: row.agentType,
          model: row.model,
          effort,
        });
      }
    },
  );

  it.each<[string[], string]>([
    [['docs/x.md'], 'medium'],
    [['src/x.ts'], 'high'],
  ])(
    'gives the diff reviewer and the reviewer the effort a slice changing %j picks: %s',
    async (files, effort) => {
      const run = fakeHooks({ tdd: { ...TDD_GREEN, files } });

      await runShip(run.hooks, 'issues 7');

      const effortOf = (label: string): string | undefined =>
        run.calls.find((c) => c.label === label)?.effort;
      expect([effortOf('diffReview:7-1'), effortOf('reviewer:7-1')]).toEqual([effort, effort]);
    },
  );
});
