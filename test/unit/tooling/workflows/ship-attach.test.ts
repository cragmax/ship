import { describe, expect, it } from 'vitest';

import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  BUMP_NO_OP,
  fakeHooks,
  GATE_OK,
  PREFLIGHT_OK,
  REPORT_DIR,
  SCOUT_FRESH,
  type FakeRun,
} from './_fake-hooks.js';

const TARGET = 'ship/epic-9';
const ATTACH_REPORTS = `${REPORT_DIR}/attach-2`;
const REGISTRY = `${REPORT_DIR}/pool-registry.batch.json`;

const ATTACHED_CUT = {
  exitCode: 0,
  envelopePath: 'e.json',
  status: 'ok',
  errors: [],
  worktree: 'C:/src/main',
  branch: TARGET,
  base: 'tip9',
  batch: BATCH,
  reportDir: ATTACH_REPORTS,
  attach: { created: false, fastForwarded: false, pr: 9, run: 2, registry: REGISTRY },
};

const PUSHED = {
  exitCode: 0,
  envelopePath: 'e.json',
  status: 'ok',
  errors: [],
  pushed: true,
  pr: { number: 9, url: 'https://x/pull/9' },
  mergeable: 'MERGEABLE',
};

const ATTACHED = { 'runner:cut-batch': ATTACHED_CUT, 'runner:publish': PUSHED };

const ARGS = 'issues 7 --attach ship/epic-9';

const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

const callOf = (run: FakeRun, label: string): FakeRun['calls'][number] | undefined =>
  run.calls.find((c) => c.label === label);

describe('runShip --attach — one attached issue from launch to the push', () => {
  it('lands the issue on the open PR’s branch and pushes onto the PR, with no PR writer', async () => {
    const run = fakeHooks(ATTACHED);

    const report = await runShip(run.hooks, ARGS);

    expect(labels(run)).toEqual([
      'runner:preflight',
      'runner:run-gate',
      'runner:live-runs',
      'scout',
      'runner:cut-batch:list',
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
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
      'runner:append-pr-body:list',
    ]);
    expect(callOf(run, 'runner:preflight')?.argv).toEqual([
      'tooling/worktree.ts',
      'preflight',
      '.',
      '--attach',
      'ship/epic-9',
    ]);
    expect(callOf(run, 'runner:cut-batch:list')?.argv).toEqual([
      'tooling/worktree.ts',
      'cut-batch',
      '.',
      '--attach',
      'ship/epic-9',
      '--attached-run',
    ]);
    const publish = callOf(run, 'runner:publish:list');
    expect(publish?.argv).toEqual([
      'tooling/worktree.ts',
      'publish',
      BATCH,
      '--push-only',
      '--log',
      `${ATTACH_REPORTS}/publish.log`,
    ]);
    expect(publish?.prompt.split('\n').filter((l) => l.startsWith('Write first:'))).toEqual([]);
    expect(report).toMatchObject({
      status: 'done',
      epics: [
        {
          epic: null,
          branch: 'ship/epic-9',
          outcome: 'pr',
          pr: 9,
          issues: [{ issue: 7, outcome: 'landed', cite: 'fixes', commit: 'landed1' }],
        },
      ],
    });
  });
});

describe('runShip --attach — pre-flight', () => {
  it.each([
    { check: 'no-open-pr', message: 'ship/epic-9 has no open PR: closed (#9)' },
    {
      check: 'slices-live',
      message:
        'node_modules of C:/src/ph-runs/epic-9/slice-a1-7-1 link into C:/src/ph-runs/epic-9/ship-epic-9/node_modules; tear those slices down first',
    },
    {
      check: 'unpublished-commits',
      message:
        'ship/epic-9 has 2 commit(s) of its own origin lacks; recover them first (ADR-0045 decision 10)',
    },
  ])('refuses the attach target’s $check problem, cutting nothing', async (problem) => {
    const run = fakeHooks({
      ...ATTACHED,
      'runner:preflight': {
        ...PREFLIGHT_OK,
        exitCode: 1,
        status: 'refused',
        reason: 'preflight-failed',
        problems: [problem],
      },
    });

    const report = await runShip(run.hooks, ARGS);

    expect(report).toEqual({
      status: 'refused',
      refusals: [{ kind: problem.check, message: problem.message }],
      dropped: [],
      epics: [],
    });
    expect(labels(run).filter((l) => l.includes('cut-batch'))).toEqual([]);
  });
});

