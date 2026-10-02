import { describe, expect, it } from 'vitest';

import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  fakeHooks,
  GATE_OK,
  LAND_OK,
  PLAN_CARD,
  REPORT_DIR,
  type FakeRun,
} from './_fake-hooks.js';

/** The gate and scout answers of the explicit list 7 → 8. */
const SEVEN_THEN_EIGHT = {
  'runner:run-gate': {
    ...GATE_OK,
    runSet: [{ epic: null, issues: [7, 8] }],
    edges: [{ blocker: 7, dependent: 8 }],
  },
  scout: {
    issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
    overlaps: [],
  },
};

const CRITIC_CUT = {
  exitCode: 0,
  envelopePath: 'e.json',
  status: 'ok',
  errors: [],
  branch: 'slice/7-8/critic',
  base: 'batchhead',
  slice: 'C:/src/ph-runs/7/slice-critic',
  at: '2026-09-29T10:30:00.000Z',
};

const CRITIC_APPLIED = {
  outcome: 'applied',
  sha: 'critic1',
  files: ['tooling/x.ts'],
  commit: { type: 'refactor', scope: 'build', subject: 'share the x helper' },
  findings: [{ lens: 'duplication', summary: 'two copies of the x helper', applied: true }],
  checks: 'build, eslint, vitest related, prettier',
};

const TEST_REVIEW_LEASED = {
  verdict: 'hardened',
  sha: 'slice3',
  survivors: 0,
  summary: 'pinned a bound',
  leaseLines: ['with-lease: waited 1.2s for folia@localhost:25711, held 40.3s'],
};

