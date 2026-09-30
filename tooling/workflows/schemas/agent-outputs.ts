/**
 * The zod source of each `ship` judgment agent's output schema (#1047): the
 * canonical home of the answer shapes `tooling/workflows/lib/agent-calls.ts`
 * types as their `z.infer`. Every field is required — the tdd's `reason`
 * alone is optional — so a verdict never reaches the workflow without what
 * backs it.
 *
 * Emitted, never rendered: `tooling/emit-workflow-schemas.ts` writes it as
 * JSON Schema into `tooling/workflows/lib/schemas.generated.ts`, which the
 * render inlines. No file in a render closure may value-import this one.
 */

import { z } from 'zod';

/** The scout's verdict on one run-set issue. */
const ScoutIssueSchema = z.object({
  /** The issue. */
  issue: z.int(),
  /** Whether the current tree has overtaken it. */
  stale: z.boolean(),
  /** What backs the verdict. */
  evidence: z.string(),
});

/** A run-set issue whose change would touch a live run's files. */
const ScoutOverlapSchema = z.object({
  /** The issue. */
  issue: z.int(),
  /** The live run's branch. */
  branch: z.string(),
  /** The files both would touch. */
  files: z.array(z.string()),
  /** What backs the overlap. */
  evidence: z.string(),
});

/** The scout's answer. */
export const ScoutVerdictSchema = z.object({
  /** One verdict per run-set issue it judged. */
  issues: z.array(ScoutIssueSchema),
  /** Every overlap with a live run. */
  overlaps: z.array(ScoutOverlapSchema),
});

/**
 * Two run-set issues the estimator judged likely to touch the same files.
 * The per-call schema narrows `a` and `b` to the run's issues
 * (`agent-calls.ts` `overlapSchema`).
 */
export const EstimatedPairSchema = z.object({
  /** One issue. */
  a: z.int(),
  /** The other. */
  b: z.int(),
  /** `likely`: file-level evidence; `unsure`: same area, no evidence of disjointness. */
  confidence: z.enum(['likely', 'unsure']),
  /** The files, hubs or area-map columns both touch. */
  shared: z.array(z.string()),
  /** What backs the pair. */
  reason: z.string(),
});

/** The overlap estimator's answer. */
export const OverlapEstimateSchema = z.object({
  /** Each run-set issue's area-map columns and paths. */
  issues: z.array(
    z.object({ number: z.int(), columns: z.array(z.string()), paths: z.array(z.string()) }),
  ),
  /** Every pair it judged to overlap, unordered. */
  pairs: z.array(EstimatedPairSchema),
  /** Whether it could read the area map. */
  areaMap: z.enum(['read', 'unavailable']),
});

/** A commit message's first line, as the planner proposes it. */
export const CommitSpecSchema = z.object({
  /** `feat`, `fix`, `refactor`, `test`, `docs` or `chore`. */
  type: z.string(),
  /** The scope (`tools`, `build`, …). */
  scope: z.string(),
  /** The description after `<type>(<scope>): `. */
  subject: z.string(),
});

/** The planner's card (also the applier's). */
export const PlanCardSchema = z.object({
  /** `plan`: planned; `stale`: the tree overtook the issue; `blocked`: it cannot be planned. */
  verdict: z.enum(['plan', 'stale', 'blocked']),
  /** The plan file written. */
  planPath: z.string(),
  /** The plan in one line. */
  summary: z.string(),
  /** The test tier the plan needs (`unit`, `standalone`, `server`). */
  tier: z.string(),
  /** The landing commit's first line. */
  commit: CommitSpecSchema,
  /** `see` when the issue carries a human-in-the-loop acceptance line, else `fixes`. */
  closes: z.enum(['fixes', 'see']),
  /** What backs the verdict. */
  evidence: z.string(),
});

/** The plan reviewer's answer. */
export const PlanReviewSchema = z.object({
  /** `approved`, or `changes` with findings to apply. */
  verdict: z.enum(['approved', 'changes']),
  /** How many findings the file lists. */
  findings: z.int(),
  /** The findings file. */
  findingsPath: z.string(),
});