describe('runShip --attach --preflight-only', () => {
  it('attaches nothing', async () => {
    const run = fakeHooks(ATTACHED);

    const report = await runShip(run.hooks, `${ARGS} --preflight-only`);

    expect(labels(run)).toEqual([
      'runner:preflight',
      'runner:run-gate',
      'runner:live-runs',
      'scout',
    ]);
    expect(report.status).toBe('preflight-ok');
  });
});

const promptLines = (run: FakeRun, label: string): string[] =>
  callOf(run, label)?.prompt.split('\n') ?? [];

const leaseLine = (run: FakeRun, label: string): string =>
  promptLines(run, label).find((l) => l.startsWith('Lease command:')) ?? '';

describe('runShip --attach — setup', () => {
  it('runs a reused batch’s attempt from the attached run’s report folder and the batch’s registry', async () => {
    const run = fakeHooks(ATTACHED);

    await runShip(run.hooks, ARGS);

    expect(promptLines(run, 'planner:7-1')).toEqual(
      expect.arrayContaining([
        `Report dir: ${ATTACH_REPORTS}`,
        `Plan file: ${ATTACH_REPORTS}/plans/7.md`,
      ]),
    );
    expect(leaseLine(run, 'planner:7-1')).toContain(`PH_POOL_REGISTRY=${REGISTRY}`);
    expect(callOf(run, 'runner:cut-slice:7-1')?.argv).toEqual([
      'tooling/worktree.ts',
      'cut-slice',
      BATCH,
      '--issue',
      '7',
      '--attempt',
      '1',
      '--attached-run',
      '2',
    ]);
  });

  it('provisions a batch checked out anew into the attached run’s report folder', async () => {
    const provisioned = `${ATTACH_REPORTS}/pool-registry.batch.json`;
    const run = fakeHooks({
      ...ATTACHED,
      'runner:cut-batch': {
        ...ATTACHED_CUT,
        attach: { ...ATTACHED_CUT.attach, created: true, registry: null },
      },
      'runner:provision-batch': {
        exitCode: 0,
        envelopePath: 'e.json',
        status: 'ok',
        errors: [],
        registry: provisioned,
        env: { PH_PROJECT_DIR: BATCH, PH_POOL_REGISTRY: provisioned },
      },
    });

    await runShip(run.hooks, ARGS);

    expect(callOf(run, 'runner:provision-batch:list')?.argv).toEqual([
      'tooling/worktree.ts',
      'provision-batch',
      BATCH,
      '--report-dir',
      ATTACH_REPORTS,
    ]);
    expect(leaseLine(run, 'planner:7-1')).toContain(`PH_POOL_REGISTRY=${provisioned}`);
  });

  it('stops the entry when a reused batch has no trimmed pool registry', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      'runner:cut-batch': { ...ATTACHED_CUT, attach: { ...ATTACHED_CUT.attach, registry: null } },
    });

    const report = await runShip(run.hooks, ARGS);

    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      branch: 'ship/epic-9',
      message: 'cut-batch --attach found no trimmed pool registry for the reused batch',
      issues: [{ issue: 7, outcome: 'blocked', cite: 'see', reason: 'its batch was not set up' }],
    });
    expect(labels(run).filter((l) => l.startsWith('runner:check'))).toEqual([]);
  });

  it('stops the entry when the attach names no run number', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      'runner:cut-batch': { ...ATTACHED_CUT, attach: { ...ATTACHED_CUT.attach, run: null } },
    });

    const report = await runShip(run.hooks, ARGS);

    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: 'cut-batch --attach named no attached run',
    });
    expect(labels(run).filter((l) => l.startsWith('runner:check'))).toEqual([]);
  });
});

