import { describe, it, expect } from 'vitest';

import {
  checkIssue,
  evaluateRunGate,
  resolveRunSet,
  type GateMode,
  type IssueFacts,
  type IssueState,
} from '../../../../src/core/gate/run-gate.js';
import type { RunSet } from '../../../../src/core/run-set.js';

// Whole-verdict pins leave `message` open; each kind's message content is
// pinned once, by substring, in the `failure messages` block.
const MSG = expect.any(String) as unknown as string;

function issue(
  number: number,
  opts: { state?: IssueState; labels?: readonly string[]; blockedBy?: readonly number[] } = {},
): IssueFacts {
  return {
    number,
    state: opts.state ?? 'OPEN',
    labels: opts.labels ?? ['ready-for-agent'],
    blockedBy: opts.blockedBy ?? [],
  };
}

function gate(
  runSet: RunSet,
  facts: readonly IssueFacts[],
  opts: { mode?: GateMode; blockerStates?: Readonly<Record<number, IssueState>> } = {},
): ReturnType<typeof evaluateRunGate> {
  return evaluateRunGate({
    runSet,
    facts,
    blockerStates: new Map(
      Object.entries(opts.blockerStates ?? {}).map(([n, s]) => [Number(n), s] as const),
    ),
    mode: opts.mode ?? 'refuse',
  });
}

/**
 * The gate over two epic entries: 100's issue 101 waits on 200's issue 201, and 102 on 101.
 *
 * @param opts - The gate's mode; `refuse` by default.
 * @returns The verdict.
 */
function crossEpicGate(opts: { mode?: GateMode } = {}): ReturnType<typeof evaluateRunGate> {
  return gate(
    [
      { epic: 100, issues: [101, 102] },
      { epic: 200, issues: [201] },
    ],
    [issue(101, { blockedBy: [201] }), issue(102, { blockedBy: [101] }), issue(201)],
    opts,
  );
}

describe('evaluateRunGate — per-issue rules', () => {
  it('an explicit list, all open + labelled, no blockers → ok', () => {
    expect(gate([{ epic: null, issues: [3, 5, 9] }], [issue(9), issue(3), issue(5)])).toEqual({
      verdict: 'ok',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [3, 5, 9] }],
      edges: [],
      failures: [],
      excluded: [],
    });
  });

  it('an issue without the label → refused with missing-label (resolved set carried)', () => {
    expect(
      gate(
        [{ epic: null, issues: [3, 5] }],
        [issue(3, { blockedBy: [5] }), issue(5, { labels: ['bug'] })],
      ),
    ).toEqual({
      verdict: 'refused',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [3, 5] }],
      edges: [{ blocker: 5, dependent: 3 }],
      failures: [{ kind: 'missing-label', issue: 5, message: MSG }],
      excluded: [],
    });
  });

  it('a near-miss label still fails', () => {
    expect(
      gate([{ epic: null, issues: [3] }], [issue(3, { labels: ['ready-for-human'] })]).failures,
    ).toEqual([{ kind: 'missing-label', issue: 3, message: MSG }]);
  });

  it('a CLOSED issue in an explicit list → refused with closed', () => {
    expect(
      gate([{ epic: null, issues: [3, 4] }], [issue(3), issue(4, { state: 'CLOSED' })]),
    ).toEqual({
      verdict: 'refused',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [3, 4] }],
      edges: [],
      failures: [{ kind: 'closed', issue: 4, message: MSG }],
      excluded: [],
    });
  });

  it('an out-of-set OPEN blocker → refused with open-blocker', () => {
    expect(
      gate([{ epic: null, issues: [3] }], [issue(3, { blockedBy: [70] })], {
        blockerStates: { 70: 'OPEN' },
      }),
    ).toEqual({
      verdict: 'refused',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [3] }],
      edges: [],
      failures: [{ kind: 'open-blocker', issue: 3, blocker: 70, message: MSG }],
      excluded: [],
    });
  });

  it('an out-of-set CLOSED blocker → ok, no edge', () => {
    expect(
      gate([{ epic: null, issues: [3] }], [issue(3, { blockedBy: [70] })], {
        blockerStates: { 70: 'CLOSED' },
      }),
    ).toEqual({
      verdict: 'ok',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [3] }],
      edges: [],
      failures: [],
      excluded: [],
    });
  });

  it('in-set blockers become edges, deduped and sorted by (blocker, dependent)', () => {
    expect(
      gate(
        [{ epic: null, issues: [1, 2, 3, 4] }],
        [
          issue(4, { blockedBy: [2, 1] }),
          issue(3, { blockedBy: [1, 1] }),
          issue(2, { blockedBy: [1] }),
          issue(1),
        ],
      ),
    ).toEqual({
      verdict: 'ok',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [1, 2, 3, 4] }],
      edges: [
        { blocker: 1, dependent: 2 },
        { blocker: 1, dependent: 3 },
        { blocker: 1, dependent: 4 },
        { blocker: 2, dependent: 4 },
      ],
      failures: [],
      excluded: [],
    });
  });
});

