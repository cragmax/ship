import { describe, expect, it } from 'vitest';

import { PHASE_TITLES, SHIP_PHASES } from '../../../../tooling/workflows/lib/stages.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  BUMP_NO_OP,
  EPIC_ACCEPTED,
  fakeHooks,
  GATE_OK,
  inTurn,
  LAND_OK,
  masterMoved,
  readyVerdict,
  REPORT_DIR,
  TDD_BLOCKED,
  TDD_GREEN,
  type FakeRun,
} from './_fake-hooks.js';
import { epicRun, holdable, idle } from './_fake-parallel.js';

/** The gate and issue-readiness answers of the explicit list 7 → 8. */
const SEVEN_THEN_EIGHT = {
  'runner:run-gate': {
    ...GATE_OK,
    runSet: [{ epic: null, issues: [7, 8] }],
    edges: [{ blocker: 7, dependent: 8 }],
  },
  issueReadiness: {
    issues: [7, 8].map((issue) => readyVerdict(issue)),
  },
};

const SPEC_REVIEW_LEASED = {
  verdict: 'fixed',
  sha: 'spec1',
  summary: 'covered criterion 3',
  leaseLines: ['with-lease: waited 0.3s for folia@localhost:25703, held 8.5s'],
};

const STANDARDS_REVIEW_LEASED = {
  verdict: 'fixed',
  sha: 'slice2',
  summary: 'renamed a helper',
  leaseLines: ['with-lease: waited 0.5s for paper@localhost:25702, held 12.5s'],
};

const LAND_BATCH_DIRTY = {
  ...LAND_OK,
  status: 'refused',
  reason: 'batch-dirty',
  commit: null,
  batchClean: false,
  errors: [{ step: 'preconditions', message: 'the batch has uncommitted changes' }],
};

// Up to date, but naming no origin/master sha: the master check stops the epic
// after the PR writer ran.
const SYNC_NO_UPSTREAM = {
  exitCode: 0,
  envelopePath: 'e.json',
  status: 'ok',
  errors: [],
  outcome: 'up-to-date',
  commit: null,
  upstream: null,
  conflicts: [],
  version: null,
  pending: [],
};

const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

/**
 * The prompt of a recorded call.
 *
 * @param run - The fake run.
 * @param label - The call's label.
 * @returns Its prompt; `''` when there is none.
 */
const promptOf = (run: FakeRun, label: string): string =>
  run.calls.find((c) => c.label === label)?.prompt ?? '';

const AUDIT_CUT = {
  exitCode: 0,
  envelopePath: 'e.json',
  status: 'ok',
  errors: [],
  branch: 'slice/7-8/audit-tests',
  base: 'batchhead',
  slice: 'C:/src/ph-runs/7/slice-audit-tests',
  at: '2026-09-29T10:30:00.000Z',
};

const AUDIT_HARDENED = {
  verdict: 'hardened',
  sha: 'audit1',
  files: ['test/unit/tooling/x.test.ts'],
  commit: { type: 'test', scope: 'build', subject: 'pin the x bound' },
  survivors: 0,
  summary: 'pinned a bound',
  leaseLines: ['with-lease: waited 1.2s for folia@localhost:25711, held 40.3s'],
};

/** The run report's `## Test audit` section, its heading through its blank line. */
const auditSection = (run: FakeRun): string[] => {
  const lines = promptOf(run, 'runner:publish:list').split('\n');
  const start = lines.indexOf('## Test audit');
  return start === -1 ? [] : lines.slice(start, lines.indexOf('', start + 2) + 1);
};

