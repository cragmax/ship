import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { advance, createScheduler } from '../../../../src/core/scheduler/run-scheduler.js';
import type {
  SchedulerEvent,
  SchedulerInput,
  Transition,
} from '../../../../src/core/scheduler/run-scheduler.types.js';
import { stripComments } from '../../../../../server-pool/test/helpers/render-safety.js';

/** Create, then feed each event in turn; returns every transition, the initial one first. */
function play(input: SchedulerInput, events: readonly SchedulerEvent[]): Transition[] {
  const transitions = [createScheduler(input)];
  for (const event of events) {
    const last = transitions[transitions.length - 1];
    if (last === undefined) throw new Error('unreachable');
    transitions.push(advance(last.state, event));
  }
  return transitions;
}

describe('advance — action order', () => {
  it('emits response, then skips, then starts, then epic-done', () => {
    // R=10 blocks D=11 in epic 900; X=20 alone in epic 800. The second death
    // blocks R (response), skips D, frees the slot for X and finishes 900.
    const [init, first, second] = play(
      {
        runSet: [
          { epic: 900, issues: [10, 11] },
          { epic: 800, issues: [20] },
        ],
        edges: [{ blocker: 10, dependent: 11 }],
        maxSlices: 1,
      },
      [
        { kind: 'agent-died', issue: 10 },
        { kind: 'agent-died', issue: 10 },
      ],
    );
    expect(init?.actions).toEqual([{ kind: 'start', issue: 10 }]);
    expect(first?.actions).toEqual([
      { kind: 'retry', issue: 10 },
      { kind: 'start', issue: 10 },
    ]);
    expect(second?.actions).toEqual([
      { kind: 'block', issue: 10, reason: 'retry-exhausted' },
      { kind: 'skip', issue: 11, cause: { root: 10, trigger: 'retry-exhausted' } },
      { kind: 'start', issue: 20 },
      { kind: 'epic-done', epic: 900 },
    ]);
  });

  it('emits several skips in ascending issue order, not input or edge order', () => {
    const [, blocked] = play(
      {
        runSet: [{ epic: 900, issues: [1, 4, 2, 3] }],
        edges: [
          { blocker: 1, dependent: 4 },
          { blocker: 1, dependent: 2 },
          { blocker: 4, dependent: 3 },
        ],
        maxSlices: 1,
      },
      [{ kind: 'blocked', issue: 1, reason: 'x' }],
    );
    const cause = { root: 1, trigger: 'blocked' };
    expect(blocked?.actions).toEqual([
      { kind: 'skip', issue: 2, cause },
      { kind: 'skip', issue: 3, cause },
      { kind: 'skip', issue: 4, cause },
      { kind: 'epic-done', epic: 900 },
    ]);
  });
});

describe('advance — protocol violations', () => {
  const input: SchedulerInput = {
    runSet: [{ epic: 900, issues: [10, 11] }],
    edges: [{ blocker: 10, dependent: 11 }],
    maxSlices: 1,
  };

  // Issue 11 waits on 10; 12 is a root queued behind 10 (one slot), so ready.
  it.each(
    (['committed', 'blocked', 'harvest-conflict', 'agent-died', 'slot-free'] as const).flatMap(
      (kind) => [
        { kind, issue: 11, phase: 'waiting' },
        { kind, issue: 12, phase: 'ready' },
      ],
    ),
  )('rejects $kind on a $phase issue', ({ kind, issue, phase }) => {
    const [init] = play(
      {
        runSet: [{ epic: 900, issues: [10, 11, 12] }],
        edges: [{ blocker: 10, dependent: 11 }],
        maxSlices: 1,
      },
      [],
    );
    if (init === undefined) throw new Error('unreachable');
    const event = (
      kind === 'blocked' ? { kind, issue, reason: 'x' } : { kind, issue }
    ) as SchedulerEvent;
    expect(() => advance(init.state, event)).toThrow(
      `run scheduler: ${kind} for #${String(issue)}, which is ${phase}`,
    );
  });

  it('rejects slot-free on a landing issue', () => {
    const [, landed] = play(input, [{ kind: 'slot-free', issue: 10 }]);
    if (landed === undefined) throw new Error('unreachable');
    expect(() => advance(landed.state, { kind: 'slot-free', issue: 10 })).toThrow(
      'run scheduler: slot-free for #10, which is landing',
    );
  });

  it.each<SchedulerEvent>([
    { kind: 'committed', issue: 10 },
    { kind: 'blocked', issue: 10, reason: 'x' },
    { kind: 'harvest-conflict', issue: 10 },
    { kind: 'agent-died', issue: 10 },
    { kind: 'slot-free', issue: 10 },
    { kind: 'label-removed', issue: 10 },
  ])('rejects $kind on a settled issue', (event) => {
    const [, settled] = play(input, [{ kind: 'committed', issue: 10 }]);
    if (settled === undefined) throw new Error('unreachable');
    expect(() => advance(settled.state, event)).toThrow(
      `run scheduler: ${event.kind} for #10, which is committed`,
    );
  });

  it('rejects an event for an issue outside the run', () => {
    const [init] = play(input, []);
    if (init === undefined) throw new Error('unreachable');
    expect(() => advance(init.state, { kind: 'label-removed', issue: 99 })).toThrow(
      'run scheduler: label-removed for #99, which is not in the run',
    );
  });

  it.each(['commited', 'toString'])('rejects the unknown event kind %s', (kind) => {
    const [init] = play(input, []);
    if (init === undefined) throw new Error('unreachable');
    const event = { kind, issue: 10 } as unknown as SchedulerEvent;
    expect(() => advance(init.state, event)).toThrow(
      `run scheduler: unknown event ${kind} for #10`,
    );
  });
});

