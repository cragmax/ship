import { describe, expect, it } from 'vitest';

import {
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
  it('roots a run beside the main checkout, under ph-runs', () => {
    expect(runLayout('C:/Users/gse/source/paper-harness', 'epic-1025')).toEqual({
      root: 'C:/Users/gse/source/ph-runs/epic-1025',
      batch: 'C:/Users/gse/source/ph-runs/epic-1025/batch',
      reports: 'C:/Users/gse/source/ph-runs/epic-1025/reports',
      branch: 'ship/epic-1025',
    });
  });

  it('accepts a backslash main path', () => {
    expect(runLayout('C:\\src\\paper-harness', '7').root).toBe('C:/src/ph-runs/7');
  });
});

describe('sliceLayout', () => {
  it('puts attempt K of issue N beside the batch, on a slice/ branch', () => {
    expect(sliceLayout('C:/src/ph-runs/epic-1025', 'epic-1025', 1043, 2)).toEqual({
      path: 'C:/src/ph-runs/epic-1025/slice-1043-2',
      branch: 'slice/epic-1025/1043-2',
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
