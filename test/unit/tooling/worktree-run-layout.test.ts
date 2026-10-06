import { describe, expect, it } from 'vitest';

import {
  attachedRunReports,
  criticSliceLayout,
  nextAttachedRun,
  RUN_BRANCH_PREFIX,
  runLayout,
  runSlug,
  runSlugOf,
  sliceBranchPrefix,
  sliceLayout,
} from '../../../tooling/worktree/run-layout.js';

describe('runSlug', () => {
  it('names an epic run epic-E', () => {
    expect(runSlug({ epic: 1025 })).toBe('epic-1025');
  });

  it('names an explicit-list run by its numbers ascending, joined with -', () => {
    expect(runSlug({ issues: [1034, 1028, 1032] })).toBe('1028-1032-1034');
  });

  it('sorts the numbers numerically, not as text', () => {
    expect(runSlug({ issues: [100, 20, 3] })).toBe('3-20-100');
  });

  it('names a one-issue list by the number alone', () => {
    expect(runSlug({ issues: [7] })).toBe('7');
  });
});

describe('runLayout', () => {
  it('roots an epic run beside the main checkout under ph-ship, its batch at ship-<slug>', () => {
    expect(runLayout('C:/Users/gse/source/paper-harness', 'epic-997')).toEqual({
      root: 'C:/Users/gse/source/ph-ship/epic-997',
      batch: 'C:/Users/gse/source/ph-ship/epic-997/ship-epic-997',
      reports: 'C:/Users/gse/source/ph-ship/epic-997/reports',
      branch: 'ship/epic-997',
    });
  });

  it('names an explicit-list batch ship-<lowest issue>', () => {
    expect(runLayout('C:/Users/gse/source/paper-harness', '1047-1048-1061').batch).toBe(
      'C:/Users/gse/source/ph-ship/1047-1048-1061/ship-1047',
    );
  });

  it('names a one-issue batch ship-<issue>', () => {
    expect(runLayout('C:/src/paper-harness', '914').batch).toBe('C:/src/ph-ship/914/ship-914');
  });

  it('accepts a backslash main path', () => {
    expect(runLayout('C:\\src\\paper-harness', '7').root).toBe('C:/src/ph-ship/7');
  });
});

describe('sliceLayout', () => {
  it('puts attempt K of issue N beside the batch, on a slice/ branch', () => {
    expect(sliceLayout('C:/src/ph-ship/epic-1025', 'epic-1025', 1043, 2)).toEqual({
      path: 'C:/src/ph-ship/epic-1025/slice-1043-2',
      branch: 'slice/epic-1025/1043-2',
    });
  });
});

describe('criticSliceLayout', () => {
  it('puts the epic end’s critic slice beside the batch, on slice/<slug>/critic', () => {
    expect(criticSliceLayout('C:/src/ph-ship/epic-9', 'epic-9')).toEqual({
      path: 'C:/src/ph-ship/epic-9/slice-critic',
      branch: 'slice/epic-9/critic',
    });
  });
});

describe('attached runs', () => {
  const root = 'C:/src/ph-ship/epic-1182';
  const slug = 'epic-1182';

  it('names an attached run’s attempt slice-a<R>-<N>-<K> on slice/<slug>/a<R>-<N>-<K>', () => {
    expect(sliceLayout(root, slug, 1190, 1, 2)).toEqual({
      path: 'C:/src/ph-ship/epic-1182/slice-a2-1190-1',
      branch: 'slice/epic-1182/a2-1190-1',
    });
  });

  it('names an attached run’s critic slice-a<R>-critic on slice/<slug>/a<R>-critic', () => {
    expect(criticSliceLayout(root, slug, 2)).toEqual({
      path: 'C:/src/ph-ship/epic-1182/slice-a2-critic',
      branch: 'slice/epic-1182/a2-critic',
    });
  });

  it('puts an attached run’s reports in reports/attach-<R>', () => {
    expect(attachedRunReports(runLayout('C:/src/paper-harness', slug), 2)).toBe(
      'C:/src/ph-ship/epic-1182/reports/attach-2',
    );
  });

  it('names the slice branch prefix slice/<slug>/', () => {
    expect(sliceBranchPrefix(slug)).toBe('slice/epic-1182/');
  });

  it.each([
    { name: 'nothing left', reports: [], branches: [], run: 1 },
    {
      name: 'only the unattached run’s leftovers',
      reports: [
        'tool',
        'plans',
        'issues',
        'pr-body.md',
        'critic.md',
        'publish.log',
        'pool-registry.batch.json',
      ],
      branches: ['1183-1', '1184-1', '1184-2', 'critic'],
      run: 1,
    },
    {
      name: 'attached run 1’s folder and branches',
      reports: ['tool', 'attach-1'],
      branches: ['1183-1', 'critic', 'a1-1190-1', 'a1-critic'],
      run: 2,
    },
    { name: 'run 1’s branches without its folder', reports: [], branches: ['a1-1190-1'], run: 2 },
    { name: 'run 1’s folder without branches', reports: ['attach-1'], branches: [], run: 2 },
    {
      name: 'run 1’s branch and run 2’s folder',
      reports: ['attach-2'],
      branches: ['a1-1190-1'],
      run: 3,
    },
    { name: 'a10 is not a1', reports: [], branches: ['a10-1190-1'], run: 1 },
  ])('gives the next attached run $run with $name', ({ reports, branches, run }) => {
    expect(nextAttachedRun({ reports, branches })).toBe(run);
  });

  it('gives a second attached run names none of an earlier run’s leftovers collide with', () => {
    const left = {
      reports: ['tool', 'plans', 'attach-1'],
      branches: ['1190-1', 'critic', 'a1-1190-1', 'a1-1190-2', 'a1-critic'],
    };

    const n = nextAttachedRun(left);

    expect(n).toBe(2);
    const taken = left.branches.map((b) => `slice/epic-1182/${b}`);
    for (const branch of [
      sliceLayout(root, slug, 1190, 1, n).branch,
      sliceLayout(root, slug, 1190, 2, n).branch,
      criticSliceLayout(root, slug, n).branch,
    ]) {
      expect(taken).not.toContain(branch);
    }
    expect(left.reports).not.toContain(`attach-${String(n)}`);
  });
});

describe('run branches', () => {
  it('keys runs on the ship/ namespace', () => {
    expect(RUN_BRANCH_PREFIX).toBe('refs/heads/ship/');
  });

  it.each([
    { ref: 'refs/heads/ship/epic-1025', slug: 'epic-1025' },
    { ref: 'refs/heads/ship/1028-1032', slug: '1028-1032' },
    { ref: 'refs/heads/slice/epic-1025/1043-1', slug: null },
    { ref: 'refs/heads/worktree-agent-x', slug: null },
    { ref: 'refs/heads/ship/', slug: null },
  ])('reads the slug of $ref as $slug', ({ ref, slug }) => {
    expect(runSlugOf(ref)).toBe(slug);
  });
});
