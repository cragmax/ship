import { describe, expect, it } from 'vitest';

import { STAGES } from '../../../src/workflow/stages.js';

const agentTypes = [...new Set(Object.values(STAGES).map((row) => row.agentType))];

describe('workflow agents', () => {
  it('covers every agent the workflow calls', () => {
    expect([...agentTypes].sort((a, b) => a.localeCompare(b))).toEqual([
      'epic-review',
      'issue-overlap',
      'issue-readiness',
      'pr',
      'resolve-index-conflicts',
      'retro',
      'runner',
      'script-api-tsdoc',
      'spec-review',
      'standards-review',
      'tdd',
      'test-review',
    ]);
  });
});