describe('runShip — the epic-end test audit', () => {
  it('audits the epic’s tests in its own slice after the last landing, landing its commit before the epic review', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'runner:cut-slice:audit-tests': AUDIT_CUT,
      auditTests: AUDIT_HARDENED,
      'runner:land:audit-tests': { ...LAND_OK, commit: 'audit-landed' },
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    const all = labels(run);
    expect(all.indexOf('runner:cut-slice:audit-tests')).toBeGreaterThan(
      all.indexOf('runner:teardown:8-1'),
    );
    expect(all.slice(all.indexOf('runner:cut-slice:audit-tests'))).toEqual([
      'runner:cut-slice:audit-tests',
      'runner:provision:audit-tests',
      'auditTests:list',
      'runner:land:audit-tests',
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
    expect(run.calls.find((c) => c.label === 'runner:cut-slice:audit-tests')?.argv).toEqual([
      'tooling/worktree.ts',
      'cut-slice',
      BATCH,
      '--audit-tests',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:provision:audit-tests')?.argv).toEqual([
      'tooling/worktree.ts',
      'provision',
      'C:/src/ph-runs/7/slice-audit-tests',
      '--batch',
      BATCH,
      '--server',
    ]);
    const call = run.calls.find((c) => c.label === 'auditTests:list');
    expect(call).toMatchObject({ agentType: 'audit-tests', model: 'opus', effort: 'high' });
    const prompt = promptOf(run, 'auditTests:list').split('\n');
    expect(prompt.slice(0, 5)).toEqual([
      'Audit slice: C:/src/ph-runs/7/slice-audit-tests',
      'Slice base: batchhead',
      'Epic range: master0..HEAD',
      `Issue files: ${REPORT_DIR}/issues/7.md, ${REPORT_DIR}/issues/8.md`,
      `Report file: ${REPORT_DIR}/audit-tests.md`,
    ]);
    expect(prompt.find((l) => l.startsWith('Lease command: '))).toContain(
      `PH_PROJECT_DIR=${BATCH}`,
    );
    const land = run.calls.find((c) => c.label === 'runner:land:audit-tests');
    expect(land?.argv).toEqual([
      'tooling/worktree.ts',
      'land',
      BATCH,
      'audit1',
      '--base',
      'batchhead',
      '--message-file',
      `${REPORT_DIR}/commit-audit-tests.txt`,
      '--log',
      `${REPORT_DIR}/land-audit-tests.log`,
    ]);
    expect(land?.prompt).toContain(
      [
        `Write first: ${REPORT_DIR}/commit-audit-tests.txt`,
        '----- BEGIN FILE -----',
        'test(build): pin the x bound',
        '',
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        '----- END FILE -----',
      ].join('\n'),
    );
    expect(land?.prompt).not.toMatch(/\b(?:fixes|see) #/);
    expect(auditSection(run)).toEqual([
      '## Test audit',
      '',
      '- Outcome: landed as audit-landed',
      '- Audit: hardened, 0 surviving mutants — pinned a bound',
      '',
    ]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      auditTests: { outcome: 'landed', commit: 'audit-landed' },
    });
  });

  it('runs a test review in every slice, and the audit once at the epic end', async () => {
    const run = fakeHooks(SEVEN_THEN_EIGHT);

    await runShip(run.hooks, 'issues 7 8');

    expect(labels(run).filter((l) => /test-?review/i.test(l))).toEqual([
      'testReview:7-1',
      'testReview:8-1',
    ]);
    expect(labels(run).filter((l) => l.startsWith('auditTests'))).toEqual(['auditTests:list']);
  });

  it('lands nothing for a clean audit, and still tears its slice down', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run)).toContain('auditTests:list');
    expect(labels(run)).not.toContain('runner:land:audit-tests');
    expect(labels(run)).toContain('runner:teardown:audit-tests');
    expect(auditSection(run)).toEqual([
      '## Test audit',
      '',
      '- Outcome: no changes',
      '- Audit: clean, 0 surviving mutants — nothing to harden',
      '',
    ]);
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', auditTests: { outcome: 'clean' } });
  });

  it('counts the audit’s lease lines in its engine’s totals, under no issue', async () => {
    const run = fakeHooks({ auditTests: AUDIT_HARDENED });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.leases).toEqual({
      engines: [
        { type: 'paper', leases: 1, waitedSeconds: 1.5, waitedMaxSeconds: 1.5, heldSeconds: 42 },
        { type: 'folia', leases: 1, waitedSeconds: 1.2, waitedMaxSeconds: 1.2, heldSeconds: 40.3 },
      ],
      issues: [{ issue: 7, waitedSeconds: 1.5, heldSeconds: 42 }],
      unparsed: [],
    });
  });

  it('skips the audit for an epic that changes no code', async () => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files: ['docs/x.md'] } });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.includes('audit'))).toEqual([]);
    expect(auditSection(run)).toEqual([
      '## Test audit',
      '',
      '- Outcome: skipped — trivial surface',
      '',
    ]);
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', auditTests: { outcome: 'skipped' } });
  });

  it('skips the audit for an epic whose range is proven comment-only', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      tdd: { ...TDD_GREEN, files: ['src/a.ts', 'eslint-suppressions.json'] },
      'runner:land': inTurn(LAND_OK, { ...LAND_OK, commit: 'landed2' }),
      'runner:comment-only': {
        exitCode: 0,
        envelopePath: 'e.json',
        notCompared: ['eslint-suppressions.json'],
      },
    });

    await runShip(run.hooks, 'issues 7 8');

    expect(labels(run).filter((l) => l.includes('audit'))).toEqual([
      'runner:comment-only:audit-tests',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:comment-only:audit-tests')?.argv).toEqual([
      'tooling/comment-only.ts',
      '--json',
      'master0..landed2',
    ]);
    expect(auditSection(run)).toContain('- Outcome: skipped — comment-only');
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
  ])('runs the audit on an epic with %s', async (_name, files, proof, proofCalled, offSchema) => {
    const run = fakeHooks(
      { tdd: { ...TDD_GREEN, files }, 'runner:comment-only': proof, auditTests: AUDIT_HARDENED },
      { offSchema },
    );

    await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(runner:comment-only|auditTests):(list|audit)/.test(l)),
    ).toEqual(
      proofCalled ? ['runner:comment-only:audit-tests', 'auditTests:list'] : ['auditTests:list'],
    );
    expect(auditSection(run)).toContain('- Audit: hardened, 0 surviving mutants — pinned a bound');
  });

  it('halts the epic when the audit’s land leaves the batch unverified: no epic review, no master sync, no PR', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      auditTests: AUDIT_HARDENED,
      'runner:land:audit-tests': LAND_BATCH_DIRTY,
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(
      labels(run).filter((l) => /^(epicReview|runner:(sync-master|bump|publish))/.test(l)),
    ).toEqual([]);
    expect(labels(run)).toContain('retro:list');
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      message: expect.stringMatching(/the test audit halted the epic: .*batch-dirty/),
      auditTests: { outcome: 'dropped' },
    });
  });

  it('records an audit that returned nothing as not run, and still opens the PR', async () => {
    const run = fakeHooks({ auditTests: null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(auditSection(run)).toEqual([
      '## Test audit',
      '',
      '- Outcome: not run — the test audit returned nothing',
      '',
    ]);
    expect(labels(run)).toContain('runner:teardown:audit-tests');
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', auditTests: { outcome: 'not-run' } });
  });

  it('drops an audit commit its land refuses on a clean batch, and still opens the PR', async () => {
    const run = fakeHooks({
      auditTests: AUDIT_HARDENED,
      'runner:land:audit-tests': {
        ...LAND_OK,
        status: 'refused',
        reason: 'slice-not-single-commit',
        commit: null,
        errors: [{ step: 'preconditions', message: 'the slice is 2 commits' }],
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(auditSection(run)).toContain(
      '- Outcome: changes dropped — land refused (slice-not-single-commit): the slice is 2 commits',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', auditTests: { outcome: 'dropped' } });
  });

  it('records an audit whose slice could not be cut as not run, tearing nothing down, and still opens the PR', async () => {
    const run = fakeHooks({
      'runner:cut-slice:audit-tests': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'branch-exists',
        branch: null,
        base: null,
        slice: null,
        errors: [{ step: 'preconditions', message: 'slice/7/audit-tests exists' }],
        at: '2026-09-29T10:30:00.000Z',
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.endsWith(':audit-tests'))).toEqual([
      'runner:cut-slice:audit-tests',
    ]);
    expect(auditSection(run)).toContain(
      '- Outcome: not run — cut-slice refused (branch-exists): slice/7/audit-tests exists',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', auditTests: { outcome: 'not-run' } });
  });

  it('halts the epic when the audit’s slice teardown leaves the batch unverified: no master sync, no PR', async () => {
    const run = fakeHooks({
      'runner:teardown:audit-tests': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'source-shrank',
        removed: false,
        registered: true,
        kept: null,
        errors: [{ step: 'gate', message: 'node_modules lost 40 entries' }],
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => /^runner:(sync-master|bump|publish)/.test(l))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      message: expect.stringMatching(/source-shrank/),
      auditTests: { outcome: 'clean' },
    });
  });
});

const EPIC_REJECTED = {
  ...EPIC_ACCEPTED,
  verdict: 'rejected',
  summary: 'criterion 2 is unmet',
  criteria: [
    { issue: 7, criterion: 'adds the x tool', state: 'met', evidence: 'tooling/x.ts:1' },
    { issue: 7, criterion: 'x rejects y', state: 'unmet', evidence: 'tooling/x.ts:9 accepts y' },
    { issue: 7, criterion: 'x logs z', state: 'unchecked', evidence: 'no log fixture' },
  ],
  findings: [
    {
      view: 'duplication',
      severity: 'judgement',
      summary: 'two x parsers',
      source: 'tooling/x.ts:3, tooling/y.ts:4',
    },
  ],
  unchecked: ['architecture: no import graph tool'],
};

/** The PR body's lines, from its first through its `## Summary` heading. */
const bodyHead = (run: FakeRun): string[] => {
  const lines = promptOf(run, 'runner:publish:list').split('\n');
  const start = lines.indexOf('----- BEGIN FILE -----') + 1;
  return lines.slice(start, lines.indexOf('## Summary') + 1);
};

describe('runShip — the epic review', () => {
  it('judges the landed change on the batch after the test audit, before the master sync, with no slice', async () => {
    const run = fakeHooks(SEVEN_THEN_EIGHT);

    await runShip(run.hooks, 'issues 7 8');

    const all = labels(run);
    expect(
      all.slice(
        all.indexOf('runner:teardown:audit-tests'),
        all.indexOf('runner:sync-master:list') + 1,
      ),
    ).toEqual(['runner:teardown:audit-tests', 'epicReview:list', 'runner:sync-master:list']);
    expect(run.calls.find((c) => c.label === 'epicReview:list')).toMatchObject({
      agentType: 'epic-review',
      model: 'opus',
      effort: 'high',
    });
    expect(promptOf(run, 'epicReview:list').split('\n')).toEqual([
      `Batch worktree: ${BATCH}`,
      'Epic range: master0..HEAD',
      'Scope: profiled',
      `Issue files: ${REPORT_DIR}/issues/7.md, ${REPORT_DIR}/issues/8.md`,
      'Unlanded (JSON): []',
      `Slice reports: ${[7, 8].flatMap((i) => [`${REPORT_DIR}/spec-review-${String(i)}-1.md`, `${REPORT_DIR}/test-review-${String(i)}-1.md`, `${REPORT_DIR}/standards-review-${String(i)}-1.md`]).join(', ')}`,
      `Report file: ${REPORT_DIR}/epic-review.md`,
    ]);
  });

  it('hands an epic run’s review its epic and the command that writes the epic’s text', async () => {
    const run = fakeHooks(epicRun([{ epic: 1, issues: [1] }]));

    await runShip(run.hooks, 'epics 1');

    const lines = promptOf(run, 'epicReview:epic-1').split('\n');
    const reports = 'C:/src/ph-runs/epic-1/reports';
    expect(lines.slice(2, 5)).toEqual([
      'Scope: epic #1',
      `Epic file: ${reports}/issues/1.md`,
      `Epic command: mkdir -p ${reports}/issues && gh issue view 1 --json title,state,labels,body,comments --jq '"# \\(.title)", "state: \\(.state)", "labels: \\([.labels[].name] | join(", "))", "", .body, (.comments[] | "", "----- comment by \\(.author.login) at \\(.createdAt) -----", .body)' > ${reports}/issues/1.md`,
    ]);
  });

  it('names the landed attempt’s slice reports, not an earlier attempt’s', async () => {
    const conflict = {
      ...LAND_OK,
      status: 'conflict',
      commit: null,
      conflicts: ['tooling/x.ts'],
      rolledBack: true,
      errors: [{ step: 'cherry-pick', message: 'tooling/x.ts would not apply' }],
    };
    const run = fakeHooks({ 'runner:land': inTurn(conflict, LAND_OK) });

    await runShip(run.hooks, 'issues 7');

    expect(promptOf(run, 'epicReview:list').split('\n')).toContain(
      `Slice reports: ${REPORT_DIR}/spec-review-7-2.md, ${REPORT_DIR}/test-review-7-2.md, ${REPORT_DIR}/standards-review-7-2.md`,
    );
  });

  it('names the Manifest TSDoc report among the slice reports when that review ran', async () => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files: ['src/a.ts', 'test/unit/a.test.ts'] } });

    await runShip(run.hooks, 'issues 7');

    expect(promptOf(run, 'epicReview:list').split('\n')).toContain(
      `Slice reports: ${REPORT_DIR}/spec-review-7-1.md, ${REPORT_DIR}/test-review-7-1.md, ${REPORT_DIR}/standards-review-7-1.md, ${REPORT_DIR}/manifest-tsdoc-7-1.md`,
    );
  });

  it('leaves the test review report out of the slice reports when that review was skipped', async () => {
    const run = fakeHooks({ tdd: { ...TDD_GREEN, files: ['docs/x.md'] } });

    await runShip(run.hooks, 'issues 7');

    expect(promptOf(run, 'epicReview:list').split('\n')).toContain(
      `Slice reports: ${REPORT_DIR}/spec-review-7-1.md, ${REPORT_DIR}/standards-review-7-1.md`,
    );
  });

  it('leads the PR body with its verdict, marked profiled for a list, and opens the PR ready', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7');

    expect(bodyHead(run)).toEqual([
      '## Epic review',
      '',
      '**Verdict:** accepted (profiled)',
      '',
      '- every criterion met',
      '- Criteria: 1 of 1 met',
      '',
      '## Summary',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:publish:list')?.argv).not.toContain('--draft');
    expect(report.epics[0]).toMatchObject({
      epicReview: { verdict: 'accepted', profiled: true },
    });
  });

  it('marks an epic run’s verdict unprofiled', async () => {
    const run = fakeHooks(epicRun([{ epic: 1, issues: [1] }]));

    const report = await runShip(run.hooks, 'epics 1');

    expect(report.epics[0]).toMatchObject({ epicReview: { verdict: 'accepted', profiled: false } });
  });

  it('opens a rejected change as a draft, its criteria not met, findings and unread views in the lead', async () => {
    const run = fakeHooks({ epicReview: EPIC_REJECTED });

    await runShip(run.hooks, 'issues 7');

    expect(bodyHead(run)).toEqual([
      '## Epic review',
      '',
      '**Verdict:** rejected (profiled)',
      '',
      '- criterion 2 is unmet',
      '- Criteria: 1 of 3 met',
      '- #7 unmet: x rejects y — tooling/x.ts:9 accepts y',
      '- #7 unchecked: x logs z — no log fixture',
      '- [duplication, judgement] two x parsers — tooling/x.ts:3, tooling/y.ts:4',
      '- Unchecked: architecture: no import graph tool',
      '',
      '## Summary',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:publish:list')?.argv.at(-1)).toBe('--draft');
  });

  it('forces rejected when an issue did not land, whatever the review answered, and opens a draft', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'runner:run-gate': { ...SEVEN_THEN_EIGHT['runner:run-gate'], edges: [] },
      tdd: (call: { label: string }) => (call.label.startsWith('tdd:8') ? TDD_BLOCKED : TDD_GREEN),
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(promptOf(run, 'epicReview:list').split('\n')).toContain(
      'Unlanded (JSON): [{"issue":8,"outcome":"blocked","reason":"tdd BLOCKED: done at abc123"}]',
    );
    expect(bodyHead(run).slice(0, 5)).toEqual([
      '## Epic review',
      '',
      '**Verdict:** rejected (profiled)',
      '',
      '- Forced rejected: did not land: #8',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:publish:list')?.argv).toContain('--draft');
    expect(report.epics[0]).toMatchObject({ epicReview: { verdict: 'rejected' } });
  });

  it('records a review that returned nothing as not run, and opens the PR as a draft', async () => {
    const run = fakeHooks({ epicReview: null });

    await runShip(run.hooks, 'issues 7');

    expect(bodyHead(run)).toEqual([
      '## Epic review',
      '',
      '**Verdict:** not run (profiled)',
      '',
      '- Not run: the epic review returned nothing',
      '',
      '## Summary',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:publish:list')?.argv).toContain('--draft');
  });
});

describe('runShip — the retro', () => {
  const FINDING = {
    title: 'land conflicts on x',
    evidence: `${REPORT_DIR}/land-7-1.log`,
    kind: 'genuine',
    suggestion: 'split x.ts',
  };

  it('runs once for a halted entry, its findings in the report, and publishes nothing', async () => {
    const run = fakeHooks({ 'runner:land': LAND_BATCH_DIRTY, retro: { findings: [FINDING] } });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('retro'))).toEqual(['retro:list']);
    expect(labels(run).filter((l) => l.startsWith('runner:publish'))).toEqual([]);
    expect(report.epics[0]).toMatchObject({ outcome: 'halted', retro: [FINDING] });
  });

  it('runs once for an entry that landed nothing', async () => {
    const run = fakeHooks({
      tdd: TDD_BLOCKED,
      retro: { findings: [FINDING] },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('retro'))).toEqual(['retro:list']);
    expect(report.epics[0]).toMatchObject({ outcome: 'nothing-landed', retro: [FINDING] });
    const prompt = promptOf(run, 'retro:list');
    expect(prompt).toContain('Epic: an explicit issue list');
    expect(prompt).toContain(`Report dir: ${REPORT_DIR}`);
    expect(prompt).toMatch(/^Run report \(JSON\): \{.*"outcome":"nothing-landed"/m);
  });

  it.each([
    [
      'a master sync code conflict',
      {
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
      },
    ],
    [
      'a bump that threw',
      {
        'runner:bump': () => {
          throw new Error('runner crashed');
        },
      },
    ],
  ])(
    'runs once for an epic end stopped by %s, reading the stopped outcome',
    async (_name, stop) => {
      const run = fakeHooks({ ...stop, retro: { findings: [FINDING] } });

      const report = await runShip(run.hooks, 'issues 7');

      expect(labels(run).filter((l) => l.startsWith('retro'))).toEqual(['retro:list']);
      expect(promptOf(run, 'retro:list')).toMatch(/^Run report \(JSON\): \{.*"outcome":"stopped"/m);
      expect(report.epics[0]).toMatchObject({ outcome: 'stopped', retro: [FINDING] });
    },
  );

  it('records a retro that returned nothing as null', async () => {
    const run = fakeHooks({ retro: null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({ outcome: 'pr', retro: null });
  });
});

describe('runShip — the bump', () => {
  it('goes on to the retro, the PR writer and the PR when the bump finds the version already at its target', async () => {
    const run = fakeHooks({ 'runner:bump': BUMP_NO_OP });

    const report = await runShip(run.hooks, 'issues 7');

    const all = labels(run);
    expect(all.slice(all.indexOf('runner:bump:list'))).toEqual([
      'runner:bump:list',
      'retro:list',
      'prWriter:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
    ]);
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 42 });
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Version bump: patch, already at 1.0.1 — no commit',
    );
  });
});

/**
 * The PR body the publish call writes, line for line.
 *
 * @param run - The fake run.
 * @returns The lines of the publish prompt's first file block.
 */
const bodyOf = (run: FakeRun): string[] => {
  const lines = promptOf(run, 'runner:publish:list').split('\n');
  return lines.slice(
    lines.indexOf('----- BEGIN FILE -----') + 1,
    lines.indexOf('----- END FILE -----'),
  );
};

describe('runShip — the PR writer', () => {
  it('writes the PR writer’s summary after the epic review and its merge danger after the Evidence', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const body = bodyOf(run);
    const at = body.indexOf('## Summary');
    expect(body.slice(at, at + 5)).toEqual([
      '## Summary',
      '',
      'Adds the x tool.',
      '',
      '## Evidence',
    ]);
    const d = body.indexOf('## Merge Danger');
    expect(body.slice(d, d + 7)).toEqual([
      '## Merge Danger',
      '',
      '**Door:** two-way',
      '',
      '**Blast Radius:** tooling',
      '',
      '## Issues',
    ]);
    expect(d).toBeGreaterThan(body.indexOf('## Evidence'));
  });

  it('hands the PR writer the epic, the batch worktree, the PR’s net diff range, the landed issues and the report dir', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    expect(promptOf(run, 'prWriter:list').split('\n')).toEqual([
      'Epic: an explicit issue list',
      `Batch worktree: ${BATCH}`,
      'Diff range: origin0...HEAD',
      `Landed (JSON): ${JSON.stringify([
        {
          issue: 7,
          commit: LAND_OK.commit,
          subject: TDD_GREEN.commit.subject,
        },
      ])}`,
      `Report dir: ${REPORT_DIR}`,
    ]);
  });

  it('falls back to the batch base for the diff range when the sync named no origin/master sha', async () => {
    const run = fakeHooks({ 'runner:sync-master': SYNC_NO_UPSTREAM });

    await runShip(run.hooks, 'issues 7');

    expect(promptOf(run, 'prWriter:list').split('\n')).toContain('Diff range: master0...HEAD');
  });

  it('hands the PR writer every landed issue, in landing order', async () => {
    const run = fakeHooks(SEVEN_THEN_EIGHT);

    await runShip(run.hooks, 'issues 7 8');

    const line = promptOf(run, 'prWriter:list')
      .split('\n')
      .find((l) => l.startsWith('Landed (JSON): '));
    const landed = JSON.parse(line?.slice('Landed (JSON): '.length) ?? '[]') as {
      issue: number;
    }[];
    expect(landed.map((l) => l.issue)).toEqual([7, 8]);
  });

  it('names each epic, its batch worktree and its report dir to that epic’s PR writer', async () => {
    const run = fakeHooks(
      epicRun([
        { epic: 1, issues: [1] },
        { epic: 2, issues: [3] },
      ]),
    );

    await runShip(run.hooks, 'epics 1 2');

    for (const epic of [1, 2]) {
      const lines = promptOf(run, `prWriter:epic-${String(epic)}`).split('\n');
      const root = `C:/src/ph-runs/epic-${String(epic)}`;
      expect([lines[0], lines[1], lines.at(-1)]).toEqual([
        `Epic: #${String(epic)}`,
        `Batch worktree: ${root}/batch`,
        `Report dir: ${root}/reports`,
      ]);
    }
  });

  it.each<[string, unknown]>([
    ['returns nothing', null],
    [
      'throws',
      () => {
        throw new Error('the PR writer died');
      },
    ],
  ])(
    'still opens the PR when the PR writer %s, its body carrying the fallback lines',
    async (_name, answer) => {
      const run = fakeHooks({ prWriter: answer });

      const report = await runShip(run.hooks, 'issues 7');

      expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 42 });
      const body = bodyOf(run);
      expect(body).toContain('Summary unavailable — the PR writer returned nothing');
      expect(body).toContain('Unavailable — the PR writer returned nothing');
      expect(body).not.toContain('<details><summary>Run report</summary>');
    },
  );

  it('runs the PR writer while the retro is still in flight, and publishes after both', async () => {
    const hold = holdable(/^retro:/);
    const run = fakeHooks({}, { gate: hold.gate });

    const done = runShip(run.hooks, 'issues 7');
    await idle();

    expect(hold.held()).toEqual(['retro:list']);
    expect(labels(run)).toContain('prWriter:list');
    expect(labels(run)).not.toContain('runner:preflight:list');
    hold.releaseAll();
    await expect(done).resolves.toMatchObject({ status: 'done' });
  });

  it('publishes the PR writer’s sections when the retro beside it throws', async () => {
    const run = fakeHooks({
      retro: () => {
        throw new Error('the retro died');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 42, retro: null });
    const body = bodyOf(run);
    expect(body.slice(body.indexOf('## Summary'), body.indexOf('## Summary') + 3)).toEqual([
      '## Summary',
      '',
      'Adds the x tool.',
    ]);
  });

  it.each([
    ['halted', { 'runner:land': LAND_BATCH_DIRTY }],
    [
      'stopped at its bump',
      {
        'runner:bump': () => {
          throw new Error('runner crashed');
        },
      },
    ],
  ])('runs no PR writer for an entry %s', async (_name, responses) => {
    const run = fakeHooks(responses);

    await runShip(run.hooks, 'issues 7');

    expect(labels(run)).toContain('retro:list');
    expect(labels(run).filter((l) => l.startsWith('prWriter'))).toEqual([]);
  });

  it('runs the PR writer outside the repo lock: another epic publishes while it is held', async () => {
    const hold = holdable(/^prWriter:epic-1$/);
    const run = fakeHooks(
      epicRun([
        { epic: 1, issues: [1] },
        { epic: 2, issues: [3] },
      ]),
      { gate: hold.gate },
    );

    const done = runShip(run.hooks, 'epics 1 2');
    await idle();

    expect(hold.held()).toEqual(['prWriter:epic-1']);
    expect(labels(run)).toContain('runner:publish:epic-2');
    hold.releaseAll();
    await done;
  });
});

describe('the epic-end phase', () => {
  it('names the test audit first and the PR writer beside the retro in its detail', () => {
    expect(SHIP_PHASES.find((p) => p.title === PHASE_TITLES.epicEnd)?.detail).toBe(
      'per epic: test audit, epic review, master sync, version bump, retro and PR writer (concurrently), master check, pull request',
    );
  });
});

describe('runShip — the lease totals', () => {
  it('totals only the landed slice’s lease lines, into the report and the PR body', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.leases).toEqual({
      engines: [
        { type: 'paper', leases: 1, waitedSeconds: 1.5, waitedMaxSeconds: 1.5, heldSeconds: 42 },
        { type: 'folia', leases: 0, waitedSeconds: 0, waitedMaxSeconds: 0, heldSeconds: 0 },
      ],
      issues: [{ issue: 7, waitedSeconds: 1.5, heldSeconds: 42 }],
      unparsed: [],
    });
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- paper: 1 leases, waited 1.5s total (max 1.5s), held 42.0s total',
    );
  });

  it('labels the slice reviews’ leases after the tdd’s in the issue’s lease timings', async () => {
    const run = fakeHooks({
      specReview: SPEC_REVIEW_LEASED,
      standardsReview: STANDARDS_REVIEW_LEASED,
    });

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, 'runner:publish:list')
        .split('\n')
        .filter((l) => l.startsWith('- Lease timings: ')),
    ).toEqual([
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; spec-review: folia@localhost:25703 waited 0.3s, held 8.5s; standards-review: paper@localhost:25702 waited 0.5s, held 12.5s',
    ]);
  });

  it('counts a landed issue’s test-review lease under the issue, in a test-review role', async () => {
    const run = fakeHooks({
      testReview: {
        verdict: 'fixed',
        sha: 'test1',
        summary: 'pinned a bound',
        leaseLines: ['with-lease: waited 2.5s for folia@localhost:25712, held 33.0s'],
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.leases).toEqual({
      engines: [
        { type: 'paper', leases: 1, waitedSeconds: 1.5, waitedMaxSeconds: 1.5, heldSeconds: 42 },
        { type: 'folia', leases: 1, waitedSeconds: 2.5, waitedMaxSeconds: 2.5, heldSeconds: 33 },
      ],
      issues: [{ issue: 7, waitedSeconds: 4, heldSeconds: 75 }],
      unparsed: [],
    });
    expect(
      promptOf(run, 'runner:publish:list')
        .split('\n')
        .filter((l) => l.startsWith('- Lease timings: ')),
    ).toEqual([
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; test-review: folia@localhost:25712 waited 2.5s, held 33s',
    ]);
  });

  it('counts a landed issue’s standards-review lease in its engine’s and its issue’s totals', async () => {
    const run = fakeHooks({ standardsReview: STANDARDS_REVIEW_LEASED });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.leases).toEqual({
      engines: [
        { type: 'paper', leases: 2, waitedSeconds: 2, waitedMaxSeconds: 1.5, heldSeconds: 54.5 },
        { type: 'folia', leases: 0, waitedSeconds: 0, waitedMaxSeconds: 0, heldSeconds: 0 },
      ],
      issues: [{ issue: 7, waitedSeconds: 2, heldSeconds: 54.5 }],
      unparsed: [],
    });
  });

  it('still totals the landed slices’ lease lines when the test audit halts the epic', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      auditTests: { ...AUDIT_HARDENED, leaseLines: [] },
      'runner:land:audit-tests': LAND_BATCH_DIRTY,
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(report.epics[0]).toMatchObject({ outcome: 'halted' });
    expect(report.epics[0]?.leases).toEqual({
      engines: [
        { type: 'paper', leases: 2, waitedSeconds: 3, waitedMaxSeconds: 1.5, heldSeconds: 84 },
        { type: 'folia', leases: 0, waitedSeconds: 0, waitedMaxSeconds: 0, heldSeconds: 0 },
      ],
      issues: [
        { issue: 7, waitedSeconds: 1.5, heldSeconds: 42 },
        { issue: 8, waitedSeconds: 1.5, heldSeconds: 42 },
      ],
      unparsed: [],
    });
  });
});

