import { describe, expect, it } from 'vitest';

import { createScheduler } from '../../../src/core/scheduler/run-scheduler.js';
import { dropWithDependents } from '../../../src/workflow/preflight.js';
import { isTrivialSurface } from '../../../src/workflow/stages.js';

describe('isTrivialSurface', () => {
  it.each([
    ['docs and agents only', ['docs/adr/0046-x.md', '.claude/agents/runner.md', 'README.md'], true],
    ['no file', [], true],
    ['a framework/src/ file', ['docs/a.md', 'framework/src/a.ts'], false],
    ['a framework/test/ file', ['framework/test/unit/a.test.ts'], false],
    ["the framework's docs only", ['framework/CLAUDE.md', 'framework/docs/adr/0001-x.md'], true],
    ['a path merely starting with framework', ['frameworks/src/a.ts'], true],
    [
      'a root src/ or test/ file, which the framework left',
      ['src/a.ts', 'test/unit/a.test.ts'],
      true,
    ],
    ['a tooling/ file', ['tooling/a.ts'], false],
    ['a server-pool/ file', ['server-pool/src/lease/claim.ts'], false],
    ['a path merely starting with server-pool', ['server-pool-old/a.ts'], true],
    ['a ship/src/ file', ['docs/a.md', 'ship/src/core/run-set.ts'], false],
    ['a ship/test/ file', ['ship/test/unit/a.test.ts'], false],
    ["ship/'s docs only", ['ship/CLAUDE.md', 'ship/docs/adr/0001-unattended-runs.md'], true],
    ['a path merely starting with ship', ['shipping/a.ts'], true],
  ])('judges %s', (_name, files, trivial) => {
    expect(isTrivialSurface(files)).toBe(trivial);
  });
});

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
