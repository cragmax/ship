import { describe, expect, it } from 'vitest';

import { RESYNC_PHASES, STAGES } from '../../../../tooling/workflows/lib/stages.js';
import { RESYNC_META } from '../../../../tooling/workflows/resync.meta.js';
import { runResync } from '../../../../tooling/workflows/resync.js';

import { BATCH, liveRuns, REPORT_DIR, type FakeRun } from './_fake-hooks.js';
import {
  attachOk,
  BRANCH,
  DOC_INDEX_CONFLICT,
  OK,
  publishOk,
  resyncHooks,
} from './_fake-resync.js';

const labels = (run: FakeRun): string[] => run.calls.map((c) => c.label);

describe('runResync — arguments', () => {
  it.each([BRANCH, { branch: BRANCH }, JSON.stringify({ branch: BRANCH })])(
    'accepts %j, starting with live runs',
    async (args) => {
      const run = resyncHooks();

      const report = await runResync(run.hooks, args);

      expect(report).toMatchObject({ status: 'done', branch: BRANCH });
      expect(labels(run)[0]).toBe('runner:live-runs:resync');
      expect(run.violations).toEqual([]);
    },
  );

  it.each([
    '',
    undefined,
    {},
    { branch: 'feature/x' },
    `${BRANCH} extra`,
    { branch: BRANCH, x: 1 },
  ])('refuses %j before any call or phase', async (args) => {
    const run = resyncHooks();

    const report = await runResync(run.hooks, args);

    expect(report.status).toBe('refused');
    expect(run.calls).toEqual([]);
    expect(run.phases).toEqual([]);
  });
});

describe('runResync — merge and push', () => {
  it.each([false, true])(
    'pushes after an up-to-date merge, reporting pushed %s',
    async (pushed) => {
      const run = resyncHooks({ 'runner:publish': publishOk(pushed) });

      const report = await runResync(run.hooks, BRANCH);

      expect(run.calls.find((c) => c.label === 'runner:publish:resync')?.argv.slice(2)).toEqual([
        BATCH,
        '--push-only',
        '--log',
        `${REPORT_DIR}/resync-push.log`,
      ]);
      expect(report).toMatchObject({
        status: 'done',
        sync: { verdict: 'up-to-date' },
        pushed,
        pr: 9,
        mergeable: 'MERGEABLE',
      });
      expect(report.message).toBe(
        `${pushed ? 'pushed' : 'nothing to push'}; PR #9 mergeable confirmed`,
      );
      expect(run.violations).toEqual([]);
    },
  );

  it('reports a mergeable state other than MERGEABLE as unconfirmed', async () => {
    const run = resyncHooks({
      'runner:publish': { ...publishOk(true), mergeable: 'CONFLICTING' },
    });

    const report = await runResync(run.hooks, BRANCH);

    expect(report).toMatchObject({ status: 'done', pushed: true, mergeable: 'CONFLICTING' });
    expect(report.message).toBe('pushed; PR #9 mergeable unconfirmed (CONFLICTING)');
    expect(run.violations).toEqual([]);
  });

  it('carries the merge start version into the report', async () => {
    const version = { base: '1.0.0', ours: '1.0.1', theirs: '1.1.0', result: '1.1.1' };
    const run = resyncHooks({
      'runner:sync-master:resync': {
        ...OK,
        outcome: 'merged',
        commit: 'merge1',
        conflicts: [{ path: 'package.json', kind: 'package', landedBy: ['chore: theirs'] }],
        version,
        pending: [],
      },
    });

    const report = await runResync(run.hooks, BRANCH);

    expect(report).toMatchObject({ status: 'done', sync: { verdict: 'merged', commit: 'merge1' } });
    expect(report.sync?.version).toEqual(version);
    expect(run.violations).toEqual([]);
  });

  const CODE_CONFLICT = {
    path: 'src/x.ts',
    kind: 'code',
    landedBy: ['Merge pull request #77 from fixture/ship-x'],
  };

  it.each([
    {
      name: 'a code conflict',
      responses: {
        'runner:sync-master:resync': {
          ...OK,
          exitCode: 1,
          status: 'refused',
          reason: 'code-conflict',
          outcome: null,
          commit: null,
          conflicts: [CODE_CONFLICT],
          version: null,
          pending: [],
          errors: [{ step: 'probe', message: 'would conflict in code: src/x.ts' }],
        },
      },
      conflicts: [CODE_CONFLICT],
    },
    {
      name: 'a failed sync',
      responses: {
        'runner:sync-master:resync': {
          ...OK,
          exitCode: 1,
          status: 'failed',
          outcome: null,
          commit: null,
          conflicts: [],
          version: null,
          pending: [],
          errors: [{ step: 'build', message: 'npm run build exited 1' }],
        },
      },
      conflicts: [],
    },
    {
      name: 'an unresolvable doc index',
      responses: {
        ...DOC_INDEX_CONFLICT,
        resolver: { verdict: 'unresolvable', summary: 'the rows contradict' },
      },
      conflicts: DOC_INDEX_CONFLICT['runner:sync-master:resync'].conflicts,
    },
  ])('stops before the push on $name', async (c) => {
    const run = resyncHooks(c.responses);

    const report = await runResync(run.hooks, BRANCH);

    expect(labels(run).filter((l) => l.startsWith('runner:publish'))).toEqual([]);
    expect(report).toMatchObject({ status: 'stopped', pushed: false });
    expect(report.sync?.conflicts).toEqual(c.conflicts);
    expect(run.violations).toEqual([]);
  });

  it('stops on a failed push, naming it', async () => {
    const failed = {
      ...OK,
      exitCode: 1,
      status: 'failed',
      pushed: false,
      pr: null,
      mergeable: null,
      errors: [{ step: 'push', message: 'origin/ship/epic-9 has commits the batch lacks' }],
    };
    const run = resyncHooks({ 'runner:publish': failed });

    const report = await runResync(run.hooks, BRANCH);

    expect(report).toMatchObject({ status: 'stopped', pushed: false });
    expect(report.message).toBe('publish failed: origin/ship/epic-9 has commits the batch lacks');
  });
});