describe('runShip — the tdd’s evidence', () => {
  it('renders the landed slice’s tracer red-green as the PR body’s Evidence bullet', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const lines = promptOf(run, 'runner:publish:list').split('\n');
    const at = lines.indexOf('## Evidence');
    expect(lines.slice(at, at + 9)).toEqual([
      '## Evidence',
      '',
      '- **#7** `test/unit/tooling/x.test.ts › adds x`',
      '  ```text',
      '  x()',
      '    returns 1',
      '  ```',
      '  **Before:** AssertionError: expected undefined to be 1',
      '  **After:** ✓ test/unit/tooling/x.test.ts › adds x',
    ]);
  });
});

describe('runShip — the slice review lines', () => {
  it('carries each landed issue’s own spec review outcome into its PR-body section', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'specReview:7-1': { ...SPEC_REVIEW_LEASED, leaseLines: [] },
      'specReview:8-1': { verdict: 'clean', sha: 'slice1', summary: 'all met', leaseLines: [] },
    });

    await runShip(run.hooks, 'issues 7 8');

    expect(
      promptOf(run, 'runner:publish:list')
        .split('\n')
        .filter((l) => l.startsWith('- Spec review: ')),
    ).toEqual(['- Spec review: fixed — covered criterion 3', '- Spec review: clean — all met']);
  });
});

