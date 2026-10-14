import { describe, expect, it } from 'vitest';

import { STAGES } from '../../../tooling/workflows/lib/stages.js';

const agentTypes = [...new Set(Object.values(STAGES).map((row) => row.agentType))];

describe('workflow agents', () => {
  it('covers every agent the workflow calls', () => {
    expect([...agentTypes].sort((a, b) => a.localeCompare(b))).toEqual([
      'critic',
      'diff-reviewer',
      'manifest-tsdoc',
      'overlap-estimator',
      'pr-writer',
      'resolve-index-conflicts',
      'retro',
      'reviewer',
      'runner',
      'scout',
      'ship-test-review',
      'tdd',
    ]);
  });
});
