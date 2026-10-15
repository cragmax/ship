/**
 * Fake workflow hooks for driving `runShip` in vitest: `agent()` answers from a label-keyed
 * response table and records every call; `pipeline` runs its work in order; `parallel` starts
 * every thunk at once, in array order, and settles as `Promise.all` does, so a recorded call
 * sequence stays deterministic. Each answer passes through its call's schema as an agent's would:
 * cut to the schema's properties, each violation recorded in {@link FakeRun.violations}. A `null`
 * answer is a dead agent's, and no schema applies to it.
 */

import { onTestFinished } from 'vitest';

import type {
  AgentOptions,
  JsonSchema,
  WorkflowHooks,
} from '../../../../tooling/workflows/lib/hooks.types.js';
import type { MasterMove } from '../../../../tooling/worktree/types-run.js';

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
  /** The words after `npx tsx` on the prompt's `Command:` line, unquoted; `[]` without one. */
  readonly argv: readonly string[];
  /** The prompt. */
  readonly prompt: string;
  /** Its output schema, `undefined` when not given. */
  readonly schema: JsonSchema | undefined;
}

/** Options of {@link fakeHooks}. */
export interface FakeOptions {
  /**
   * Wraps each answer before its `agent()` promise settles; the default
   * settles it at once. A held call is one whose promise the gate has not
   * settled yet.
   */
  readonly gate?: (call: RecordedCall, answer: unknown) => Promise<unknown>;
  /**
   * The run answers off its call schemas on purpose: its {@link FakeRun.violations} are recorded
   * for the test to read, and do not fail it. Without it, any violation fails the test that made
   * the run, when that test finishes, so {@link fakeHooks} must be called inside a running test.
   */
  readonly offSchema?: boolean;
}

/** A fake run: the hooks to pass, and what they recorded. */
export interface FakeRun {
  /** The hooks. */
  readonly hooks: WorkflowHooks;
  /** Every `agent()` call, in call order. */
  readonly calls: RecordedCall[];
  /** Every `phase()` title, in call order. */
  readonly phases: string[];
  /** Every `agent()` call (`call <label>`) and `log()` line (`log <message>`), in order. */
  readonly timeline: string[];
  /**
   * Where an answer broke its call's schema: `<label>.<path>: <what>`. Any
   * line fails the test when it finishes, unless {@link FakeOptions.offSchema}.
   */
  readonly violations: string[];
}

/** A table entry answering per call: `nth` counts the earlier calls it answered. */
export type Responder = (call: RecordedCall, nth: number) => unknown;

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
  snapshot: { head: 'abc123', dirty: false, master: { local: 'local0', remote: 'origin0' } },
  problems: [],
  errors: [],
};

/** An `ok` gate over the one-issue explicit run of issue 7. */
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

/** The checks of an `issue-readiness` verdict: the tree, then each rubric point. */
const READINESS_CHECKS = [
  'current',
  'sliceable',
  'unblocked',
  'rightSized',
  'directionDecided',
  'specified',
] as const;

/**
 * One issue's `issue-readiness` verdict: every check passing but those `fails` names.
 *
 * @param issue - The issue.
 * @param fails - Each failing check and its evidence.
 * @returns The verdict.
 */
export const readyVerdict = (
  issue: number,
  fails: Partial<Record<(typeof READINESS_CHECKS)[number], string>> = {},
) => ({
  issue,
  ...Object.fromEntries(
    READINESS_CHECKS.map((check) => {
      const evidence = fails[check];
      return [
        check,
        evidence === undefined ? { pass: true, evidence: 'holds' } : { pass: false, evidence },
      ];
    }),
  ),
});

const RUN_ROOT = 'C:/src/ph-runs/7';

/** Fields every `ok` worktree-CLI output carries. */
export const OK = { exitCode: 0, envelopePath: 'e.json', status: 'ok', errors: [] };

/**
 * A `live-runs` answer holding `runs`.
 *
 * @param runs - The runs, each over a spent, clean, un-nested default.
 * @returns The answer.
 */
export const liveRuns = (...runs: Readonly<Record<string, unknown>>[]) => ({
  'runner:live-runs': {
    ...OK,
    runs: runs.map((r, i) => ({
      branch: `ship/old-${String(i)}`,
      landed: [],
      pr: { state: 'merged', number: 100 + i },
      spent: true,
      spentUnverified: false,
      path: `C:/src/ph-runs/old-${String(i)}/batch`,
      dirty: false,
      nested: [],
      ...r,
    })),
  },
});

