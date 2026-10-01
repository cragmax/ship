/**
 * The `ship` workflow's judgment-agent calls: each stage's output type, the
 * schema the runtime validates it against, and one wrapper per stage that
 * builds the prompt, takes the tier from `stages.ts` and returns the answer
 * — or `null` when the agent returned none (it died, or answered no object).
 *
 * The output shapes are the zod sources in
 * `tooling/workflows/schemas/agent-outputs.ts` — the canonical home of each
 * field and its doc; each type here is its `z.infer`, and each schema is its
 * `schemas.generated.ts` emission ({@link AGENT_OUTPUT_SCHEMAS}).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect; the zod sources are imported for their types
 * only.
 */

import type { z } from 'zod';

import { runSetIssues } from '../../lib/run-set.js';
import type {
  CommitSpecSchema,
  CriticFindingSchema,
  CriticOutputSchema,
  DiffReviewOutputSchema,
  EstimatedPairSchema,
  OverlapEstimateSchema,
  PlanCardSchema,
  PlanReviewSchema,
  ProbeRecordSchema,
  ResolverOutputSchema,
  RetroFindingSchema,
  RetroOutputSchema,
  ReviewOutputSchema,
  ScoutVerdictSchema,
  TddOutputSchema,
  TestReviewOutputSchema,
} from '../schemas/agent-outputs.js';

import type { AgentOptions, JsonSchema, WorkflowHooks } from './hooks.types.js';
import {
  PROMPTS,
  type CriticValues,
  type DiffReviewValues,
  type OverlapValues,
  type PlannerValues,
  type PlanReviewerValues,
  type ResolverValues,
  type RetroValues,
  type ReviewerValues,
  type ScoutValues,
  type SliceReviewValues,
  type TddValues,
} from './prompts.js';
import { AGENT_OUTPUT_SCHEMAS } from './schemas.generated.js';
import { agentOptions, reviewOptions } from './stages.js';

/** The scout's answer. */
export type ScoutVerdict = z.infer<typeof ScoutVerdictSchema>;

/** Two run-set issues the estimator judged likely to touch the same files. */
export type EstimatedPair = z.infer<typeof EstimatedPairSchema>;

/** How sure the estimator is that a pair overlaps. */
export type OverlapConfidence = EstimatedPair['confidence'];

/** The overlap estimator's answer. */
export type OverlapEstimate = z.infer<typeof OverlapEstimateSchema>;

/** A commit message's first line, as the planner proposes it. */
export type CommitSpec = z.infer<typeof CommitSpecSchema>;

/** The planner's card (also the applier's). */
export type PlanCard = z.infer<typeof PlanCardSchema>;

/** The plan reviewer's answer. */
export type PlanReview = z.infer<typeof PlanReviewSchema>;

/** One probe a stage ran, or chose not to finish: a plan-time probe on the planner's card, or the tdd's. */
export type ProbeRecord = z.infer<typeof ProbeRecordSchema>;

/** The tdd's answer. */
export type TddOutput = z.infer<typeof TddOutputSchema>;

/** The diff reviewer's answer. */
export type DiffReviewOutput = z.infer<typeof DiffReviewOutputSchema>;

/** The reviewer's answer. */
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** The test reviewer's answer. */
export type TestReviewOutput = z.infer<typeof TestReviewOutputSchema>;

/** What a slice's agents produced by the time its commit is ready to land. */
export interface SliceWork {
  /** The plan card the slice was authored from (the applier's, when it ran). */
  readonly card: PlanCard;
  /** The tdd's answer. */
  readonly tdd: TddOutput;
  /** The reviewer's answer. */
  readonly review: ReviewOutput;
  /** The test reviewer's answer; `null` when skipped for a trivial surface. */
  readonly testReview: TestReviewOutput | null;
}

/** One finding of the critic. */
export type CriticFinding = z.infer<typeof CriticFindingSchema>;

/** The critic's answer. */
export type CriticOutput = z.infer<typeof CriticOutputSchema>;

/** One finding of the retro. */
export type RetroFinding = z.infer<typeof RetroFindingSchema>;

/** The retro's answer. */
export type RetroOutput = z.infer<typeof RetroOutputSchema>;

/** The doc-index resolver's answer. */
export type ResolverOutput = z.infer<typeof ResolverOutputSchema>;

/**
 * The overlap estimator's output schema, built per call: a pair's endpoints
 * may only be the run's issues.
 *
 * @param issues - The run-set issues.
 * @returns The emitted schema, `a` and `b` narrowed to `issues`.
 */
