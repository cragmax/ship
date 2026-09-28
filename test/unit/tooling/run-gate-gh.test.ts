import { describe, it, expect } from 'vitest';

import {
  gatherAndEvaluate,
  gatherCheck,
  toIssueFacts,
  type GhJson,
} from '../../../tooling/lib/run-gate-gh.js';

// Fixtures mirror observed gh 2.101.0 `issue view --json` output, extra keys
// (`id`, `title`, `url`, `color`) included so the schemas' unknown-key
// tolerance is exercised.
interface GhFixtures {
  readonly epics?: Readonly<Record<number, unknown>>;
  readonly facts?: Readonly<Record<number, unknown>>;
  readonly states?: Readonly<Record<number, unknown>>;
}

const TABLE_FOR_FIELDS: Readonly<Record<string, keyof GhFixtures>> = {
  'number,subIssues': 'epics',
  'number,state,labels,body,blockedBy': 'facts',
  'number,state': 'states',
};

/** Routes each call by the `--json` field set it asks for, then by issue number. */
function fakeGh(fixtures: GhFixtures): { gh: GhJson; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhJson = (args) => {
    calls.push([...args]);
    const table = TABLE_FOR_FIELDS[args[4] ?? ''];
    const answer = table === undefined ? undefined : fixtures[table]?.[Number(args[2])];
    if (answer === undefined) {
      return Promise.reject(new Error(`fakeGh: no fixture for ${args.join(' ')}`));
    }
    return Promise.resolve(answer);
  };
  return { gh, calls };
}

function node(number: number, state: 'OPEN' | 'CLOSED'): unknown {
  return {
    id: `I_${String(number)}`,
    number,
    state,
    title: `issue ${String(number)}`,
    url: `https://github.com/o/r/issues/${String(number)}`,
  };
}

function facts(
  number: number,
  opts: {
    state?: 'OPEN' | 'CLOSED';
    labels?: readonly string[];
    body?: string;
    native?: readonly unknown[];
    nativeTotal?: number;
  } = {},
): unknown {
  const native = opts.native ?? [];
  return {
    number,
    state: opts.state ?? 'OPEN',
    labels: (opts.labels ?? ['ready-for-agent']).map((name) => ({
      id: `L_${name}`,
      name,
      description: '',
      color: 'ededed',
    })),
    body: opts.body ?? '',
    blockedBy: { nodes: native, totalCount: opts.nativeTotal ?? native.length },
  };
}

