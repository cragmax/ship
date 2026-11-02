import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { aggregateLeaseTimings, parseLeaseLines } from '../../../src/workflow/pr/lease-timings.js';

import { describeRenderSafety } from '../../helpers/render-safety.js';

// The pool's wait-line shapes, written out as `with-lease` prints them.
const WAIT_LINE_KNOWN =
  'with-lease: waiting for paper@localhost:25701 — held by epic-911/slice-913-1 (pid 1234, since 2026-09-30T18:23:58.961Z, alive): npx vitest run a.test.ts';
const WAIT_LINE_UNKNOWN =
  'with-lease: waiting for paper@localhost:25701 — held by an unknown holder';

describe('parseLeaseLines', () => {
  it('returns every release line in order, skipping the rest', () => {
    const text = [
      ' RUN  v4.1.1',
      'with-lease: waited 1.0s for paper@localhost:25701, held 10.0s',
      'noise',
      'with-lease: waited 2.0s for folia@localhost:25711, held 20.0s',
      '',
    ].join('\r\n');

    expect(parseLeaseLines(text)).toEqual([
      { type: 'paper', endpoint: 'localhost:25701', waitedSeconds: 1, heldSeconds: 10 },
      { type: 'folia', endpoint: 'localhost:25711', waitedSeconds: 2, heldSeconds: 20 },
    ]);
  });

  // regression: the pool runner prints each shard's release line indented, so a full server-tier
  // run's lines an agent copied verbatim were dropped from the PR body
  it('tolerates the leading indent the pool runner prints a shard’s line with', () => {
    expect(
      parseLeaseLines('  with-lease: waited 3.1s for paper@localhost:25700, held 412.0s'),
    ).toEqual([
      { type: 'paper', endpoint: 'localhost:25700', waitedSeconds: 3.1, heldSeconds: 412 },
    ]);
  });

  it('reads the holder waited on from the suffix', () => {
    expect(
      parseLeaseLines(
        'with-lease: waited 38.9s for paper@localhost:25701, held 27.0s, waited on epic-911/slice-913-1 (pid 1234)\r\n',
      ),
    ).toEqual([
      {
        type: 'paper',
        endpoint: 'localhost:25701',
        waitedSeconds: 38.9,
        heldSeconds: 27,
        waitedOn: 'epic-911/slice-913-1 (pid 1234)',
      },
    ]);
  });

  it.each([
    'with-lease: reset failed on localhost:25701 (1 of 2 candidates): boom',
    'with-lease: waited ?s for paper@localhost:25701, held 1.0s',
    'with-lease: waited 1.0s for paper@localhost:25701',
    'prefix with-lease: waited 1.0s for paper@localhost:25701, held 2.0s',
    WAIT_LINE_KNOWN,
    WAIT_LINE_UNKNOWN,
  ])('reads no release line from %j', (line) => {
    expect(parseLeaseLines(line)).toEqual([]);
  });
});

describe('aggregateLeaseTimings', () => {
  // Issue 7's two waits sum to 2.75s, which pins the rounding to 0.1 (2.8).
  const SAMPLES = [
    { issue: 8, line: 'with-lease: waited 1.5s for paper@localhost:25701, held 42.0s' },
    { issue: 7, line: 'with-lease: waited 0.5s for paper@localhost:25701, held 60.0s' },
    { issue: 7, line: 'with-lease: waited 2.25s for folia@localhost:25711, held 30.0s' },
    {
      issue: 9,
      lease: { type: 'folia', endpoint: 'localhost:25711', waitedSeconds: 4, heldSeconds: 90 },
    },
  ];
  const SAMPLES_TOTALS = {
    engines: [
      { type: 'paper', leases: 2, waitedSeconds: 2, waitedMaxSeconds: 1.5, heldSeconds: 102 },
      { type: 'folia', leases: 2, waitedSeconds: 6.3, waitedMaxSeconds: 4, heldSeconds: 120 },
    ],
    issues: [
      { issue: 7, waitedSeconds: 2.8, heldSeconds: 90 },
      { issue: 8, waitedSeconds: 1.5, heldSeconds: 42 },
      { issue: 9, waitedSeconds: 4, heldSeconds: 90 },
    ],
    unparsed: [],
  };

  it('totals each engine, paper then folia, and each issue ascending, a parsed lease beside the lines', () => {
    expect(aggregateLeaseTimings(SAMPLES)).toEqual(SAMPLES_TOTALS);
  });

  it('skips a wait line: in no total and not unparsed', () => {
    expect(
      aggregateLeaseTimings([
        ...SAMPLES,
        { issue: 7, line: WAIT_LINE_KNOWN },
        { issue: 8, line: WAIT_LINE_UNKNOWN },
      ]),
    ).toEqual(SAMPLES_TOTALS);
  });

  it('keeps a malformed line and an unknown engine unparsed, with their issue, out of the totals', () => {
    const agg = aggregateLeaseTimings([
      ...SAMPLES,
      { issue: 9, line: 'with-lease: waited ?s for paper@h:1, held 1.0s' },
      { issue: 7, line: 'with-lease: waited 3.0s for forge@h:1, held 5.0s' },
      {
        issue: 8,
        lease: {
          type: 'forge',
          endpoint: 'h:2',
          waitedSeconds: 1.25,
          heldSeconds: 2,
          waitedOn: 'x',
        },
      },
    ]);

    expect(agg.unparsed).toEqual([
      { issue: 9, line: 'with-lease: waited ?s for paper@h:1, held 1.0s' },
      { issue: 7, line: 'with-lease: waited 3.0s for forge@h:1, held 5.0s' },
      { issue: 8, line: 'with-lease: waited 1.3s for forge@h:2, held 2.0s, waited on x' },
    ]);
    expect(agg.engines).toEqual(SAMPLES_TOTALS.engines);
    expect(agg.issues).toEqual(SAMPLES_TOTALS.issues);
  });

  it('gives two zeroed engines and nothing else for no samples', () => {
    const zero = { leases: 0, waitedSeconds: 0, waitedMaxSeconds: 0, heldSeconds: 0 };

    expect(aggregateLeaseTimings([])).toEqual({
      engines: [
        { type: 'paper', ...zero },
        { type: 'folia', ...zero },
      ],
      issues: [],
      unparsed: [],
    });
  });
});

describeRenderSafety(resolve(import.meta.dirname, '../../../src/workflow/pr/lease-timings.ts'));