describe('evaluateRunGate — run-level rules', () => {
  it('a 2-cycle and a self-loop → refused with one cycle failure per component', () => {
    expect(
      gate(
        [{ epic: null, issues: [1, 2, 3, 4] }],
        [
          issue(1, { blockedBy: [2] }),
          issue(2, { blockedBy: [1] }),
          issue(3),
          issue(4, { blockedBy: [4, 3] }),
        ],
      ),
    ).toEqual({
      verdict: 'refused',
      mode: 'refuse',
      runSet: [{ epic: null, issues: [1, 2, 3, 4] }],
      edges: [
        { blocker: 1, dependent: 2 },
        { blocker: 2, dependent: 1 },
        { blocker: 3, dependent: 4 },
        { blocker: 4, dependent: 4 },
      ],
      failures: [
        { kind: 'cycle', issues: [1, 2], message: MSG },
        { kind: 'cycle', issues: [4], message: MSG },
      ],
      excluded: [],
    });
  });

  it('every failure is listed, ordered by subject, then kind, then blocker; run-level last', () => {
    expect(
      gate(
        [{ epic: null, issues: [5, 6, 8, 9] }],
        [
          issue(9, { blockedBy: [8] }),
          issue(8, { blockedBy: [9] }),
          issue(6, { state: 'CLOSED' }),
          issue(5, { labels: [], blockedBy: [72, 71] }),
        ],
        { blockerStates: { 71: 'OPEN', 72: 'OPEN' } },
      ).failures,
    ).toEqual([
      { kind: 'missing-label', issue: 5, message: MSG },
      { kind: 'open-blocker', issue: 5, blocker: 71, message: MSG },
      { kind: 'open-blocker', issue: 5, blocker: 72, message: MSG },
      { kind: 'closed', issue: 6, message: MSG },
      { kind: 'cycle', issues: [8, 9], message: MSG },
    ]);
  });

  it('an epic with zero open children → refused with empty-epic, sorted among issue subjects', () => {
    expect(
      gate(
        [
          { epic: 50, issues: [] },
          { epic: 60, issues: [40, 61] },
        ],
        [issue(40, { labels: [] }), issue(61, { labels: [] })],
      ),
    ).toEqual({
      verdict: 'refused',
      mode: 'refuse',
      runSet: [
        { epic: 50, issues: [] },
        { epic: 60, issues: [40, 61] },
      ],
      edges: [],
      failures: [
        { kind: 'missing-label', issue: 40, message: MSG },
        { kind: 'empty-epic', epic: 50, message: MSG },
        { kind: 'missing-label', issue: 61, message: MSG },
      ],
      excluded: [],
    });
  });

  it('a blocker in a different epic entry → refused with cross-epic-blocker, no edge', () => {
    expect(crossEpicGate()).toEqual({
      verdict: 'refused',
      mode: 'refuse',
      runSet: [
        { epic: 100, issues: [101, 102] },
        { epic: 200, issues: [201] },
      ],
      edges: [{ blocker: 101, dependent: 102 }],
      failures: [
        { kind: 'cross-epic-blocker', issue: 101, blocker: 201, blockerEpic: 200, message: MSG },
      ],
      excluded: [],
    });
  });
});