describe('gatherAndEvaluate', () => {
  it('gates an explicit list end-to-end: body blocker in the set becomes an edge', async () => {
    const { gh } = fakeGh({
      facts: {
        1031: facts(1031),
        1032: facts(1032, { body: '## Blocked by\n\n- #1031 (declares the run set)\n' }),
      },
    });

    const verdict = await gatherAndEvaluate({ kind: 'issues', issues: [1032, 1031] }, 'refuse', gh);

    expect(verdict).toEqual({
      verdict: 'ok',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [1031, 1032] }],
      edges: [{ blocker: 1031, dependent: 1032 }],
      failures: [],
      excluded: [],
    });
  });

  it('the epic container is never gated — only asked for its sub-issues', async () => {
    const { gh, calls } = fakeGh({
      epics: {
        1025: {
          number: 1025,
          subIssues: {
            nodes: [node(1032, 'OPEN'), node(1027, 'CLOSED'), node(1031, 'OPEN')],
            totalCount: 3,
          },
        },
      },
      facts: {
        // A CLOSED, unlabelled container with an open blocker: would fail
        // three ways if the gate ever looked at it.
        1025: facts(1025, { state: 'CLOSED', labels: ['epic'], body: '## Blocked by\n- #9999\n' }),
        1031: facts(1031, { body: '## Blocked by\n- #1027\n' }),
        1032: facts(1032, { body: '## Blocked by\n- #1031\n' }),
      },
      states: { 1027: { number: 1027, state: 'CLOSED' }, 9999: { number: 9999, state: 'OPEN' } },
    });

    const verdict = await gatherAndEvaluate({ kind: 'epics', epics: [1025] }, 'refuse', gh);

    expect(verdict).toEqual({
      verdict: 'ok',
      mode: 'refuse',
      runSet: [{ epic: 1025, issues: [1031, 1032] }],
      edges: [{ blocker: 1031, dependent: 1032 }],
      failures: [],
      excluded: [],
    });
    expect(calls.filter((c) => c[2] === '1025')).toEqual([
      ['issue', 'view', '1025', '--json', 'number,subIssues'],
    ]);
  });

  describe('body ∪ native links', () => {
    it('a native-only in-set link yields an edge', async () => {
      const { gh } = fakeGh({
        facts: { 1: facts(1), 2: facts(2, { native: [node(1, 'OPEN')] }) },
      });
      const verdict = await gatherAndEvaluate({ kind: 'issues', issues: [1, 2] }, 'refuse', gh);
      expect(verdict.edges).toEqual([{ blocker: 1, dependent: 2 }]);
    });

    it('a native-only out-of-set OPEN link → open-blocker', async () => {
      const { gh } = fakeGh({
        facts: { 2: facts(2, { native: [node(80, 'OPEN')] }) },
        states: { 80: { number: 80, state: 'OPEN' } },
      });
      const verdict = await gatherAndEvaluate({ kind: 'issues', issues: [2] }, 'refuse', gh);
      expect(verdict.failures).toEqual([
        { kind: 'open-blocker', issue: 2, blocker: 80, message: expect.any(String) },
      ]);
    });

    it('the same blocker named in body and native yields one edge', async () => {
      const { gh } = fakeGh({
        facts: {
          1: facts(1),
          2: facts(2, { body: '## Blocked by\n- #1\n', native: [node(1, 'OPEN')] }),
        },
      });
      const verdict = await gatherAndEvaluate({ kind: 'issues', issues: [1, 2] }, 'refuse', gh);
      expect(verdict.edges).toEqual([{ blocker: 1, dependent: 2 }]);
    });
  });

  describe('truncation guard', () => {
    it('throws naming the epic when subIssues is truncated', async () => {
      const { gh } = fakeGh({
        epics: { 500: { number: 500, subIssues: { nodes: [node(501, 'OPEN')], totalCount: 101 } } },
        facts: { 501: facts(501) },
      });
      await expect(
        gatherAndEvaluate({ kind: 'epics', epics: [500] }, 'refuse', gh),
      ).rejects.toThrow(/#500.*subIssues/);
    });

    it('throws naming the issue when blockedBy is truncated', async () => {
      const { gh } = fakeGh({
        facts: { 7: facts(7, { native: [node(8, 'CLOSED')], nativeTotal: 51 }) },
        states: { 8: { number: 8, state: 'CLOSED' } },
      });
      await expect(
        gatherAndEvaluate({ kind: 'issues', issues: [7] }, 'refuse', gh),
      ).rejects.toThrow(/#7.*blockedBy/);
    });
  });

  it('a malformed facts answer throws naming the issue and the bad field', async () => {
    const malformed = { ...(facts(33) as Record<string, unknown>) };
    delete malformed['state'];
    const { gh } = fakeGh({ facts: { 33: malformed } });
    await expect(gatherAndEvaluate({ kind: 'issues', issues: [33] }, 'refuse', gh)).rejects.toThrow(
      /#33.*state/,
    );
  });

  describe('out-of-set blocker states come from the state fetch', () => {
    const body = '## Blocked by\n- #90\n';

    it('a CLOSED blocker is satisfied', async () => {
      const { gh, calls } = fakeGh({
        facts: { 3: facts(3, { body }) },
        states: { 90: { number: 90, state: 'CLOSED' } },
      });
      const verdict = await gatherAndEvaluate({ kind: 'issues', issues: [3] }, 'refuse', gh);
      expect(verdict.verdict).toBe('ok');
      expect(calls).toContainEqual(['issue', 'view', '90', '--json', 'number,state']);
    });

    it('an OPEN blocker fails open-blocker', async () => {
      const { gh } = fakeGh({
        facts: { 3: facts(3, { body }) },
        states: { 90: { number: 90, state: 'OPEN' } },
      });
      const verdict = await gatherAndEvaluate({ kind: 'issues', issues: [3] }, 'refuse', gh);
      expect(verdict.failures).toEqual([
        { kind: 'open-blocker', issue: 3, blocker: 90, message: expect.any(String) },
      ]);
    });
  });
});

describe('toIssueFacts', () => {
  it('unions body and native blockers, deduped, ascending', () => {
    expect(
      toIssueFacts({
        number: 5,
        state: 'OPEN',
        labels: [{ name: 'ready-for-agent' }, { name: 'P2' }],
        body: '## Blocked by\n- #9, #2\n',
        blockedBy: {
          nodes: [
            { number: 9, state: 'OPEN' },
            { number: 4, state: 'CLOSED' },
          ],
          totalCount: 2,
        },
      }),
    ).toEqual({
      number: 5,
      state: 'OPEN',
      labels: ['ready-for-agent', 'P2'],
      blockedBy: [2, 4, 9],
    });
  });
});

describe('gatherCheck', () => {
  it('checks one issue from a single facts fetch, never its blockers', async () => {
    const { gh, calls } = fakeGh({
      facts: { 1032: facts(1032, { body: '## Blocked by\n- #1031\n' }) },
    });
    expect(await gatherCheck(1032, gh)).toEqual({ issue: 1032, ready: true, failures: [] });
    expect(calls).toEqual([
      ['issue', 'view', '1032', '--json', 'number,state,labels,body,blockedBy'],
    ]);
  });

  it('reports a missing label as not ready', async () => {
    const { gh } = fakeGh({ facts: { 1026: facts(1026, { labels: ['enhancement'] }) } });
    expect(await gatherCheck(1026, gh)).toEqual({
      issue: 1026,
      ready: false,
      failures: [{ kind: 'missing-label', issue: 1026, message: expect.any(String) }],
    });
  });
});
