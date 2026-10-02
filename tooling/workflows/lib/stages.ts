/**
 * The saved workflows' tier table — the one home of every stage's
 * `agentType`, `model` and `effort` (ADR-0045), plus the run's tunables and
 * each workflow's phase titles. No other workflow source spells a tier:
 * each `agent()` call takes its options from {@link agentOptions} (a
 * `diffReview` or `reviewer` call from {@link reviewOptions}). The PR
 * review's pins sit beside the table, not in it — its default level, its
 * nested session's model and its runner timeout — because the PR review is a
 * tooling command, not an `agent()` call (ADR-0045 decision 11).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { PrReviewLevel } from '../../worktree/types-run.js';

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
 * Every stage the workflow runs an agent for. `runner` runs one tooling
 * command and transcribes its envelope; `scout` checks the run set against
 * the current tree; `overlapEstimator` names the run-set pairs likely to
 * touch the same files; `planner` plans one issue and `applier` (the same
 * agent) applies the plan review's findings once; `planReviewer` reviews the
 * plan; `tdd` authors the slice's one commit; `diffReview` checks it,
 * read-only, against the repo's rules and its issue and plan, writing
 * findings for the reviewer; `reviewer` verifies those findings, hunts bugs
 * and amends the commit — the two efforts set per call by
 * {@link reviewEffort}; `resolver` (the reviewer agent) resolves the epic
 * end's doc-index conflicts; `testReview` hardens the tests on the slice's
 * final shape; `critic` reviews the epic's landed slices together in a
 * slice of its own and may commit one fix; `retro` reads the entry's
 * reports and names what the run should learn.
 */
export const STAGES = {
  runner: { agentType: 'runner', model: 'sonnet', effort: 'low' },
  scout: { agentType: 'scout' },
  overlapEstimator: { agentType: 'overlap-estimator' },
  planner: { agentType: 'planner' },
  applier: { agentType: 'planner' },
  planReviewer: { agentType: 'ship-plan-reviewer' },
  tdd: { agentType: 'ship-tdd', model: 'opus' },
  diffReview: { agentType: 'diff-reviewer', model: 'opus' },
  reviewer: { agentType: 'reviewer', model: 'opus' },
  resolver: { agentType: 'reviewer', model: 'opus' },
  testReview: { agentType: 'ship-test-review', model: 'opus' },
  critic: { agentType: 'critic' },
  retro: { agentType: 'retro', model: 'sonnet' },
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

/**
 * The most minutes one plan-time probe may take — a cheap local probe the
 * planner runs before plan review; a hit records a follow-up, never a verdict.
 */
export const PLAN_PROBE_CAP_MINUTES = 5;

/** The most plan-time probes one issue attempt's planner may run, its plan and apply modes together. */
export const PLAN_PROBES_PER_ISSUE = 2;

/**
 * The PR review's level when the launch gives no `--pr-review` (#1101
 * decision 4): `xhigh`, which found the four most severe of `max`'s
 * findings (PF-57).
 */
export const DEFAULT_PR_REVIEW_LEVEL: PrReviewLevel = 'xhigh';

/**
 * The model the PR review's nested session runs, passed as `pr-review`'s
 * `--model` (#1101 decision 6): pinned, since an unpinned nested session
 * takes the CLI's default model (PF-58).
 */
export const PR_REVIEW_MODEL: ModelAlias = 'opus';

/**
 * The Bash `timeout` the runner gives the `pr-review` command, in
 * milliseconds: the tool's 120-minute maximum (#1106). Without it the
 * 30-minute default kills the runner's wrapper shell, orphaning the nested
 * session and writing no exit code (PF-59). The review's own cap,
 * `PR_REVIEW_CAP_MS` (`tooling/worktree/exec.ts`), must stay below this
 * value; its TSDoc owns why.
 */
export const PR_REVIEW_RUNNER_TIMEOUT_MS = 7_200_000;

/** The paths whose change is not a trivial surface: code, tooling, tests and evals. */
const CODE_PREFIXES: readonly string[] = ['src/', 'tooling/', 'test/', 'evals/'];

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
 * @returns `true` when no path is under `src/`, `tooling/`, `test/` or
 *   `evals/` (an empty list included).
 */
export function isTrivialSurface(files: readonly string[]): boolean {
  return !files.some((path) => CODE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

/** The titles `phase()` is called with. */
export const PHASE_TITLES = {
  preflight: 'Pre-flight',
  issues: 'Issues',
  epicEnd: 'Epic end',
  prReview: 'PR review',
} as const;

/** The workflow's phases, in run order (`meta.phases`). */
export const SHIP_PHASES: readonly WorkflowPhase[] = [
  {
    title: PHASE_TITLES.preflight,
    detail:
      'master level, gh auth, warm set, run gate, live runs, the scout and the overlap estimate; ' +
      'refuses on any failure; then spent batches torn down (guarded)',
  },
  {
    title: PHASE_TITLES.issues,
    detail:
      'per issue, in dependency order: plan, plan review, tdd, diff review, review, test review, land',
  },
  {
    title: PHASE_TITLES.epicEnd,
    detail: 'per epic: critic, master sync, version bump, retro, master check, pull request',
  },
  {
    title: PHASE_TITLES.prReview,
    detail:
      'after every epic end, per opened pull request, one at a time in publish order: ' +
      'the built-in /code-review in a nested Opus session in a throwaway clone (pr-review); ' +
      'non-fatal; none under --pr-review off',
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
 * @param stage - The stage.
 * @param detail - What distinguishes this call among the stage's calls
 *   (the label becomes `<stage>:<detail>`); `null` labels it `<stage>`.
 * @param schema - The structured output's schema.
 * @returns The options.
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
 * @param stage - The stage.
 * @param detail - What distinguishes this call (the label becomes `<stage>:<detail>`).
 * @param schema - The structured output's schema.
 * @param files - The slice commit's changed paths.
 * @returns The options.
 */
export function reviewOptions(
  stage: 'diffReview' | 'reviewer',
  detail: string,
  schema: JsonSchema,
  files: readonly string[],
): AgentOptions {
  return { ...agentOptions(stage, detail, schema), effort: reviewEffort(files) };
}