/** One ref's scripted move for {@link masterMoved}. */
export interface ScriptedMove {
  /** The move. */
  readonly move: MasterMove['move'];
  /** The current sha; `null` when deleted. */
  readonly current: string | null;
  /**
   * `origin`'s synced sha; defaults to `origin0`, the default sync's
   * `upstream`; ignored for local.
   */
  readonly synced?: string | null;
}

/**
 * A `check-master` answer moving each ref from its launch sha in {@link PREFLIGHT_OK}.
 *
 * @param local - Local `master`'s move.
 * @param remote - `origin`'s `master` move.
 * @returns The answer, under `runner:check-master`.
 */
export const masterMoved = (
  local: ScriptedMove,
  remote: ScriptedMove,
): Readonly<Record<string, unknown>> => {
  const passed = [local, remote].every((m) => m.move === 'equal' || m.move === 'forward');
  return {
    'runner:check-master': {
      exitCode: passed ? 0 : 1,
      envelopePath: 'e.json',
      status: passed ? 'ok' : 'refused',
      ...(passed ? {} : { reason: 'master-not-forward' }),
      errors: passed ? [] : [{ step: 'check', message: 'master is not forward of its launch' }],
      local: { launch: 'local0', ...local, synced: null },
      remote: { launch: 'origin0', synced: 'origin0', ...remote },
    },
  };
};

/** The run's report directory in the fakes. */
export const REPORT_DIR = `${RUN_ROOT}/reports`;

/** The run's batch worktree in the fakes. */
export const BATCH = `${RUN_ROOT}/batch`;

/** The files the fake tdd's slice commit changes. */
export const TDD_FILES = ['tooling/x.ts', 'test/unit/tooling/x.test.ts'];

/**
 * A GREEN tdd over {@link TDD_FILES} for issue 7, with one lease line, no probe, its tracer's
 * red-green, and the commit line and cite it chose.
 */
export const TDD_GREEN = {
  verdict: 'GREEN',
  sha: 'slice1',
  files: TDD_FILES,
  leaseLines: ['with-lease: waited 1.5s for paper@localhost:25575, held 42.0s'],
  probes: [],
  evidence: {
    kind: 'tracer',
    test: 'test/unit/tooling/x.test.ts › adds x',
    pseudocode: 'x()\n  returns 1',
    red: 'AssertionError: expected undefined to be 1',
    green: '✓ test/unit/tooling/x.test.ts › adds x',
    reason: '',
  },
  recorded: [],
  commit: { type: 'feat', scope: 'build', subject: 'add the x tool' },
  closes: 'fixes',
};

/** A tdd that blocked before committing: the tree already does what issue 7 asks. */
export const TDD_BLOCKED = { ...TDD_GREEN, verdict: 'BLOCKED', sha: '', reason: 'done at abc123' };

/** A clean land of issue 7's slice: {@link TDD_FILES}, 40 lines changed. */
export const LAND_OK = {
  ...OK,
  sha: 'slice1',
  commit: 'landed1',
  files: TDD_FILES,
  lines: 40,
  conflicts: [],
  rolledBack: false,
  batchClean: true,
  at: '2026-09-29T10:20:00.000Z',
};

/** A bump that found the version already at its target: `ok`, no commit. */
export const BUMP_NO_OP = { ...OK, kind: 'patch', from: '1.0.1', to: '1.0.1', commit: null };

/** A PR writer's answer: a one-line summary, a two-way door, no note and no ramifications. */
export const PR_WRITER_OK = {
  summary: 'Adds the x tool.',
  door: 'two-way',
  doorNote: '',
  blastRadius: 'tooling',
  ramifications: '',
};

/** An epic review accepting issue 7: its one criterion met, no finding. */
export const EPIC_ACCEPTED = {
  verdict: 'accepted',
  summary: 'every criterion met',
  criteria: [{ issue: 7, criterion: 'adds the x tool', state: 'met', evidence: 'tooling/x.ts:1' }],
  findings: [],
  unchecked: [],
};

