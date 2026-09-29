/**
 * The `ship` workflow's judgment-agent calls: each stage's output shape, the
 * schema the runtime validates it against, and one wrapper per stage that
 * builds the prompt, takes the tier from `stages.ts` and returns the answer
 * — or `null` when the agent returned none (it died, or answered no object).
 *
 * The schemas mark every field the workflow relies on `required` (only the
 * tdd's `reason` is optional), so a verdict never reaches the workflow
 * without what backs it.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { AgentOptions, JsonSchema, WorkflowHooks } from './hooks.types.js';
import {
  PROMPTS,
  type PlannerValues,
  type PlanReviewerValues,
  type ResolverValues,
  type SliceReviewValues,
  type TddValues,
} from './prompts.js';
import { agentOptions, reviewerOptions } from './stages.js';
import { INTEGER, STRING, STRINGS } from './tool-calls.js';

/** A commit message's first line, as the planner proposes it. */
export interface CommitSpec {
  /** `feat`, `fix`, `refactor`, `test`, `docs` or `chore`. */
  readonly type: string;
  /** The scope (`tools`, `build`, …). */
  readonly scope: string;
  /** The description after `<type>(<scope>): `. */
  readonly subject: string;
}

/** The planner's card (also the applier's). */
export interface PlanCard {
  /** `plan`: planned; `stale`: the tree overtook the issue; `blocked`: it cannot be planned. */
  readonly verdict: 'plan' | 'stale' | 'blocked';
  /** The plan file written. */
  readonly planPath: string;
  /** The plan in one line. */
  readonly summary: string;
  /** The test tier the plan needs (`unit`, `standalone`, `server`). */
  readonly tier: string;
  /** The landing commit's first line. */
  readonly commit: CommitSpec;
  /** `see` when the issue carries a human-in-the-loop acceptance line, else `fixes`. */
  readonly closes: 'fixes' | 'see';
  /** What backs the verdict. */
  readonly evidence: string;
}

/** The plan reviewer's answer. */
export interface PlanReview {
  /** `approved`, or `changes` with findings to apply. */
  readonly verdict: 'approved' | 'changes';
  /** How many findings the file lists. */
  readonly findings: number;
  /** The findings file. */
  readonly findingsPath: string;
}

/** One probe the tdd ran, or chose not to finish. */
export interface ProbeRecord {
  /** The claim probed. */
  readonly claim: string;
  /** `confirmed`, `falsified`, `inconclusive`, or `cap-hit` (a follow-up, never a verdict). */
  readonly verdict: 'confirmed' | 'falsified' | 'inconclusive' | 'cap-hit';
  /** The follow-up to file, for an inconclusive probe or a cap hit; empty otherwise. */
  readonly followUp: string;
}

/** The tdd's answer. */
export interface TddOutput {
  /** `GREEN`, `PARTIAL` (some tests authored but unrun), or `BLOCKED`. */
  readonly verdict: 'GREEN' | 'PARTIAL' | 'BLOCKED';
  /** The slice's one commit; empty when `BLOCKED` before committing. */
  readonly sha: string;
  /** The commit's changed paths, repository-relative. */
  readonly files: readonly string[];
  /** Every `with-lease:` release line its lease runs printed. */
  readonly leaseLines: readonly string[];
  /** Every probe it ran. */
  readonly probes: readonly ProbeRecord[];
  /** Why, when `BLOCKED` or `PARTIAL`. */
  readonly reason?: string;
}

/** The reviewer's answer. */
export interface ReviewOutput {
  /** `clean`: nothing to fix; `fixed`: fixes amended in; `blocked`: the slice cannot land. */
  readonly verdict: 'clean' | 'fixed' | 'blocked';
  /** The slice's commit after any amend. */
  readonly sha: string;
  /** The review-fix summary, one line. */
  readonly summary: string;
}

/** The test reviewer's answer. */
export interface TestReviewOutput {
  /** `clean`: nothing to harden; `hardened`: tests amended in; `blocked`: the slice cannot land. */
  readonly verdict: 'clean' | 'hardened' | 'blocked';
  /** The slice's commit after any amend. */
  readonly sha: string;
  /** Mutants still surviving on the final shape. */
  readonly survivors: number;
  /** The outcome, one line. */
  readonly summary: string;
}

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