describe('advance — epic halt', () => {
  it('halts an entry with nothing in flight at once, leaving the other entry running', () => {
    // Issue 20 of epic 800 holds the one slot; epic 900's 1 and 3 are ready, 2 waits on 1.
    const [, halted, first, second] = play(
      {
        runSet: [
          { epic: 800, issues: [20, 21] },
          { epic: 900, issues: [1, 2, 3] },
        ],
        edges: [{ blocker: 1, dependent: 2 }],
        maxSlices: 1,
      },
      [
        { kind: 'epic-halt', epic: 900, reason: 'x' },
        { kind: 'committed', issue: 20 },
        { kind: 'committed', issue: 21 },
      ],
    );
    expect(halted?.actions).toEqual([{ kind: 'epic-halted', epic: 900 }]);
    expect(first?.actions).toEqual([{ kind: 'start', issue: 21 }]);
    expect(second?.actions).toEqual([{ kind: 'epic-done', epic: 800 }]);
  });

  it.each<SchedulerEvent>([
    { kind: 'blocked', issue: 1, reason: 'x' },
    { kind: 'agent-died', issue: 1 },
    { kind: 'harvest-conflict', issue: 1 },
  ])(
    'waits for the in-flight issue, then settles it on $kind with no restart or skip',
    (settle) => {
      const [, halted, settled] = play(
        {
          runSet: [
            { epic: 900, issues: [1, 2] },
            { epic: 800, issues: [20] },
          ],
          edges: [{ blocker: 1, dependent: 2 }],
          maxSlices: 1,
        },
        [{ kind: 'epic-halt', epic: 900, reason: 'x' }, settle],
      );
      expect(halted?.actions).toEqual([]);
      expect(settled?.actions).toEqual([
        { kind: 'start', issue: 20 },
        { kind: 'epic-halted', epic: 900 },
      ]);
    },
  );

  it('lets a halted entry release its slot and then settle from landing', () => {
    const [, , landed, settled] = play(
      { runSet: [{ epic: 900, issues: [1] }], edges: [], maxSlices: 1 },
      [
        { kind: 'epic-halt', epic: 900, reason: 'x' },
        { kind: 'slot-free', issue: 1 },
        { kind: 'blocked', issue: 1, reason: 'x' },
      ],
    );
    expect(landed?.actions).toEqual([]);
    expect(settled?.actions).toEqual([{ kind: 'epic-halted', epic: 900 }]);
  });

  it('rejects committed for an in-flight issue of a halted entry', () => {
    const [, halted] = play({ runSet: [{ epic: 900, issues: [1] }], edges: [], maxSlices: 1 }, [
      { kind: 'epic-halt', epic: 900, reason: 'x' },
    ]);
    if (halted === undefined) throw new Error('unreachable');
    expect(() => advance(halted.state, { kind: 'committed', issue: 1 })).toThrow(
      'run scheduler: committed for #1, whose epic #900 is halted',
    );
  });

  it('rejects any event for a halted issue', () => {
    const [, halted] = play({ runSet: [{ epic: 900, issues: [1, 2] }], edges: [], maxSlices: 1 }, [
      { kind: 'epic-halt', epic: 900, reason: 'x' },
    ]);
    if (halted === undefined) throw new Error('unreachable');
    expect(() => advance(halted.state, { kind: 'label-removed', issue: 2 })).toThrow(
      'run scheduler: label-removed for #2, which is halted',
    );
  });

  it.each([
    {
      entry: 'an unknown epic',
      epic: 999,
      events: [],
      label: 'epic #999, which is not in the run',
    },
    {
      entry: 'a halted entry',
      epic: 900,
      events: [{ kind: 'epic-halt', epic: 900, reason: 'x' }] as const,
      label: 'epic #900, which is halted',
    },
    {
      entry: 'a done entry',
      epic: 900,
      events: [{ kind: 'committed', issue: 1 }] as const,
      label: 'epic #900, which is done',
    },
    {
      entry: 'the explicit list when absent',
      epic: null,
      events: [],
      label: 'the explicit list, which is not in the run',
    },
  ])('rejects epic-halt for $entry', ({ epic, events, label }) => {
    const transitions = play(
      {
        runSet: [
          { epic: 900, issues: [1] },
          { epic: 800, issues: [20] },
        ],
        edges: [],
        maxSlices: 2,
      },
      events,
    );
    const last = transitions[transitions.length - 1];
    if (last === undefined) throw new Error('unreachable');
    expect(() => advance(last.state, { kind: 'epic-halt', epic, reason: 'x' })).toThrow(
      `run scheduler: epic-halt for ${label}`,
    );
  });
});

