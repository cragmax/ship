/**
 * Fake workflow hooks for driving `runShip` in vitest: `agent()` answers from
 * a label-keyed response table and records every call; `parallel` and
 * `pipeline` run their work in order, so a recorded call sequence is
 * deterministic.
 */

import type { AgentOptions, WorkflowHooks } from '../../../../tooling/workflows/lib/hooks.types.js';

/** One recorded `agent()` call. */
export interface RecordedCall {
  /** The call's label. */
  readonly label: string;
  /** Its `agentType`, `undefined` when not given. */
  readonly agentType: string | undefined;
  /** Its `model`, `undefined` when not given. */
  readonly model: string | undefined;
  /** Its `effort`, `undefined` when not given. */
  readonly effort: string | undefined;
  /** The command words after `npx tsx` on the prompt's `Command:` line, unquoted; `[]` without one. */
  readonly argv: readonly string[];
  /** The prompt. */
  readonly prompt: string;
}

/** A fake run: the hooks to pass, and what they recorded. */
export interface FakeRun {
  /** The hooks. */
  readonly hooks: WorkflowHooks;
  /** Every `agent()` call, in call order. */
  readonly calls: RecordedCall[];
  /** Every `phase()` title, in call order. */
  readonly phases: string[];
  /** Every `agent()` call (`call <label>`) and `log()` line (`log <message>`), interleaved in order. */
  readonly timeline: string[];
}

/** A table entry answering per call: `nth` counts the earlier calls it answered. */
type Responder = (call: RecordedCall, nth: number) => unknown;

/**
 * A responder answering its values in turn, the last one for every later call.
 *
 * @param values - The answers.
 * @returns The responder.
 */
export function inTurn(...values: readonly unknown[]): Responder {
  return (_call, nth) => values[Math.min(nth, values.length - 1)];
}

/** An `ok` pre-flight: master level, `gh` logged in, the warm set answering. */
export const PREFLIGHT_OK = {
  exitCode: 0,
  envelopePath: 'reports/tool/preflight.json',
  status: 'ok',
  worktree: 'C:/src/main',
  snapshot: { head: 'abc123', dirty: false },
  problems: [],
  errors: [],
};

/** An `ok` gate over the one-issue explicit run of #7. */
export const GATE_OK = {
  exitCode: 0,
  envelopePath: 'reports/tool/run-gate.json',
  verdict: 'ok',
  failures: [],
  excluded: [],
  runSet: [{ epic: null, issues: [7] }],
  edges: [],
};

/** No live run. */
export const LIVE_RUNS_NONE = {
  exitCode: 0,
  envelopePath: 'reports/tool/live-runs.json',
  status: 'ok',
  runs: [],
  errors: [],
};

/** #7 fresh, no overlap. */
export const SCOUT_FRESH = {
  issues: [{ issue: 7, stale: false, evidence: 'every named symbol present' }],
  overlaps: [],
};

const RUN_ROOT = 'C:/src/ph-runs/7';

/** Fields every `ok` worktree-CLI output carries. */
const OK = { exitCode: 0, envelopePath: 'e.json', status: 'ok', errors: [] };

/** The run's report directory in the fakes. */
export const REPORT_DIR = `${RUN_ROOT}/reports`;

/** The run's batch worktree in the fakes. */
export const BATCH = `${RUN_ROOT}/batch`;

/** The files the fake tdd's slice commit changes. */
export const TDD_FILES = ['tooling/x.ts', 'test/unit/tooling/x.test.ts'];

/** A GREEN tdd over {@link TDD_FILES}, with one lease line and no probe. */
export const TDD_GREEN = {
  verdict: 'GREEN',
  sha: 'slice1',
  files: TDD_FILES,
  leaseLines: ['with-lease: waited 1.5s for paper@localhost:25575, held 42.0s'],
  probes: [],
};

/** A plan card for #7. */
export const PLAN_CARD = {
  verdict: 'plan',
  planPath: `${REPORT_DIR}/plans/7.md`,
  summary: 'add the x tool',
  tier: 'unit',
  commit: { type: 'feat', scope: 'build', subject: 'add the x tool' },
  closes: 'fixes',
  evidence: 'the issue asks for x',
};

/** A clean land of #7's slice. */
export const LAND_OK = {
  ...OK,
  sha: 'slice1',
  commit: 'landed1',
  files: TDD_FILES,
  conflicts: [],
  rolledBack: false,
  batchClean: true,
};

/**
 * A green server tier on `engine`.
 *
 * @param engine - The engine.
 * @returns The output.
 */
const tierOk = (engine: string) => ({
  ...OK,
  engine,
  version: '1.21.4',
  tests: { passed: 12, failed: 0, skipped: 1 },
  lease: { type: engine, endpoint: 'localhost:25575', waitedSeconds: 0.5, heldSeconds: 60 },
});