describe('runShip --attach — the epic end', () => {
  it('runs the critic over this run’s slices from the attached tip, then pushes with no PR writer', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8] }],
        edges: [{ blocker: 7, dependent: 8 }],
      },
      scout: {
        issues: [7, 8].map((issue) => ({ issue, stale: false, evidence: 'fresh' })),
        overlaps: [],
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8 --attach ship/epic-9');

    expect(callOf(run, 'runner:cut-slice:critic')?.argv).toEqual([
      'tooling/worktree.ts',
      'cut-slice',
      BATCH,
      '--critic',
      '--attached-run',
      '2',
    ]);
    expect(promptLines(run, 'critic:list')).toEqual(
      expect.arrayContaining([
        'Epic range: tip9..HEAD',
        `Report file: ${ATTACH_REPORTS}/critic.md`,
      ]),
    );
    const all = labels(run);
    expect(all.slice(all.indexOf('runner:bump:list'))).toEqual([
      'runner:bump:list',
      'retro:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
      'runner:append-pr-body:list',
    ]);
    expect(all.filter((l) => l.startsWith('prWriter'))).toEqual([]);
    expect(report.epics[0]).toMatchObject({
      epic: null,
      branch: 'ship/epic-9',
      outcome: 'pr',
      pr: 9,
    });
  });

  it('stops the epic end when the PR is no longer open, its issues still landed', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      'runner:publish': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'no-open-pr',
        errors: [{ step: 'pr-state', message: 'ship/epic-9 has no open PR: closed (#9)' }],
        pushed: false,
        pr: null,
        mergeable: null,
      },
    });

    const report = await runShip(run.hooks, ARGS);

    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: 'publish refused (no-open-pr): ship/epic-9 has no open PR: closed (#9)',
      issues: [{ issue: 7, outcome: 'landed', cite: 'fixes', commit: 'landed1' }],
    });
    expect(labels(run).filter((l) => l.startsWith('retro'))).toEqual(['retro:list']);
  });
});

const TARGET_RUN = {
  branch: TARGET,
  landed: ['tooling/x.ts'],
  pr: { state: 'open', number: 9 },
  spent: false,
  spentUnverified: false,
  path: BATCH,
  dirty: false,
  nested: [],
};

const OTHER_RUN = {
  ...TARGET_RUN,
  branch: 'ship/epic-8',
  landed: ['src/o.ts'],
  pr: { state: 'open', number: 8 },
  path: 'C:/src/ph-runs/epic-8/batch',
};

const liveRunsOf = (...runs: readonly (typeof TARGET_RUN)[]) => ({
  'runner:live-runs': {
    exitCode: 0,
    envelopePath: 'e.json',
    status: 'ok',
    errors: [],
    runs,
  },
});

const scoutLines = (run: FakeRun): string[] => callOf(run, 'scout')?.prompt.split('\n') ?? [];

describe('runShip --attach — the scout', () => {
  it('shows the scout every live run but the target, and names the PR head', async () => {
    const run = fakeHooks({ ...ATTACHED, ...liveRunsOf(TARGET_RUN, OTHER_RUN) });

    const report = await runShip(run.hooks, `${ARGS} --preflight-only`);

    expect(scoutLines(run)).toEqual(
      expect.arrayContaining([
        'Live runs (JSON): [{"branch":"ship/epic-8","landed":["src/o.ts"]}]',
        'PR head: origin/ship/epic-9',
      ]),
    );
    expect(report.status).toBe('preflight-ok');
  });

  it('still refuses an overlap with another live run', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      ...liveRunsOf(TARGET_RUN, OTHER_RUN),
      scout: {
        ...SCOUT_FRESH,
        overlaps: [
          { issue: 7, branch: 'ship/epic-8', files: ['src/o.ts'], evidence: 'both edit src/o.ts' },
        ],
      },
    });

    const report = await runShip(run.hooks, `${ARGS} --preflight-only`);

    expect(report.refusals).toEqual([
      { kind: 'overlap', issue: 7, message: 'ship/epic-8: both edit src/o.ts' },
    ]);
  });

  it('shows the scout no live run when the target is the only one', async () => {
    const run = fakeHooks({ ...ATTACHED, ...liveRunsOf(TARGET_RUN) });

    const report = await runShip(run.hooks, `${ARGS} --preflight-only`);

    expect(scoutLines(run)).toEqual(expect.arrayContaining(['Live runs (JSON): []']));
    expect(report.status).toBe('preflight-ok');
  });

  it('names no PR head to an unattached run’s scout', async () => {
    const run = fakeHooks(liveRunsOf(TARGET_RUN, OTHER_RUN));

    await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(scoutLines(run).filter((l) => l.startsWith('PR head:'))).toEqual([]);
  });
});

