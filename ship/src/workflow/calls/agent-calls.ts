/**
 * The `ship` workflow's judgment-agent calls: each stage's output type, the
 * schema the runtime validates it against, and one wrapper per stage that
 * builds the prompt, takes the tier from `stages.ts` and returns the answer
 * — or `null` when the agent returned none (it died, or answered no object).
 *
 * The output shapes are the zod sources in
 * `ship/src/schemas/agent-outputs.ts` — the canonical home of each
 * field and its doc; each type here is its `z.infer`, and each schema is its
 * `schemas.generated.ts` emission ({@link AGENT_OUTPUT_SCHEMAS}).
 *
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect; the zod sources are imported for their types
 * only.
 */

import type { z } from 'zod';

import { runSetIssues } from '../../core/run-set.js';
import type {
  CommitSpecSchema,
  EpicReviewOutputSchema,
  EstimatedPairSchema,
  IssueReadinessSchema,
  IssueOverlapSchema,
  ScriptApiTsdocOutputSchema,
  PrWriterOutputSchema,
  ProbeRecordSchema,
  ReadinessVerdictSchema,
  RetroFindingSchema,
  RetroOutputSchema,
  ReviewOutputSchema,
  TddEvidenceSchema,
  TddOutputSchema,
} from '../../schemas/agent-outputs.js';

import type { AgentOptions, JsonSchema, WorkflowHooks } from '../runtime.types.js';
import {
  PROMPTS,
  type EpicReviewValues,
  type IssueOverlapValues,
  type IssueReadinessValues,
  type ScriptApiTsdocValues,
  type PrWriterValues,
  type RetroValues,
  type SliceReviewValues,
  type TddValues,
  type TestReviewValues,
} from './prompts.js';
import { AGENT_OUTPUT_SCHEMAS } from '../schemas.generated.js';
import { agentOptions } from '../stages.js';

/** `issue-readiness`'s verdict on one run-set issue. */
export type ReadinessVerdict = z.infer<typeof ReadinessVerdictSchema>;

/** `issue-readiness`'s answer. */
export type IssueReadiness = z.infer<typeof IssueReadinessSchema>;

/** Two run-set issues `issue-overlap` judged likely to touch the same files. */
export type EstimatedPair = z.infer<typeof EstimatedPairSchema>;

/** `issue-overlap`'s answer. */
type IssueOverlap = z.infer<typeof IssueOverlapSchema>;

/** A commit message's first line, as the tdd proposes it. */
export type CommitSpec = z.infer<typeof CommitSpecSchema>;

/** One probe the tdd ran, or chose not to finish. */
export type ProbeRecord = z.infer<typeof ProbeRecordSchema>;

/** The tdd's evidence: its tracer test's red-green, or why it saw none. */
export type TddEvidence = z.infer<typeof TddEvidenceSchema>;

/** The tdd's answer. */
export type TddOutput = z.infer<typeof TddOutputSchema>;

/** A slice review's answer: the spec review's, the test review's or the standards review's. */
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/**
 * Why a slice's test review was skipped: no code changed, or every code change is proven
 * comment-only.
 */
export type TestReviewSkip = 'trivial surface' | 'comment-only';

/** The Script API TSDoc review's answer. */
export type ScriptApiTsdocOutput = z.infer<typeof ScriptApiTsdocOutputSchema>;

/** Why a slice's Script API TSDoc review was skipped: it changed nothing under `src/`. */
export type ScriptApiTsdocSkip = 'no src/ change';

/** What a slice's agents produced by the time its commit is ready to land. */
export interface SliceWork {
  /** The tdd's answer: its commit line and cite among it. */
  readonly tdd: TddOutput;
  /** The spec review's answer. */
  readonly specReview: ReviewOutput;
  /** The test review's answer, or why it was skipped. */
  readonly testReview: ReviewOutput | TestReviewSkip;
  /** The standards review's answer. */
  readonly standardsReview: ReviewOutput;
  /** The Script API TSDoc review's answer, or why it was skipped. */
  readonly scriptApiTsdoc: ScriptApiTsdocOutput | ScriptApiTsdocSkip;
}

/** The epic review's answer. */
export type EpicReviewOutput = z.infer<typeof EpicReviewOutputSchema>;

/** One finding of the retro. */
export type RetroFinding = z.infer<typeof RetroFindingSchema>;