function overlapSchema(issues: readonly number[]): JsonSchema {
  const base = AGENT_OUTPUT_SCHEMAS.overlapEstimator;
  const pairs = base.properties.pairs;
  const pair = pairs.items;
  const issue = { type: 'integer', enum: issues } as const;
  return {
    ...base,
    properties: {
      ...base.properties,
      pairs: {
        ...pairs,
        items: { ...pair, properties: { ...pair.properties, a: issue, b: issue } },
      },
    },
  };
}

/**
 * Run one agent and keep its answer only when it is an object.
 *
 * @param hooks - The workflow hooks.
 * @param prompt - The prompt.
 * @param options - The call's options.
 * @returns Resolves to the answer; `null` when there is none.
 */
async function askAgent<T>(
  hooks: WorkflowHooks,
  prompt: string,
  options: AgentOptions,
): Promise<T | null> {
  const out = await hooks.agent(prompt, options);
  return typeof out === 'object' && out !== null ? (out as T) : null;
}

/**
 * One wrapper per judgment stage; `tag` tells the call from the stage's
 * others (`7-1`). The scout and the overlap estimator run once per launch,
 * so they take none.
 */
export const AGENT_CALLS = {
  scout: (hooks: WorkflowHooks, values: ScoutValues) =>
    askAgent<ScoutVerdict>(
      hooks,
      PROMPTS.scout(values),
      agentOptions('scout', null, AGENT_OUTPUT_SCHEMAS.scout),
    ),
  overlapEstimator: (hooks: WorkflowHooks, values: OverlapValues) =>
    askAgent<OverlapEstimate>(
      hooks,
      PROMPTS.overlapEstimator(values),
      agentOptions('overlapEstimator', null, overlapSchema(runSetIssues(values.runSet))),
    ),
  planner: (hooks: WorkflowHooks, values: PlannerValues, tag: string) =>
    askAgent<PlanCard>(
      hooks,
      PROMPTS.planner(values),
      agentOptions(
        values.mode === 'plan' ? 'planner' : 'applier',
        tag,
        AGENT_OUTPUT_SCHEMAS.planCard,
      ),
    ),
  planReviewer: (hooks: WorkflowHooks, values: PlanReviewerValues, tag: string) =>
    askAgent<PlanReview>(
      hooks,
      PROMPTS.planReviewer(values),
      agentOptions('planReviewer', tag, AGENT_OUTPUT_SCHEMAS.planReview),
    ),
  tdd: (hooks: WorkflowHooks, values: TddValues, tag: string) =>
    askAgent<TddOutput>(
      hooks,
      PROMPTS.tdd(values),
      agentOptions('tdd', tag, AGENT_OUTPUT_SCHEMAS.tdd),
    ),
  diffReview: (hooks: WorkflowHooks, values: DiffReviewValues, tag: string) =>
    askAgent<DiffReviewOutput>(
      hooks,
      PROMPTS.diffReview(values),
      reviewOptions('diffReview', tag, AGENT_OUTPUT_SCHEMAS.diffReview, values.files),
    ),
  reviewer: (hooks: WorkflowHooks, values: ReviewerValues, tag: string) =>
    askAgent<ReviewOutput>(
      hooks,
      PROMPTS.reviewer(values),
      reviewOptions('reviewer', tag, AGENT_OUTPUT_SCHEMAS.review, values.files),
    ),
  testReview: (hooks: WorkflowHooks, values: SliceReviewValues, tag: string) =>
    askAgent<TestReviewOutput>(
      hooks,
      PROMPTS.testReview(values),
      agentOptions('testReview', tag, AGENT_OUTPUT_SCHEMAS.testReview),
    ),
  resolver: (hooks: WorkflowHooks, values: ResolverValues, tag: string) =>
    askAgent<ResolverOutput>(
      hooks,
      PROMPTS.resolver(values),
      agentOptions('resolver', tag, AGENT_OUTPUT_SCHEMAS.resolver),
    ),
  critic: (hooks: WorkflowHooks, values: CriticValues, tag: string) =>
    askAgent<CriticOutput>(
      hooks,
      PROMPTS.critic(values),
      agentOptions('critic', tag, AGENT_OUTPUT_SCHEMAS.critic),
    ),
  retro: (hooks: WorkflowHooks, values: RetroValues, tag: string) =>
    askAgent<RetroOutput>(
      hooks,
      PROMPTS.retro(values),
      agentOptions('retro', tag, AGENT_OUTPUT_SCHEMAS.retro),
    ),
};