describe('runShip --attach — the PR body section', () => {
  const SECTION_FILE = `${ATTACH_REPORTS}/pr-section.md`;

  it('appends the run’s section to the open PR’s body once the push succeeded', async () => {
    const run = fakeHooks(ATTACHED);

    const report = await runShip(run.hooks, ARGS);

    const all = labels(run);
    expect(all.slice(all.indexOf('runner:publish:list'))).toEqual([
      'runner:publish:list',
      'runner:append-pr-body:list',
    ]);
    expect(callOf(run, 'runner:append-pr-body:list')?.argv).toEqual([
      'tooling/worktree.ts',
      'append-pr-body',
      BATCH,
      '--pr',
      '9',
      '--section-file',
      SECTION_FILE,
    ]);
    const lines = promptLines(run, 'runner:append-pr-body:list');
    const at = lines.indexOf(`Write first: ${SECTION_FILE}`);
    expect(lines.slice(at, at + 4)).toEqual([
      `Write first: ${SECTION_FILE}`,
      '----- BEGIN FILE -----',
      '## Attached run 2',
      '',
    ]);
    expect(lines).toEqual(
      expect.arrayContaining([
        '### Evidence',
        '### Issues',
        '- fixes #7 — add the x tool',
        '<details><summary>Run report — attached run 2</summary>',
        '----- END FILE -----',
      ]),
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 9 });
    expect(report.epics[0]).not.toHaveProperty('prBodyEdit');
  });

  // An attached run's usual bump: the PR is already bumped, so a fix adds no commit.
  it('pushes and appends a section naming the bump a no-op when the version is already at its target', async () => {
    const run = fakeHooks({ ...ATTACHED, 'runner:bump': BUMP_NO_OP });

    const report = await runShip(run.hooks, ARGS);

    const all = labels(run);
    expect(all.slice(all.indexOf('runner:bump:list'))).toEqual([
      'runner:bump:list',
      'retro:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
      'runner:append-pr-body:list',
    ]);
    expect(promptLines(run, 'runner:append-pr-body:list')).toContain(
      '- Version bump: patch, already at 1.0.1 — no commit',
    );
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 9 });
    expect(report.epics[0]).not.toHaveProperty('prBodyEdit');
  });

  it.each([
    {
      name: 'refused',
      publish: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'no-open-pr',
        errors: [{ step: 'pr-state', message: 'ship/epic-9 has no open PR: closed (#9)' }],
        pushed: false,
        pr: null,
        mergeable: null,
      },
    },
    {
      name: 'failed at the push',
      publish: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [
          {
            step: 'push',
            message:
              'git push -u origin refs/heads/ship/epic-9:refs/heads/ship/epic-9 exited 1; output in x.log',
          },
        ],
        pushed: false,
        pr: null,
        mergeable: null,
      },
    },
    { name: 'returned nothing', publish: null },
  ])('edits no PR body when the publish $name', async ({ publish }) => {
    const run = fakeHooks({ ...ATTACHED, 'runner:publish': publish });

    const report = await runShip(run.hooks, ARGS);

    expect(labels(run).filter((l) => l.startsWith('runner:append-pr-body'))).toEqual([]);
    expect(report.epics[0]?.outcome).toBe('stopped');
    expect(report.epics[0]).not.toHaveProperty('prBodyEdit');
  });

  it.each([
    {
      name: 'failed',
      edit: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [
          { step: 'pr-edit', message: 'gh pr edit 9 exited 1; the body is in C:/tmp/b/pr-body.md' },
        ],
      },
      prBodyEdit:
        'append-pr-body failed: gh pr edit 9 exited 1; the body is in C:/tmp/b/pr-body.md',
    },
    {
      name: 'returned nothing',
      edit: null,
      prBodyEdit: 'the runner returned nothing for append-pr-body',
    },
    {
      name: 'threw',
      edit: () => {
        throw new Error('agent died');
      },
      prBodyEdit: 'append-pr-body threw: agent died',
    },
  ])('reports an edit that $name, the push standing', async ({ edit, prBodyEdit }) => {
    const run = fakeHooks({ ...ATTACHED, 'runner:append-pr-body': edit });

    const report = await runShip(run.hooks, ARGS);

    expect(report.status).toBe('done');
    expect(report.epics[0]).toMatchObject({
      outcome: 'pr',
      pr: 9,
      prBodyEdit,
      issues: [{ issue: 7, outcome: 'landed', cite: 'fixes', commit: 'landed1' }],
    });
    expect(report.epics[0]?.message).toBeUndefined();
  });
});
