import { describe, expect, it } from 'vitest';

import { PROMPTS } from '../../../src/workflow/calls/prompts.js';

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

describe('issue-readiness’s PR head', () => {
  it('names the PR head after the run set when given', () => {
    expect(
      PROMPTS.issueReadiness({ issues: [7], prHead: 'origin/ship/epic-9' }).split('\n'),
    ).toEqual(['Run-set issues: #7', 'PR head: origin/ship/epic-9']);
  });

  it('names no PR head without one', () => {
    expect(PROMPTS.issueReadiness({ issues: [7] }).split('\n')).toEqual(['Run-set issues: #7']);
  });
});