/** The all-pass answers of a full run of `issues 7`, by label. */
const HAPPY_PATH: Readonly<Record<string, unknown>> = {
  'runner:preflight': PREFLIGHT_OK,
  'runner:run-gate': GATE_OK,
  'runner:live-runs': LIVE_RUNS_NONE,
  scout: SCOUT_FRESH,
  'runner:cut-batch': {
    ...OK,
    worktree: 'C:/src/main',
    branch: 'ship/7',
    base: 'master0',
    runRoot: RUN_ROOT,
    batch: BATCH,
    reportDir: REPORT_DIR,
  },
  'runner:provision-batch': {
    ...OK,
    registry: `${REPORT_DIR}/pool-registry.batch.json`,
    env: { PH_PROJECT_DIR: BATCH, PH_POOL_REGISTRY: `${REPORT_DIR}/pool-registry.batch.json` },
  },
  'runner:check': { exitCode: 0, envelopePath: 'e.json', issue: 7, ready: true, failures: [] },
  'runner:cut-slice': {
    ...OK,
    branch: 'slice/7/7-1',
    base: 'cut1',
    slice: `${RUN_ROOT}/slice-7-1`,
  },
  'runner:provision': { ...OK, env: { PH_PROJECT_DIR: BATCH } },
  planner: PLAN_CARD,
  planReviewer: { verdict: 'approved', findings: 0, findingsPath: `${REPORT_DIR}/pr.md` },
  tdd: TDD_GREEN,
  reviewer: { verdict: 'clean', sha: 'slice1', summary: 'no finding' },
  testReview: { verdict: 'clean', sha: 'slice1', survivors: 0, summary: 'every mutant killed' },
  'runner:land': LAND_OK,
  'runner:teardown': { ...OK, removed: true, registered: false },
  'runner:server-tier:paper': tierOk('paper'),
  'runner:server-tier:folia': tierOk('folia'),
  'runner:sync-master': { ...OK, outcome: 'up-to-date', commit: null, conflicts: [], pending: [] },
  'runner:bump': { ...OK, kind: 'minor', from: '1.0.0', to: '1.1.0', commit: 'bump1' },
  'runner:publish': { ...OK, pushed: true, pr: { number: 42, url: 'https://x/pull/42' } },
};

/**
 * Build fake hooks answering each label from `responses` over the all-pass
 * defaults of a full `issues 7` run. A label `a:b:c` is answered by the
 * first of `a:b:c`, `a:b` and `a` the table holds; a label none matches
 * answers `null`, as a dead agent does.
 *
 * @param responses - Per-label answers (or {@link Responder}s) overriding the defaults.
 * @returns The hooks and their records.
 */
export function fakeHooks(responses: Readonly<Record<string, unknown>> = {}): FakeRun {
  const table: Readonly<Record<string, unknown>> = { ...HAPPY_PATH, ...responses };
  const calls: RecordedCall[] = [];
  const phases: string[] = [];
  const timeline: string[] = [];
  const answered = new Map<string, number>();
  const agent = (prompt: string, options: AgentOptions): Promise<unknown> => {
    const call: RecordedCall = {
      label: options.label,
      agentType: options.agentType,
      model: options.model,
      effort: options.effort,
      argv: commandWords(prompt),
      prompt,
    };
    calls.push(call);
    timeline.push(`call ${options.label}`);
    const key = tableKey(table, options.label);
    if (key === undefined) return Promise.resolve(null);
    const nth = answered.get(key) ?? 0;
    answered.set(key, nth + 1);
    const entry = table[key];
    return Promise.resolve(typeof entry === 'function' ? (entry as Responder)(call, nth) : entry);
  };
  const hooks: WorkflowHooks = {
    agent,
    parallel: async (thunks) => {
      const out = [];
      for (const thunk of thunks) out.push(await thunk());
      return out;
    },
    pipeline: async (items, step) => {
      const out = [];
      for (const item of items) out.push(await step(item));
      return out;
    },
    phase: (title) => {
      phases.push(title);
    },
    log: (message) => {
      timeline.push(`log ${message}`);
    },
  };
  return { hooks, calls, phases, timeline };
}

/**
 * The table key answering `label`: the label itself, else its longest
 * `:`-prefix the table holds.
 *
 * @param table - The response table.
 * @param label - The call's label.
 * @returns The key; `undefined` when none is held.
 */
function tableKey(table: Readonly<Record<string, unknown>>, label: string): string | undefined {
  const parts = label.split(':');
  for (let n = parts.length; n > 0; n--) {
    const key = parts.slice(0, n).join(':');
    if (Object.hasOwn(table, key)) return key;
  }
  return undefined;
}

/**
 * The words after `npx tsx` on a prompt's `Command:` line, each unquoted
 * (a `'…'` span is one word, `'\''` a literal quote).
 *
 * @param prompt - The prompt.
 * @returns The words; `[]` when the prompt has no such line.
 */
function commandWords(prompt: string): string[] {
  const line = prompt.split('\n').find((l) => l.startsWith('Command: npx tsx '));
  if (line === undefined) return [];
  const words = line.slice('Command: npx tsx '.length).match(/(?:'[^']*'|\\'|[^\s'\\])+/g) ?? [];
  return words.map((w) => w.replace(/'([^']*)'|\\'/g, (_m, inner?: string) => inner ?? "'"));
}
