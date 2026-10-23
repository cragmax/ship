// The launch's spent-run cleanup, split from ship.test.ts (already past a thousand lines).
import { describe, expect, it } from 'vitest';

import { runShip } from '../../../src/workflow/ship.js';

import {
  fakeHooks,
  GATE_OK,
  labels,
  liveRuns,
  readyVerdict,
  STANDING_SPENT_RUNS,
} from './_fake-hooks.js';

const SPENT_BATCH = 'C:/src/ph-runs/old-0/batch';

describe('runShip — spent-run cleanup at launch', () => {
  it('tears a spent, clean, un-nested run down after pre-flight and before the cut', async () => {
    const run = fakeHooks(liveRuns({}));

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).slice(0, 7)).toEqual([
      'runner:preflight',
      'runner:run-gate',
      'runner:live-runs',
      'issueReadiness',
      'runner:teardown:spent-1',
      'runner:retire-run:spent-1',
      'runner:cut-batch:list',
    ]);
    expect(run.calls.find((c) => c.label === 'runner:teardown:spent-1')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
      'teardown',
      SPENT_BATCH,
    ]);
    expect(run.calls.find((c) => c.label === 'runner:retire-run:spent-1')?.argv).toEqual([
      'ship/src/cli/worktree.ts',
      'retire-run',
      '.',
      '--branch',
      'ship/old-0',
    ]);
    expect(report.status).toBe('done');
    expect(report.cleanup).toEqual({
      tornDown: [SPENT_BATCH],
      retired: ['ship/old-0'],
      skipped: [],
      residue: [],
      blocked: null,
      stop: null,
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
        errors: [{ step: 'branch-guard', message: 'ship/old-0 is not in origin/master' }],
      },
      residue:
        'ship/old-0: retire-run refused (branch-unmerged): ship/old-0 is not in origin/master',
    },
    {
      name: 'failed',
      answer: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'failed',
        errors: [{ step: 'delete-branch', message: 'in use' }],
      },
      residue: 'ship/old-0: retire-run failed: in use',
    },
    {
      name: 'dead',
      answer: null,
      residue: 'ship/old-0: the runner returned nothing for retire-run',
    },
  ])('records a $name retire-run as residue and still ships', async (c) => {
    const run = fakeHooks({ ...liveRuns({}), 'runner:retire-run:spent-1': c.answer });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.status).toBe('done');
    expect(report.cleanup).toEqual({
      tornDown: [SPENT_BATCH],
      retired: [],
      skipped: [],
      residue: [c.residue],
      blocked: null,
      stop: null,
    });
  });

  it("names the spent run's batch to teardown and its branch to retire-run, never its run root", async () => {
    const run = fakeHooks(liveRuns({}));

    await runShip(run.hooks, 'issues 7');

    const touching = run.calls.filter((c) =>
      c.argv.some((w) => w.startsWith('C:/src/ph-runs/old-0')),
    );
    expect(touching.map((c) => [c.label, c.argv.slice(2)])).toEqual([
      ['runner:teardown:spent-1', [SPENT_BATCH]],
    ]);
    expect(run.calls.filter((c) => c.argv.includes('ship/old-0')).map((c) => c.label)).toEqual([
      'runner:retire-run:spent-1',
    ]);
  });

  it('leaves a run whose PR is still open untouched', async () => {
    const run = fakeHooks(liveRuns({ spent: false, pr: { state: 'open', number: 100 } }));

    const report = await runShip(run.hooks, 'issues 7');

    expect(labels(run).filter((l) => l.startsWith('runner:teardown:spent'))).toEqual([]);
    expect(report.cleanup).toEqual({
      tornDown: [],
      retired: [],
      skipped: [],
      residue: [],
      blocked: null,
      stop: null,
    });
    expect(labels(run)).toContain('runner:cut-batch:list');
    expect(report.status).toBe('done');
  });

  it.each(STANDING_SPENT_RUNS)(
    'leaves a spent run $name standing, reporting why, and still cuts',
    async (c) => {
      const run = fakeHooks(liveRuns(c.run));

      const report = await runShip(run.hooks, 'issues 7');

      expect(labels(run).filter((l) => l.startsWith('runner:teardown:spent'))).toEqual([]);
      expect(report.cleanup?.skipped).toEqual([{ path: SPENT_BATCH, why: c.why }]);
      expect(labels(run)).toContain('runner:cut-batch:list');
      expect(report.status).toBe('done');
    },
  );

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
      residue: `${SPENT_BATCH}: teardown failed: busy`,
    },
    {
      name: 'refused for another reason',
      answer: {
        exitCode: 1,
        envelopePath: 'e.json',
        status: 'refused',
        reason: 'links-remain',
        errors: [{ step: 'gate', message: 'a link remains' }],
        removed: false,
        registered: true,
        kept: null,
      },
      residue: `${SPENT_BATCH}: teardown refused (links-remain): a link remains`,
    },
    {
      name: 'dead',
      answer: null,
      residue: `${SPENT_BATCH}: the runner returned nothing for teardown`,
    },
  ])('records a $name teardown as residue, tears the next run down and ships', async (c) => {
    const run = fakeHooks({ ...liveRuns({}, {}), 'runner:teardown:spent-1': c.answer });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.cleanup?.residue).toEqual([c.residue]);
    expect(report.cleanup?.tornDown).toEqual(['C:/src/ph-runs/old-1/batch']);
    expect(report.cleanup?.retired).toEqual(['ship/old-1']);
    expect(labels(run)).not.toContain('runner:retire-run:spent-1');
    expect(report.cleanup?.stop).toBeNull();
    expect(labels(run)).toContain('runner:cut-batch:list');
    expect(report.status).toBe('done');
    expect(report.epics[0]).toMatchObject({ outcome: 'pr' });
  });

  it('refuses the launch with nothing cut when a teardown finds a link target shrank', async () => {
    const shrank = {
      exitCode: 1,
      envelopePath: 'e.json',
      status: 'refused',
      reason: 'source-shrank',
      errors: [{ step: 'gate', message: 'node_modules lost files' }],
      removed: false,
      registered: true,
      kept: null,
    };
    const run = fakeHooks({
      ...liveRuns({}),
      'runner:teardown': shrank,
      // An exclude-mode drop, so the refusal is seen keeping pre-flight's `dropped`.
      'runner:run-gate': {
        ...GATE_OK,
        failures: [{ kind: 'missing-label', issue: 8, message: '#8 lacks ready-for-agent' }],
        excluded: [{ issue: 8, cause: 'failed' }],
      },
    });

    const report = await runShip(run.hooks, 'issues 7 8 --exclude');

    const stop = 'teardown refused (source-shrank): node_modules lost files';
    expect(report).toEqual({
      status: 'refused',
      refusals: [{ kind: 'source-shrank', message: stop }],
      dropped: [{ issue: 8, cause: 'gate', message: '#8 lacks ready-for-agent' }],
      cleanup: { tornDown: [], retired: [], skipped: [], residue: [], blocked: null, stop },
      epics: [],
    });
    expect(labels(run).filter((l) => /cut-batch|provision|land|cut-slice/.test(l))).toEqual([]);
    expect(run.phases).toEqual(['Pre-flight']);
  });

  it('tears nothing down on a --preflight-only launch', async () => {
    const run = fakeHooks(liveRuns({}));

    const report = await runShip(run.hooks, 'issues 7 --preflight-only');

    expect(report.status).toBe('preflight-ok');
    expect(labels(run).filter((l) => l.startsWith('runner:teardown'))).toEqual([]);
    expect(report).not.toHaveProperty('cleanup');
  });

  it('tears nothing down when pre-flight refuses the launch', async () => {
    const run = fakeHooks({
      ...liveRuns({}),
      issueReadiness: { issues: [readyVerdict(7, { current: 'done in abc123' })] },
    });

    const report = await runShip(run.hooks, 'issues 7');

    expect(report.status).toBe('refused');
    expect(report.refusals?.map((r) => r.kind)).toEqual(['stale']);
    expect(labels(run).filter((l) => l.startsWith('runner:teardown'))).toEqual([]);
    expect(report).not.toHaveProperty('cleanup');
  });
});
