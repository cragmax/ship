/**
 * The saved workflows' tier table — the one home of every stage's
 * `agentType`, `model` and `effort` (ADR-0045), plus the run's tunables and
 * each workflow's phase titles. No other workflow source spells a tier:
 * each `agent()` call takes its options from {@link agentOptions} (a
 * `diffReview` or `reviewer` call from {@link reviewOptions}).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { AgentOptions, Effort, JsonSchema, ModelAlias, WorkflowPhase } from './hooks.types.js';

/** One stage's tier; an absent `model` or `effort` inherits the session's. */
export interface StageRow {
  /** The project agent (`.claude/agents/<agentType>.md`). */
  readonly agentType: string;
  /** The model alias, when pinned. */
  readonly model?: ModelAlias;
  /** The effort, when pinned. */
  readonly effort?: Effort;
}

/**
 * Every stage the workflow runs an agent for; each stage's job is its agent file's. `resolver` runs
 * the reviewer agent over the epic end's doc-index conflicts; the `diffReview` and `reviewer`
 * efforts are set per call by {@link reviewEffort}; the `critic` works in a slice of its own.
 */
export const STAGES = {
  runner: { agentType: 'runner', model: 'sonnet', effort: 'low' },
  scout: { agentType: 'scout' },
  overlapEstimator: { agentType: 'overlap-estimator' },
  tdd: { agentType: 'tdd', model: 'opus', effort: 'medium' },
  diffReview: { agentType: 'diff-reviewer', model: 'opus' },
  reviewer: { agentType: 'reviewer', model: 'opus' },
  resolver: { agentType: 'reviewer', model: 'opus' },
  testReview: { agentType: 'ship-test-review', model: 'opus' },
  critic: { agentType: 'critic' },
  retro: { agentType: 'retro', model: 'sonnet' },
  prWriter: { agentType: 'pr-writer' },
} as const satisfies Readonly<Record<string, StageRow>>;

/** A stage's key in {@link STAGES}. */
export type StageName = keyof typeof STAGES;

/**
 * The default most issues in flight at once, from start until settled — the
 * commit-queue wait included (the `maxSlices` launch arg). Epic ends run
 * outside the cap.
 */
export const MAX_SLICES = 4;

/**
 * The most minutes one probe of the tdd, the reviewer or the test reviewer may
 * take; a hit records a follow-up, never a verdict.
 */
export const PROBE_CAP_MINUTES = 15;

/** The most probes one issue's tdd, reviewer or test reviewer may run. */
export const PROBES_PER_ISSUE = 3;

/** The paths whose change is not a trivial surface: code, tooling and tests. */
const CODE_PREFIXES: readonly string[] = ['src/', 'tooling/', 'test/'];

/** More changed files than this make a review `high` effort. */
const HIGH_EFFORT_FILE_COUNT = 5;

/**
 * The diff reviewer's and the reviewer's effort for a slice.
 *
 * @param files - The slice commit's changed paths, repository-relative.
 * @returns `high` when any path is under `src/` or there are more than five
 *   paths; `medium` otherwise.
 */
export function reviewEffort(files: readonly string[]): Effort {
  const touchesSrc = files.some((path) => path.startsWith('src/'));
  return touchesSrc || files.length > HIGH_EFFORT_FILE_COUNT ? 'high' : 'medium';
}

/**
 * Whether a slice changes no code: test review is skipped for it.
 *
 * @param files - The slice commit's changed paths, repository-relative.
 * @returns `true` when no path is under `src/`, `tooling/` or `test/` (an
 *   empty list included).
 */
export function isTrivialSurface(files: readonly string[]): boolean {
  return !files.some((path) => CODE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

/** The titles `phase()` is called with. */
export const PHASE_TITLES = {
  preflight: 'Pre-flight',
  issues: 'Issues',
  epicEnd: 'Epic end',
} as const;

/** The workflow's phases, in run order (`meta.phases`). */
export const SHIP_PHASES: readonly WorkflowPhase[] = [
  {
    title: PHASE_TITLES.preflight,
    detail:
      'master level, gh auth, warm set, leftover slice branches, run gate, live runs, the scout ' +
      'and the overlap estimate; ' +
      'refuses on any failure; then spent batches torn down (guarded)',
  },
  {
    title: PHASE_TITLES.issues,
    detail: 'per issue, in dependency order: tdd, diff review, review, test review, land',
  },
  {
    title: PHASE_TITLES.epicEnd,
    detail:
      'per epic: critic, master sync, version bump, retro and PR writer (concurrently), ' +
      'master check, pull request',
  },
];

/** The titles the `resync` workflow calls `phase()` with. */
export const RESYNC_PHASE_TITLES = {
  preflight: PHASE_TITLES.preflight,
  merge: 'Merge',
  push: 'Push',
} as const;

/** The `resync` workflow's phases, in run order (`meta.phases`). */
export const RESYNC_PHASES: readonly WorkflowPhase[] = [
  {
    title: RESYNC_PHASE_TITLES.preflight,
    detail:
      'live runs; spent batches torn down (guarded); the branch batch attached, and re-cut and ' +
      'provisioned if it was torn down',
  },
  {
    title: RESYNC_PHASE_TITLES.merge,
    detail:
      "the epic end's merge step: doc indexes resolved, the version line re-bumped, " +
      'a code conflict stops',
  },
  {
    title: RESYNC_PHASE_TITLES.push,
    detail: "pushed through the pre-push gate, never forced; the PR's mergeable state read",
  },
];

/**
 * The options of one `agent()` call for `stage`: its label and its
 * {@link STAGES} tier, nothing re-spelled.
 *
 * @param detail - What distinguishes this call among the stage's calls
 *   (the label becomes `<stage>:<detail>`); `null` labels it `<stage>`.
 * @param schema - The structured output's schema.
 */
export function agentOptions(
  stage: StageName,
  detail: string | null,
  schema: JsonSchema,
): AgentOptions {
  const row: StageRow = STAGES[stage];
  return {
    label: detail === null ? stage : `${stage}:${detail}`,
    agentType: row.agentType,
    ...(row.model === undefined ? {} : { model: row.model }),
    ...(row.effort === undefined ? {} : { effort: row.effort }),
    schema,
  };
}

/**
 * The options of one call that reviews a slice's commit — a `diffReview` or
 * a `reviewer` call: {@link agentOptions}' plus the effort
 * {@link reviewEffort} picks for the slice.
 *
 * @param detail - What distinguishes this call (the label becomes `<stage>:<detail>`).
 * @param schema - The structured output's schema.
 * @param files - The slice commit's changed paths.
 */
export function reviewOptions(
  stage: 'diffReview' | 'reviewer',
  detail: string,
  schema: JsonSchema,
  files: readonly string[],
): AgentOptions {
  return { ...agentOptions(stage, detail, schema), effort: reviewEffort(files) };
}