/** The all-pass answers of a full run of `issues 7`, by label. */
const HAPPY_PATH: Readonly<Record<string, unknown>> = {
  'runner:preflight': PREFLIGHT_OK,
  'runner:run-gate': GATE_OK,
  'runner:live-runs': LIVE_RUNS_NONE,
  issueReadiness: { issues: [readyVerdict(7)] },
  issueOverlap: { issues: [], pairs: [], liveOverlaps: [], areaMap: 'read' },
  'runner:cut-batch': {
    ...OK,
    worktree: 'C:/src/main',
    branch: 'ship/7',
    base: 'master0',
    batch: BATCH,
    reportDir: REPORT_DIR,
    attach: null,
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
    at: '2026-09-29T10:00:00.000Z',
  },
  'runner:provision': { ...OK, env: { PH_PROJECT_DIR: BATCH } },
  tdd: TDD_GREEN,
  // Each amending stage answers a new sha, so a stage that reads a stale one shows.
  specReview: { verdict: 'fixed', sha: 'spec1', summary: 'covered criterion 3', leaseLines: [] },
  standardsReview: {
    verdict: 'fixed',
    sha: 'slice2',
    summary: 'renamed a helper',
    leaseLines: [],
  },
  // Clean: no amend, so the standards review's sha stands.
  manifestTsdoc: { verdict: 'clean', sha: 'slice2', summary: 'nothing to fix' },
  'runner:land': LAND_OK,
  'runner:teardown': { ...OK, removed: true, registered: false, kept: null },
  'runner:retire-run': OK,
  'runner:sync-master': {
    ...OK,
    outcome: 'up-to-date',
    commit: null,
    upstream: 'origin0',
    conflicts: [],
    version: null,
    pending: [],
  },
  'runner:bump': { ...OK, kind: 'minor', from: '1.0.0', to: '1.1.0', commit: 'bump1' },
  'runner:check-master': {
    ...OK,
    local: { launch: 'local0', synced: null, current: 'local0', move: 'equal' },
    remote: { launch: 'origin0', synced: 'origin0', current: 'origin0', move: 'equal' },
  },
  'runner:publish': {
    ...OK,
    pushed: true,
    pr: { number: 42, url: 'https://x/pull/42' },
    mergeable: null,
  },
  'runner:append-pr-body': OK,
  'runner:post-pr-comment': { ...OK, url: 'https://x/pull/9#issuecomment-1' },
  'runner:post-issue-comment': { ...OK, url: 'https://x/issues/7#issuecomment-2' },
  auditTests: {
    verdict: 'clean',
    sha: '',
    files: [],
    commit: { type: 'test', scope: 'build', subject: '' },
    survivors: 0,
    summary: 'nothing to harden',
    leaseLines: [],
  },
  epicReview: EPIC_ACCEPTED,
  retro: { findings: [] },
  prWriter: PR_WRITER_OK,
};

/**
 * Fake hooks answering from `responses` over the all-pass defaults of a full `issues 7` run.
 *
 * @param responses - Per-label answers or {@link Responder}s; a label no key matches gets `null`.
 * @param options - The answer gate, and whether the run answers off its schemas on purpose.
 * @returns The hooks and their records.
 */
