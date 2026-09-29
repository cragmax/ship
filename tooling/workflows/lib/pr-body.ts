/**
 * The `ship` workflow's texts that land in git and on GitHub: each landed
 * issue's commit message, and each epic's pull request title and body.
 *
 * **Closing keywords are the workflow's own.** GitHub closes an issue for a
 * closing keyword (`fixes`, `closes`, `resolves`, …) before its reference
 * anywhere in a merged commit message or PR body. So only this file writes
 * one — `fixes #N`, for a landed issue whose plan card says so. Every other
 * issue is cited `see #N`, the epic container included, and every text
 * carrying agent- or tool-written words passes through {@link neutralText},
 * which turns `fixed #12` into `fixed (see #12)`: a commit's whole subject
 * line, and a PR body as a whole, sparing only its landed `fixes` issues.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect. Lease lines are parsed by
 * `tooling/lib/lease-timings.ts`, which joins the render closure here.
 */

import { CO_AUTHOR_TRAILER } from '../../lib/commit-trailer.js';
import { parseLeaseLines, type LeaseAggregate, type LeaseTiming } from '../../lib/lease-timings.js';

import type {
  CommitSpec,
  CriticFinding,
  PlanCard,
  ProbeRecord,
  RetroFinding,
  SliceWork,
} from './agent-calls.js';
import type { OverlapEdge, OverlapRecord } from './preflight.js';
import type { SyncStepResult } from './sync-master-step.js';
import type { BumpOutput, ServerTierOutput } from './tool-calls.js';

/** A closing keyword, then any colons and whitespace. */
const CLOSING_KEYWORD = String.raw`\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)([\s:]*)`;

/**
 * A closing keyword before an issue reference, one pattern per form:
 * `#N` or `owner/repo#N`; an issue URL (any URL ending `/N`).
 */
const CLOSING_REFS: readonly RegExp[] = [
  new RegExp(String.raw`${CLOSING_KEYWORD}([\w./-]*#\d+)`, 'giu'),
  new RegExp(String.raw`${CLOSING_KEYWORD}(https?://\S+/\d+)`, 'giu'),
];

/** An issue that landed on the epic branch, with what its slice produced. */
export interface LandedIssue extends SliceWork {
  /** The issue. */
  readonly issue: number;
  /** Its batch commit. */
  readonly commit: string;
}

/** An issue that did not land, as the run report records it. */
export interface UnlandedIssue {
  /** The issue. */
  readonly issue: number;
  /** How it ended (`blocked`, `skipped`, `removed`, …). */
  readonly outcome: string;
  /** Why, when known. */
  readonly reason?: string;
}

/** One issue's line of an entry's schedule. */
export interface ScheduleEntry {
  /** The issue. */
  readonly issue: number;
  /** Its blockers in the scheduled graph (overlap edges included), ascending. */
  readonly blockers: readonly number[];
  /** How many attempts it took; 0 when it never started. */
  readonly attempts: number;
  /** When its final attempt's slice was cut; `null` when none was. */
  readonly startedAt: string | null;
  /** When its commit landed; `null` unless it landed. */
  readonly committedAt: string | null;
}

/** The critic's part of an epic end. */
export interface CriticReport {
  /**
   * `clean`: nothing to change; `landed`: its commit landed
   * ({@link CriticReport.commit}); `dropped`: its commit did not land;
   * `not-run`: it could not run; `skipped`: fewer than two issues landed.
   * The last three carry {@link CriticReport.reason}, but for `skipped`.
   */
  readonly outcome: 'clean' | 'landed' | 'dropped' | 'not-run' | 'skipped';
  /** The batch commit, when `landed`. */
  readonly commit?: string;
  /** Why, when `dropped` or `not-run`. */
  readonly reason?: string;
  /** Every finding it reported. */
  readonly findings: readonly CriticFinding[];
}

/** One engine's server-tier run. */
export interface TierRun {
  /** The engine. */
  readonly engine: 'paper' | 'folia';
  /** `server-tier`'s output; `null` when the runner returned none. */
  readonly out: ServerTierOutput | null;
}

