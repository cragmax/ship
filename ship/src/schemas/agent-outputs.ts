/**
 * The zod source of each `ship` judgment agent's output schema: the
 * canonical home of the answer shapes `ship/src/workflow/calls/agent-calls.ts`
 * types as their `z.infer`. Every field is required, the tdd's `reason`
 * alone optional, so a verdict never reaches the workflow without what
 * backs it.
 *
 * Emitted, never rendered: `ship/src/build/emit-workflow-schemas.ts` writes it as
 * JSON Schema into `ship/src/workflow/schemas.generated.ts`, which the
 * render inlines. No file in a render closure may value-import this one.
 */

import { z } from 'zod';

/** One readiness check of an issue. */
const ReadinessCheckSchema = z.object({
  /** Whether the issue passes it. */
  pass: z.boolean(),
  /** What backs the verdict. */
  evidence: z.string(),
});

/** `issue-readiness`'s verdict on one run-set issue: the tree, then each rubric point. */
export const ReadinessVerdictSchema = z.object({
  /** The run-set issue's number. */
  issue: z.int(),
  /** It still describes the tree. Failing makes it stale. */
  current: ReadinessCheckSchema,
  /** Rubric point 1. */
  sliceable: ReadinessCheckSchema,
  /** Rubric point 2. */
  unblocked: ReadinessCheckSchema,
  /** Rubric point 3. */
  rightSized: ReadinessCheckSchema,
  /** Rubric point 4. */
  directionDecided: ReadinessCheckSchema,
  /** Rubric point 5. */
  specified: ReadinessCheckSchema,
});

/** `issue-readiness`'s answer. */
export const IssueReadinessSchema = z.object({
  /** One verdict per run-set issue it judged. */
  issues: z.array(ReadinessVerdictSchema),
});

/**
 * Two run-set issues `issue-overlap` judged likely to touch the same files.
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

/**
 * A run-set issue whose change would touch a live run's changed files. The
 * per-call schema narrows `issue` to the run's issues.
 */
const LiveOverlapSchema = z.object({
  /** The run-set issue. */
  issue: z.int(),
  /** The live run's branch. */
  branch: z.string(),
  /** The files both would change. */
  files: z.array(z.string()),
  /** What backs the overlap. */
  reason: z.string(),
});

/** `issue-overlap`'s answer. */
export const IssueOverlapSchema = z.object({
  /** Each run-set issue's area-map columns and paths. */
  issues: z.array(
    z.object({ number: z.int(), columns: z.array(z.string()), paths: z.array(z.string()) }),
  ),
  /** Every pair it judged to overlap, unordered. */
  pairs: z.array(EstimatedPairSchema),
  /** Every overlap with a live run's changed files. */
  liveOverlaps: z.array(LiveOverlapSchema),
  /** Whether it could read the area map. */
  areaMap: z.enum(['read', 'unavailable']),
});

/** A commit message's first line, as the tdd proposes it. */
export const CommitSpecSchema = z.object({
  /** `feat`, `fix`, `refactor`, `test`, `docs` or `chore`. */
  type: z.string(),
  /** The scope (`tools`, `build`, …). */
  scope: z.string(),
  /** The description after `<type>(<scope>): `. */
  subject: z.string(),
});

/** One probe the tdd ran, or chose not to finish. */
export const ProbeRecordSchema = z.object({
  /** The claim probed. */
  claim: z.string(),
  /** `confirmed`, `falsified`, `inconclusive`, or `cap-hit` (a follow-up, never a verdict). */
  verdict: z.enum(['confirmed', 'falsified', 'inconclusive', 'cap-hit']),
  /** The follow-up to file, for an inconclusive probe or a cap hit. Empty otherwise. */
  followUp: z.string(),
  /**
   * Measured wallclock seconds summed across every run of the claim, a killed run counted up to
   * the kill.
   */
  seconds: z.int(),
});

/**
 * The tdd's evidence: its tracer test's red-green, or why it saw none. One
 * object serves both kinds, every string required, because the emitter
 * refuses unions: the strings a kind does not use arrive empty.
 */
export const TddEvidenceSchema = z.object({
  /**
   * `tracer`: the slice's tracer test, seen red then green; `none`: no
   * red-green, for docs or config only, `PARTIAL`, `BLOCKED`.
   */
  kind: z.enum(['tracer', 'none']),
  /** The tracer test, as `<path> › <test name>`. Empty for `none`. */
  test: z.string(),
  /** At most three lines: what the test drives and asserts. Empty for `none`. */
  pseudocode: z.string(),
  /** The failure line as printed when the test was seen red. Empty for `none`. */
  red: z.string(),
  /** The line showing the test passing. Empty for `none`. */
  green: z.string(),
  /** Why there is no red-green. Empty for `tracer`. */
  reason: z.string(),
});

