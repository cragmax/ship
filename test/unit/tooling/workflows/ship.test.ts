import { describe, expect, it } from 'vitest';

import { createCommitQueue } from '../../../../tooling/workflows/lib/commit-queue.js';
import { runAttempt } from '../../../../tooling/workflows/lib/slice-chain.js';
import { STAGES, type StageName, type StageRow } from '../../../../tooling/workflows/lib/stages.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  fakeHooks,
  GATE_OK,
  inTurn,
  LAND_OK,
  LIVE_RUNS_NONE,
  liveRuns,
  PREFLIGHT_OK,
  REPORT_DIR,
  TDD_BLOCKED,
  TDD_GREEN,
  readyVerdict,
  type FakeRun,
} from './_fake-hooks.js';
import { epicRun, holdable, idle } from './_fake-parallel.js';

const EPIC_GRAPH = {
  runSet: [{ epic: 1025, issues: [1045, 1046] }],
  edges: [{ blocker: 1045, dependent: 1046 }],
};

const EPIC_FRESH = {
  'runner:run-gate': { ...GATE_OK, ...EPIC_GRAPH },
  issueReadiness: {
    issues: [readyVerdict(1045), readyVerdict(1046)],
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
  issueReadiness: {
    issues: [readyVerdict(7, { current: 'parseFoo no longer exists' }), readyVerdict(8)],
  },
};

const SEVEN_STALE_BLOCKS_EIGHT = {
  'runner:run-gate': {
    ...GATE_OK,
    runSet: [{ epic: null, issues: [7, 8, 9] }],
    edges: [{ blocker: 7, dependent: 8 }],
  },
  issueReadiness: {
    issues: [
      readyVerdict(7, { current: 'already implemented at abc123' }),
      readyVerdict(8),
      readyVerdict(9),
    ],
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
  kept: null,
  errors: [{ step: 'gate', message: 'node_modules lost 40 entries' }],
};

const TDD_STALE = { tdd: { ...TDD_BLOCKED, reason: 'x already exists at abc123' } };

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

// Two issues bring in issue-overlap (one pair), a hardening test audit and a retro finding.
const TWO_ISSUES = {
  'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
  issueReadiness: {
    issues: [7, 8].map((issue) => readyVerdict(issue)),
  },
  issueOverlap: {
    issues: [{ number: 7, columns: ['tooling'], paths: ['tooling/x.ts'] }],
    pairs: [{ a: 7, b: 8, confidence: 'likely', shared: ['tooling/x.ts'], reason: 'both edit x' }],
    liveOverlaps: [],
    areaMap: 'read',
  },
  auditTests: {
    verdict: 'hardened',
    sha: 'audit1',
    files: ['test/unit/tooling/x.test.ts'],
    commit: { type: 'test', scope: 'build', subject: 'pin x' },
    survivors: 0,
    summary: 'pinned a bound',
    leaseLines: [],
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
  { name: 'blocked tdd', responses: TDD_STALE, args: 'issues 7' },
  { name: 'dead tdd', responses: { tdd: null }, args: 'issues 7' },
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
      'issueReadiness',
      'issueOverlap',
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
  it('refuses a stale-slice-branch problem though issue-readiness finds #7 ready, cutting nothing', async () => {
    const run = fakeHooks({ 'runner:preflight': STALE_PREFLIGHT });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.status).toBe('refused');
    expect(report.refusals).toEqual([{ kind: 'stale-slice-branch', message: STALE_7.message }]);
    expect(run.calls.map((c) => c.label)).toContain('issueReadiness');
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
  it('runs the chain through the reviews, the test review between the spec and standards reviews, before one land, tears the slice down before committed, then the epic end', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7');

    expect(run.calls.map((c) => c.label)).toEqual([
      'runner:preflight',
      'runner:run-gate',
      'runner:live-runs',
      'issueReadiness',
      'runner:cut-batch:list',
      'runner:provision-batch:list',
      'runner:check:7-1',
      'runner:cut-slice:7-1',
      'runner:provision:7-1',
      'tdd:7-1',
      'specReview:7-1',
      'testReview:7-1',
      'standardsReview:7-1',
      'runner:land:7-1',
      'runner:teardown:7-1',
      'runner:cut-slice:audit-tests',
      'runner:provision:audit-tests',
      'auditTests:list',
      'runner:teardown:audit-tests',
      'epicReview:list',
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

  it('runs the Manifest TSDoc review after the standards review on a slice changing src/, the land reading its amend', async () => {
    const files = ['src/fluent/wrapped-bot/types.ts', 'test/unit/x.test.ts'];
    const run = fakeHooks({
      tdd: { ...TDD_GREEN, files },
      manifestTsdoc: { verdict: 'fixed', sha: 'slice2m', summary: 'sharpened walkTo' },
    });

    await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => AFTER_BUILD_CALL.test(l))).toEqual([
      'tdd:7-1',
      'specReview:7-1',
      'testReview:7-1',
      'standardsReview:7-1',
      'manifestTsdoc:7-1',
      'runner:land:7-1',
      'runner:teardown:7-1',
    ]);
    const call = run.calls.find((c) => c.label === 'manifestTsdoc:7-1');
    expect({ agentType: call?.agentType, model: call?.model, effort: call?.effort }).toEqual({
      agentType: 'manifest-tsdoc',
      model: 'opus',
      effort: 'high',
    });
    expect(promptOf(run, 'manifestTsdoc:7-1').split('\n')).toEqual([
      'Issue: #7',
      'Slice worktree: C:/src/ph-runs/7/slice-7-1',
      'Slice base: cut1',
      'Slice commit: slice2',
      'Changed files: src/fluent/wrapped-bot/types.ts, test/unit/x.test.ts',
      `Report file: ${REPORT_DIR}/manifest-tsdoc-7-1.md`,
    ]);
    expect(run.calls.find((c) => c.label === 'runner:land:7-1')?.argv[3]).toBe('slice2m');
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
    // Each amend moves the slice commit: each review sees the one before it.
    expect(shaSeenBy('specReview:7-1')).toBe('Slice commit: slice1');
    expect(shaSeenBy('standardsReview:7-1')).toBe('Slice commit: spec1');
    expect(argvOf('runner:land:7-1')).toEqual([
      'tooling/worktree.ts',
      'land',
      BATCH,
      'slice2',
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
      'an issue-readiness that returned nothing',
      { issueReadiness: null },
      'issues 7 --preflight-only',
      [{ kind: 'readiness-unavailable', message: 'no issue-readiness verdict for #7' }],
    ],
    [
      'exclude mode dropping every issue',
      { issueReadiness: { issues: [readyVerdict(7, { current: 'done in abc123' })] } },
      'issues 7 --exclude --preflight-only',
      [{ kind: 'empty-run-set', message: 'no issue is left after the readiness drops' }],
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

  it('refuses a gate with no verdict, and skips issue-readiness for want of a run set', async () => {
    const run = fakeHooks(
      {
        'runner:run-gate': { exitCode: 2, envelopePath: 'g', stderrTail: 'run-gate: schema error' },
      },
      { offSchema: true },
    );

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(report.refusals).toEqual([{ kind: 'gate-error', message: 'run-gate: schema error' }]);
    expect(run.calls.map((c) => c.label)).not.toContain('issueReadiness');
  });

  it('shows issue-overlap only the unspent live runs', async () => {
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

    const prompt = run.calls.find((c) => c.label === 'issueOverlap')?.prompt ?? '';
    expect(prompt.split('\n')).toContain(
      'Live runs (JSON): [{"branch":"ship/epic-9","landed":["src/a.ts"]}]',
    );
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

/** A closing keyword before issue 7's ref, as GitHub reads one. */
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
    expect(labels(run)).toContain('tdd:7-2');
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

  it('tears the slice down before feeding blocked for a blocked tdd, landing nothing', async () => {
    const run = fakeHooks(TDD_STALE);

    const report = await runShip(run.hooks, 'issues 7');

    expect(when(run, 'call runner:teardown:7-1')).toBeLessThan(when(run, 'log fed blocked #7'));
    expect(labels(run).filter((l) => /^(specReview|runner:land)/.test(l))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      issues: [
        { issue: 7, outcome: 'blocked', cite: 'see', reason: expect.stringMatching(/BLOCKED/) },
      ],
    });
  });

  describe('an unlanded attempt keeps its work outside the run root', () => {
    // The cut's `at` (2026-09-29T10:00:00.000Z), made path-safe, tells a re-run's attempt apart.
    const KEPT = 'C:/src/main/reports/kept/slice-7-1-2026-09-29T10-00-00-000Z';
    const SLICE = 'C:/src/ph-runs/7/slice-7-1';
    const teardownArgv = (run: FakeRun): readonly string[] | undefined =>
      run.calls.find((c) => c.label === 'runner:teardown:7-1')?.argv;

    it('asks the teardown of a blocked attempt to keep its patch from the slice base and its tdd report', async () => {
      const run = fakeHooks(TDD_STALE);

      await runShip(run.hooks, 'issues 7');

      expect(teardownArgv(run)).toEqual([
        'tooling/worktree.ts',
        'teardown',
        SLICE,
        '--keep-to',
        KEPT,
        '--base',
        'cut1',
        '--report',
        `${REPORT_DIR}/tdd-7-1.md`,
      ]);
    });

    it('asks the teardown of a landed attempt to keep nothing', async () => {
      const run = fakeHooks();

      await runShip(run.hooks, 'issues 7');

      expect(teardownArgv(run)).toEqual(['tooling/worktree.ts', 'teardown', SLICE]);
    });

    it('tells the tdd where its work is kept', async () => {
      const run = fakeHooks(TDD_STALE);

      await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, 'tdd:7-1').split('\n')).toContain(`Kept dir: ${KEPT}`);
    });

    it('names the kept paths, not the report dir, in the issue comment and the run report', async () => {
      const kept = { patch: `${KEPT}/slice.patch`, report: `${KEPT}/tdd-7-1.md` };
      const run = fakeHooks({
        ...TDD_STALE,
        'runner:teardown': {
          exitCode: 0,
          envelopePath: 'e.json',
          status: 'ok',
          errors: [],
          removed: true,
          registered: false,
          kept,
        },
      });

      const report = await runShip(run.hooks, 'issues 7');

      const posted = run.calls.find((c) => c.label === 'runner:post-issue-comment:7')?.prompt ?? '';
      expect(posted.split('\n')).toContain(
        `Run: branch \`ship/7\`, no pull request. Kept: patch \`${KEPT}/slice.patch\`, tdd report \`${KEPT}/tdd-7-1.md\`.`,
      );
      expect(posted).not.toContain('Report dir:');
      expect(report.epics[0]?.issues).toEqual([
        {
          issue: 7,
          outcome: 'blocked',
          cite: 'see',
          reason: expect.stringMatching(/BLOCKED/),
          kept,
        },
      ]);
    });
  });

  describe('a blocked issue hears why', () => {
    const COMMENT_FILE = `${REPORT_DIR}/issue-comment-7.md`;

    it('posts the reason on the issue from the main checkout, the comment written first, after the slice is torn down', async () => {
      const run = fakeHooks(TDD_STALE);

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
        '**Not landed: blocked.** tdd BLOCKED: x already exists at abc123',
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
        'tdd:8-1': TDD_BLOCKED,
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
        const run = fakeHooks({ ...TDD_STALE, 'runner:post-issue-comment': answer });

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

  it('retries the issue when the spec review returns nothing, never calling the standards review, then blocks it', async () => {
    const run = fakeHooks({ specReview: null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(specReview|standardsReview|runner:teardown):\d/.test(l)),
    ).toEqual(['specReview:7-1', 'runner:teardown:7-1', 'specReview:7-2', 'runner:teardown:7-2']);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      issues: [
        { issue: 7, outcome: 'blocked', cite: 'see', reason: 'its agent died on the retry too' },
      ],
    });
  });

  it('blocks the issue, with no retry and no standards review call, when the spec review call throws', async () => {
    const run = fakeHooks({
      specReview: () => {
        throw new Error('runtime crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(specReview|standardsReview|runner:teardown):\d/.test(l)),
    ).toEqual(['specReview:7-1', 'runner:teardown:7-1']);
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
const UP_TO_TDD = ['runner:check:7-1', 'runner:cut-slice:7-1', 'runner:provision:7-1', 'tdd:7-1'];
const BUILD_CALL = /^(runner:(check|cut-slice|provision|teardown|land)|tdd|specReview):\d/;
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
    'blocked by the tdd',
    {
      tdd: { ...TDD_BLOCKED, reason: 'the issue names a missing symbol' },
    },
    [...UP_TO_TDD, 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'tdd BLOCKED: the issue names a missing symbol' },
  ],
  [
    'blocked by a tdd that committed nothing',
    { tdd: { ...TDD_GREEN, sha: '' } },
    [...UP_TO_TDD, 'runner:teardown:7-1'],
    { outcome: 'blocked', reason: 'tdd GREEN: no commit' },
  ],
  [
    'blocked by a tdd that threw',
    {
      tdd: () => {
        throw new Error('runtime crashed');
      },
    },
    [...UP_TO_TDD, 'runner:teardown:7-1'],
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
});

const AFTER_BUILD_CALL =
  /^(tdd|specReview|testReview|standardsReview|manifestTsdoc|runner:(land|teardown)):\d/;
const UP_TO_REVIEW = ['tdd:7-1', 'specReview:7-1', 'testReview:7-1', 'standardsReview:7-1'];
const UP_TO_LAND = [...UP_TO_REVIEW, 'runner:land:7-1'];
const AFTER_BUILD_ENDINGS: [string, Readonly<Record<string, unknown>>, string[], string][] = [
  [
    'blocked by the spec review',
    {
      specReview: {
        verdict: 'blocked',
        sha: '',
        summary: 'criterion 2 needs a file outside the slice',
        leaseLines: [],
      },
    },
    ['tdd:7-1', 'specReview:7-1', 'runner:teardown:7-1'],
    'spec review: criterion 2 needs a file outside the slice',
  ],
  [
    'blocked by the test review',
    {
      testReview: {
        verdict: 'blocked',
        sha: '',
        summary: 'the real x() fails its hardened bound test',
        leaseLines: [],
      },
    },
    ['tdd:7-1', 'specReview:7-1', 'testReview:7-1', 'runner:teardown:7-1'],
    'test review: the real x() fails its hardened bound test',
  ],
  [
    'blocked by the standards review',
    {
      standardsReview: {
        verdict: 'blocked',
        sha: '',
        summary: 'the amend fails its hooks',
        leaseLines: [],
      },
    },
    [...UP_TO_REVIEW, 'runner:teardown:7-1'],
    'standards review: the amend fails its hooks',
  ],
  [
    'blocked by a standards review that threw',
    {
      standardsReview: () => {
        throw new Error('runtime crashed');
      },
    },
    [...UP_TO_REVIEW, 'runner:teardown:7-1'],
    'a stage threw: runtime crashed',
  ],
  [
    'blocked by the Manifest TSDoc review',
    {
      tdd: { ...TDD_GREEN, files: ['src/fluent/wrapped-bot/types.ts'] },
      manifestTsdoc: { verdict: 'blocked', sha: '', summary: 'a hook failure would not clear' },
    },
    [...UP_TO_REVIEW, 'manifestTsdoc:7-1', 'runner:teardown:7-1'],
    'manifest tsdoc: a hook failure would not clear',
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

  it.each(['specReview', 'testReview', 'standardsReview'])(
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
  it('hands the tdd the commit message template its commit line and cite fill', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    expect(promptOf(run, 'tdd:7-1')).toContain(
      [
        `Commit message template: ${REPORT_DIR}/commit-7-1.txt`,
        '----- BEGIN FILE -----',
        '<type>(<scope>): <subject>',
        '',
        '<fixes|see> #7',
        '',
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        '----- END FILE -----',
      ].join('\n'),
    );
  });

  it.each([
    ['fixes', 'fixes #7'],
    ['see', 'see #7'],
  ] as const)(
    'lands a %s tdd’s commit line and closing choice in the commit message, the PR and the run report',
    async (closes, line) => {
      const commit = { type: 'fix', scope: 'tools', subject: 'mend the x tool' };
      const run = fakeHooks({ tdd: { ...TDD_GREEN, commit, closes } });

      const report = await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, 'runner:land:7-1')).toContain(
        [
          `Write first: ${REPORT_DIR}/commit-7-1.txt`,
          '----- BEGIN FILE -----',
          'fix(tools): mend the x tool',
          '',
          line,
          '',
          'Co-Authored-By: Claude <noreply@anthropic.com>',
          '----- END FILE -----',
        ].join('\n'),
      );
      expect(run.calls.find((c) => c.label === 'runner:publish:list')?.argv).toContain(
        'fix(tools): mend the x tool',
      );
      expect(report.epics[0]?.issues).toEqual([
        { issue: 7, outcome: 'landed', cite: closes, commit: 'landed1' },
      ]);
      expect(CLOSES_SEVEN.test(promptOf(run, 'runner:publish:list'))).toBe(closes === 'fixes');
    },
  );

  it.each(['specReview:7-1', 'testReview:7-1', 'standardsReview:7-1', 'auditTests:list'])(
    'hands %s the tdd’s lease recipe',
    async (label) => {
      // A provisioned project dir unlike the batch, so a recipe built from the batch shows.
      const projectDir = 'C:/src/ph-runs/7/project-7-1';
      const run = fakeHooks({
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

  // Hand-written: the probe allowance of the tdd, the slice reviews and the test audit.
  const PROBE_CAPS = 'Probe caps: 15 min per probe, 3 probes per issue';

  it.each([
    'tdd:7-1',
    'specReview:7-1',
    'testReview:7-1',
    'standardsReview:7-1',
    'auditTests:list',
  ])('hands %s the probe caps, once', async (label) => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, label)
        .split('\n')
        .filter((l) => l.startsWith('Probe caps: ')),
    ).toEqual([PROBE_CAPS]);
  });

  it('hands no prompt any probe caps but those', async () => {
    const run = fakeHooks(TWO_ISSUES);

    await runShip(run.hooks, 'issues 7 8');

    const caps = run.calls.flatMap((c) =>
      c.prompt.split('\n').filter((l) => l.startsWith('Probe caps: ')),
    );
    expect(new Set(caps)).toEqual(new Set([PROBE_CAPS]));
  });

  // Sizing is a ticket-time job: the run judges no slice against a budget.
  it('hands no prompt a slice budget', async () => {
    const run = fakeHooks(TWO_ISSUES);

    await runShip(run.hooks, 'issues 7 8');

    expect(run.calls.filter((c) => c.prompt.includes('Slice budget:'))).toEqual([]);
  });

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

  it.each(['tdd:7-1'])(
    'hands %s the command that fetches the issue as markdown into the report dir',
    async (label) => {
      const run = fakeHooks();

      await runShip(run.hooks, 'issues 7');

      const lines = promptOf(run, label).split('\n');
      expect(lines).toContain(`Issue file: ${REPORT_DIR}/issues/7.md`);
      expect(lines).toContain(
        `Issue command: mkdir -p ${REPORT_DIR}/issues && gh issue view 7 --json title,state,labels,body,comments --jq '"# \\(.title)", "state: \\(.state)", "labels: \\([.labels[].name] | join(", "))", "", .body, (.comments[] | "", "----- comment by \\(.author.login) at \\(.createdAt) -----", .body)' > ${REPORT_DIR}/issues/7.md`,
      );
    },
  );

  it.each(['tdd:7-1', 'specReview:7-1', 'testReview:7-1', 'standardsReview:7-1'])(
    'hands %s the slice worktree the cut named',
    async (label) => {
      const run = fakeHooks();

      await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, label).split('\n')).toContain(`Slice worktree: ${SLICE_7}`);
    },
  );

  it.each(['tdd:7-1', 'specReview:7-1', 'testReview:7-1', 'standardsReview:7-1'])(
    'hands %s the slice base the cut answered',
    async (label) => {
      const run = fakeHooks();

      await runShip(run.hooks, 'issues 7');

      expect(promptOf(run, label).split('\n')).toContain('Slice base: cut1');
    },
  );

  it.each(['specReview:7-1', 'standardsReview:7-1'])(
    'orders %s’s prompt: the slice’s lines, the issue and report files, then the server-tier recipe',
    async (label) => {
      const run = fakeHooks();

      await runShip(run.hooks, 'issues 7');

      const keys = promptOf(run, label)
        .split('\n')
        .map((l) => l.slice(0, l.indexOf(': ')));
      expect(keys).toEqual([
        'Issue',
        'Slice worktree',
        'Slice base',
        'Slice commit',
        'Changed files',
        'Issue file',
        'Report file',
        'Lease command',
        'Lease version',
        'Probe caps',
      ]);
    },
  );

  it('orders the test review’s prompt as a slice review’s, with no changed files: the slice base is its fixed point', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const keys = promptOf(run, 'testReview:7-1')
      .split('\n')
      .map((l) => l.slice(0, l.indexOf(': ')));
    expect(keys).toEqual([
      'Issue',
      'Slice worktree',
      'Slice base',
      'Slice commit',
      'Issue file',
      'Report file',
      'Lease command',
      'Lease version',
      'Probe caps',
    ]);
  });

  it('orders the tdd’s prompt: the slice, the issue’s lines, its report, its kept dir, the server-tier recipe, then the message template', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const lines = promptOf(run, 'tdd:7-1').split('\n');
    const head = lines.slice(
      0,
      lines.findIndex((l) => l.startsWith('Commit message template: ')),
    );
    expect(head.map((l) => l.slice(0, l.indexOf(': ')))).toEqual([
      'Issue',
      'Attempt',
      'Slice worktree',
      'Slice base',
      'Issue file',
      'Issue command',
      'Report file',
      'Kept dir',
      'Lease command',
      'Lease version',
      'Probe caps',
    ]);
  });

  it.each([
    ['specReview:7-1', 'spec-review-7-1.md'],
    ['testReview:7-1', 'test-review-7-1.md'],
    ['standardsReview:7-1', 'standards-review-7-1.md'],
    ['specReview:7-2', 'spec-review-7-2.md'],
    ['testReview:7-2', 'test-review-7-2.md'],
    ['standardsReview:7-2', 'standards-review-7-2.md'],
  ])('hands %s its attempt’s own report file, %s', async (label, file) => {
    // A land conflict re-cuts the issue, so attempt 2's hand-off shows beside attempt 1's.
    const run = fakeHooks({ 'runner:land': inTurn(LAND_CONFLICT, LAND_OK) });

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, label)
        .split('\n')
        .filter((l) => l.startsWith('Report file: ')),
    ).toEqual([`Report file: ${REPORT_DIR}/${file}`]);
  });

  it('lands the standards review’s commit on a slice that changes no code', async () => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files: ['docs/x.md'] } });

    await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(tdd|specReview|standardsReview|runner:land):\d/.test(l)),
    ).toEqual(['tdd:7-1', 'specReview:7-1', 'standardsReview:7-1', 'runner:land:7-1']);
    expect(run.calls.find((c) => c.label === 'runner:land:7-1')?.argv[3]).toBe('slice2');
  });
});

describe('runShip — the slice test review', () => {
  it('runs the test-review agent at its tier on the spec review’s commit, handing its fixed sha to the standards review', async () => {
    const run = fakeHooks({
      testReview: { verdict: 'fixed', sha: 'test1', summary: 'pinned a bound', leaseLines: [] },
    });

    await runShip(run.hooks, 'issues 7');

    const call = run.calls.find((c) => c.label === 'testReview:7-1');
    expect({ agentType: call?.agentType, model: call?.model, effort: call?.effort }).toEqual({
      agentType: 'test-review',
      model: 'opus',
      effort: 'high',
    });
    const shaSeenBy = (label: string): string | undefined =>
      promptOf(run, label)
        .split('\n')
        .find((l) => l.startsWith('Slice commit: '));
    expect(shaSeenBy('testReview:7-1')).toBe('Slice commit: spec1');
    expect(shaSeenBy('standardsReview:7-1')).toBe('Slice commit: test1');
  });

  it.each<[name: string, files: string[], proof: unknown, proofRuns: boolean, reviewRuns: boolean]>(
    [
      ['changes no code', ['docs/x.md', '.claude/agents/x.md'], null, false, false],
      ['only adds tests', ['test/unit/x.test.ts'], null, false, true],
      [
        'changes code and tests',
        ['tooling/x.ts', 'test/unit/x.test.ts'],
        { exitCode: 0, envelopePath: 'e.json', notCompared: [] },
        false,
        true,
      ],
      [
        'proves its code change comment-only',
        ['src/a.ts', 'eslint-suppressions.json'],
        { exitCode: 0, envelopePath: 'e.json', notCompared: ['eslint-suppressions.json'] },
        true,
        false,
      ],
      [
        'fails its comment-only proof',
        ['src/a.ts'],
        { exitCode: 1, envelopePath: 'e.json', notCompared: [] },
        true,
        true,
      ],
      [
        'leaves a code path uncompared',
        ['tooling/x.ts', 'tooling/y.cts'],
        { exitCode: 0, envelopePath: 'e.json', notCompared: ['tooling/y.cts'] },
        true,
        true,
      ],
    ],
  )('for a slice that %s', async (_name, files, proof, proofRuns, reviewRuns) => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files }, 'runner:comment-only': proof });

    await runShip(run.hooks, 'issues 7');

    const sliceCalls = labels(run).filter((l) => /^(runner:comment-only|testReview):7-1/.test(l));
    expect(sliceCalls).toEqual([
      ...(proofRuns ? ['runner:comment-only:7-1'] : []),
      ...(reviewRuns ? ['testReview:7-1'] : []),
    ]);
    if (proofRuns) {
      expect(run.calls.find((c) => c.label === 'runner:comment-only:7-1')?.argv).toEqual([
        'tooling/comment-only.ts',
        '--json',
        'cut1..spec1',
      ]);
    }
  });

  it('lands a slice whose test review was skipped, its section naming why', async () => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files: ['docs/x.md'] } });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.issues).toEqual([
      { issue: 7, outcome: 'landed', cite: 'fixes', commit: 'landed1' },
    ]);
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Test review: skipped — trivial surface',
    );
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
    expect(promptOf(run, 'resolver:list').split('\n')).toEqual([
      `Batch worktree: ${BATCH}`,
      `Pending paths: ${ADR_INDEX}`,
      `Report file: ${REPORT_DIR}/resolve.md`,
    ]);
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
      issueReadiness: {
        issues: [7, 8].map((issue) => readyVerdict(issue)),
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
      issueReadiness: {
        issues: [7, 8].map((issue) => readyVerdict(issue)),
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
      issueReadiness: {
        issues: [7, 8].map((issue) => readyVerdict(issue)),
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
    const hold = holdable(/^(tdd:8-1|runner:teardown:7-1)$/);
    const run = fakeHooks(
      {
        'runner:run-gate': { ...GATE_OK, runSet: [{ epic: null, issues: [7, 8] }] },
        issueReadiness: {
          issues: [7, 8].map((issue) => readyVerdict(issue)),
        },
        'runner:land:7-1': LAND_BATCH_DIRTY,
        'tdd:8-1': TDD_STALE.tdd,
      },
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'issues 7 8');
    await idle();
    expect(hold.held()).toEqual(['tdd:8-1', 'runner:teardown:7-1']);
    hold.release('tdd:8-1');
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
        reason: 'tdd BLOCKED: x already exists at abc123',
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
    attached: null,
    hooks: run.hooks,
    queue: createCommitQueue(),
    isHalting: () => halting,
    markHalting: () => undefined,
  });
  const ENDINGS: [string, Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>][] =
    [
      [
        'landed',
        {},
        {
          kind: 'landed',
          work: {
            tdd: TDD_GREEN,
            specReview: {
              verdict: 'fixed',
              sha: 'spec1',
              summary: 'covered criterion 3',
              leaseLines: [],
            },
            testReview: {
              verdict: 'clean',
              sha: 'spec1',
              summary: 'every claim killed',
              leaseLines: [],
            },
            standardsReview: {
              verdict: 'fixed',
              sha: 'slice2',
              summary: 'renamed a helper',
              leaseLines: [],
            },
            manifestTsdoc: 'no src/ change',
          },
          commit: 'landed1',
          committedAt: LAND_OK.at,
          size: { files: 2, lines: 40 },
          halt: null,
          residue: null,
          kept: null,
          startedAt: '2026-09-29T10:00:00.000Z',
        },
      ],
      [
        'conflicted on landing',
        { 'runner:land': LAND_CONFLICT },
        {
          kind: 'unlanded',
          primary: { kind: 'harvest-conflict', issue: 7 },
          halt: null,
          residue: null,
          kept: null,
          startedAt: '2026-09-29T10:00:00.000Z',
        },
      ],
      [
        'failed its cut, naming its slice',
        { 'runner:cut-slice': CUT_FAILED },
        {
          kind: 'unlanded',
          primary: { kind: 'blocked', issue: 7, reason: 'cut-slice failed: worktree add failed' },
          halt: null,
          residue: null,
          kept: null,
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
  // the failed cut of epic 1 drop issue 2 from epic 2.
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
      issueReadiness: {
        issues: [1, ...epicTwo].map((issue) => readyVerdict(issue)),
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

describe('runShip — issue readiness', () => {
  it('refuses an issue failing a rubric point as not-ready, each failed point with its evidence', async () => {
    const run = fakeHooks({
      issueReadiness: {
        issues: [
          readyVerdict(7, { rightSized: 'title reads as a list', specified: 'no done-criteria' }),
        ],
      },
    });

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(report.refusals).toEqual([
      {
        kind: 'not-ready',
        issue: 7,
        message: 'right-sized: title reads as a list; specified: no done-criteria',
      },
    ]);
    expect(run.calls.find((c) => c.label === 'issueReadiness')).toMatchObject({
      agentType: 'issue-readiness',
      model: 'opus',
      effort: 'medium',
      prompt: 'Run-set issues: #7',
    });
  });
  it('refuses an issue both stale and not-ready once for each', async () => {
    const run = fakeHooks({
      issueReadiness: {
        issues: [readyVerdict(7, { current: 'parseFoo is gone', sliceable: 'an epic container' })],
      },
    });

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(report.refusals).toEqual([
      { kind: 'stale', issue: 7, message: 'parseFoo is gone' },
      { kind: 'not-ready', issue: 7, message: 'sliceable: an epic container' },
    ]);
  });
});

describe('runShip — exclude mode', () => {
  it('drops a not-ready issue and its dependent under its failed points', async () => {
    const run = fakeHooks({
      ...SEVEN_STALE_BLOCKS_EIGHT,
      issueReadiness: {
        issues: [
          readyVerdict(7, { unblocked: 'blocked by open #99' }),
          readyVerdict(8),
          readyVerdict(9),
        ],
      },
    });

    const report = await runShip(run.hooks, 'issues 7,8 #9 --exclude --preflight-only');

    expect(report).toMatchObject({
      status: 'preflight-ok',
      graph: { runSet: [{ epic: null, issues: [9] }], edges: [] },
      dropped: [
        { issue: 7, cause: 'not-ready', message: 'unblocked: blocked by open #99' },
        { issue: 8, cause: 'dependent', message: 'blocked by a dropped issue' },
      ],
    });
  });

  it('drops the stale issue and its dependent, keeping the rest of the graph', async () => {
    const run = fakeHooks(SEVEN_STALE_BLOCKS_EIGHT);

    const report = await runShip(run.hooks, 'issues 7,8 #9 --exclude --preflight-only');

    expect(report).toEqual({
      status: 'preflight-ok',
      graph: { runSet: [{ epic: null, issues: [9] }], edges: [] },
      overlap: { added: [], sequenced: [], areaMap: 'read' },
      dropped: [
        { issue: 7, cause: 'stale', message: 'already implemented at abc123' },
        { issue: 8, cause: 'dependent', message: 'blocked by a dropped issue' },
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
      issueReadiness: { agentType: 'issue-readiness', model: 'opus', effort: 'medium' },
      issueOverlap: { agentType: 'issue-overlap', model: 'opus', effort: 'medium' },
      tdd: { agentType: 'tdd', model: 'opus', effort: 'medium' },
      specReview: { agentType: 'spec-review', model: 'opus', effort: 'high' },
      testReview: { agentType: 'test-review', model: 'opus', effort: 'high' },
      standardsReview: { agentType: 'standards-review', model: 'opus', effort: 'high' },
      manifestTsdoc: { agentType: 'manifest-tsdoc', model: 'opus', effort: 'high' },
      resolver: { agentType: 'resolve-index-conflicts', model: 'opus', effort: 'medium' },
      auditTests: { agentType: 'audit-tests', model: 'opus', effort: 'high' },
      epicReview: { agentType: 'epic-review', model: 'opus', effort: 'high' },
      retro: { agentType: 'retro', model: 'opus', effort: 'medium' },
      prWriter: { agentType: 'pr', model: 'opus', effort: 'medium' },
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