/** Everything an epic's pull request body reports. */
export interface PrBodyInput {
  /** The epic; `null` for an explicit list. */
  readonly epic: number | null;
  /** The feature branch. */
  readonly branch: string;
  /** The run's report directory. */
  readonly reportDir: string;
  /** Every landed issue, in landing order. */
  readonly landed: readonly LandedIssue[];
  /** Every other issue of the entry. */
  readonly unlanded: readonly UnlandedIssue[];
  /** Both engines' server-tier runs. */
  readonly serverTier: readonly TierRun[];
  /** The master sync. */
  readonly sync: SyncStepResult;
  /** The bump; `null` when the runner returned none. */
  readonly bump: BumpOutput | null;
  /** The critic's part. */
  readonly critic: CriticReport;
  /** The overlap edges pre-flight added to the entry. */
  readonly overlap: OverlapRecord;
  /** Each issue's schedule, in the entry's order. */
  readonly schedule: readonly ScheduleEntry[];
  /** The entry's lease totals. */
  readonly leases: LeaseAggregate;
  /** The retro's findings; `null` when it returned none. */
  readonly retro: readonly RetroFinding[] | null;
}

/**
 * A text with every closing keyword defused, but for the issues it may close.
 *
 * @param text - The text.
 * @param closing - The issues whose bare `<keyword> #N` stays; none by default.
 * @returns It with each other `<keyword> <ref>` spelled `<keyword> (see <ref>)`.
 */
export function neutralText(text: string, closing: ReadonlySet<number> = new Set()): string {
  return CLOSING_REFS.reduce(
    (out, pattern) =>
      out.replace(pattern, (match: string, word: string, gap: string, ref: string) =>
        ref.startsWith('#') && closing.has(Number(ref.slice(1)))
          ? match
          : `${word}${gap}(see ${ref})`,
      ),
    text,
  );
}

/**
 * A commit's first line.
 *
 * @param commit - The planner's proposal.
 * @returns `<type>(<scope>): <subject>`, neutralised whole.
 */
export function subjectLine(commit: CommitSpec): string {
  return neutralText(`${commit.type}(${commit.scope}): ${commit.subject}`);
}

/**
 * A landed issue's commit message.
 *
 * @param issue - The issue.
 * @param card - Its plan card's commit and closing choice.
 * @returns The subject line, a blank line, `fixes #N` (or `see #N`), a
 *   blank line and {@link CO_AUTHOR_TRAILER}, newline-terminated.
 */
export function commitMessage(issue: number, card: Pick<PlanCard, 'commit' | 'closes'>): string {
  return [
    subjectLine(card.commit),
    '',
    `${card.closes} #${String(issue)}`,
    '',
    CO_AUTHOR_TRAILER,
    '',
  ].join('\n');
}

/**
 * The critic commit's message: it closes and cites no issue.
 *
 * @param commit - The critic's first line.
 * @returns The subject line, a blank line and {@link CO_AUTHOR_TRAILER},
 *   newline-terminated.
 */
export function criticCommitMessage(commit: CommitSpec): string {
  return [subjectLine(commit), '', CO_AUTHOR_TRAILER, ''].join('\n');
}

/**
 * An epic's pull request title.
 *
 * @param input - The epic's report.
 * @returns The one landed issue's subject line; `<branch>: <n> issues` for several.
 */
export function prTitle(input: Pick<PrBodyInput, 'branch' | 'landed'>): string {
  const [only] = input.landed;
  if (input.landed.length === 1 && only !== undefined) return subjectLine(only.card.commit);
  return `${input.branch}: ${String(input.landed.length)} issues`;
}

/**
 * An epic's pull request body.
 *
 * @param input - The epic's report.
 * @returns Markdown: a summary, one section per landed issue, the unlanded
 *   issues, the epic end, then the critic, the overlap edges, the schedule,
 *   the lease timings and the retro findings (an empty one `None.`) —
 *   neutralised whole but for the landed `fixes` issues.
 */
