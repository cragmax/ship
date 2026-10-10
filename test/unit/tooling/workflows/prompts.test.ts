import { describe, expect, it } from 'vitest';

import { PROMPTS } from '../../../../tooling/workflows/lib/prompts.js';

const REPORTS = 'C:/r/reports';

describe('the PR writer’s Epic line', () => {
  it.each<[number | null, string]>([
    [1025, 'Epic: #1025'],
    [null, 'Epic: an explicit issue list'],
  ])('spells epic %s as %s', (epic, line) => {
    const prompt = PROMPTS.prWriter({
      epic,
      batch: 'C:/r/batch',
      range: 'o0...HEAD',
      landed: [],
      reportDir: REPORTS,
    });

    expect(prompt.split('\n')[0]).toBe(line);
  });
});

describe('the scout’s PR head', () => {
  it('names the PR head between the run set and the live runs when given', () => {
    expect(
      PROMPTS.scout({ issues: [7], liveRuns: [], prHead: 'origin/ship/epic-9' }).split('\n'),
    ).toEqual(['Run-set issues: #7', 'PR head: origin/ship/epic-9', 'Live runs (JSON): []']);
  });

  it('names no PR head without one', () => {
    expect(PROMPTS.scout({ issues: [7], liveRuns: [] }).split('\n')).toEqual([
      'Run-set issues: #7',
      'Live runs (JSON): []',
    ]);
  });
});
