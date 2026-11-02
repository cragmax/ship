import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { findCycles, runSetIssues, transitiveDependents } from '../../../src/core/run-set.js';

import { describeRenderSafety } from '../../helpers/render-safety.js';

describe('runSetIssues', () => {
  it('flattens every entry, ascending', () => {
    expect(
      runSetIssues([
        { epic: 900, issues: [905, 903] },
        { epic: 800, issues: [801] },
      ]),
    ).toEqual([801, 903, 905]);
  });
});

describe('findCycles', () => {
  it('returns [] for a DAG', () => {
    expect(
      findCycles(
        [1, 2, 3, 4],
        [
          { blocker: 1, dependent: 2 },
          { blocker: 2, dependent: 3 },
          { blocker: 1, dependent: 3 },
          { blocker: 3, dependent: 4 },
        ],
      ),
    ).toEqual([]);
  });

  it('returns each of two disjoint cycles, members ascending, ordered by first member', () => {
    expect(
      findCycles(
        // descending, so a traversal in input order discovers {40, 50, 60} first
        [60, 50, 40, 30, 20, 10],
        [
          // cycle {40, 50, 60} listed first, and entered from its largest member
          { blocker: 60, dependent: 40 },
          { blocker: 40, dependent: 50 },
          { blocker: 50, dependent: 60 },
          // cycle {10, 30}. 20 hangs off it but is not in it
          { blocker: 30, dependent: 10 },
          { blocker: 10, dependent: 30 },
          { blocker: 30, dependent: 20 },
        ],
      ),
    ).toEqual([
      [10, 30],
      [40, 50, 60],
    ]);
  });

  it('returns a self-loop as a singleton', () => {
    expect(
      findCycles(
        [7, 8],
        [
          { blocker: 7, dependent: 7 },
          { blocker: 7, dependent: 8 },
        ],
      ),
    ).toEqual([[7]]);
  });

  it('ignores an edge with an endpoint outside the issues', () => {
    expect(
      findCycles(
        [1, 2],
        [
          { blocker: 1, dependent: 2 },
          { blocker: 2, dependent: 99 },
          { blocker: 99, dependent: 1 },
        ],
      ),
    ).toEqual([]);
  });
});

describe('transitiveDependents', () => {
  it('walks a chain and a diamond: every reachable dependent once, ascending, roots excluded', () => {
    expect(
      transitiveDependents(
        [1],
        [
          // chain 1 → 2 → 3
          { blocker: 1, dependent: 2 },
          { blocker: 2, dependent: 3 },
          // diamond 1 → {5, 4} → 6
          { blocker: 1, dependent: 5 },
          { blocker: 1, dependent: 4 },
          { blocker: 4, dependent: 6 },
          { blocker: 5, dependent: 6 },
          // unreachable from the root
          { blocker: 8, dependent: 9 },
        ],
      ),
    ).toEqual([2, 3, 4, 5, 6]);
  });

  it('excludes a root even when another root reaches it', () => {
    expect(
      transitiveDependents(
        [2, 1],
        [
          { blocker: 1, dependent: 2 },
          { blocker: 2, dependent: 3 },
        ],
      ),
    ).toEqual([3]);
  });

  it('returns [] for no roots', () => {
    expect(transitiveDependents([], [{ blocker: 1, dependent: 2 }])).toEqual([]);
  });
});

describeRenderSafety(resolve(import.meta.dirname, '../../../src/core/run-set.ts'));
