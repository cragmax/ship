import { describe, expect, it } from 'vitest';

import {
  criticSliceLayout,
  RUN_BRANCH_PREFIX,
  runLayout,
  runSlug,
  runSlugOf,
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