/** The doc-index resolver's answer. */
export interface ResolverOutput {
  /** `resolved`: every pending path edited clean; `unresolvable`: not. */
  readonly verdict: 'resolved' | 'unresolvable';
  /** What it did, one line. */
  readonly summary: string;
}

/**
 * An object schema requiring every property.
 *
 * @param properties - The properties' schemas.
 * @returns The schema.
 */
function strictObject(properties: Readonly<Record<string, unknown>>): JsonSchema {
  return { type: 'object', properties, required: Object.keys(properties) };
}

/**
 * A string enum's schema.
 *
 * @param values - The allowed values.
 * @returns The schema.
 */
function oneOf(...values: readonly string[]): JsonSchema {
  return { type: 'string', enum: values };
}

/** The planner's and the applier's output schema. */
const PLAN_CARD_SCHEMA = strictObject({
  verdict: oneOf('plan', 'stale', 'blocked'),
  planPath: STRING,
  summary: STRING,
  tier: STRING,
  commit: strictObject({ type: STRING, scope: STRING, subject: STRING }),
  closes: oneOf('fixes', 'see'),
  evidence: STRING,
});

/** The plan reviewer's output schema. */
const PLAN_REVIEW_SCHEMA = strictObject({
  verdict: oneOf('approved', 'changes'),
  findings: INTEGER,
  findingsPath: STRING,
});

/** The tdd's output schema. */
const TDD_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdict: oneOf('GREEN', 'PARTIAL', 'BLOCKED'),
    sha: STRING,
    files: STRINGS,
    leaseLines: STRINGS,
    probes: {
      type: 'array',
      items: strictObject({
        claim: STRING,
        verdict: oneOf('confirmed', 'falsified', 'inconclusive', 'cap-hit'),
        followUp: STRING,
      }),
    },
    reason: STRING,
  },
  required: ['verdict', 'sha', 'files', 'leaseLines', 'probes'],
};

/** The reviewer's output schema. */
const REVIEW_SCHEMA = strictObject({
  verdict: oneOf('clean', 'fixed', 'blocked'),
  sha: STRING,
  summary: STRING,
});

/** The test reviewer's output schema. */
const TEST_REVIEW_SCHEMA = strictObject({
  verdict: oneOf('clean', 'hardened', 'blocked'),
  sha: STRING,
  survivors: INTEGER,
  summary: STRING,
});

/** The resolver's output schema. */
const RESOLVER_SCHEMA = strictObject({
  verdict: oneOf('resolved', 'unresolvable'),
  summary: STRING,
});

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

/** One wrapper per judgment stage; `tag` tells the call from the stage's others (`7-1`). */
export const AGENT_CALLS = {
  planner: (hooks: WorkflowHooks, values: PlannerValues, tag: string) =>
    askAgent<PlanCard>(
      hooks,
      PROMPTS.planner(values),
      agentOptions(values.mode === 'plan' ? 'planner' : 'applier', tag, PLAN_CARD_SCHEMA),
    ),
  planReviewer: (hooks: WorkflowHooks, values: PlanReviewerValues, tag: string) =>
    askAgent<PlanReview>(
      hooks,
      PROMPTS.planReviewer(values),
      agentOptions('planReviewer', tag, PLAN_REVIEW_SCHEMA),
    ),
  tdd: (hooks: WorkflowHooks, values: TddValues, tag: string) =>
    askAgent<TddOutput>(hooks, PROMPTS.tdd(values), agentOptions('tdd', tag, TDD_SCHEMA)),
  reviewer: (hooks: WorkflowHooks, values: SliceReviewValues, tag: string) =>
    askAgent<ReviewOutput>(
      hooks,
      PROMPTS.reviewer(values),
      reviewerOptions(tag, REVIEW_SCHEMA, values.files),
    ),
  testReview: (hooks: WorkflowHooks, values: SliceReviewValues, tag: string) =>
    askAgent<TestReviewOutput>(
      hooks,
      PROMPTS.testReview(values),
      agentOptions('testReview', tag, TEST_REVIEW_SCHEMA),
    ),
  resolver: (hooks: WorkflowHooks, values: ResolverValues, tag: string) =>
    askAgent<ResolverOutput>(
      hooks,
      PROMPTS.resolver(values),
      agentOptions('resolver', tag, RESOLVER_SCHEMA),
    ),
};