describe('runResync — spent cleanup', () => {
  it('tears down a spent, clean run by its path', async () => {
    const run = resyncHooks(liveRuns({}));

    const report = await runResync(run.hooks, BRANCH);

    const teardown = run.calls.find((c) => c.label === 'runner:teardown:spent-1');
    expect(teardown?.argv.slice(2)).toEqual(['C:/src/ph-runs/old-0/batch']);
    expect(report.cleanup.tornDown).toEqual(['C:/src/ph-runs/old-0/batch']);
    expect(run.violations).toEqual([]);
  });

  it.each([
    { name: 'dirty', run: { dirty: true }, why: 'uncommitted changes' },
    { name: 'of unknown dirtiness', run: { dirty: null }, why: 'dirtiness unknown' },
    {
      name: 'with a nested worktree',
      run: { nested: ['C:/x/agent'] },
      why: 'nested worktrees: C:/x/agent',
    },
    {
      name: 'unverified',
      run: { spent: false, spentUnverified: true },
      why: 'its PR is over, but the PR head could not be checked',
    },
  ])('leaves a spent run $name standing, reporting why', async (c) => {
    const run = resyncHooks(liveRuns(c.run));

    const report = await runResync(run.hooks, BRANCH);

    expect(labels(run).filter((l) => l.startsWith('runner:teardown'))).toEqual([]);
    expect(report.cleanup.skipped).toEqual([{ path: 'C:/src/ph-runs/old-0/batch', why: c.why }]);
  });

  it('leaves a spent run live-runs named no path standing, by its branch', async () => {
    const run = resyncHooks(liveRuns({ path: undefined }));

    const report = await runResync(run.hooks, BRANCH);

    expect(labels(run).filter((l) => l.startsWith('runner:teardown'))).toEqual([]);
    expect(report.cleanup.skipped).toEqual([
      { path: 'ship/old-0', why: 'live-runs named no path' },
    ]);
    expect(run.violations).toEqual([]);
  });

  it('keeps a re-cut run whose merged PR does not contain its tip', async () => {
    const run = resyncHooks(liveRuns({ spent: false }));

    const report = await runResync(run.hooks, BRANCH);

    expect(labels(run).filter((l) => l.startsWith('runner:teardown'))).toEqual([]);
    expect(report.cleanup).toMatchObject({ tornDown: [], skipped: [] });
  });

  it('tears nothing down when live-runs fails, and still merges', async () => {
    const failed = {
      ...OK,
      exitCode: 1,
      status: 'failed',
      runs: liveRuns({})['runner:live-runs'].runs,
      errors: [{ step: 'pr-state', message: 'ship/old-0: gh pr list exited 1' }],
    };
    const run = resyncHooks({ 'runner:live-runs': failed });

    const report = await runResync(run.hooks, BRANCH);

    expect(labels(run).filter((l) => l.startsWith('runner:teardown'))).toEqual([]);
    expect(report.cleanup.blocked).toBe('live-runs failed: ship/old-0: gh pr list exited 1');
    expect(labels(run)).toContain('runner:sync-master:resync');
  });

  it('records a failed teardown as residue and tears the next spent run down', async () => {
    const failed = {
      ...OK,
      exitCode: 1,
      status: 'failed',
      errors: [{ step: 'remove', message: 'busy' }],
    };
    const teardown = { ...OK, removed: true, registered: false };
    const run = resyncHooks({
      ...liveRuns({}, {}),
      'runner:teardown:spent-1': failed,
      'runner:teardown:spent-2': teardown,
    });

    const report = await runResync(run.hooks, BRANCH);

    expect(report.cleanup.residue).toEqual(['C:/src/ph-runs/old-0/batch: teardown failed: busy']);
    expect(report.cleanup.tornDown).toEqual(['C:/src/ph-runs/old-1/batch']);
  });

  it('stops before the attach when a teardown finds a link target shrank', async () => {
    const shrank = {
      ...OK,
      exitCode: 1,
      status: 'refused',
      reason: 'source-shrank',
      errors: [{ step: 'unlink', message: 'node_modules lost files' }],
    };
    const run = resyncHooks({ ...liveRuns({}), 'runner:teardown': shrank });

    const report = await runResync(run.hooks, BRANCH);

    expect(report.status).toBe('stopped');
    expect(labels(run).filter((l) => l.startsWith('runner:cut-batch'))).toEqual([]);
  });
});

