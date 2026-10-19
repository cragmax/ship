import { describe, expect, it } from 'vitest';

import { runShip } from '../../../../tooling/workflows/ship.js';

import {
  BATCH,
  BUMP_NO_OP,
  EPIC_ACCEPTED,
  fakeHooks,
  GATE_OK,
  liveRuns,
  OK,
  PREFLIGHT_OK,
  readyVerdict,
  REPORT_DIR,
  TDD_BLOCKED,
  TDD_GREEN,
  type FakeRun,
} from './_fake-hooks.js';

const TARGET = 'ship/epic-9';
const ATTACH_REPORTS = `${REPORT_DIR}/attach-2`;
const REGISTRY = `${REPORT_DIR}/pool-registry.batch.json`;

const ATTACHED_CUT = {
  ...OK,
  worktree: 'C:/src/main',
  branch: TARGET,
  base: 'tip9',
  batch: BATCH,
  reportDir: ATTACH_REPORTS,
  attach: { created: false, fastForwarded: false, pr: 9, run: 2, registry: REGISTRY },
};

const PUSHED = {
  ...OK,
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
      'issueReadiness',
      'runner:cut-batch:list',
      'runner:check:7-1',
      'runner:cut-slice:7-1',
      'runner:provision:7-1',
      'tdd:7-1',
      'specReview:7-1',
      'runner:changed-files:7-1',
      'testReview:7-1',
      'standardsReview:7-1',
      'runner:changed-files:7-1',
      'runner:land:7-1',
      'runner:teardown:7-1',
      'epicReview:list',
      'runner:sync-master:list',
      'runner:bump:list',
      'runner:changed-files:list',
      'retro:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
      'runner:post-pr-comment:list',
      'runner:append-pr-body:list',
    ]);
    expect(callOf(run, 'runner:preflight')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
      'preflight',
      '.',
      '--attach',
      'ship/epic-9',
    ]);
    expect(callOf(run, 'runner:cut-batch:list')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
      'cut-batch',
      '.',
      '--attach',
      'ship/epic-9',
      '--attached-run',
    ]);
    const publish = callOf(run, 'runner:publish:list');
    expect(publish?.argv).toEqual([
      'ship/src/cli/worktree.ts',
      'publish',
      BATCH,
      '--push-only',
      '--log',
      `${ATTACH_REPORTS}/publish.log`,
    ]);
    expect(publish?.prompt.split('\n').filter((l) => l.startsWith('Write first:'))).toEqual([
      `Write first: ${ATTACH_REPORTS}/pr-report-comment.md`,
      `Write first: ${ATTACH_REPORTS}/pr-section.md`,
    ]);
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
    expect(report.epics[0]).not.toHaveProperty('recovery');
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
      'issueReadiness',
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

    expect(promptLines(run, 'tdd:7-1')).toEqual(
      expect.arrayContaining([
        `Issue file: ${ATTACH_REPORTS}/issues/7.md`,
        `Report file: ${ATTACH_REPORTS}/tdd-7-1.md`,
      ]),
    );
    expect(leaseLine(run, 'tdd:7-1')).toContain(`PH_POOL_REGISTRY=${REGISTRY}`);
    expect(callOf(run, 'runner:cut-slice:7-1')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
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
        ...OK,
        registry: provisioned,
        env: { PH_PROJECT_DIR: BATCH, PH_POOL_REGISTRY: provisioned },
      },
    });

    await runShip(run.hooks, ARGS);

    expect(callOf(run, 'runner:provision-batch:list')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
      'provision-batch',
      BATCH,
      '--report-dir',
      ATTACH_REPORTS,
    ]);
    expect(leaseLine(run, 'tdd:7-1')).toContain(`PH_POOL_REGISTRY=${provisioned}`);
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
  it.each([
    ['accepted', {}, '**Verdict:** accepted (profiled)'],
    [
      'rejected',
      { epicReview: { ...EPIC_ACCEPTED, verdict: 'rejected', summary: 'criterion 2 is unmet' } },
      '**Verdict:** rejected (profiled)',
    ],
  ])(
    'carries a %s profiled verdict first in its appended section, leaving the draft state alone',
    async (_name, review, verdict) => {
      const run = fakeHooks({ ...ATTACHED, ...review });

      await runShip(run.hooks, ARGS);

      const lines = promptLines(run, 'runner:append-pr-body:list');
      const at = lines.indexOf('## Attached run 2');
      expect(lines.slice(at, at + 5)).toEqual([
        '## Attached run 2',
        '',
        '### Epic review',
        '',
        verdict,
      ]);
      expect(callOf(run, 'runner:publish:list')?.argv).not.toContain('--draft');
    },
  );

  it('reviews this run’s slices from the attached tip, then pushes with no PR writer', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      'runner:run-gate': {
        ...GATE_OK,
        runSet: [{ epic: null, issues: [7, 8] }],
        edges: [{ blocker: 7, dependent: 8 }],
      },
      issueReadiness: {
        issues: [7, 8].map((issue) => readyVerdict(issue)),
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8 --attach ship/epic-9');

    expect(promptLines(run, 'epicReview:list')).toEqual(
      expect.arrayContaining([
        'Epic range: tip9..HEAD',
        'Scope: profiled',
        `Report file: ${ATTACH_REPORTS}/epic-review.md`,
      ]),
    );
    const all = labels(run);
    expect(all.slice(all.indexOf('runner:bump:list'))).toEqual([
      'runner:bump:list',
      'runner:changed-files:list',
      'retro:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
      'runner:post-pr-comment:list',
      'runner:append-pr-body:list',
    ]);
    expect(all.filter((l) => l.startsWith('prWriter'))).toEqual([]);
    // The open PR's tip, not the synced origin/master: pre-push diffs the push from it.
    expect(callOf(run, 'runner:changed-files:list')?.argv.slice(2)).toEqual([
      BATCH,
      'HEAD',
      '--base',
      'tip9',
    ]);
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
    // The retro ran before the refused push, then again over the stopped report.
    expect(labels(run).filter((l) => l.startsWith('retro'))).toEqual(['retro:list', 'retro:list']);
  });

  it('stops a failed push with the push-only command, then the report post and the section append for the open PR, each file written', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      'runner:publish': {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'push', message: 'the pre-push gate failed' }],
        pushed: false,
        pr: null,
        mergeable: null,
      },
    });

    const report = await runShip(run.hooks, ARGS);

    const recovery = report.epics[0]?.recovery ?? [];
    expect(report.epics[0]).toMatchObject({
      outcome: 'stopped',
      message: 'publish failed: the pre-push gate failed',
    });
    expect(recovery).toEqual([
      `node --import tsx ship/src/cli/worktree.ts publish ${BATCH} --push-only --log ${ATTACH_REPORTS}/publish.log`,
      `node --import tsx ship/src/cli/worktree.ts post-pr-comment ${BATCH} --pr 9 --comment-file ${ATTACH_REPORTS}/pr-report-comment.md`,
      `node --import tsx ship/src/cli/worktree.ts append-pr-body ${BATCH} --pr 9 --section-file ${ATTACH_REPORTS}/pr-section.md`,
    ]);
    const lines = promptLines(run, 'runner:publish:list');
    expect(lines.slice(0, 2)).toEqual(['Checkout: C:/src/main', `Command: ${recovery[0] ?? ''}`]);
    const at = lines.indexOf(`Write first: ${ATTACH_REPORTS}/pr-report-comment.md`);
    expect(lines.slice(at, at + 3)).toEqual([
      `Write first: ${ATTACH_REPORTS}/pr-report-comment.md`,
      '----- BEGIN FILE -----',
      '<details><summary>Run report — attached run 2</summary>',
    ]);
    const from = lines.indexOf(`Write first: ${ATTACH_REPORTS}/pr-section.md`);
    expect(lines.slice(from, from + 3)).toEqual([
      `Write first: ${ATTACH_REPORTS}/pr-section.md`,
      '----- BEGIN FILE -----',
      '## Attached run 2',
    ]);
    expect(lines).toContain(`Run report: not posted to this PR; it is in \`${ATTACH_REPORTS}\`.`);
    expect(labels(run).filter((l) => /^runner:(post-pr-comment|append-pr-body)/.test(l))).toEqual(
      [],
    );
  });
});