describe('evaluateRunGate — exclude mode', () => {
  it('a cycle still refuses, in the refused shape: every failure listed, nothing excluded', () => {
    expect(
      gate(
        [{ epic: null, issues: [1, 2, 3, 4, 5] }],
        [
          issue(1, { blockedBy: [2] }),
          issue(2, { blockedBy: [1] }),
          issue(3),
          issue(4, { blockedBy: [4, 3] }),
          issue(5, { labels: [] }),
        ],
        { mode: 'exclude' },
      ),
    ).toEqual({
      verdict: 'refused',
      mode: 'exclude',
      runSet: [{ epic: null, issues: [1, 2, 3, 4, 5] }],
      edges: [
        { blocker: 1, dependent: 2 },
        { blocker: 2, dependent: 1 },
        { blocker: 3, dependent: 4 },
        { blocker: 4, dependent: 4 },
      ],
      failures: [
        { kind: 'missing-label', issue: 5, message: MSG },
        { kind: 'cycle', issues: [1, 2], message: MSG },
        { kind: 'cycle', issues: [4], message: MSG },
      ],
      excluded: [],
    });
  });

  it('a failing issue drops, then its transitive dependents; the rest runs', () => {
    expect(
      gate(
        [{ epic: null, issues: [10, 11, 12, 13, 14] }],
        [
          issue(10, { labels: [] }),
          issue(11, { blockedBy: [10] }),
          issue(12, { blockedBy: [11] }),
          issue(13),
          issue(14, { blockedBy: [13] }),
        ],
        { mode: 'exclude' },
      ),
    ).toEqual({
      verdict: 'ok',
      mode: 'exclude',
      runSet: [{ epic: null, issues: [13, 14] }],
      edges: [{ blocker: 13, dependent: 14 }],
      failures: [{ kind: 'missing-label', issue: 10, message: MSG }],
      excluded: [
        { issue: 10, cause: 'failed' },
        { issue: 11, cause: 'dependent', blockers: [10] },
        { issue: 12, cause: 'dependent', blockers: [11] },
      ],
    });
  });

  it('a dependent lists only its dropped direct blockers, ascending', () => {
    expect(
      gate(
        [{ epic: null, issues: [10, 11, 12, 13] }],
        [
          issue(10, { labels: [] }),
          issue(11, { labels: [] }),
          issue(12),
          issue(13, { blockedBy: [12, 11, 10] }),
        ],
        { mode: 'exclude' },
      ).excluded,
    ).toEqual([
      { issue: 10, cause: 'failed' },
      { issue: 11, cause: 'failed' },
      { issue: 13, cause: 'dependent', blockers: [10, 11] },
    ]);
  });

  it('a dependent never lists a dropped CLOSED blocker', () => {
    expect(
      gate(
        [{ epic: null, issues: [10, 11, 12, 13] }],
        [
          issue(10, { labels: [] }),
          issue(11, { state: 'CLOSED' }),
          issue(12, { blockedBy: [11, 10] }),
          issue(13),
        ],
        { mode: 'exclude' },
      ).excluded,
    ).toEqual([
      { issue: 10, cause: 'failed' },
      { issue: 11, cause: 'failed' },
      { issue: 12, cause: 'dependent', blockers: [10] },
    ]);
  });

  it('dropping a CLOSED issue does not drop what it blocks', () => {
    expect(
      gate(
        [{ epic: null, issues: [20, 21] }],
        [issue(20, { state: 'CLOSED' }), issue(21, { blockedBy: [20] })],
        { mode: 'exclude' },
      ),
    ).toEqual({
      verdict: 'ok',
      mode: 'exclude',
      runSet: [{ epic: null, issues: [21] }],
      edges: [],
      failures: [{ kind: 'closed', issue: 20, message: MSG }],
      excluded: [{ issue: 20, cause: 'failed' }],
    });
  });

  it('the dependent walk never passes through a CLOSED blocker', () => {
    expect(
      gate(
        [{ epic: null, issues: [30, 31, 32] }],
        [
          issue(30, { labels: [] }),
          issue(31, { state: 'CLOSED', blockedBy: [30] }),
          issue(32, { blockedBy: [31] }),
        ],
        { mode: 'exclude' },
      ),
    ).toEqual({
      verdict: 'ok',
      mode: 'exclude',
      runSet: [{ epic: null, issues: [32] }],
      edges: [],
      failures: [
        { kind: 'missing-label', issue: 30, message: MSG },
        { kind: 'closed', issue: 31, message: MSG },
      ],
      excluded: [
        { issue: 30, cause: 'failed' },
        { issue: 31, cause: 'failed' },
      ],
    });
  });

  it('dropping every issue refuses with empty-run-set, in the refused shape', () => {
    expect(
      gate(
        [{ epic: null, issues: [40, 41] }],
        [issue(40, { labels: [] }), issue(41, { state: 'CLOSED', blockedBy: [40] })],
        { mode: 'exclude' },
      ),
    ).toEqual({
      verdict: 'refused',
      mode: 'exclude',
      runSet: [{ epic: null, issues: [40, 41] }],
      edges: [{ blocker: 40, dependent: 41 }],
      failures: [
        { kind: 'missing-label', issue: 40, message: MSG },
        { kind: 'closed', issue: 41, message: MSG },
        { kind: 'empty-run-set', message: MSG },
      ],
      excluded: [],
    });
  });

  it('an empty epic still refuses, in the refused shape', () => {
    expect(
      gate(
        [
          { epic: 50, issues: [] },
          { epic: 60, issues: [61, 62] },
        ],
        [issue(61, { labels: [] }), issue(62)],
        { mode: 'exclude' },
      ),
    ).toEqual({
      verdict: 'refused',
      mode: 'exclude',
      runSet: [
        { epic: 50, issues: [] },
        { epic: 60, issues: [61, 62] },
      ],
      edges: [],
      failures: [
        { kind: 'empty-epic', epic: 50, message: MSG },
        { kind: 'missing-label', issue: 61, message: MSG },
      ],
      excluded: [],
    });
  });

  it('a cross-epic dependent drops with its dependents; the blocker stays; an emptied entry goes', () => {
    expect(crossEpicGate({ mode: 'exclude' })).toEqual({
      verdict: 'ok',
      mode: 'exclude',
      runSet: [{ epic: 200, issues: [201] }],
      edges: [],
      failures: [
        { kind: 'cross-epic-blocker', issue: 101, blocker: 201, blockerEpic: 200, message: MSG },
      ],
      excluded: [
        { issue: 101, cause: 'failed' },
        { issue: 102, cause: 'dependent', blockers: [101] },
      ],
    });
  });
});