/** The tdd's answer. */
export const TddOutputSchema = z.object({
  /** `GREEN`, `PARTIAL` (some tests authored but unrun), or `BLOCKED`. */
  verdict: z.enum(['GREEN', 'PARTIAL', 'BLOCKED']),
  /** The slice's one commit. Empty when `BLOCKED` before committing. */
  sha: z.string(),
  /** The commit's changed paths, repository-relative. */
  files: z.array(z.string()),
  /**
   * Every test file it ran green at its commit, repository-relative: the slice reviews take them
   * as passed and rerun only those an amend reaches.
   */
  greenTests: z.array(z.string()),
  /** Every `with-lease:` release line its lease runs printed. */
  leaseLines: z.array(z.string()),
  /** Every probe it ran. */
  probes: z.array(ProbeRecordSchema),
  /** Its tracer test's red-green, or why it saw none. */
  evidence: TddEvidenceSchema,
  /**
   * Each value its issue asked it to record for the PR body (a count, a size
   * the build produced), one per entry. Empty when the issue asks for none.
   */
  recorded: z.array(z.string()),
  /** The landing commit's first line. */
  commit: CommitSpecSchema,
  /** `see` when the issue carries a human-in-the-loop acceptance line, else `fixes`. */
  closes: z.enum(['fixes', 'see']),
  /** Why, when `BLOCKED` or `PARTIAL`. */
  reason: z.string().exactOptional(),
});

/** A slice review's answer: the spec review's, the test review's or the standards review's. */
export const ReviewOutputSchema = z.object({
  /** `clean`: nothing to fix; `fixed`: fixes amended in; `blocked`: the slice cannot land. */
  verdict: z.enum(['clean', 'fixed', 'blocked']),
  /** The slice's commit after any amend. */
  sha: z.string(),
  /** The review's outcome, one line. */
  summary: z.string(),
  /** Every `with-lease:` release line its lease runs printed, verbatim, one per lease. */
  leaseLines: z.array(z.string()),
});

/** The Script API TSDoc review's answer. */
export const ScriptApiTsdocOutputSchema = z.object({
  /** `clean`: nothing to fix; `fixed`: fixes amended in; `blocked`: the slice cannot land. */
  verdict: z.enum(['clean', 'fixed', 'blocked']),
  /** The slice's commit after any amend. */
  sha: z.string(),
  /** The outcome, one line. */
  summary: z.string(),
});

/** One acceptance criterion as the epic review traced it. */
const EpicCriterionSchema = z.object({
  /** The issue it belongs to. */
  issue: z.int(),
  /** Its text, one line. */
  criterion: z.string(),
  /** `met`, `unmet`, or `unchecked`: never traced. */
  state: z.enum(['met', 'unmet', 'unchecked']),
  /** Its source, or why it went unchecked. */
  evidence: z.string(),
});

/** One verified finding of the epic review. */
const EpicFindingSchema = z.object({
  /** The cross-issue view that found it. `parked`: a slice review's skipped finding still open. */
  view: z.enum(['duplication', 'drift', 'size', 'intent', 'architecture', 'parked']),
  /** `hard`: it rejects the change; `judgement`: an open item. */
  severity: z.enum(['hard', 'judgement']),
  /** The finding, one line. */
  summary: z.string(),
  /** Its cited source. */
  source: z.string(),
});

/** The epic review's answer. */
export const EpicReviewOutputSchema = z.object({
  /** The change's verdict. */
  verdict: z.enum(['accepted', 'accepted-with-open-items', 'rejected']),
  /** The verdict's reason, one line. */
  summary: z.string(),
  /** Every acceptance criterion it traced. */
  criteria: z.array(EpicCriterionSchema),
  /** Every verified finding, none applied. */
  findings: z.array(EpicFindingSchema),
  /** Each view it could not read, with why. */
  unchecked: z.array(z.string()),
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

/** The PR writer's answer: the PR body's Summary and Merge Danger. */
export const PrWriterOutputSchema = z.object({
  /** The Summary: markdown with no heading, one view of the whole epic. */
  summary: z.string(),
  /** `one-way`: the merge cannot be walked back; `two-way`: it can. */
  door: z.enum(['one-way', 'two-way']),
  /** What makes the door what it is. Empty when none. */
  doorNote: z.string(),
  /** The merge's blast radius, one word. */
  blastRadius: z.string(),
  /** The merge's potential ramifications. Empty when none. */
  ramifications: z.string(),
});

/** Each judgment stage's output schema, keyed as `schemas.generated.ts` emits it. */
export const AGENT_OUTPUTS = {
  issueReadiness: IssueReadinessSchema,
  issueOverlap: IssueOverlapSchema,
  tdd: TddOutputSchema,
  specReview: ReviewOutputSchema,
  testReview: ReviewOutputSchema,
  standardsReview: ReviewOutputSchema,
  scriptApiTsdoc: ScriptApiTsdocOutputSchema,
  epicReview: EpicReviewOutputSchema,
  retro: RetroOutputSchema,
  prWriter: PrWriterOutputSchema,
} as const;