const REVIEW_LEASED = {
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

describe('runShip — the critic', () => {
  it('runs in its own slice before the master sync, landing its commit through land, then bump, retro, PR', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'runner:cut-slice:critic': CRITIC_CUT,
      critic: CRITIC_APPLIED,
      'runner:land:critic': { ...LAND_OK, commit: 'critic-landed' },
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    const all = labels(run);
    expect(all.slice(all.indexOf('runner:cut-slice:critic'))).toEqual([
      'runner:cut-slice:critic',
      'runner:provision:critic',
      'critic:list',
      'runner:land:critic',
      'runner:teardown:critic',
      'runner:sync-master:list',
      'runner:bump:list',
      'retro:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
      'runner:pr-review:list',
      'curator:list',
      'runner:pr-comment:list',
    ]);
    const land = run.calls.find((c) => c.label === 'runner:land:critic');
    expect(land?.argv).toEqual([
      'tooling/worktree.ts',
      'land',
      BATCH,
      'critic1',
      '--base',
      'batchhead',
      '--message-file',
      `${REPORT_DIR}/commit-critic.txt`,
      '--log',
      `${REPORT_DIR}/land-critic.log`,
    ]);
    expect(land?.prompt).toContain(
      [
        `Write first: ${REPORT_DIR}/commit-critic.txt`,
        '----- BEGIN FILE -----',
        'refactor(build): share the x helper',
        '',
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        '----- END FILE -----',
      ].join('\n'),
    );
    expect(land?.prompt).not.toMatch(/\b(?:fixes|see) #/);
    const critic = promptOf(run, 'critic:list').split('\n');
    expect(critic.slice(0, 2)).toEqual([
      'Critic slice: C:/src/ph-runs/7/slice-critic',
      'Epic range: master0..HEAD',
    ]);
    expect(critic).toContain(`Report file: ${REPORT_DIR}/critic.md`);
    const landed = critic.find((l) => l.startsWith('Landed (JSON): '))?.slice(15) ?? 'null';
    expect(JSON.parse(landed)).toEqual([
      { issue: 7, commit: 'landed1', plan: PLAN_CARD.planPath },
      { issue: 8, commit: 'landed1', plan: PLAN_CARD.planPath },
    ]);
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Outcome: landed as critic-landed',
    );
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      critic: { outcome: 'landed', commit: 'critic-landed' },
    });
  });

  it('lands nothing for a clean critic', async () => {
    const run = fakeHooks(SEVEN_THEN_EIGHT);

    await runShip(run.hooks, 'issues 7 8');

    expect(labels(run)).toContain('critic:list');
    expect(labels(run)).not.toContain('runner:land:critic');
    expect(labels(run)).toContain('runner:teardown:critic');
  });

  it('skips the critic when one issue landed', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.includes('critic'))).toEqual([]);
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Outcome: skipped — one issue landed',
    );
  });

  it('drops a critic commit its land refuses on a clean batch, and still opens the PR', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      critic: CRITIC_APPLIED,
      'runner:land:critic': {
        ...LAND_OK,
        status: 'refused',
        reason: 'slice-not-single-commit',
        commit: null,
        errors: [{ step: 'preconditions', message: 'the slice is 2 commits' }],
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Outcome: changes dropped — land refused (slice-not-single-commit): the slice is 2 commits',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', critic: { outcome: 'dropped' } });
  });

  it('halts the epic when the critic’s land leaves the batch unverified: no master sync, no PR', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      critic: CRITIC_APPLIED,
      'runner:land:critic': LAND_BATCH_DIRTY,
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(labels(run).filter((l) => /^runner:(sync-master|bump|publish)/.test(l))).toEqual([]);
    expect(labels(run)).toContain('retro:list');
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      message: expect.stringMatching(/batch-dirty/),
    });
  });

  it('records a critic that returned nothing as not run, and still opens the PR', async () => {
    const run = fakeHooks({ ...SEVEN_THEN_EIGHT, critic: null });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Outcome: not run — the critic returned nothing',
    );
    expect(labels(run)).toContain('runner:teardown:critic');
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', critic: { outcome: 'not-run' } });
  });

  it('records a critic whose slice could not be cut as not run, tearing nothing down, and still opens the PR', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'runner:cut-slice:critic': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'branch-exists',
        branch: null,
        base: null,
        slice: null,
        errors: [{ step: 'preconditions', message: 'slice/7-8/critic exists' }],
        at: '2026-09-29T10:30:00.000Z',
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(labels(run).filter((l) => l.includes('critic'))).toEqual(['runner:cut-slice:critic']);
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- Outcome: not run — cut-slice refused (branch-exists): slice/7-8/critic exists',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', critic: { outcome: 'not-run' } });
  });

  it('halts the epic when the critic’s slice teardown leaves the batch unverified: no master sync, no PR', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'runner:teardown:critic': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'source-shrank',
        removed: false,
        registered: true,
        errors: [{ step: 'gate', message: 'node_modules lost 40 entries' }],
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8');

    expect(labels(run).filter((l) => /^runner:(sync-master|bump|publish)/.test(l))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      outcome: 'halted',
      message: expect.stringMatching(/source-shrank/),
      critic: { outcome: 'clean' },
    });
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
      planner: { ...PLAN_CARD, verdict: 'stale', evidence: 'done at abc123' },
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

  it('labels the test review’s leases after the tdd’s in the issue’s lease timings', async () => {
    const run = fakeHooks({ testReview: TEST_REVIEW_LEASED });

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, 'runner:publish:list')
        .split('\n')
        .filter((l) => l.startsWith('- Lease timings: ')),
    ).toEqual([
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ]);
  });

  it('labels the review’s leases between the tdd’s and the test review’s in the issue’s lease timings', async () => {
    const run = fakeHooks({ reviewer: REVIEW_LEASED, testReview: TEST_REVIEW_LEASED });

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, 'runner:publish:list')
        .split('\n')
        .filter((l) => l.startsWith('- Lease timings: ')),
    ).toEqual([
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; review: paper@localhost:25702 waited 0.5s, held 12.5s; test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
    ]);
  });

  it('counts a landed issue’s reviewer lease in its engine’s and its issue’s totals', async () => {
    const run = fakeHooks({ reviewer: REVIEW_LEASED });

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

  it('counts a landed issue’s test-review lease in its engine’s and its issue’s totals', async () => {
    const run = fakeHooks({ testReview: TEST_REVIEW_LEASED });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.leases).toEqual({
      engines: [
        { type: 'paper', leases: 1, waitedSeconds: 1.5, waitedMaxSeconds: 1.5, heldSeconds: 42 },
        { type: 'folia', leases: 1, waitedSeconds: 1.2, waitedMaxSeconds: 1.2, heldSeconds: 40.3 },
      ],
      issues: [{ issue: 7, waitedSeconds: 2.7, heldSeconds: 82.3 }],
      unparsed: [],
    });
  });

  it('keeps a test review’s malformed lease line unparsed, under its issue', async () => {
    const run = fakeHooks({
      testReview: {
        ...TEST_REVIEW_LEASED,
        leaseLines: [...TEST_REVIEW_LEASED.leaseLines, 'with-lease: waited ?s'],
      },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.epics[0]?.leases?.unparsed).toEqual([
      { issue: 7, line: 'with-lease: waited ?s' },
    ]);
    expect(promptOf(run, 'runner:publish:list').split('\n')).toContain(
      '- unparsed (#7): with-lease: waited ?s',
    );
  });

  it('still totals the landed slices’ lease lines when the critic halts the epic', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      critic: CRITIC_APPLIED,
      'runner:land:critic': LAND_BATCH_DIRTY,
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

describe('runShip — the diff review counts', () => {
  it('carries each landed issue’s own diff review counts into its PR-body section', async () => {
    const run = fakeHooks({
      ...SEVEN_THEN_EIGHT,
      'diffReview:7-1': { rules: 3, plan: 0, findingsPath: `${REPORT_DIR}/diff-review-7-1.md` },
      'diffReview:8-1': { rules: 0, plan: 4, findingsPath: `${REPORT_DIR}/diff-review-8-1.md` },
    });

    await runShip(run.hooks, 'issues 7 8');

    expect(
      promptOf(run, 'runner:publish:list')
        .split('\n')
        .filter((l) => l.startsWith('- Diff review: ')),
    ).toEqual([
      '- Diff review: 3 rules, 0 plan findings',
      '- Diff review: 0 rules, 4 plan findings',
    ]);
  });
});