/** One probe the tdd ran, or chose not to finish. */
export const ProbeRecordSchema = z.object({
  /** The claim probed. */
  claim: z.string(),
  /** `confirmed`, `falsified`, `inconclusive`, or `cap-hit` (a follow-up, never a verdict). */
  verdict: z.enum(['confirmed', 'falsified', 'inconclusive', 'cap-hit']),
  /** The follow-up to file, for an inconclusive probe or a cap hit; empty otherwise. */
  followUp: z.string(),
});

/** The tdd's answer. */
export const TddOutputSchema = z.object({
  /** `GREEN`, `PARTIAL` (some tests authored but unrun), or `BLOCKED`. */
  verdict: z.enum(['GREEN', 'PARTIAL', 'BLOCKED']),
  /** The slice's one commit; empty when `BLOCKED` before committing. */
  sha: z.string(),
  /** The commit's changed paths, repository-relative. */
  files: z.array(z.string()),
  /** Every `with-lease:` release line its lease runs printed. */
  leaseLines: z.array(z.string()),
  /** Every probe it ran. */
  probes: z.array(ProbeRecordSchema),
  /** Why, when `BLOCKED` or `PARTIAL`. */
  reason: z.string().exactOptional(),
});

/** The reviewer's answer. */
export const ReviewOutputSchema = z.object({
  /** `clean`: nothing to fix; `fixed`: fixes amended in; `blocked`: the slice cannot land. */
  verdict: z.enum(['clean', 'fixed', 'blocked']),
  /** The slice's commit after any amend. */
  sha: z.string(),
  /** The review-fix summary, one line. */
  summary: z.string(),
  /** Every `with-lease:` release line its lease runs printed, verbatim, one per lease. */
  leaseLines: z.array(z.string()),
});

/** The test reviewer's answer. */
export const TestReviewOutputSchema = z.object({
  /** `clean`: nothing to harden; `hardened`: tests amended in; `blocked`: the slice cannot land. */
  verdict: z.enum(['clean', 'hardened', 'blocked']),
  /** The slice's commit after any amend. */
  sha: z.string(),
  /** Mutants still surviving on the final shape. */
  survivors: z.int(),
  /** The outcome, one line. */
  summary: z.string(),
  /** Every `with-lease:` release line its lease runs printed, verbatim, one per lease. */
  leaseLines: z.array(z.string()),
});

/** The doc-index resolver's answer. */
export const ResolverOutputSchema = z.object({
  /** `resolved`: every pending path edited clean; `unresolvable`: not. */
  verdict: z.enum(['resolved', 'unresolvable']),
  /** What it did, one line. */
  summary: z.string(),
});

/** One finding of the critic. */
export const CriticFindingSchema = z.object({
  /** `duplication`, `helpers`, `drift` or `test-gaps`. */
  lens: z.string(),
  /** The finding, one line. */
  summary: z.string(),
  /** Whether its commit carries the fix. */
  applied: z.boolean(),
});

/** The critic's answer. */
export const CriticOutputSchema = z.object({
  /** `clean`: no commit; `applied`: one commit in the critic slice. */
  outcome: z.enum(['clean', 'applied']),
  /** The commit; empty when `clean`. */
  sha: z.string(),
  /** Its changed paths. */
  files: z.array(z.string()),
  /** Its first line. */
  commit: CommitSpecSchema,
  /** Every finding, applied or not. */
  findings: z.array(CriticFindingSchema),
  /** The checks it ran green, one line. */
  checks: z.string(),
});

/** One finding of the retro. */
export const RetroFindingSchema = z.object({
  /** The finding, one line. */
  title: z.string(),
  /** The report path that shows it. */
  evidence: z.string(),
  /** `genuine`: the next run would hit it too; `first-time`: unfamiliarity. */
  kind: z.enum(['genuine', 'first-time']),
  /** What to change. */
  suggestion: z.string(),
});

/** The retro's answer. */
export const RetroOutputSchema = z.object({
  /** Every finding. */
  findings: z.array(RetroFindingSchema),
});

/** Each judgment stage's output schema, keyed as `schemas.generated.ts` emits it. */
export const AGENT_OUTPUTS = {
  scout: ScoutVerdictSchema,
  overlapEstimator: OverlapEstimateSchema,
  planCard: PlanCardSchema,
  planReview: PlanReviewSchema,
  tdd: TddOutputSchema,
  review: ReviewOutputSchema,
  testReview: TestReviewOutputSchema,
  resolver: ResolverOutputSchema,
  critic: CriticOutputSchema,
  retro: RetroOutputSchema,
} as const;
