/**
 * The `STAGES` oracle: Ship ADR-0001 decision 15's tier per stage, written out by hand and never
 * imported from `ship/src/workflow/stages.ts`, as expected values come from the contract. It holds
 * nothing else, so a clone check can ignore this one intended copy without hiding any other.
 */

export const EXPECTED_STAGES = {
  runner: { agentType: 'runner', model: 'sonnet', effort: 'low' },
  issueReadiness: { agentType: 'issue-readiness', model: 'opus', effort: 'medium' },
  issueOverlap: { agentType: 'issue-overlap', model: 'opus', effort: 'medium' },
  tdd: { agentType: 'tdd', model: 'opus', effort: 'medium' },
  specReview: { agentType: 'spec-review', model: 'opus', effort: 'high' },
  testReview: { agentType: 'test-review', model: 'opus', effort: 'high' },
  standardsReview: { agentType: 'standards-review', model: 'opus', effort: 'high' },
  scriptApiTsdoc: { agentType: 'script-api-tsdoc', model: 'opus', effort: 'high' },
  epicReview: { agentType: 'epic-review', model: 'opus', effort: 'high' },
  retro: { agentType: 'retro', model: 'opus', effort: 'medium' },
  prWriter: { agentType: 'pr', model: 'opus', effort: 'medium' },
};