const TARGET_RUN = {
  branch: TARGET,
  landed: ['tooling/x.ts'],
  pr: { state: 'open', number: 9 },
  spent: false,
  path: BATCH,
};

const OTHER_RUN = {
  ...TARGET_RUN,
  branch: 'ship/epic-8',
  landed: ['src/o.ts'],
  pr: { state: 'open', number: 8 },
  path: 'C:/src/ph-runs/epic-8/batch',
};

describe('runShip --attach — issue-readiness and issue-overlap', () => {
  it('shows issue-overlap every live run but the target, and names the PR head to both', async () => {
    const run = fakeHooks({ ...ATTACHED, ...liveRuns(TARGET_RUN, OTHER_RUN) });

    const report = await runShip(run.hooks, `${ARGS} --preflight-only`);

    expect(promptLines(run, 'issueOverlap')).toEqual([
      'Checkout: C:/src/main',
      'Run set (JSON): [{"epic":null,"issues":[7]}]',
      'Declared edges (JSON): []',
      'Live runs (JSON): [{"branch":"ship/epic-8","landed":["src/o.ts"]}]',
      'PR head: origin/ship/epic-9',
    ]);
    expect(promptLines(run, 'issueReadiness')).toEqual([
      'Checkout: C:/src/main',
      'Run-set issues: #7',
      'PR head: origin/ship/epic-9',
    ]);
    expect(report.status).toBe('preflight-ok');
  });

  it('still refuses an overlap with another live run', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      ...liveRuns(TARGET_RUN, OTHER_RUN),
      issueOverlap: {
        issues: [],
        pairs: [],
        liveOverlaps: [
          { issue: 7, branch: 'ship/epic-8', files: ['src/o.ts'], reason: 'both edit src/o.ts' },
        ],
        areaMap: 'read',
      },
    });

    const report = await runShip(run.hooks, `${ARGS} --preflight-only`);

    expect(report.refusals).toEqual([
      { kind: 'overlap', issue: 7, message: 'ship/epic-8: both edit src/o.ts' },
    ]);
  });

  it('asks issue-overlap nothing for one issue when the target is the only live run', async () => {
    const run = fakeHooks({ ...ATTACHED, ...liveRuns(TARGET_RUN) });

    const report = await runShip(run.hooks, `${ARGS} --preflight-only`);

    expect(labels(run)).not.toContain('issueOverlap');
    expect(report.status).toBe('preflight-ok');
  });

  it('names no PR head to an unattached run’s issue-readiness or issue-overlap', async () => {
    const run = fakeHooks(liveRuns(TARGET_RUN, OTHER_RUN));

    await runShip(run.hooks, 'issues 7 --preflight-only');

    const heads = (label: string): string[] =>
      promptLines(run, label).filter((l) => l.startsWith('PR head:'));
    expect(heads('issueOverlap')).toEqual([]);
    expect(heads('issueReadiness')).toEqual([]);
    expect(labels(run)).toContain('issueOverlap');
  });
});

