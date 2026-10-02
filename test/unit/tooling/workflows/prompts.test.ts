import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROMPTS } from '../../../../tooling/workflows/lib/prompts.js';
import { STAGES } from '../../../../tooling/workflows/lib/stages.js';

const AGENTS_DIR = resolve(import.meta.dirname, '../../../../.claude/agents');

const SLICE = 'C:/r/slice-7-1';
const REPORTS = 'C:/r/reports';
const LEASE = { main: 'C:/main', projectDir: 'C:/r/batch', registry: `${REPORTS}/pool.json` };

// Every builder, every optional value given: an optional line an agent file
// forgets to list shows only when the fixture emits it.
const PROMPTS_OF: { readonly [K in keyof typeof PROMPTS]: readonly string[] } = {
  runner: [
    PROMPTS.runner({
      argv: ['tooling/worktree.ts', 'check', '7'],
      envelopeDir: `${REPORTS}/tool`,
      envelopeName: 'check',
      timeoutMs: 7200000,
      write: { path: `${REPORTS}/in.json`, content: 'Not a key: inside the file\n' },
    }),
  ],
  scout: [PROMPTS.scout({ issues: [7], liveRuns: [{ branch: 'ship/epic-9', landed: ['a.ts'] }] })],
  overlapEstimator: [
    PROMPTS.overlapEstimator({
      runSet: [{ epic: null, issues: [7, 8] }],
      edges: [{ blocker: 7, dependent: 8 }],
    }),
  ],
  planner: [
    PROMPTS.planner({
      mode: 'plan',
      issue: 7,
      attempt: 2,
      slice: SLICE,
      reportDir: REPORTS,
      planPath: `${REPORTS}/plans/7.md`,
      priorSlices: [{ issue: 6, commit: 'c6', plan: `${REPORTS}/plans/6.md` }],
      conflicts: ['a.ts'],
      lease: LEASE,
    }),
    PROMPTS.planner({
      mode: 'apply',
      issue: 7,
      attempt: 1,
      slice: SLICE,
      reportDir: REPORTS,
      planPath: `${REPORTS}/plans/7.md`,
      findingsPath: `${REPORTS}/plan-review-7-1.md`,
      priorSlices: [],
      lease: LEASE,
    }),
  ],
  planReviewer: [
    PROMPTS.planReviewer({
      issue: 7,
      slice: SLICE,
      planPath: `${REPORTS}/plans/7.md`,
      findingsPath: `${REPORTS}/plan-review-7-1.md`,
      reportDir: REPORTS,
    }),
  ],
  tdd: [
    PROMPTS.tdd({
      issue: 7,
      attempt: 1,
      slice: SLICE,
      base: 'cut1',
      planPath: `${REPORTS}/plans/7.md`,
      reportPath: `${REPORTS}/tdd-7-1.md`,
      messagePath: `${REPORTS}/commit-7-1.txt`,
      message: 'feat(build): add x\n\nNot a key: inside the file\n',
      lease: LEASE,
    }),
  ],
  diffReview: [
    PROMPTS.diffReview({
      issue: 7,
      slice: SLICE,
      base: 'cut1',
      planPath: `${REPORTS}/plans/7.md`,
      sha: 'slice1',
      files: ['a.ts'],
      findingsPath: `${REPORTS}/diff-review-7-1.md`,
      reportDir: REPORTS,
    }),
  ],
  reviewer: [
    PROMPTS.reviewer({
      issue: 7,
      slice: SLICE,
      base: 'cut1',
      planPath: `${REPORTS}/plans/7.md`,
      sha: 'slice1',
      files: ['a.ts'],
      reportPath: `${REPORTS}/review-7-1.md`,
      lease: LEASE,
      findingsPath: `${REPORTS}/diff-review-7-1.md`,
    }),
  ],
  testReview: [
    PROMPTS.testReview({
      issue: 7,
      slice: SLICE,
      base: 'cut1',
      planPath: `${REPORTS}/plans/7.md`,
      sha: 'slice2',
      files: ['a.ts'],
      reportPath: `${REPORTS}/test-review-7-1.md`,
      lease: LEASE,
    }),
  ],
  resolver: [
    PROMPTS.resolver({
      batch: 'C:/r/batch',
      pending: ['docs/adr/readme.md'],
      reportPath: `${REPORTS}/resolve.md`,
    }),
  ],
  critic: [
    PROMPTS.critic({
      slice: 'C:/r/slice-critic',
      range: 'b0..HEAD',
      landed: [{ issue: 7, commit: 'c7', plan: `${REPORTS}/plans/7.md` }],
      reportPath: `${REPORTS}/critic.md`,
    }),
  ],
  retro: [PROMPTS.retro({ epic: 1025, reportDir: REPORTS, report: { outcome: 'pr' } })],
  curator: [
    PROMPTS.curator({
      pr: 42,
      findingsPath: `${REPORTS}/pr-review-42-findings.json`,
      resultPath: `${REPORTS}/pr-review-42-result.md`,
      landed: [{ issue: 7, commit: 'c7', plan: `${REPORTS}/plans/7.md` }],
      commentPath: `${REPORTS}/pr-review-42-curated.md`,
    }),
  ],
};

const agentTypes = [...new Set(Object.values(STAGES).map((row) => row.agentType))];

const promptsFor = (agentType: string): string[] =>
  (Object.keys(PROMPTS_OF) as (keyof typeof PROMPTS)[])
    .filter((key) => STAGES[key].agentType === agentType)
    .flatMap((key) => PROMPTS_OF[key]);

// A verbatim file block's lines are file content, not keys.
const emittedKeys = (prompt: string): string[] => {
  const keys: string[] = [];
  let inFile = false;
  for (const line of prompt.split('\n')) {
    if (line === '----- BEGIN FILE -----') inFile = true;
    if (inFile) {
      if (line === '----- END FILE -----') inFile = false;
      continue;
    }
    const key = /^([A-Z][A-Za-z ()-]*): /.exec(line)?.[1];
    if (key !== undefined) keys.push(key);
  }
  return keys;
};

const listedKeys = (agentType: string): string[] => {
  const text = readFileSync(join(AGENTS_DIR, `${agentType}.md`), 'utf8').replaceAll('\r\n', '\n');
  const start = text.indexOf('\n## Inputs (from the prompt)\n');
  if (start === -1) return [];
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end === -1 ? text.length : end);
  return [...section.matchAll(/`([A-Z][A-Za-z ()-]*):`/g)].map((m) => m[1] ?? '');
};

const sortedSet = (keys: readonly string[]): string[] =>
  [...new Set(keys)].sort((a, b) => a.localeCompare(b));

describe('stage prompts', () => {
  it.each(agentTypes)('%s: its agent file lists exactly the keys its prompts emit', (agentType) => {
    const prompts = promptsFor(agentType);

    expect(prompts.length).toBeGreaterThan(0);
    expect(sortedSet(listedKeys(agentType))).toEqual(sortedSet(prompts.flatMap(emittedKeys)));
  });
});