describe('runShip — the landing commit message', () => {
  it('lands the slice with a message file of the subject, the closing line and the trailer', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const land = run.calls.find((c) => c.label === 'runner:land:7-1');
    const flag = land?.argv.indexOf('--message-file') ?? -1;
    expect(land?.argv.slice(flag, flag + 2)).toEqual([
      '--message-file',
      `${REPORT_DIR}/commit-7-1.txt`,
    ]);
    expect(land?.prompt).toContain(
      [
        `Write first: ${REPORT_DIR}/commit-7-1.txt`,
        '----- BEGIN FILE -----',
        'feat(build): add the x tool',
        '',
        'fixes #7',
        '',
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        '----- END FILE -----',
      ].join('\n'),
    );
  });
});

describe('runShip — recorded', () => {
  it('renders each landed slice’s recorded values under its issue in a ## Recorded section between the Issues list and the run report', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'tdd:7-1': { ...TDD_GREEN, recorded: ['a', 'b'] },
    });

    await runShip(run.hooks, 'issues 7 8');

    const body = bodyOf(run);
    const at = body.indexOf('## Recorded');
    expect(at).toBeGreaterThan(body.indexOf('## Issues'));
    expect(body.slice(at, at + 7)).toEqual([
      '## Recorded',
      '',
      '- #7',
      '  - `a`',
      '  - `b`',
      '',
      '<details><summary>Run report</summary>',
    ]);
  });
});