describe('runShip --attach — the PR body section', () => {
  const SECTION_FILE = `${ATTACH_REPORTS}/pr-section.md`;
  const COMMENT_FILE = `${ATTACH_REPORTS}/pr-report-comment.md`;

  it('appends the run’s section to the open PR’s body once the push succeeded', async () => {
    const run = fakeHooks(ATTACHED);

    const report = await runShip(run.hooks, ARGS);

    const all = labels(run);
    expect(all.slice(all.indexOf('runner:publish:list'))).toEqual([
      'runner:publish:list',
      'runner:post-pr-comment:list',
      'runner:append-pr-body:list',
    ]);
    expect(callOf(run, 'runner:append-pr-body:list')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
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
        'Run report: [PR comment](https://x/pull/9#issuecomment-1)',
        '----- END FILE -----',
      ]),
    );
    expect(lines).not.toContain('<details><summary>Run report — attached run 2</summary>');
    expect(lines).not.toContain('## Landed issues');
    expect(callOf(run, 'runner:post-pr-comment:list')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
      'post-pr-comment',
      BATCH,
      '--pr',
      '9',
      '--comment-file',
      COMMENT_FILE,
    ]);
    const posted = promptLines(run, 'runner:post-pr-comment:list');
    const from = posted.indexOf(`Write first: ${COMMENT_FILE}`);
    expect(posted.slice(from, from + 5)).toEqual([
      `Write first: ${COMMENT_FILE}`,
      '----- BEGIN FILE -----',
      '<details><summary>Run report — attached run 2</summary>',
      '',
      '## Landed issues',
    ]);
    expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 9 });
    expect(report.epics[0]).not.toHaveProperty('prBodyEdit');
    expect(report.epics[0]).not.toHaveProperty('prReportComment');
  });

  it('carries the run’s own recorded values in its appended section', async () => {
    const run = fakeHooks({ ...ATTACHED, tdd: { ...TDD_GREEN, recorded: ['a'] } });

    await runShip(run.hooks, ARGS);

    const lines = promptLines(run, 'runner:append-pr-body:list');
    const at = lines.indexOf('### Recorded');
    expect(at).toBeGreaterThan(lines.indexOf('### Issues'));
    expect(lines.slice(at, at + 5)).toEqual(['### Recorded', '', '- #7', '  - `a`', '']);
  });

  // An attached run's usual bump: the PR is already bumped, so a fix adds no commit.
  it('pushes and appends a section naming the bump a no-op when the version is already at its target', async () => {
    const run = fakeHooks({ ...ATTACHED, 'runner:bump': BUMP_NO_OP });

    const report = await runShip(run.hooks, ARGS);

    const all = labels(run);
    expect(all.slice(all.indexOf('runner:bump:list'))).toEqual([
      'runner:bump:list',
      'runner:changed-files:list',
      'retro:list',
      'runner:preflight:list',
      'runner:check-master:list',
      'runner:publish:list',
      'runner:post-pr-comment:list',
      'runner:append-pr-body:list',
    ]);
    expect(promptLines(run, 'runner:post-pr-comment:list')).toContain(
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
    expect(labels(run).filter((l) => l.startsWith('runner:post-pr-comment'))).toEqual([]);
    expect(report.epics[0]?.outcome).toBe('stopped');
    expect(report.epics[0]).not.toHaveProperty('prBodyEdit');
    expect(report.epics[0]).not.toHaveProperty('prReportComment');
  });

  it.each([
    {
      name: 'failed',
      post: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [
          {
            step: 'body-too-long',
            message:
              "comment file C:/r/pr-report-comment.md is 70000 characters, over GitHub's 65536-character limit",
          },
        ],
        url: null,
      },
      prReportComment:
        "post-pr-comment failed: comment file C:/r/pr-report-comment.md is 70000 characters, over GitHub's 65536-character limit",
    },
    {
      name: 'returned nothing',
      post: null,
      prReportComment: 'the runner returned nothing for post-pr-comment',
    },
    {
      name: 'threw',
      post: () => {
        throw new Error('agent died');
      },
      prReportComment: 'post-pr-comment threw: agent died',
    },
    {
      name: 'ok without a url',
      post: { ...OK, url: null },
      prReportComment: 'post-pr-comment ok without a url',
    },
  ])(
    'reports a report comment that $name, appending the section without its link',
    async ({ post, prReportComment }) => {
      const run = fakeHooks({ ...ATTACHED, 'runner:post-pr-comment': post });

      const report = await runShip(run.hooks, ARGS);

      expect(report.status).toBe('done');
      expect(report.epics[0]).toMatchObject({ outcome: 'pr', pr: 9, prReportComment });
      expect(report.epics[0]).not.toHaveProperty('prBodyEdit');
      expect(report.epics[0]?.message).toBeUndefined();
      expect(labels(run)).toContain('runner:append-pr-body:list');
      expect(promptLines(run, 'runner:append-pr-body:list')).toContain(
        `Run report: not posted to this PR; it is in \`${ATTACH_REPORTS}\`.`,
      );
    },
  );

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

describe('runShip --attach — an attached run that landed nothing', () => {
  it('leaves its batch and the open PR’s branch alone', async () => {
    const run = fakeHooks({
      ...ATTACHED,
      tdd: TDD_BLOCKED,
    });

    const report = await runShip(run.hooks, ARGS);

    expect(labels(run)).not.toContain('runner:teardown:list');
    expect(labels(run).filter((l) => l.startsWith('runner:retire-run'))).toEqual([]);
    expect(report.epics[0]).toMatchObject({ outcome: 'nothing-landed', branch: TARGET });
  });
});
