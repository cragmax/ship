import { describe, expect, it } from 'vitest';

import { createScheduler } from '../../../../tooling/lib/run-scheduler.js';
import { dropWithDependents } from '../../../../tooling/workflows/lib/preflight.js';
import {
  isDocsOnly,
  isTrivialSurface,
  reviewEffort,
} from '../../../../tooling/workflows/lib/stages.js';

describe('reviewEffort', () => {
  it.each([
    ['one src/ file', ['src/engine/a.ts'], 'high'],
    ['six files outside src/', ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'], 'high'],
    [
      'five files outside src/',
      ['tooling/a.ts', 'test/a.test.ts', 'b.md', 'c.md', 'd.md'],
      'medium',
    ],
    ['a path merely starting with src', ['srcmap/a.ts'], 'medium'],
    ['no file', [], 'medium'],
  ])('rates %s', (_name, files, effort) => {
    expect(reviewEffort(files)).toBe(effort);
  });
});

describe('isTrivialSurface', () => {
  it.each([
    [
      'docs and agents only',
      ['docs/adr/0045-x.md', '.claude/agents/planner.md', 'README.md'],
      true,
    ],
    ['no file', [], true],
    ['a path merely starting with src', ['srcmap/a.ts'], true],
    ['a src/ file', ['docs/a.md', 'src/a.ts'], false],
    ['a tooling/ file', ['tooling/a.ts'], false],
    ['a test/ file', ['test/unit/a.test.ts'], false],
    ['an evals/ file', ['evals/run.ts'], false],
  ])('judges %s', (_name, files, trivial) => {
    expect(isTrivialSurface(files)).toBe(trivial);
  });
});

describe('isDocsOnly', () => {
  it.each([
    [
      'markdown under docs/',
      ['docs/adr/0045-unattended-runs.md', 'docs/platform-facts/claude-code-headless.md'],
      true,
    ],
    ['markdown at the root', ['README.md', 'CONTEXT.md'], true],
    ['markdown under docs/ and at the root', ['CHANGELOG.md', 'docs/adr/readme.md'], true],
    ['a path merely starting with .claude', ['.claudex/notes.md'], true],
    ['a .claude/ directory below the root', ['docs/.claude/notes.md'], true],
    ['an agent file among docs', ['docs/a.md', '.claude/agents/curator.md'], false],
    ['a rule', ['.claude/rules/git.md'], false],
    ['a skill', ['.claude/skills/tdd/SKILL.md'], false],
    ['a non-markdown file among docs', ['docs/a.md', 'package.json'], false],
    ['a path merely ending md', ['docs/a.mdx'], false],
    ['an upper-case extension', ['NOTES.MD'], false],
    ['no file', [], false],
  ])('judges %s', (_name, files, docsOnly) => {
    expect(isDocsOnly(files)).toBe(docsOnly);
  });

  it('skips less than isTrivialSurface: docs and agent files are trivial, not docs-only', () => {
    const files = ['docs/adr/0045-x.md', '.claude/agents/planner.md', 'README.md'];

    expect([isTrivialSurface(files), isDocsOnly(files)]).toEqual([true, false]);
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