describe('runShip — the PR body limit', () => {
  const OVER_LIMIT = {
    retro: {
      findings: [{ title: 'big', evidence: 'e'.repeat(66_000), kind: 'genuine', suggestion: 's' }],
    },
  };
  const pointer = (file: string): string =>
    `Moved to a PR comment: the body was over GitHub's 65536-character limit. Also in \`${REPORT_DIR}/${file}\`.`;

  it('publishes the body with the bulky sections moved out, then posts each as a PR comment', async () => {
    const run = fakeHooks(OVER_LIMIT);

    const report = await runShip(run.hooks, 'issues 7');

    const body = bodyOf(run);
    expect(body).toContain(pointer('pr-comment-schedule.md'));
    expect(body).toContain(pointer('pr-comment-retro-findings.md'));
    expect(body.filter((l) => l.startsWith('- big (genuine)'))).toEqual([]);
    const posts = run.calls.filter((c) => c.label === 'runner:post-pr-comment:list');
    expect(posts.map((c) => c.argv)).toEqual(
      ['pr-comment-schedule.md', 'pr-comment-retro-findings.md'].map((file) => [
        'tooling/worktree.ts',
        'post-pr-comment',
        BATCH,
        '--pr',
        '42',
        '--comment-file',
        `${REPORT_DIR}/${file}`,
      ]),
    );
    const [schedule, retro] = posts.map((c) => {
      const lines = c.prompt.split('\n');
      return lines.slice(
        lines.indexOf('----- BEGIN FILE -----') + 1,
        lines.indexOf('----- END FILE -----'),
      );
    });
    expect(schedule?.slice(0, 2)).toEqual(['## Schedule', '']);
    expect(schedule?.[2]).toMatch(/^- #7: blockers none; /);
    expect(retro).toEqual(['## Retro findings', '', `- big (genuine): ${'e'.repeat(66_000)} — s`]);
    const all = labels(run);
    expect(all.indexOf('runner:post-pr-comment:list')).toBeGreaterThan(
      all.indexOf('runner:publish:list'),
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 42 });
    expect(report.epics[0]).not.toHaveProperty('prReportComment');
    expect(report.epics[0]).not.toHaveProperty('recovery');
  });

  it('posts no comment for a body within the limit', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:post-pr-comment'))).toEqual([]);
    expect(bodyOf(run).filter((l) => l.startsWith('Moved to a PR comment'))).toEqual([]);
  });

  it('reports each failed post, every post still made and the PR standing', async () => {
    const run = fakeHooks({
      ...OVER_LIMIT,
      'runner:post-pr-comment': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'body-too-long', message: 'm' }],
        url: null,
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l === 'runner:post-pr-comment:list')).toHaveLength(2);
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      pr: 42,
      prReportComment: 'post-pr-comment failed: m; post-pr-comment failed: m',
    });
  });

  it('posts nothing when the publish opens no PR', async () => {
    const run = fakeHooks({ ...OVER_LIMIT, 'runner:publish': null });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:post-pr-comment'))).toEqual([]);
    expect(report.epics[0]?.outcome).toBe('stopped');
    expect(report.epics[0]).not.toHaveProperty('prReportComment');
  });
});

