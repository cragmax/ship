/**
 * Ship's reader of the lines `with-lease` prints on stderr: its own copy of the pool's parsing,
 * held to the lease log's written contract with the pool, so Ship imports nothing from
 * `server-pool/`, and the run's totals over them. A release line reads
 * `with-lease: waited <W>s for <type>@<host:port>, held <H>s[, waited on <holder>]`, and a wait
 * line `with-lease: waiting for <type>@<host:port> — held by <holder details>`.
 *
 * Render-safe (`src/build/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

/** One lease's timings, as its release line reports them. */
export interface LeaseTiming {
  /** The server type leased (`paper`, `folia`). */
  readonly type: string;
  /** The leased server's `host:rconPort`. */
  readonly endpoint: string;
  /** Seconds spent waiting for a free server. */
  readonly waitedSeconds: number;
  /** Seconds the lease was held. */
  readonly heldSeconds: number;
  /** The holder waited on, absent when there was no wait. */
  readonly waitedOn?: string;
}

/** The whole release line. A leading indent and a trailing carriage return are tolerated. */
const LEASE_LINE =
  /^[ \t]*with-lease: waited (\d+(?:\.\d+)?)s for (\w+)@(\S+), held (\d+(?:\.\d+)?)s(?:, waited on (.+?))?\r?$/u;

/** A wait line's head, whatever its holder. */
const LEASE_WAIT_LINE = /^with-lease: waiting for \w+@\S+ /u;

/**
 * Parse every release line in a block of output.
 *
 * @param text - Output, `\n` or `\r\n` separated.
 * @returns Each well-formed release line's timings, in order, `[]` for none. A wait line and
 *   anything else `with-lease` prints are no release line.
 */
export function parseLeaseLines(text: string): LeaseTiming[] {
  const timings: LeaseTiming[] = [];

  for (const line of text.split('\n')) {
    const timing = parseLeaseLine(line);
    if (timing !== null) timings.push(timing);
  }

  return timings;
}

/**
 * One lease to aggregate, under its issue: a release line as an agent
 * transcribed it, or a lease a tool envelope already parsed.
 */
type LeaseSample = { readonly issue: number } & (
  { readonly line: string } | { readonly lease: LeaseTiming }
);

/** The engines an aggregate totals, in report order. */
const LEASE_ENGINES = ['paper', 'folia'] as const;

/** One engine's totals. */
interface EngineLeaseTotals {
  /** The engine. */
  readonly type: (typeof LEASE_ENGINES)[number];
  /** How many leases. */
  readonly leases: number;
  /** Seconds waited, summed. */
  readonly waitedSeconds: number;
  /** The longest single wait, in seconds. */
  readonly waitedMaxSeconds: number;
  /** Seconds held, summed. */
  readonly heldSeconds: number;
}

/** One issue's totals, over both engines. */
interface IssueLeaseTotals {
  /** The issue. */
  readonly issue: number;
  /** Seconds waited, summed. */
  readonly waitedSeconds: number;
  /** Seconds held, summed. */
  readonly heldSeconds: number;
}

/** A run's lease contention, as its pull request reports it. */
export interface LeaseAggregate {
  /** Paper's totals, then Folia's, zeroed for an engine with no lease. */
  readonly engines: readonly EngineLeaseTotals[];
  /** Each issue's totals, ascending by issue. */
  readonly issues: readonly IssueLeaseTotals[];
  /** Each sample that is not a well-formed Paper or Folia lease, as a line, in sample order. */
  readonly unparsed: readonly { readonly issue: number; readonly line: string }[];
}

/** A running engine total. */
type LeaseTally = { -readonly [K in keyof EngineLeaseTotals]: EngineLeaseTotals[K] };

/** A running issue total. */
type IssueTally = { -readonly [K in keyof IssueLeaseTotals]: IssueLeaseTotals[K] };