export function fakeHooks(
  responses: Readonly<Record<string, unknown>> = {},
  options: FakeOptions = {},
): FakeRun {
  const table: Readonly<Record<string, unknown>> = { ...HAPPY_PATH, ...responses };
  const gate = options.gate ?? ((_call: RecordedCall, answer: unknown) => Promise.resolve(answer));
  const calls: RecordedCall[] = [];
  const phases: string[] = [];
  const timeline: string[] = [];
  const violations: string[] = [];
  if (options.offSchema !== true) failTestOnViolations(violations);
  const answered = new Map<string, number>();
  const agent = (prompt: string, options: AgentOptions): Promise<unknown> => {
    const call: RecordedCall = {
      label: options.label,
      agentType: options.agentType,
      model: options.model,
      effort: options.effort,
      argv: commandWords(prompt),
      prompt,
      schema: options.schema,
    };
    calls.push(call);
    timeline.push(`call ${options.label}`);
    const key = tableKey(table, options.label);
    if (key === undefined) return gate(call, null);
    const nth = answered.get(key) ?? 0;
    answered.set(key, nth + 1);
    const entry = table[key];
    const answer = typeof entry === 'function' ? (entry as Responder)(call, nth) : entry;
    if (answer === null) return gate(call, null);
    return gate(call, conform(answer, options.schema, { at: options.label, violations }));
  };
  const hooks: WorkflowHooks = {
    agent,
    parallel: (thunks) => Promise.all(thunks.map((thunk) => thunk())),
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
  return { hooks, calls, phases, timeline, violations };
}

/**
 * Fail the running test when it finishes with a violation recorded, its
 * error naming each violation line.
 *
 * @param violations - The run's violation lines, read when the test finishes.
 */
function failTestOnViolations(violations: readonly string[]): void {
  onTestFinished(() => {
    if (violations.length > 0) {
      throw new Error(`fake answers broke their call schemas:\n${violations.join('\n')}`);
    }
  });
}

/** Where a part of an answer sits, and where its violations go. */
interface AnswerPlace {
  /** `<label>` then `.key` / `[i]` steps. */
  readonly at: string;
  /** The run's violation lines. */
  readonly violations: string[];
}

/**
 * A value as a schema, when it is one (a plain object).
 *
 * @param value - The value.
 * @returns It, or `undefined` for anything else.
 */
function schemaOf(value: unknown): JsonSchema | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function conform(value: unknown, schema: JsonSchema | undefined, place: AnswerPlace): unknown {
  if (schema === undefined || value === undefined) return value;
  checkType(value, schema, place);
  if (value === null) return value;
  checkEnum(value, schema, place);
  if (Array.isArray(value)) return conformItems(value, schema, place);
  const properties = schemaOf(schema['properties']);
  if (typeof value !== 'object' || properties === undefined) return value;
  const record = value as Readonly<Record<string, unknown>>;
  checkRequired(record, schema, place);
  return pickProperties(record, properties, place);
}

/** How each JSON Schema `type` name tells its values. */
const TYPE_TESTS: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => schemaOf(v) !== undefined,
};

/**
 * Record a value of none of its schema's `type`s.
 *
 * @param value - The value, `null` included.
 * @param schema - Its schema; one without a `type` allows anything.
 * @param place - Where it sits.
 */
function checkType(value: unknown, schema: JsonSchema, place: AnswerPlace): void {
  const type = schema['type'];
  if (type === undefined) return;
  const types = (Array.isArray(type) ? type : [type]) as readonly string[];
  if (!types.some((t) => TYPE_TESTS[t]?.(value) === true)) {
    place.violations.push(`${place.at}: ${JSON.stringify(value)} is not ${types.join(' or ')}`);
  }
}

/**
 * Record a value its schema's `enum` does not allow.
 *
 * @param value - The value.
 * @param schema - Its schema.
 * @param place - Where it sits.
 */
function checkEnum(value: unknown, schema: JsonSchema, place: AnswerPlace): void {
  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    place.violations.push(`${place.at}: ${JSON.stringify(value)} is off the enum`);
  }
}

function conformItems(value: readonly unknown[], schema: JsonSchema, place: AnswerPlace): unknown {
  const items = schemaOf(schema['items']);
  if (items === undefined) return value;
  return value.map((v, i) => conform(v, items, { ...place, at: `${place.at}[${String(i)}]` }));
}

/**
 * Record each `required` key an object lacks, or holds as `undefined` (which JSON drops).
 *
 * @param record - The object.
 * @param schema - Its schema.
 * @param place - Where it sits.
 */
function checkRequired(
  record: Readonly<Record<string, unknown>>,
  schema: JsonSchema,
  place: AnswerPlace,
): void {
  const required = schema['required'];
  if (!Array.isArray(required)) return;
  for (const key of required as unknown[]) {
    if (typeof key === 'string' && (!Object.hasOwn(record, key) || record[key] === undefined)) {
      place.violations.push(`${place.at}: lacks required ${key}`);
    }
  }
}

function pickProperties(
  record: Readonly<Record<string, unknown>>,
  properties: JsonSchema,
  place: AnswerPlace,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(properties)) {
    if (Object.hasOwn(record, key)) {
      out[key] = conform(record[key], schemaOf(sub), { ...place, at: `${place.at}.${key}` });
    }
  }
  return out;
}

/**
 * The table key answering `label`: the label itself, else its longest held `:`-prefix.
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