const PUBLISH_FAILED = {
  exitCode: 1,
  envelopePath: 'e.json',
  status: 'failed',
  errors: [{ step: 'push', message: 'the pre-push gate failed' }],
  pushed: false,
  pr: null,
  mergeable: null,
};

/** Every file a run's runner prompts write first, by path. */
const writtenFiles = (run: FakeRun): string[] =>
  run.calls.flatMap((c) =>
    c.prompt
      .split('\n')
      .filter((l) => l.startsWith('Write first: '))
      .map((l) => l.slice('Write first: '.length)),
  );

/** The files a recovery's commands name: each word after a `--*-file` flag. */
const namedFiles = (commands: readonly string[]): string[] =>
  commands.flatMap((c) =>
    [...c.matchAll(/--(?:body|comment|section)-file (\S+)/g)].map((m) => m[1] ?? ''),
  );

describe('runShip — a failed publish’s recovery', () => {
  it('stops the epic with the publish command it ran and one post-pr-comment per moved section, each file written', async () => {
    const run = fakeHooks({
      retro: {
        findings: [
          { title: 'big', evidence: 'e'.repeat(66_000), kind: 'genuine', suggestion: 's' },
        ],
      },
      'runner:publish': PUBLISH_FAILED,
    });

    const report = await runShip(run.hooks, 'issues 7');

    const recovery = report.epics[0]?.recovery ?? [];
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: 'publish failed: the pre-push gate failed',
    });
    expect(recovery).toEqual([
      `npx tsx tooling/worktree.ts publish ${BATCH} --title 'feat(build): add the x tool' --body-file ${REPORT_DIR}/pr-body.md --log ${REPORT_DIR}/publish.log`,
      `npx tsx tooling/worktree.ts post-pr-comment ${BATCH} --pr <pr> --comment-file ${REPORT_DIR}/pr-comment-schedule.md`,
      `npx tsx tooling/worktree.ts post-pr-comment ${BATCH} --pr <pr> --comment-file ${REPORT_DIR}/pr-comment-retro-findings.md`,
    ]);
    expect(promptOf(run, 'runner:publish:list').split('\n')[0]).toBe(
      `Command: ${recovery[0] ?? ''}`,
    );
    expect(writtenFiles(run)).toEqual(expect.arrayContaining(namedFiles(recovery)));
    expect(namedFiles(recovery)).toHaveLength(3);
    const lines = promptOf(run, 'runner:publish:list').split('\n');
    const head = (file: string): string[] => {
      const at = lines.indexOf(`Write first: ${REPORT_DIR}/${file}`);
      return lines.slice(at, at + 3);
    };
    expect(head('pr-comment-schedule.md')).toEqual([
      `Write first: ${REPORT_DIR}/pr-comment-schedule.md`,
      '----- BEGIN FILE -----',
      '## Schedule',
    ]);
    expect(head('pr-comment-retro-findings.md')).toEqual([
      `Write first: ${REPORT_DIR}/pr-comment-retro-findings.md`,
      '----- BEGIN FILE -----',
      '## Retro findings',
    ]);
    expect(labels(run).filter((l) => /^runner:(teardown|retire-run):list$/.test(l))).toEqual([]);
  });

  it('keeps --draft in the recovery’s publish command when the epic end opened a draft', async () => {
    const run = fakeHooks({ epicReview: EPIC_REJECTED, 'runner:publish': PUBLISH_FAILED });

    const report = await runShip(run.hooks, 'issues 7');

    const recovery = report.epics[0]?.recovery ?? [];
    expect(recovery).toEqual([
      `npx tsx tooling/worktree.ts publish ${BATCH} --title 'feat(build): add the x tool' --body-file ${REPORT_DIR}/pr-body.md --log ${REPORT_DIR}/publish.log --draft`,
    ]);
    expect(promptOf(run, 'runner:publish:list').split('\n')[0]).toBe(
      `Command: ${recovery[0] ?? ''}`,
    );
  });
});

