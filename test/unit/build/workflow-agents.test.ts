import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAGES } from '../../../src/workflow/stages.js';

const agentTypes = [...new Set(Object.values(STAGES).map((row) => row.agentType))];

const AGENT_SOURCES = join(import.meta.dirname, '../../../agents');

describe('workflow agents', () => {
  it('covers every agent the workflow calls', () => {
    expect([...agentTypes].sort((a, b) => a.localeCompare(b))).toEqual([
      'epic-review',
      'issue-overlap',
      'issue-readiness',
      'pr',
      'retro',
      'runner',
      'spec-review',
      'standards-review',
      'tdd',
      'test-review',
    ]);
  });

  it('has one source under agents/ per agent the workflow calls, and no other', () => {
    const sources = readdirSync(AGENT_SOURCES).map((name) => name.replace(/\.md$/, ''));

    expect(sources.toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...agentTypes].sort((a, b) => a.localeCompare(b)),
    );
  });
});
