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

import { parseLeaseLines, type LeaseTiming } from '../../lib/lease-timings.js';

import type { CommitSpec, PlanCard, ProbeRecord, SliceWork } from './agent-calls.js';
import type { SyncStepResult } from './sync-master-step.js';
import type { BumpOutput, ServerTierOutput } from './tool-calls.js';

/** The trailer every landed commit carries: model-neutral, since several agents on several tiers wrote it. */
export const CO_AUTHOR_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';

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
 *   issues, then the epic end — neutralised whole but for the landed
 *   `fixes` issues.
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
  ].join('\n');
  return neutralText(body, closing);
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