/** The retro's answer. */
type RetroOutput = z.infer<typeof RetroOutputSchema>;

/** The PR writer's answer. */
export type PrWriterOutput = z.infer<typeof PrWriterOutputSchema>;

/**
 * `issue-overlap`'s output schema, built per call: a pair's endpoints and a
 * live overlap's issue may only be the run's issues.
 */
function overlapSchema(issues: readonly number[]): JsonSchema {
  const base = AGENT_OUTPUT_SCHEMAS.issueOverlap;
  const { pairs, liveOverlaps } = base.properties;
  const issue = { type: 'integer', enum: issues } as const;
  return {
    ...base,
    properties: {
      ...base.properties,
      pairs: {
        ...pairs,
        items: { ...pairs.items, properties: { ...pairs.items.properties, a: issue, b: issue } },
      },
      liveOverlaps: {
        ...liveOverlaps,
        items: { ...liveOverlaps.items, properties: { ...liveOverlaps.items.properties, issue } },
      },
    },
  };
}

/** Run one agent; resolves to its answer, or `null` unless the answer is an object. */
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
 * others (`7-1`). `issue-readiness` and `issue-overlap` run once per launch,
 * so they take none.
 */
export const AGENT_CALLS = {
  issueReadiness: (hooks: WorkflowHooks, values: IssueReadinessValues) =>
    askAgent<IssueReadiness>(
      hooks,
      PROMPTS.issueReadiness(values),
      agentOptions('issueReadiness', null, AGENT_OUTPUT_SCHEMAS.issueReadiness),
    ),
  issueOverlap: (hooks: WorkflowHooks, values: IssueOverlapValues) =>
    askAgent<IssueOverlap>(
      hooks,
      PROMPTS.issueOverlap(values),
      agentOptions('issueOverlap', null, overlapSchema(runSetIssues(values.runSet))),
    ),
  tdd: (hooks: WorkflowHooks, values: TddValues, tag: string) =>
    askAgent<TddOutput>(
      hooks,
      PROMPTS.tdd(values),
      agentOptions('tdd', tag, AGENT_OUTPUT_SCHEMAS.tdd),
    ),
  specReview: (hooks: WorkflowHooks, values: SliceReviewValues, tag: string) =>
    askAgent<ReviewOutput>(
      hooks,
      PROMPTS.specReview(values),
      agentOptions('specReview', tag, AGENT_OUTPUT_SCHEMAS.specReview),
    ),
  testReview: (hooks: WorkflowHooks, values: TestReviewValues, tag: string) =>
    askAgent<ReviewOutput>(
      hooks,
      PROMPTS.testReview(values),
      agentOptions('testReview', tag, AGENT_OUTPUT_SCHEMAS.testReview),
    ),
  standardsReview: (hooks: WorkflowHooks, values: SliceReviewValues, tag: string) =>
    askAgent<ReviewOutput>(
      hooks,
      PROMPTS.standardsReview(values),
      agentOptions('standardsReview', tag, AGENT_OUTPUT_SCHEMAS.standardsReview),
    ),
  scriptApiTsdoc: (hooks: WorkflowHooks, values: ScriptApiTsdocValues, tag: string) =>
    askAgent<ScriptApiTsdocOutput>(
      hooks,
      PROMPTS.scriptApiTsdoc(values),
      agentOptions('scriptApiTsdoc', tag, AGENT_OUTPUT_SCHEMAS.scriptApiTsdoc),
    ),
  epicReview: (hooks: WorkflowHooks, values: EpicReviewValues, tag: string) =>
    askAgent<EpicReviewOutput>(
      hooks,
      PROMPTS.epicReview(values),
      agentOptions('epicReview', tag, AGENT_OUTPUT_SCHEMAS.epicReview),
    ),
  retro: (hooks: WorkflowHooks, values: RetroValues, tag: string) =>
    askAgent<RetroOutput>(
      hooks,
      PROMPTS.retro(values),
      agentOptions('retro', tag, AGENT_OUTPUT_SCHEMAS.retro),
    ),
  prWriter: (hooks: WorkflowHooks, values: PrWriterValues, tag: string) =>
    askAgent<PrWriterOutput>(
      hooks,
      PROMPTS.prWriter(values),
      agentOptions('prWriter', tag, AGENT_OUTPUT_SCHEMAS.prWriter),
    ),
};
