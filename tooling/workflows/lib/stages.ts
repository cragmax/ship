/**
 * The `ship` workflow's tier table — the one home of every stage's
 * `agentType`, `model` and `effort` (ADR-0045), plus the run's tunables and
 * its phase titles. No other workflow source spells a tier: each `agent()`
 * call takes its options from {@link agentOptions}.
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
 * Every stage the workflow runs an agent for. `runner` runs one tooling
 * command and transcribes its envelope; `scout` checks the run set against
 * the current tree.
 */
export const STAGES = {
  runner: { agentType: 'runner', model: 'sonnet', effort: 'low' },
  scout: { agentType: 'scout' },
} as const satisfies Readonly<Record<string, StageRow>>;

/** A stage's key in {@link STAGES}. */
export type StageName = keyof typeof STAGES;

/** The default most issues authoring at once (the `maxSlices` launch arg). */
export const MAX_SLICES = 4;

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
      'master level, gh auth, warm set, run gate, live runs and the scout; refuses on any failure',
  },
  {
    title: PHASE_TITLES.issues,
    detail: 'per issue, in dependency order: plan, plan review, tdd, review, test review, land',
  },
  {
    title: PHASE_TITLES.epicEnd,
    detail: 'per epic: server tier on both engines, master sync, version bump, pull request',
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