describe('runShip — a stop before the publish carries no recovery', () => {
  it.each([
    [
      'a master sync code conflict',
      {
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
      },
      'master sync code-conflict: sync-master refused (code-conflict): src/a.ts conflicts',
    ],
    [
      'a failed bump',
      {
        'runner:bump': {
          exitCode: 1,
          envelopePath: 'e.json',
          status: 'failed',
          errors: [{ step: 'commit', message: 'the hook failed' }],
          kind: 'minor',
          from: '1.0.0',
          to: '1.1.0',
          commit: null,
        },
      },
      'bump failed: the hook failed',
    ],
    [
      'a failed master check',
      masterMoved({ move: 'rewound', current: 'older1' }, { move: 'equal', current: 'origin0' }),
      'master check failed: local master rewound: launch local0, now older1 — restore it from local0',
    ],
  ])('stops on %s with its message alone', async (_name, stop, message) => {
    const run = fakeHooks(stop);

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({ outcome: 'stopped', message });
    expect(report.epics[0]).not.toHaveProperty('recovery');
    expect(labels(run).filter((l) => l.startsWith('runner:publish'))).toEqual([]);
  });
});

describe('runShip — a nothing-landed run cleans up after itself', () => {
  // Issue 7's tdd blocked, so the entry lands nothing.
  const TDD_STALE = { tdd: TDD_BLOCKED };

  it('tears its batch down after the retro, then retires its branch from the main checkout', async () => {
    const run = fakeHooks(TDD_STALE);

    const report = await runShip(run.hooks, 'issues 7');

    expect(
      labels(run).filter((l) => /^(retro|runner:(teardown|retire-run)):list$/.test(l)),
    ).toEqual(['retro:list', 'runner:teardown:list', 'runner:retire-run:list']);
    expect(run.calls.find((c) => c.label === 'runner:teardown:list')?.argv).toEqual([
      'tooling/worktree.ts',
      'teardown',
      BATCH,
    ]);
    expect(run.calls.find((c) => c.label === 'runner:retire-run:list')?.argv).toEqual([
      'tooling/worktree.ts',
      'retire-run',
      '.',
      '--branch',
      'ship/7',
    ]);
    expect(promptOf(run, 'runner:teardown:list').split('\n')).toContain(
      `Envelope dir: ${REPORT_DIR}/tool`,
    );
    expect(promptOf(run, 'runner:retire-run:list').split('\n')).toContain(
      'Envelope dir: reports/tool',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'nothing-landed', residue: [], retro: [] });
  });

  it.each([
    {
      name: 'failed',
      answer: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'remove', message: 'busy' }],
        removed: false,
        registered: true,
        kept: null,
      },
      residue: `${BATCH}: teardown failed: busy`,
    },
    {
      name: 'thrown',
      answer: () => {
        throw new Error('runner crashed');
      },
      residue: `${BATCH}: the runner returned nothing for teardown`,
    },
  ])('records a $name batch teardown as residue and retires nothing', async (c) => {
    const run = fakeHooks({ ...TDD_STALE, 'runner:teardown:list': c.answer });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:retire-run'))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      residue: [c.residue],
      retro: [],
    });
  });

  it.each([
    {
      name: 'refused',
      answer: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'branch-unmerged',
        errors: [{ step: 'branch-guard', message: 'ship/7 is not in origin/master' }],
      },
      residue: 'ship/7: retire-run refused (branch-unmerged): ship/7 is not in origin/master',
    },
    {
      name: 'thrown',
      answer: () => {
        throw new Error('runner crashed');
      },
      residue: 'ship/7: the runner returned nothing for retire-run',
    },
  ])('records a $name retire-run as residue and still ends the entry', async (c) => {
    const run = fakeHooks({ ...TDD_STALE, 'runner:retire-run:list': c.answer });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      residue: [c.residue],
      retro: [],
    });
  });

  it('keeps a slice teardown’s residue ahead of its own cleanup’s', async () => {
    const run = fakeHooks({
      ...TDD_STALE,
      'runner:teardown:7-1': () => {
        throw new Error('runner crashed');
      },
      'runner:retire-run:list': () => {
        throw new Error('runner crashed');
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]).toMatchObject({
      outcome: 'nothing-landed',
      residue: [
        'the runner returned nothing for teardown',
        'ship/7: the runner returned nothing for retire-run',
      ],
      retro: [],
    });
  });

  it('cleans nothing up for a halted entry', async () => {
    const run = fakeHooks({ 'runner:land': LAND_BATCH_DIRTY });

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run)).not.toContain('runner:teardown:list');
    expect(labels(run).filter((l) => l.startsWith('runner:retire-run'))).toEqual([]);
    expect(report.epics[0]).toMatchObject({ outcome: 'halted' });
  });
});