describe('evaluateRunGate — failure messages', () => {
  function messageOf(runSet: RunSet, facts: readonly IssueFacts[], states = {}): string {
    const [failure] = gate(runSet, facts, { blockerStates: states }).failures;

    return failure?.message ?? '';
  }

  it('closed names the issue', () => {
    expect(messageOf([{ epic: null, issues: [41] }], [issue(41, { state: 'CLOSED' })])).toContain(
      '#41',
    );
  });

  it('missing-label names the issue and the label', () => {
    const message = messageOf([{ epic: null, issues: [42] }], [issue(42, { labels: [] })]);
    expect(message).toContain('#42');
    expect(message).toContain('ready-for-agent');
  });

  it('open-blocker names the issue and the blocker', () => {
    const message = messageOf([{ epic: null, issues: [43] }], [issue(43, { blockedBy: [71] })], {
      71: 'OPEN',
    });

    expect(message).toContain('#43');
    expect(message).toContain('#71');
  });

  it('cross-epic-blocker names the issue, the blocker and its epic', () => {
    const message = messageOf(
      [
        { epic: 300, issues: [301] },
        { epic: 400, issues: [401] },
      ],
      [issue(301, { blockedBy: [401] }), issue(401)],
    );

    expect(message).toContain('#301');
    expect(message).toContain('#401');
    expect(message).toContain('#400');
  });

  it('cycle names every member', () => {
    const message = messageOf(
      [{ epic: null, issues: [44, 45] }],
      [issue(44, { blockedBy: [45] }), issue(45, { blockedBy: [44] })],
    );

    expect(message).toContain('#44');
    expect(message).toContain('#45');
  });

  it('empty-epic names the epic', () => {
    expect(messageOf([{ epic: 46, issues: [] }], [])).toContain('#46');
  });
});

describe('evaluateRunGate — caller bugs throw', () => {
  it('an out-of-set blocker with no state throws naming it, never counts as satisfied', () => {
    expect(() => gate([{ epic: null, issues: [3] }], [issue(3, { blockedBy: [70] })])).toThrow(
      '#70',
    );
  });
});

describe('resolveRunSet', () => {
  it('an issues spec becomes one epic-less entry, ascending', () => {
    expect(resolveRunSet({ kind: 'issues', issues: [1032, 1027, 1031] }, new Map())).toEqual([
      { epic: null, issues: [1027, 1031, 1032] },
    ]);
  });

  it('an epics spec keeps spec order, open children ascending; closed children and the epic omitted', () => {
    expect(
      resolveRunSet(
        { kind: 'epics', epics: [900, 800] },
        new Map([
          [
            800,
            [
              { number: 803, state: 'OPEN' },
              { number: 801, state: 'OPEN' },
            ],
          ],
          [
            900,
            [
              { number: 905, state: 'OPEN' },
              { number: 902, state: 'CLOSED' },
              { number: 903, state: 'OPEN' },
            ],
          ],
        ]),
      ),
    ).toEqual([
      { epic: 900, issues: [903, 905] },
      { epic: 800, issues: [801, 803] },
    ]);
  });

  it('an epic whose children are all closed resolves to an empty entry', () => {
    expect(
      resolveRunSet(
        { kind: 'epics', epics: [700] },
        new Map([[700, [{ number: 701, state: 'CLOSED' }]]]),
      ),
    ).toEqual([{ epic: 700, issues: [] }]);
  });
});

describe('checkIssue', () => {
  it('open + labelled is ready, even with an OPEN blocker', () => {
    expect(checkIssue(issue(1032, { blockedBy: [1031] }))).toEqual({
      issue: 1032,
      ready: true,
      failures: [],
    });
  });

  it('a missing label is not ready', () => {
    expect(checkIssue(issue(1026, { labels: ['enhancement'] }))).toEqual({
      issue: 1026,
      ready: false,
      failures: [{ kind: 'missing-label', issue: 1026, message: MSG }],
    });
  });

  it('a closed issue is not ready', () => {
    expect(checkIssue(issue(1020, { state: 'CLOSED' }))).toEqual({
      issue: 1020,
      ready: false,
      failures: [{ kind: 'closed', issue: 1020, message: MSG }],
    });
  });
});