describe('advance — ready order', () => {
  it('queues newly ready issues behind those already waiting, in input order', () => {
    // 5 before 4 in the entry: input order, not numeric order, decides.
    const [, first, second, third] = play(
      {
        runSet: [{ epic: 900, issues: [1, 2, 5, 4] }],
        edges: [
          { blocker: 1, dependent: 5 },
          { blocker: 1, dependent: 4 },
        ],
        maxSlices: 1,
      },
      [
        { kind: 'committed', issue: 1 },
        { kind: 'committed', issue: 2 },
        { kind: 'committed', issue: 5 },
      ],
    );
    expect(first?.actions).toEqual([{ kind: 'start', issue: 2 }]);
    expect(second?.actions).toEqual([{ kind: 'start', issue: 5 }]);
    expect(third?.actions).toEqual([{ kind: 'start', issue: 4 }]);
  });

  it('drops a label-removed issue from the ready queue, so it is never started', () => {
    const [, removed, committed] = play(
      { runSet: [{ epic: 900, issues: [1, 2, 3] }], edges: [], maxSlices: 1 },
      [
        { kind: 'label-removed', issue: 2 },
        { kind: 'committed', issue: 1 },
      ],
    );
    expect(removed?.actions).toEqual([]);
    expect(committed?.actions).toEqual([{ kind: 'start', issue: 3 }]);
  });
});

describe('advance — duplicate edges', () => {
  it('gives the same transitions as the deduplicated edge list', () => {
    const runSet = [{ epic: 900, issues: [1, 2, 3, 4] }];
    const edges = [
      { blocker: 1, dependent: 2 },
      { blocker: 1, dependent: 3 },
      { blocker: 2, dependent: 4 },
      { blocker: 3, dependent: 4 },
    ];
    const events: SchedulerEvent[] = [
      { kind: 'committed', issue: 1 },
      { kind: 'blocked', issue: 2, reason: 'x' },
      { kind: 'committed', issue: 3 },
    ];
    const duplicated = [edges[0], ...edges, edges[3], edges[0]].filter((e) => e !== undefined);
    expect(play({ runSet, edges: duplicated, maxSlices: 2 }, events)).toEqual(
      play({ runSet, edges, maxSlices: 2 }, events),
    );
  });
});