/**
 * Total a run's leases per engine and per issue. Every total is rounded to
 * 0.1 s after summing.
 *
 * @param samples - The leases, in any order.
 * @returns The totals. A wait line is skipped: in no total and not in
 *   `unparsed`. Any other line that is no well-formed release line, or a lease of an engine
 *   other than `paper` / `folia` (written back as its release line, seconds to one decimal),
 *   goes to `unparsed` and into no total.
 */
export function aggregateLeaseTimings(samples: readonly LeaseSample[]): LeaseAggregate {
  const engines: LeaseTally[] = LEASE_ENGINES.map((type) => ({
    type,
    leases: 0,
    waitedSeconds: 0,
    waitedMaxSeconds: 0,
    heldSeconds: 0,
  }));
  const issues = new Map<number, IssueTally>();
  const unparsed: { issue: number; line: string }[] = [];

  for (const sample of samples.filter((s) => !leaseIsWaitLine(s))) {
    const lease = 'lease' in sample ? sample.lease : parseLeaseLine(sample.line);
    const engine = engines.find((e) => e.type === lease?.type);

    if (lease === null || engine === undefined) {
      unparsed.push({ issue: sample.issue, line: leaseSampleLine(sample) });
      continue;
    }

    leaseAddToEngine(engine, lease);
    leaseAddToIssue(issues, sample.issue, lease);
  }

  return {
    engines: engines.map((e) => ({
      ...e,
      waitedSeconds: leaseTenths(e.waitedSeconds),
      waitedMaxSeconds: leaseTenths(e.waitedMaxSeconds),
      heldSeconds: leaseTenths(e.heldSeconds),
    })),
    issues: [...issues.values()]
      .sort((a, b) => a.issue - b.issue)
      .map((t) => ({
        ...t,
        waitedSeconds: leaseTenths(t.waitedSeconds),
        heldSeconds: leaseTenths(t.heldSeconds),
      })),
    unparsed,
  };
}

/** One line's timings, or `null` when it is not a well-formed release line. */
function parseLeaseLine(line: string): LeaseTiming | null {
  const match = LEASE_LINE.exec(line);
  if (match === null) return null;
  const [, waited = '', type = '', endpoint = '', held = '', waitedOn] = match;
  const timing = { type, endpoint, waitedSeconds: Number(waited), heldSeconds: Number(held) };

  return waitedOn === undefined ? timing : { ...timing, waitedOn };
}

/** Whether a sample is a line sample holding a wait line, which no total counts. */
function leaseIsWaitLine(sample: LeaseSample): boolean {
  return 'line' in sample && LEASE_WAIT_LINE.test(sample.line);
}

/** A sample as a release line: its line, or its lease written back. */
function leaseSampleLine(sample: LeaseSample): string {
  if ('line' in sample) return sample.line;
  const { type, endpoint, waitedSeconds, heldSeconds, waitedOn } = sample.lease;
  const suffix = waitedOn === undefined ? '' : `, waited on ${waitedOn}`;

  return `with-lease: waited ${waitedSeconds.toFixed(1)}s for ${type}@${endpoint}, held ${heldSeconds.toFixed(1)}s${suffix}`;
}

/** Add one lease to its engine's running total, mutating `engine`. */
function leaseAddToEngine(engine: LeaseTally, lease: LeaseTiming): void {
  engine.leases += 1;
  engine.waitedSeconds += lease.waitedSeconds;
  engine.waitedMaxSeconds = Math.max(engine.waitedMaxSeconds, lease.waitedSeconds);
  engine.heldSeconds += lease.heldSeconds;
}

/** Add one lease to its issue's running total, mutating `issues`. */
function leaseAddToIssue(issues: Map<number, IssueTally>, issue: number, lease: LeaseTiming): void {
  const own = issues.get(issue) ?? { issue, waitedSeconds: 0, heldSeconds: 0 };
  own.waitedSeconds += lease.waitedSeconds;
  own.heldSeconds += lease.heldSeconds;
  issues.set(issue, own);
}

/** Seconds rounded to the nearest tenth. */
function leaseTenths(seconds: number): number {
  return Math.round(seconds * 10) / 10;
}