export function renderPrBody(input: PrBodyInput): string {
  const container = input.epic === null ? 'an explicit issue list' : `see #${String(input.epic)}`;
  const closing = new Set(
    input.landed.filter((l) => l.card.closes === 'fixes').map((l) => l.issue),
  );
  const body = [
    '## Summary',
    '',
    `Unattended run on \`${input.branch}\` — ${container}.`,
    '',
    '## Issues',
    '',
    ...input.landed.flatMap(issueSection),
    '## Not landed',
    '',
    ...(input.unlanded.length === 0 ? ['None.'] : input.unlanded.map(unlandedLine)),
    '',
    '## Epic end',
    '',
    ...input.serverTier.map(tierLine),
    `- Master sync: ${input.sync.verdict}${input.sync.commit === null ? '' : ` at ${input.sync.commit}`}`,
    `- Version bump: ${bumpText(input.bump)}`,
    `- Report dir: \`${input.reportDir}\``,
    '',
    ...section('Critic', criticLines(input.critic)),
    ...section('Overlap edges', input.overlap.added.map(overlapLine)),
    ...section('Schedule', input.schedule.map(scheduleLine)),
    ...section('Lease timings', leaseLines(input.leases)),
    ...section('Retro findings', retroLines(input.retro)),
  ].join('\n');
  return neutralText(body, closing);
}

/**
 * One body section.
 *
 * @param heading - Its `##` heading.
 * @param lines - Its lines; none renders `None.`.
 * @returns The heading, a blank line, the lines and a blank line.
 */
function section(heading: string, lines: readonly string[]): string[] {
  return [`## ${heading}`, '', ...(lines.length === 0 ? ['None.'] : lines), ''];
}

/**
 * The critic's lines.
 *
 * @param critic - Its part of the epic end.
 * @returns `- Outcome: …`, then one line per finding.
 */
function criticLines(critic: CriticReport): string[] {
  const outcome = {
    clean: 'no changes',
    landed: `landed as ${critic.commit ?? '?'}`,
    dropped: `changes dropped — ${critic.reason ?? 'no reason named'}`,
    'not-run': `not run — ${critic.reason ?? 'no reason named'}`,
    skipped: 'skipped — one issue landed',
  }[critic.outcome];
  return [
    `- Outcome: ${outcome}`,
    ...critic.findings.map(
      (f) => `- [${f.lens}] ${f.summary} (${f.applied ? 'applied' : 'not applied'})`,
    ),
  ];
}

/**
 * One overlap edge's line.
 *
 * @param edge - The edge.
 * @returns `- #B → #D (<confidence>): <reason>`.
 */
function overlapLine(edge: OverlapEdge): string {
  return `- #${String(edge.blocker)} → #${String(edge.dependent)} (${edge.confidence}): ${edge.reason}`;
}

/**
 * One issue's schedule line.
 *
 * @param entry - Its schedule.
 * @returns `- #N: blockers …; started …; committed …; attempts K`, `never`
 *   for a missing instant.
 */
function scheduleLine(entry: ScheduleEntry): string {
  const blockers =
    entry.blockers.length === 0 ? 'none' : entry.blockers.map((b) => `#${String(b)}`).join(', ');
  return (
    `- #${String(entry.issue)}: blockers ${blockers}; started ${entry.startedAt ?? 'never'}; ` +
    `committed ${entry.committedAt ?? 'never'}; attempts ${String(entry.attempts)}`
  );
}

/**
 * The lease totals' lines: per engine, per issue, then each unparsed line.
 *
 * @param leases - The totals.
 * @returns The lines.
 */