describe('runResync — attach', () => {
  it('provisions a batch checked out anew before the merge', async () => {
    const run = resyncHooks({ 'runner:cut-batch': attachOk(true) });

    await runResync(run.hooks, BRANCH);

    expect(labels(run).slice(1, 4)).toEqual([
      'runner:cut-batch:resync',
      'runner:provision-batch:resync',
      'runner:sync-master:resync',
    ]);
    const provision = run.calls.find((c) => c.label === 'runner:provision-batch:resync');
    expect(provision?.argv.slice(2)).toEqual([BATCH, '--report-dir', REPORT_DIR]);
  });

  it('provisions nothing for a reused batch', async () => {
    const run = resyncHooks();

    await runResync(run.hooks, BRANCH);

    expect(labels(run).filter((l) => l.startsWith('runner:provision-batch'))).toEqual([]);
  });

  it.each(['no-open-pr', 'branch-diverged', 'branch-checked-out'])(
    'stops on a %s attach, before any merge',
    async (reason) => {
      const refused = {
        ...attachOk(false),
        exitCode: 1,
        status: 'refused',
        reason,
        batch: null,
        reportDir: null,
        attach: null,
        errors: [{ step: 'preconditions', message: reason }],
      };
      const run = resyncHooks({ 'runner:cut-batch': refused });

      const report = await runResync(run.hooks, BRANCH);

      expect(labels(run).slice(1)).toEqual(['runner:cut-batch:resync']);
      expect(report.status).toBe('stopped');
    },
  );

  it('stops when provisioning fails, before any merge', async () => {
    const failed = {
      ...OK,
      exitCode: 1,
      status: 'failed',
      errors: [{ step: 'install', message: 'npm ci' }],
    };
    const run = resyncHooks({
      'runner:cut-batch': attachOk(true),
      'runner:provision-batch': failed,
    });

    const report = await runResync(run.hooks, BRANCH);

    expect(labels(run).filter((l) => l.startsWith('runner:sync-master'))).toEqual([]);
    expect(report.status).toBe('stopped');
  });
});

describe('runResync — tiers and phases', () => {
  it('runs every call at its STAGES tier and enters each phase in order', async () => {
    const run = resyncHooks(DOC_INDEX_CONFLICT);

    await runResync(run.hooks, BRANCH);

    for (const call of run.calls) {
      const row = call.label.startsWith('resolver') ? STAGES.resolver : STAGES.runner;
      expect({ agentType: call.agentType, model: call.model, effort: call.effort }).toEqual({
        agentType: row.agentType,
        model: row.model,
        effort: 'effort' in row ? row.effort : undefined,
      });
    }
    expect(run.phases).toEqual(['Pre-flight', 'Merge', 'Push']);
    expect(RESYNC_META.phases).toEqual(RESYNC_PHASES);
  });
});

describe('runResync — order', () => {
  it('runs live runs, attach, merge, resolver, continue, then the push', async () => {
    const run = resyncHooks(DOC_INDEX_CONFLICT);

    const report = await runResync(run.hooks, BRANCH);

    expect(labels(run)).toEqual([
      'runner:live-runs:resync',
      'runner:cut-batch:resync',
      'runner:sync-master:resync',
      'resolver:resync',
      'runner:sync-master:resync-continue',
      'runner:publish:resync',
    ]);
    expect(report).toMatchObject({ status: 'done', branch: BRANCH, pushed: true });
    expect(run.violations).toEqual([]);
  });
});
