/**
 * Fake workflow hooks for driving `runShip` in vitest: `agent()` answers from
 * a label-keyed response table and records every call; `parallel` and
 * `pipeline` run their work in order, so a recorded call sequence is
 * deterministic. Each answer passes through the call's schema as an agent's
 * would: cut to the schema's properties, a missing required key, an
 * off-enum value or a value of none of its `type`s recorded in
 * {@link FakeRun.violations}. A required key held as `undefined` counts as
 * missing, as JSON drops it. A test whose fake run recorded a violation fails
 * when it finishes, with no assertion needed, unless the run opts out
 * ({@link FakeOptions.offSchema}). A `null` answer is a dead agent's, and no
 * schema applies to it.
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
  /** The command words after `npx tsx` on the prompt's `Command:` line, unquoted; `[]` without one. */
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
   * The run answers off its call schemas on purpose: its {@link FakeRun.violations}
   * are recorded for the test to read, and do not fail it. By default any
   * violation fails the test that made the run, when that test finishes.
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
  /** Every `agent()` call (`call <label>`) and `log()` line (`log <message>`), interleaved in order. */
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
 * A `check-master` answer moving each ref from its launch sha in
 * {@link PREFLIGHT_OK} (`local0` / `origin0`): `ok` when both moves are
 * `equal` or `forward`, otherwise `refused` `master-not-forward`. Local's
 * `synced` is always `null`; `origin`'s defaults to `origin0`.
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

/** A GREEN tdd over {@link TDD_FILES}, with one lease line and no probe. */
export const TDD_GREEN = {
  verdict: 'GREEN',
  sha: 'slice1',
  files: TDD_FILES,
  leaseLines: ['with-lease: waited 1.5s for paper@localhost:25575, held 42.0s'],
  probes: [],
};

/** A diff review that found two rules findings and one plan finding. */
export const DIFF_REVIEW_OK = {
  rules: 2,
  plan: 1,
  findingsPath: `${REPORT_DIR}/diff-review-7-1.md`,
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
  probes: [],
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
  at: '2026-09-29T10:20:00.000Z',
};

/** A `pr-review` that reviewed PR 42 and wrote 15 findings. */
export const PR_REVIEW_OK = {
  ...OK,
  outcome: 'reviewed',
  durationMs: 561000,
  findingCount: 15,
  findingsFile: `${REPORT_DIR}/pr-review-42-findings.json`,
  resultFile: `${REPORT_DIR}/pr-review-42-result.md`,
  plainFile: `${REPORT_DIR}/pr-review-42-plain.md`,
};

/** A curator that wrote PR 42's comment, three findings before merge. */
export const CURATOR_OK = {
  commentPath: `${REPORT_DIR}/pr-review-42-curated.md`,
  beforeMerge: 3,
};

/** A `pr-comment` that posted on PR 42 and printed the comment's URL. */
export const PR_COMMENT_OK = {
  ...OK,
  outcome: 'posted',
  url: 'https://github.com/fixture/repo/pull/42#issuecomment-1',
};

/** The all-pass answers of a full run of `issues 7`, by label. */
const HAPPY_PATH: Readonly<Record<string, unknown>> = {
  'runner:preflight': PREFLIGHT_OK,
  'runner:run-gate': GATE_OK,
  'runner:live-runs': LIVE_RUNS_NONE,
  scout: SCOUT_FRESH,
  overlapEstimator: { issues: [], pairs: [], areaMap: 'read' },
  'runner:cut-batch': {
    ...OK,
    worktree: 'C:/src/main',
    branch: 'ship/7',
    base: 'master0',
    runRoot: RUN_ROOT,
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
  planner: PLAN_CARD,
  planReviewer: { verdict: 'approved', findings: 0, findingsPath: `${REPORT_DIR}/pr.md` },
  tdd: TDD_GREEN,
  diffReview: DIFF_REVIEW_OK,
  // Each amending stage answers a new sha, so a stage that reads a stale one shows.
  reviewer: { verdict: 'fixed', sha: 'slice2', summary: 'renamed a helper', leaseLines: [] },
  testReview: {
    verdict: 'hardened',
    sha: 'slice3',
    survivors: 0,
    summary: 'pinned a bound',
    leaseLines: [],
  },
  'runner:land': LAND_OK,
  'runner:pr-review': PR_REVIEW_OK,
  curator: CURATOR_OK,
  'runner:pr-comment': PR_COMMENT_OK,
  'runner:teardown': { ...OK, removed: true, registered: false },
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
  critic: {
    outcome: 'clean',
    sha: '',
    files: [],
    commit: { type: 'refactor', scope: 'build', subject: '' },
    findings: [],
    checks: 'nothing to verify',
  },
  retro: { findings: [] },
};

/**
 * Build fake hooks answering each label from `responses` over the all-pass
 * defaults of a full `issues 7` run. A label `a:b:c` is answered by the
 * first of `a:b:c`, `a:b` and `a` the table holds; a label none matches
 * answers `null`, as a dead agent does.
 *
 * @param responses - Per-label answers (or {@link Responder}s) overriding the defaults.
 * @param options - The answer gate, and whether the run answers off its schemas on purpose.
 * @returns The hooks and their records.
 * @throws When called outside a running test without `offSchema`: the finish
 *   check registers through vitest's `onTestFinished`.
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

/**
 * An answer as its agent would give it: only what the schema asks for.
 *
 * @param value - The answer, or a part of it.
 * @param schema - Its schema; `undefined` passes the value through.
 * @param place - Where it sits.
 * @returns The value, each object cut to its schema's `properties`.
 */
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

/**
 * An array, each item conformed to the schema's `items`.
 *
 * @param value - The array.
 * @param schema - Its schema.
 * @param place - Where it sits.
 * @returns The conformed items.
 */
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

/**
 * An object cut to its schema's properties, each conformed.
 *
 * @param record - The object.
 * @param properties - The schema's `properties`.
 * @param place - Where it sits.
 * @returns The kept properties.
 */
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
