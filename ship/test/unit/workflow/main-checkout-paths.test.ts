import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { gitPathList } from '../../../../tooling/test/helpers/worktree-fixture-git.js';
import { PROMPTS } from '../../../src/workflow/calls/prompts.js';
import { TOOL_COMMANDS } from '../../../src/workflow/calls/tool-calls.js';

// A stale literal surfaces only in the first run after a move, as a pre-flight failure of every
// runner call; these read the paths from the Workflow source, never from a copied list.

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const TRACKED = new Set(gitPathList(ROOT, ['ls-files', '-z']));

/** A main checkout no real path starts with, so each tool path it prefixes is found by it. */
const MAIN = 'Z:/main-checkout';

describe('the main-checkout paths the Saved workflow invokes', () => {
  it('names a tracked script first in every tool command', () => {
    const untracked = Object.entries(TOOL_COMMANDS)
      .filter(([, words]) => !TRACKED.has(words[0] ?? ''))
      .map(([tool, words]) => `${tool}: ${words[0] ?? '(no words)'}`);

    expect(untracked).toEqual([]);
  });

  it('names a tracked tool in each lease line of a slice prompt', () => {
    const prompt = PROMPTS.tdd({
      issue: 7,
      attempt: 1,
      slice: 'C:/r/slice',
      base: 'b0',
      reportDir: 'C:/r/reports',
      reportPath: 'C:/r/reports/tdd-7-1.md',
      keptDir: 'C:/r/kept',
      previousPatch: null,
      messagePath: 'C:/r/reports/commit-7-1.txt',
      messageTemplate: 'x\n',
      lease: { main: MAIN, projectDir: 'C:/r/batch', registry: 'C:/r/registry.json' },
    });
    const toolPaths = prompt
      .split('\n')
      .filter((line) => line.includes(`${MAIN}/`))
      .map((line) => {
        const label = line.slice(0, line.indexOf(':'));
        const paths = line
          .split(' ')
          .filter((word) => word.startsWith(`${MAIN}/`))
          .map((word) => word.slice(MAIN.length + 1));
        return { label, paths };
      });

    // The lines are pinned so a line that stops naming its tool fails here, not vacuously below.
    expect(toolPaths.map(({ label, paths }) => [label, paths.length])).toEqual([
      ['Lease command', 1],
      ['Full server tier', 1],
    ]);
    const untracked = toolPaths.flatMap(({ label, paths }) =>
      paths.filter((path) => !TRACKED.has(path)).map((path) => `${label}: ${path}`),
    );
    expect(untracked).toEqual([]);
  });
});
