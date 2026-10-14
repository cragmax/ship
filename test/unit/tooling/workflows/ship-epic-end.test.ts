import { describe, expect, it } from 'vitest';

import { PHASE_TITLES, SHIP_PHASES } from '../../../../tooling/workflows/lib/stages.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  BUMP_NO_OP,
  fakeHooks,
  GATE_OK,
  LAND_OK,
  REPORT_DIR,
  TDD_BLOCKED,
  TDD_GREEN,
  type FakeRun,
} from './_fake-hooks.js';
import { epicRun, holdable, idle } from './_fake-parallel.js';

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
      'prWriter:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
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
      { issue: 7, commit: 'landed1' },
      { issue: 8, commit: 'landed1' },
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
 * @returns The lines after the publish prompt's begin marker.
 */
const bodyOf = (run: FakeRun): string[] => {
  const lines = promptOf(run, 'runner:publish:list').split('\n');
  return lines.slice(lines.indexOf('----- BEGIN FILE -----') + 1);
};

describe('runShip — the PR writer', () => {
  it('writes the PR writer’s summary first and its merge danger after the Evidence', async () => {
    const run = fakeHooks();

    await runShip(run.hooks, 'issues 7');

    const body = bodyOf(run);
    expect(body.slice(0, 5)).toEqual(['## Summary', '', 'Adds the x tool.', '', '## Evidence']);
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
    expect(bodyOf(run).slice(0, 3)).toEqual(['## Summary', '', 'Adds the x tool.']);
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
  it('names the PR writer beside the retro in its detail', () => {
    expect(SHIP_PHASES.find((p) => p.title === PHASE_TITLES.epicEnd)?.detail).toBe(
      'per epic: critic, master sync, version bump, retro and PR writer (concurrently), master check, pull request',
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

  it('labels the slice reviews’ leases between the tdd’s and the test review’s in the issue’s lease timings', async () => {
    const run = fakeHooks({
      specReview: SPEC_REVIEW_LEASED,
      standardsReview: STANDARDS_REVIEW_LEASED,
      testReview: TEST_REVIEW_LEASED,
    });

    await runShip(run.hooks, 'issues 7');

    expect(
      promptOf(run, 'runner:publish:list')
        .split('\n')
        .filter((l) => l.startsWith('- Lease timings: ')),
    ).toEqual([
      '- Lease timings: tdd: paper@localhost:25575 waited 1.5s, held 42s; spec-review: folia@localhost:25703 waited 0.3s, held 8.5s; standards-review: paper@localhost:25702 waited 0.5s, held 12.5s; test-review: folia@localhost:25711 waited 1.2s, held 40.3s',
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
