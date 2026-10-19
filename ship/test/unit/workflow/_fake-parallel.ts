/**
 * Helpers for driving `runShip` concurrently through `fakeHooks`' answer gate: {@link holdable}
 * keeps chosen calls pending until a test releases them, {@link idle} lets every unheld call chain
 * run to a standstill, {@link settleInOrder} settles held calls one per standstill, oldest or
 * newest first, so a test can compare call orders under different settle timings, and
 * {@link entryResponses} gives each run-set entry its own batch, report directory, branch and PR
 * number.
 */

import { readyVerdict, type RecordedCall } from './_fake-hooks.js';

/** A gate that holds matching calls until released. */
interface Holdable {
  /** Pass as `fakeHooks`' `gate`. */
  readonly gate: (call: RecordedCall, answer: unknown) => Promise<unknown>;
  /** Settle every held call with this label; later calls with it pass. */
  readonly release: (label: string) => void;
  /** Settle every held call, and hold nothing from now on. */
  readonly releaseAll: () => void;
  /** The labels held now, in call order. */
  readonly held: () => string[];
}

/** One held call. */
interface HeldCall {
  readonly label: string;
  readonly settle: () => void;
}

/**
 * A gate holding every call whose label `match` accepts.
 *
 * @param match - The labels to hold.
 * @returns The gate and its controls.
 */
export function holdable(match: RegExp): Holdable {
  let holding = true;
  const released = new Set<string>();
  const pending: HeldCall[] = [];
  const settle = (keep: (h: HeldCall) => boolean): void => {
    for (const h of pending.filter((p) => !keep(p))) h.settle();
    const kept = pending.filter(keep);
    pending.length = 0;
    pending.push(...kept);
  };
  return {
    gate: (call, answer) => {
      if (!holding || released.has(call.label) || !match.test(call.label)) {
        return Promise.resolve(answer);
      }
      return new Promise((resolve) => {
        pending.push({ label: call.label, settle: () => resolve(answer) });
      });
    },
    release: (label) => {
      released.add(label);
      settle((h) => h.label !== label);
    },
    releaseAll: () => {
      holding = false;
      settle(() => false);
    },
    held: () => pending.map((h) => h.label),
  };
}

/**
 * Let every unheld call chain run to a standstill: one macrotask tick, by
 * which every fake answer's microtask chain has drained.
 *
 * @returns Resolves on the next `setImmediate`.
 */
export function idle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Which held call a {@link settleInOrder} pump settles at each standstill. */
export type SettleOrder = 'oldest' | 'newest';

/** A gate holding every call, and the pump that settles them. */
interface SettlePump {
  /** Pass as `fakeHooks`' `gate`; it holds every call. */
  readonly gate: (call: RecordedCall, answer: unknown) => Promise<unknown>;
  /**
   * Settle one held call per standstill until `done` settles.
   *
   * @param done - The run.
   * @returns Resolves or rejects as `done` does; rejects when the run stands
   *   still with no call held.
   */
  readonly drain: <T>(done: Promise<T>) => Promise<T>;
}

/**
 * A pump settling every held call one per standstill ({@link idle}): the
 * oldest held first, or the newest.
 *
 * @param order - Which held call each standstill settles.
 * @returns The gate and its drain.
 */
export function settleInOrder(order: SettleOrder): SettlePump {
  const pending: HeldCall[] = [];
  return {
    gate: (call, answer) =>
      new Promise((resolve) => {
        pending.push({ label: call.label, settle: () => resolve(answer) });
      }),
    drain: async (done) => {
      const run = { settled: false };
      const mark = (): void => {
        run.settled = true;
      };
      // Handles `done`'s rejection here; the `return done` below surfaces it.
      void done.then(mark, mark);
      for (;;) {
        await idle();
        if (run.settled) return done;
        const next = order === 'oldest' ? pending.shift() : pending.pop();
        if (next === undefined) throw new Error('the run stands still with no call held');
        next.settle();
      }
    },
  };
}

/** Fields every `ok` worktree-CLI output carries. */
const OK = { exitCode: 0, envelopePath: 'e.json', status: 'ok', errors: [] };

/**
 * One epic entry's cut, provision and publish answers: batch
 * `C:/src/ph-runs/epic-<E>/batch`, branch `ship/epic-<E>`, PR number `<E>00`.
 *
 * @param epic - The entry's epic.
 * @returns The answers, keyed by the entry's labels.
 */
function entryResponses(epic: number): Record<string, unknown> {
  const tag = `epic-${String(epic)}`;
  const root = `C:/src/ph-runs/${tag}`;
  return {
    [`runner:cut-batch:${tag}`]: {
      ...OK,
      worktree: 'C:/src/main',
      branch: `ship/${tag}`,
      base: `master-${tag}`,
      batch: `${root}/batch`,
      reportDir: `${root}/reports`,
      attach: null,
    },
    [`runner:provision-batch:${tag}`]: {
      ...OK,
      registry: `${root}/reports/pool-registry.batch.json`,
      env: {
        PH_PROJECT_DIR: `${root}/batch`,
        PH_POOL_REGISTRY: `${root}/reports/pool-registry.batch.json`,
      },
    },
    [`runner:publish:${tag}`]: {
      ...OK,
      pushed: true,
      pr: { number: epic * 100, url: `https://x/pull/${String(epic * 100)}` },
      mergeable: null,
    },
  };
}

/**
 * A run of epic entries: the gate's run set and edges, every issue ready, each entry's answers.
 *
 * @param entries - Each epic and its issues, in run-set order.
 * @param edges - The declared edges.
 * @returns The answers.
 */
export function epicRun(
  entries: readonly { readonly epic: number; readonly issues: readonly number[] }[],
  edges: readonly { readonly blocker: number; readonly dependent: number }[] = [],
): Record<string, unknown> {
  const issues = entries.flatMap((e) => e.issues);
  return {
    'runner:run-gate': {
      exitCode: 0,
      envelopePath: 'g.json',
      verdict: 'ok',
      failures: [],
      excluded: [],
      runSet: entries,
      edges,
    },
    issueReadiness: {
      issues: issues.map((issue) => readyVerdict(issue)),
    },
    ...Object.fromEntries(entries.flatMap((e) => Object.entries(entryResponses(e.epic)))),
  };
}
