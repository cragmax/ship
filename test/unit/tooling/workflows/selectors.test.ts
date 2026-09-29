import { describe, expect, it } from 'vitest';

import { createScheduler } from '../../../../tooling/lib/run-scheduler.js';
import { dropWithDependents } from '../../../../tooling/workflows/lib/preflight.js';

describe('dropWithDependents', () => {
  // 13 → 12 keeps its blocker but loses its dependent: the edge must go too (review N5).
  const graph = {
    runSet: [
      { epic: 1, issues: [10, 11, 12, 13] },
      { epic: 2, issues: [20] },
    ],
    edges: [
      { blocker: 10, dependent: 11 },
      { blocker: 11, dependent: 12 },
      { blocker: 13, dependent: 12 },
    ],
  };

  it('drops the issues, their transitive dependents, every edge touching them and emptied entries', () => {
    expect(dropWithDependents(graph, [10, 20, 99])).toEqual({
      graph: { runSet: [{ epic: 1, issues: [13] }], edges: [] },
      dependents: [11, 12],
    });
  });

  it('leaves a graph createScheduler accepts', () => {
    const { graph: kept } = dropWithDependents(graph, [10, 20]);

    expect(() => createScheduler({ ...kept, maxSlices: 1 })).not.toThrow();
  });

  it('keeps an edge between two kept issues', () => {
    expect(dropWithDependents(graph, [20]).graph).toEqual({
      runSet: [{ epic: 1, issues: [10, 11, 12, 13] }],
      edges: graph.edges,
    });
  });
});
