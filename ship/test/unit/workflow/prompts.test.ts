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

describe('a slice review’s Passed at line', () => {
  it('says none when the tdd ran no test green', () => {
    const prompt = PROMPTS.specReview({
      issue: 7,
      slice: 'C:/r/slice-7-1',
      base: 'cut1',
      reportDir: REPORTS,
      sha: 'slice1',
      files: ['docs/x.md'],
      reportPath: `${REPORTS}/spec-review-7-1.md`,
      passed: {
        sha: 'slice1',
        tests: [],
        evidence: { kind: 'none', test: '', pseudocode: '', red: '', green: '', reason: 'docs' },
        amended: [],
      },
      lease: { main: 'C:/r/main', projectDir: 'C:/r/slice-7-1', registry: `${REPORTS}/pool.json` },
    });

    expect(prompt.split('\n').filter((l) => l.startsWith('Passed at '))).toEqual([
      'Passed at slice1: none',
    ]);
  });
});