function leaseLines(leases: LeaseAggregate): string[] {
  return [
    ...leases.engines.map(
      (e) =>
        `- ${e.type}: ${String(e.leases)} leases, waited ${e.waitedSeconds.toFixed(1)}s total ` +
        `(max ${e.waitedMaxSeconds.toFixed(1)}s), held ${e.heldSeconds.toFixed(1)}s total`,
    ),
    ...leases.issues.map(
      (t) =>
        `- #${String(t.issue)}: waited ${t.waitedSeconds.toFixed(1)}s, held ${t.heldSeconds.toFixed(1)}s`,
    ),
    ...leases.unparsed.map(
      (u) => `- unparsed${u.issue === null ? '' : ` (#${String(u.issue)})`}: ${u.line}`,
    ),
  ];
}

/**
 * The retro's lines.
 *
 * @param retro - Its findings; `null` when it returned none.
 * @returns One line per finding; a note line when it returned nothing.
 */
function retroLines(retro: readonly RetroFinding[] | null): string[] {
  if (retro === null) return ['- The retro returned nothing.'];
  return retro.map((f) => `- ${f.title} (${f.kind}): ${f.evidence} — ${f.suggestion}`);
}

/**
 * One landed issue's section.
 *
 * @param landed - The issue.
 * @returns The section's lines, blank-line terminated.
 */
function issueSection(landed: LandedIssue): string[] {
  const ref = `#${String(landed.issue)}`;
  const cite =
    landed.card.closes === 'fixes' ? `fixes ${ref}` : `see ${ref} (its acceptance needs a human)`;
  const test = landed.testReview;
  return [
    `### ${subjectLine(landed.card.commit)}`,
    '',
    `- Issue: ${cite}, landed as ${landed.commit}`,
    `- Plan: ${landed.card.summary} (tier: ${landed.card.tier})`,
    `- Review: ${landed.review.verdict} — ${landed.review.summary}`,
    test === null
      ? '- Test review: skipped — trivial surface'
      : `- Test review: ${test.verdict}, ${String(test.survivors)} surviving mutants — ${test.summary}`,
    `- Lease timings: ${leaseText(parseLeaseLines(landed.tdd.leaseLines.join('\n')))}`,
    ...probeLines(landed.tdd.probes),
    '',
  ];
}

/**
 * A slice's probe lines.
 *
 * @param probes - The tdd's probe records.
 * @returns `- Probes: no probe needed`, or one nested line per probe with its
 *   verdict and follow-up.
 */
function probeLines(probes: readonly ProbeRecord[]): string[] {
  if (probes.length === 0) return ['- Probes: no probe needed'];
  return [
    '- Probes:',
    ...probes.map((p) => {
      const followUp = p.followUp === '' ? '' : `; follow-up: ${p.followUp}`;
      return `  - ${p.claim}: ${p.verdict}${followUp}`;
    }),
  ];
}

/**
 * Lease timings as one phrase.
 *
 * @param timings - The parsed release lines.
 * @returns Each as `<type>@<endpoint> waited <W>s, held <H>s`, `; `-joined;
 *   `none` for none.
 */
function leaseText(timings: readonly LeaseTiming[]): string {
  if (timings.length === 0) return 'none';
  return timings
    .map(
      (t) =>
        `${t.type}@${t.endpoint} waited ${String(t.waitedSeconds)}s, held ${String(t.heldSeconds)}s`,
    )
    .join('; ');
}

/**
 * One unlanded issue's line.
 *
 * @param issue - The issue.
 * @returns `- see #N — <outcome>[: <reason>]`.
 */
function unlandedLine(issue: UnlandedIssue): string {
  const reason = issue.reason === undefined ? '' : `: ${issue.reason}`;
  return `- see #${String(issue.issue)} — ${issue.outcome}${reason}`;
}

/**
 * One engine's server-tier line.
 *
 * @param run - The engine's run.
 * @returns Its counts, its outcome when not `ok`, and its lease.
 */
function tierLine(run: TierRun): string {
  const { out } = run;
  if (out === null) return `- Server tier, ${run.engine}: no result (the runner returned nothing)`;
  const t = out.tests;
  const counts =
    t === undefined || t === null
      ? 'no counts'
      : `${String(t.passed)} passed, ${String(t.failed)} failed, ${String(t.skipped)} skipped`;
  const status =
    out.status === 'ok'
      ? ''
      : ` — ${out.status ?? 'no status'}: ${out.errors?.[0]?.message ?? 'no error named'}`;
  const lease = out.lease === undefined || out.lease === null ? 'none' : leaseText([out.lease]);
  return `- Server tier, ${run.engine}: ${counts}${status}; lease ${lease}`;
}

/**
 * The bump as one phrase.
 *
 * @param bump - `bump`'s output.
 * @returns `<kind>, <from> → <to>`; the outcome when it did not land.
 */
function bumpText(bump: BumpOutput | null): string {
  if (bump?.status !== 'ok') return `not applied (${bump?.status ?? 'no result'})`;
  return `${bump.kind ?? '?'}, ${bump.from ?? '?'} → ${bump.to ?? '?'}`;
}
