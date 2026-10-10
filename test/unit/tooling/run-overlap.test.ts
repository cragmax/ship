import { describe, expect, it } from 'vitest';

import { mergeOverlapEdges } from '../../../tooling/lib/run-overlap.js';
import { advance, createScheduler } from '../../../tooling/lib/run-scheduler.js';
import { findCycles } from '../../../tooling/lib/run-set.js';

describe('mergeOverlapEdges', () => {
  it('directs each pair along a topological order of the declared edges, keeping the union acyclic', () => {
    // Under "the lower number blocks", {10,15} and {15,20} add 10→15 and 15→20,
    // and with 20→10 that is the cycle 10→15→20→10.
    const graph = {
      runSet: [{ epic: 1, issues: [10, 15, 20] }],
      edges: [{ blocker: 20, dependent: 10 }],
    };

    const merged = mergeOverlapEdges(graph, [
      { a: 10, b: 15 },
      { a: 15, b: 20 },
    ]);

    expect(merged).toEqual({
      kind: 'ok',
      graph: {
        runSet: graph.runSet,
        edges: [
          { blocker: 15, dependent: 10 },
          { blocker: 15, dependent: 20 },
          { blocker: 20, dependent: 10 },
        ],
      },
      added: [
        { blocker: 15, dependent: 10 },
        { blocker: 15, dependent: 20 },
      ],
      sequenced: [],
    });
    expect(merged.kind === 'ok' ? findCycles([10, 15, 20], merged.graph.edges) : null).toEqual([]);
  });

  it.each([
    [
      'the lower number first',
      [
        { blocker: 1, dependent: 2 },
        { blocker: 2, dependent: 3 },
      ],
    ],
    [
      'the higher number first',
      [
        { blocker: 2, dependent: 1 },
        { blocker: 3, dependent: 2 },
      ],
    ],
  ])(
    'adds nothing for a pair the declared edges already order (%s), and records it sequenced',
    (_name, edges) => {
      const merged = mergeOverlapEdges({ runSet: [{ epic: null, issues: [1, 2, 3] }], edges }, [
        { a: 3, b: 1 },
      ]);

      expect(merged).toMatchObject({ kind: 'ok', added: [], sequenced: [{ a: 1, b: 3 }] });
      expect(merged.kind === 'ok' ? merged.graph.edges : null).toEqual(edges);
    },
  );

  it('counts a pair once whichever order and however often it is named', () => {
    const merged = mergeOverlapEdges({ runSet: [{ epic: null, issues: [4, 5] }], edges: [] }, [
      { a: 4, b: 5 },
      { a: 5, b: 4 },
      { a: 4, b: 5 },
    ]);

    expect(merged).toMatchObject({ kind: 'ok', added: [{ blocker: 4, dependent: 5 }] });
  });

  it('lists every pair across entries with both epic keys, even beside in-entry pairs', () => {
    const graph = {
      runSet: [
        { epic: 1, issues: [1, 2] },
        { epic: 2, issues: [3, 4] },
      ],
      edges: [],
    };

    const merged = mergeOverlapEdges(graph, [
      { a: 1, b: 2 },
      { a: 4, b: 1 },
      { a: 2, b: 3 },
    ]);

    expect(merged).toEqual({
      kind: 'cross-entry',
      pairs: [
        { a: 1, b: 4, epicA: 1, epicB: 2 },
        { a: 2, b: 3, epicA: 1, epicB: 2 },
      ],
    });
  });

  it('returns the declared edges sorted and adds nothing for no pairs', () => {
    const graph = {
      runSet: [{ epic: null, issues: [1, 2, 3] }],
      edges: [
        { blocker: 2, dependent: 3 },
        { blocker: 1, dependent: 3 },
      ],
    };

    expect(mergeOverlapEdges(graph, [])).toEqual({
      kind: 'ok',
      graph: {
        runSet: graph.runSet,
        edges: [
          { blocker: 1, dependent: 3 },
          { blocker: 2, dependent: 3 },
        ],
      },
      added: [],
      sequenced: [],
    });
  });

  it('gives the scheduler a graph it starts one issue of an overlapping pair from', () => {
    const merged = mergeOverlapEdges({ runSet: [{ epic: null, issues: [1, 2] }], edges: [] }, [
      { a: 1, b: 2 },
    ]);
    if (merged.kind !== 'ok') throw new Error('expected ok');

    const first = createScheduler({ ...merged.graph, maxSlices: 4 });
    const next = advance(first.state, { kind: 'committed', issue: 1 });

    expect(first.actions).toEqual([{ kind: 'start', issue: 1 }]);
    expect(next.actions).toEqual([{ kind: 'start', issue: 2 }]);
  });

  it.each([
    {
      name: 'an endpoint outside the run set',
      graph: { runSet: [{ epic: null, issues: [1, 2] }], edges: [] },
      pairs: [{ a: 1, b: 9 }],
      message: 'run overlap: pair {#1, #9} names #9, which is outside the run set',
    },
    {
      name: 'a pair of one issue',
      graph: { runSet: [{ epic: null, issues: [1, 2] }], edges: [] },
      pairs: [{ a: 2, b: 2 }],
      message: 'run overlap: pair {#2, #2} pairs an issue with itself',
    },
    {
      name: 'cyclic declared edges',
      graph: {
        runSet: [{ epic: null, issues: [1, 2] }],
        edges: [
          { blocker: 1, dependent: 2 },
          { blocker: 2, dependent: 1 },
        ],
      },
      pairs: [],
      message: 'run overlap: the declared edges hold a cycle among #1, #2',
    },
  ])('throws for $name', ({ graph, pairs, message }) => {
    expect(() => mergeOverlapEdges(graph, pairs)).toThrow(message);
  });
});