describe('run-scheduler render safety', () => {
  // Read as text: the render step concatenates the type-stripped run-set.ts and
  // run-scheduler.ts into one scope. Comments are stripped first so the header
  // TSDoc may name forbidden tokens.
  const code = (file: string): string =>
    stripComments(readFileSync(resolve(import.meta.dirname, '../../../../src/core', file), 'utf8'));
  const scheduler = code('scheduler/run-scheduler.ts');
  const types = code('scheduler/run-scheduler.types.ts');
  const runSet = code('run-set.ts');
  const imports = (src: string): string[] => src.match(/^import\s[^;]*;/gm) ?? [];
  const isTypeImport = (statement: string): boolean => /^import\s+type\s/.test(statement);
  // Prettier puts only top-level declarations at column 0.
  const topLevelNames = (src: string): string[] =>
    [
      ...src.matchAll(
        /^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((m) => m[1] ?? '');

  it('run-scheduler.ts value-imports only ../run-set.js; every other import is import type', () => {
    const valueImports = imports(scheduler).filter((s) => !isTypeImport(s));
    expect(valueImports.map((s) => /from\s*['"]([^'"]+)['"]/.exec(s)?.[1])).toEqual([
      '../run-set.js',
    ]);
  });

  it('run-scheduler.ts has no dynamic import, require, side-effect import or re-export', () => {
    expect(scheduler).not.toMatch(/\bimport\s*\(/);
    expect(scheduler).not.toMatch(/^import\s*['"]/m);
    expect(scheduler).not.toMatch(/^export\s[^;]*\bfrom\s*['"]/m);
  });

  it.each([
    'eval(',
    'new Function',
    'Date.now',
    'new Date(',
    'Math.random',
    'process.',
    'Buffer',
    'require(',
    'setTimeout',
    'setImmediate',
    'globalThis',
    '__dirname',
    'console',
    'structuredClone',
    'crypto',
    'performance',
    'fetch',
    'setInterval',
    'queueMicrotask',
  ])('run-scheduler.ts never uses %s', (token) => {
    expect(scheduler).not.toContain(token);
  });

  it('run-scheduler.ts never names Date', () => {
    expect(scheduler).not.toMatch(/\bDate\b/);
  });

  it('run-scheduler.types.ts holds only import type lines and type declarations', () => {
    expect(imports(types).length).toBeGreaterThan(0);
    expect(imports(types).filter((s) => !isTypeImport(s))).toEqual([]);
    const columnZero = types.split(/\r?\n/).filter((line) => /^\S/.test(line));
    expect(
      columnZero.filter(
        (line) => !/^(?:import type\s|(?:export\s+)?(?:type|interface)\s|\})/.test(line),
      ),
    ).toEqual([]);
  });

  it('declares no top-level value name that run-set.ts also declares', () => {
    const ours = topLevelNames(scheduler);
    const theirs = topLevelNames(runSet);
    expect(theirs).toEqual(
      expect.arrayContaining([
        'adjacency',
        'findCycles',
        'runSetIssues',
        'stronglyConnected',
        'transitiveDependents',
      ]),
    );
    expect(ours).toEqual(expect.arrayContaining(['advance', 'createScheduler']));
    expect(ours.filter((name) => theirs.includes(name))).toEqual([]);
  });
});

describe('createScheduler', () => {
  it('starts the only issue of a one-issue run', () => {
    const t = createScheduler({ runSet: [{ epic: 900, issues: [7] }], edges: [], maxSlices: 1 });
    expect(t.actions).toEqual([{ kind: 'start', issue: 7 }]);
  });

  it('starts the roots in input order (entry, then position), up to the cap', () => {
    // Issues deliberately not ascending: input order, not numeric order, decides.
    const runSet = [
      { epic: 900, issues: [5, 3] },
      { epic: 800, issues: [9, 1] },
    ];
    const edges = [{ blocker: 5, dependent: 3 }];
    expect(createScheduler({ runSet, edges, maxSlices: 2 }).actions).toEqual([
      { kind: 'start', issue: 5 },
      { kind: 'start', issue: 9 },
    ]);
    expect(createScheduler({ runSet, edges, maxSlices: 4 }).actions).toEqual([
      { kind: 'start', issue: 5 },
      { kind: 'start', issue: 9 },
      { kind: 'start', issue: 1 },
    ]);
  });
});

describe('createScheduler — cycles', () => {
  it('rejects a self-loop, naming the issue', () => {
    expect(() =>
      createScheduler({
        runSet: [{ epic: 900, issues: [3, 4] }],
        edges: [{ blocker: 3, dependent: 3 }],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: dependency cycle among #3');
  });

  it('rejects a 2-cycle, naming both members', () => {
    expect(() =>
      createScheduler({
        runSet: [{ epic: 900, issues: [5, 3] }],
        edges: [
          { blocker: 3, dependent: 5 },
          { blocker: 5, dependent: 3 },
        ],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: dependency cycle among #3, #5');
  });

  it('rejects a 3-cycle, naming every member', () => {
    expect(() =>
      createScheduler({
        runSet: [{ epic: 900, issues: [2, 4, 6, 8] }],
        edges: [
          { blocker: 4, dependent: 6 },
          { blocker: 6, dependent: 2 },
          { blocker: 2, dependent: 4 },
          { blocker: 2, dependent: 8 },
        ],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: dependency cycle among #2, #4, #6');
  });
});

describe('createScheduler — input guards', () => {
  const one = [{ epic: 900, issues: [1] }];

  it.each([0, 1.5])('rejects maxSlices %s', (maxSlices) => {
    expect(() => createScheduler({ runSet: one, edges: [], maxSlices })).toThrow(
      `run scheduler: maxSlices must be an integer of 1 or more, got ${String(maxSlices)}`,
    );
  });

  it('rejects an empty entry, naming its epic', () => {
    expect(() =>
      createScheduler({
        runSet: [
          { epic: 900, issues: [1] },
          { epic: 800, issues: [] },
        ],
        edges: [],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: the entry for epic #800 has no issues');
  });

  it('rejects an empty explicit-list entry', () => {
    expect(() =>
      createScheduler({ runSet: [{ epic: null, issues: [] }], edges: [], maxSlices: 1 }),
    ).toThrow('run scheduler: the entry for the explicit list has no issues');
  });

  it('rejects an issue listed twice within one entry', () => {
    expect(() =>
      createScheduler({ runSet: [{ epic: 900, issues: [4, 2, 4] }], edges: [], maxSlices: 1 }),
    ).toThrow('run scheduler: issue #4 appears more than once in the run set');
  });

  it('rejects an issue listed in two entries', () => {
    expect(() =>
      createScheduler({
        runSet: [
          { epic: 900, issues: [1, 2] },
          { epic: 800, issues: [3, 2] },
        ],
        edges: [],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: issue #2 appears more than once in the run set');
  });

  it('rejects two entries sharing an epic key', () => {
    expect(() =>
      createScheduler({
        runSet: [
          { epic: 900, issues: [1] },
          { epic: 900, issues: [2] },
        ],
        edges: [],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: two entries share the epic key #900');
  });

  it('rejects two explicit-list entries', () => {
    expect(() =>
      createScheduler({
        runSet: [
          { epic: null, issues: [1] },
          { epic: null, issues: [2] },
        ],
        edges: [],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: two entries share the epic key null');
  });

  it('rejects out-of-set edges even when findCycles alone would accept them', () => {
    // 1 -> 99 -> 1 is a cycle only through 99; findCycles ignores edges that
    // leave the issue list, so only the scheduler's own guard catches this.
    expect(() =>
      createScheduler({
        runSet: one,
        edges: [
          { blocker: 1, dependent: 99 },
          { blocker: 99, dependent: 1 },
        ],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: edge #1 -> #99 names #99, which is outside the run set');
  });

  it('checks out-of-set endpoints before cycles', () => {
    expect(() =>
      createScheduler({
        runSet: [{ epic: 900, issues: [1, 2, 3] }],
        edges: [
          { blocker: 1, dependent: 2 },
          { blocker: 2, dependent: 1 },
          { blocker: 3, dependent: 99 },
        ],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: edge #3 -> #99 names #99, which is outside the run set');
  });

  it('rejects an edge that crosses entries', () => {
    expect(() =>
      createScheduler({
        runSet: [
          { epic: 900, issues: [1] },
          { epic: 800, issues: [5] },
        ],
        edges: [{ blocker: 1, dependent: 5 }],
        maxSlices: 1,
      }),
    ).toThrow('run scheduler: edge #1 -> #5 crosses run-set entries');
  });
});
