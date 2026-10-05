/**
 * The `ship` workflow's texts that land in git and on GitHub: each landed
 * issue's commit message, and each epic's pull request title and body — the
 * PR writer's Summary ({@link summaryLines}), the Evidence
 * ({@link evidenceBullet}), the PR writer's Merge Danger
 * ({@link mergeDangerLines}), the visible Issues list, then the run report,
 * folded in `<details>` unless the PR writer returned nothing (the order:
 * {@link renderPrBody}).
 *
 * **Closing keywords are the workflow's own.** GitHub closes an issue for a
 * closing keyword (`fixes`, `closes`, `resolves`, …) before its reference
 * anywhere in a merged commit message or PR body. So only this file writes
 * one — `fixes #N`, for a landed issue whose plan card says so: in its
 * commit message, and once in a PR body, in the Issues list
 * ({@link landedLine}), never inside the fold. Every other
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
  OverlapConfidence,
  PlanCard,
  PrWriterOutput,
  ProbeRecord,
  RetroFinding,
  SliceWork,
} from './agent-calls.js';
import type { ForwardMove, PassedMasterCheck } from './master-check.js';
import { evidenceBullet } from './pr-evidence.js';
import type { OverlapEdge, OverlapRecord } from './preflight.js';
import { mergeDangerLines, summaryLines } from './pr-writer-sections.js';
import type { SyncStepResult } from './sync-master-step.js';
import type { BumpOutput } from './tool-calls.js';

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

/** A slice's lease lines from one agent role. */
export interface RoleLeaseLines {
  /** The agent whose lease runs printed them: `tdd`, `review` or `test-review`. */
  readonly role: 'tdd' | 'review' | 'test-review';
  /** Its `with-lease:` lines, as the agent transcribed them. */
  readonly lines: readonly string[];
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

/** One blocker of a scheduled issue, with where its edge came from. */
export type ScheduleBlocker =
  | {
      /** The blocking issue. */
      readonly issue: number;
      /** `declared`: a `blocked_by` edge the run gate declared. */
      readonly source: 'declared';
    }
  | {
      /** The blocking issue. */
      readonly issue: number;
      /** `overlap`: an edge pre-flight's overlap estimate added. */
      readonly source: 'overlap';
      /** The estimator's word for the edge. */
      readonly confidence: OverlapConfidence;
    };

/** One issue's line of an entry's schedule. */
export interface ScheduleEntry {
  /** The issue. */
  readonly issue: number;
  /** Its blockers in the scheduled graph, ascending, each with its source. */
  readonly blockers: readonly ScheduleBlocker[];
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
  /** The master sync. */
  readonly sync: SyncStepResult;
  /** The bump; `null` when the runner returned none. */
  readonly bump: BumpOutput | null;
  /** The master check, passed: a failed check opens no PR. */
  readonly masterCheck: PassedMasterCheck;
  /**
   * Whether the main checkout's `HEAD` and dirtiness equal pre-flight's,
   * read before the push; `null` when a read failed.
   */
  readonly mainUntouched: boolean | null;
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
  /** The PR writer's answer; `null` when it returned none. */
  readonly writer: PrWriterOutput | null;
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
 * A slice's lease lines by role: the one reader of each agent's `leaseLines`.
 *
 * @param work - The slice's tdd, review and test-review answers.
 * @returns The tdd's, then the review's, then the test review's; no
 *   test-review entry when it was skipped (`null`); lines unparsed and
 *   unfiltered.
 */
export function sliceLeaseLines(
  work: Pick<SliceWork, 'tdd' | 'review' | 'testReview'>,
): RoleLeaseLines[] {
  const roles: RoleLeaseLines[] = [
    { role: 'tdd', lines: work.tdd.leaseLines },
    { role: 'review', lines: work.review.leaseLines },
  ];
  if (work.testReview !== null) {
    roles.push({ role: 'test-review', lines: work.testReview.leaseLines });
  }
  return roles;
}

/**
 * An epic's pull request body.
 *
 * @param input - The epic's report.
 * @returns Markdown, neutralised whole but for the landed `fixes` issues,
 *   the PR writer's prose included: `## Summary` per {@link summaryLines};
 *   `## Evidence`, one bullet per landed issue in landing order per
 *   {@link evidenceBullet}; `## Merge Danger` per {@link mergeDangerLines};
 *   `## Issues` per {@link issueListLines}; then the run report per
 *   {@link reportBlock}. Each section per {@link section}.
 */
export function renderPrBody(input: PrBodyInput): string {
  const closing = new Set(
    input.landed.filter((l) => l.card.closes === 'fixes').map((l) => l.issue),
  );
  const body = [
    ...section('Summary', summaryLines(input.writer)),
    ...section(
      'Evidence',
      input.landed.flatMap((l) => evidenceBullet(l.issue, l.tdd.evidence)),
    ),
    ...section('Merge Danger', mergeDangerLines(input.writer)),
    ...section('Issues', issueListLines(input)),
    ...reportBlock(input),
  ].join('\n');
  return neutralText(body, closing);
}

/**
 * The run report as the body carries it.
 *
 * @param input - The epic's report.
 * @returns The lines of {@link runReportLines}, unfolded when the PR writer
 *   returned nothing; otherwise between `<details><summary>Run report</summary>`
 *   and `</details>`, each followed by a blank line.
 */
function reportBlock(input: PrBodyInput): string[] {
  const report = runReportLines(input);
  if (input.writer === null) return report;
  return ['<details><summary>Run report</summary>', '', ...report, '</details>', ''];
}

/**
 * The run report the body folds.
 *
 * @param input - The epic's report.
 * @returns `## Landed issues` and one section per landed issue per
 *   {@link issueSection}; the epic end (master sync, version bump, master
 *   check, main checkout, report dir); then the critic, the overlap edges,
 *   the schedule, the lease timings and the retro findings, an empty one
 *   `None.` — blank-line terminated.
 */
function runReportLines(input: PrBodyInput): string[] {
  return [
    '## Landed issues',
    '',
    ...input.landed.flatMap(issueSection),
    '## Epic end',
    '',
    `- Master sync: ${input.sync.verdict}${input.sync.commit === null ? '' : ` at ${input.sync.commit}`}`,
    `- Version bump: ${bumpText(input.bump)}`,
    `- Master check: ${masterCheckText(input.masterCheck)}`,
    `- Main checkout: ${mainCheckoutText(input.mainUntouched)}`,
    `- Report dir: \`${input.reportDir}\``,
    '',
    ...section('Critic', criticLines(input.critic)),
    ...section('Overlap edges', input.overlap.added.map(overlapLine)),
    ...section('Schedule', input.schedule.map(scheduleLine)),
    ...section('Lease timings', leaseLines(input.leases)),
    ...section('Retro findings', retroLines(input.retro)),
  ];
}

/**
 * The Issues list.
 *
 * @param input - The epic's report.
 * @returns The {@link epicLine}, then a {@link landedLine} per landed issue
 *   in landing order, then an {@link unlandedLine} per unlanded issue in
 *   input order.
 */
function issueListLines(input: Pick<PrBodyInput, 'epic' | 'landed' | 'unlanded'>): string[] {
  return [
    epicLine(input.epic),
    ...input.landed.map(landedLine),
    ...input.unlanded.map(unlandedLine),
  ];
}

/**
 * The Issues list's container line.
 *
 * @param epic - The epic; `null` for an explicit list.
 * @returns `- Epic: see #E`, or `- An explicit issue list`.
 */
function epicLine(epic: number | null): string {
  return epic === null ? '- An explicit issue list' : `- Epic: see #${String(epic)}`;
}

/**
 * One landed issue's Issues-list line.
 *
 * @param landed - The issue.
 * @returns `- fixes #N — <subject>` when its card says `fixes`, else
 *   `- see #N — <subject> (its acceptance needs a human)`; the subject is
 *   the card's bare commit subject, not its `type(scope):` line.
 */
function landedLine(landed: LandedIssue): string {
  const ref = `#${String(landed.issue)}`;
  const subject = landed.card.commit.subject;
  return landed.card.closes === 'fixes'
    ? `- fixes ${ref} — ${subject}`
    : `- see ${ref} — ${subject} (its acceptance needs a human)`;
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
 * @returns `- #N: blockers …; started …; committed …; attempts K`: each
 *   blocker per {@link blockerText}, `, `-joined, `none` for none; `never`
 *   for a missing instant.
 */
function scheduleLine(entry: ScheduleEntry): string {
  const blockers =
    entry.blockers.length === 0 ? 'none' : entry.blockers.map(blockerText).join(', ');
  return (
    `- #${String(entry.issue)}: blockers ${blockers}; started ${entry.startedAt ?? 'never'}; ` +
    `committed ${entry.committedAt ?? 'never'}; attempts ${String(entry.attempts)}`
  );
}

/**
 * One schedule blocker as a phrase.
 *
 * @param blocker - The blocker.
 * @returns `#B (declared)`, or `#B (overlap, <confidence>)`.
 */
function blockerText(blocker: ScheduleBlocker): string {
  const source = blocker.source === 'declared' ? 'declared' : `overlap, ${blocker.confidence}`;
  return `#${String(blocker.issue)} (${source})`;
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
 * @returns The section's lines, blank-line terminated: the heading, then the
 *   issue (`- Issue: #N, landed as <sha>`, no closing keyword), plan, diff
 *   review (`- Diff review: <rules> rules, <plan> plan findings`), review,
 *   test review, lease and probe lines; its lease line per
 *   {@link sliceLeaseText}, its probe lines per {@link probeLines}.
 */
function issueSection(landed: LandedIssue): string[] {
  const diff = landed.diffReview;
  const test = landed.testReview;
  return [
    `### ${subjectLine(landed.card.commit)}`,
    '',
    `- Issue: #${String(landed.issue)}, landed as ${landed.commit}`,
    `- Plan: ${landed.card.summary} (tier: ${landed.card.tier})`,
    `- Diff review: ${String(diff.rules)} rules, ${String(diff.plan)} plan findings`,
    `- Review: ${landed.review.verdict} — ${landed.review.summary}`,
    test === null
      ? '- Test review: skipped — trivial surface'
      : `- Test review: ${test.verdict}, ${String(test.survivors)} surviving mutants — ${test.summary}`,
    `- Lease timings: ${sliceLeaseText(landed)}`,
    ...probeLines(landed),
    '',
  ];
}

/**
 * A slice's probe lines: the planner's plan-time records, then the tdd's.
 *
 * @param work - The slice's plan card and tdd answer.
 * @returns `- Probes: no probe needed` when neither has a record; else
 *   `- Probes:`, then one nested line per record, the card's first, each per
 *   {@link probeLine}.
 */
function probeLines(work: Pick<SliceWork, 'card' | 'tdd'>): string[] {
  const records = [
    ...work.card.probes.map((p) => probeLine('plan', p)),
    ...work.tdd.probes.map((p) => probeLine('tdd', p)),
  ];
  if (records.length === 0) return ['- Probes: no probe needed'];
  return ['- Probes:', ...records];
}

/**
 * One probe record's nested line.
 *
 * @param stage - The stage that ran it.
 * @param probe - The record.
 * @returns `  - <stage>: <claim>: <verdict> in <dur>`, `<dur>` per
 *   {@link durationText}, with `; follow-up: <followUp>` when it has one.
 */
function probeLine(stage: 'plan' | 'tdd', probe: ProbeRecord): string {
  const followUp = probe.followUp === '' ? '' : `; follow-up: ${probe.followUp}`;
  return `  - ${stage}: ${probe.claim}: ${probe.verdict} in ${durationText(probe.seconds)}${followUp}`;
}

/**
 * A probe's measured duration as a phrase.
 *
 * @param seconds - Its whole seconds.
 * @returns `<s>s` below 60 (`42s`); from 60 up, `<m>m <ss>s`, the seconds
 *   zero-padded to two digits (`11m 04s`).
 */
function durationText(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const rest = String(seconds % 60).padStart(2, '0');
  return `${String(Math.floor(seconds / 60))}m ${rest}s`;
}

/**
 * A slice's lease timings as one phrase.
 *
 * @param work - The slice's tdd, review and test-review answers.
 * @returns `<role>: <leases>` for each role with at least one release line,
 *   in {@link sliceLeaseLines} order, `; `-joined, each role's leases per
 *   {@link leaseText}; a role with none is omitted; `none` when no role has
 *   one.
 */
function sliceLeaseText(work: Pick<SliceWork, 'tdd' | 'review' | 'testReview'>): string {
  const parts = sliceLeaseLines(work).flatMap(({ role, lines }) => {
    const timings = parseLeaseLines(lines.join('\n'));
    return timings.length === 0 ? [] : [`${role}: ${leaseText(timings)}`];
  });
  return parts.length === 0 ? 'none' : parts.join('; ');
}

/**
 * Lease timings as one phrase.
 *
 * @param timings - The parsed release lines, at least one.
 * @returns Each as `<type>@<endpoint> waited <W>s, held <H>s` — with
 *   ` on <waitedOn>` after `waited <W>s` when the line names the holder
 *   waited on — `; `-joined.
 */
function leaseText(timings: readonly LeaseTiming[]): string {
  return timings
    .map((t) => {
      const on = t.waitedOn === undefined ? '' : ` on ${t.waitedOn}`;
      return `${t.type}@${t.endpoint} waited ${String(t.waitedSeconds)}s${on}, held ${String(t.heldSeconds)}s`;
    })
    .join('; ');
}

/**
 * One unlanded issue's Issues-list line.
 *
 * @param issue - The issue.
 * @returns `- see #N — not landed: <outcome>[: <reason>]`.
 */
function unlandedLine(issue: UnlandedIssue): string {
  const reason = issue.reason === undefined ? '' : `: ${issue.reason}`;
  return `- see #${String(issue.issue)} — not landed: ${issue.outcome}${reason}`;
}

/**
 * The passed master check as one phrase.
 *
 * @param check - The check.
 * @returns `passed — local <move>; origin <move>`, each per {@link forwardText}.
 */
function masterCheckText(check: PassedMasterCheck): string {
  return `passed — local ${forwardText(check.local)}; origin ${forwardText(check.remote)}`;
}

/**
 * One ref's passing move as a phrase.
 *
 * @param move - The move.
 * @returns `equal at <current>`, or `forward, <launch> → <current>`; then,
 *   for a move carrying a synced sha (`origin`), `, checked against synced <sha>`.
 */
function forwardText(move: ForwardMove): string {
  const text =
    move.move === 'equal'
      ? `equal at ${move.current}`
      : `forward, ${move.launch} → ${move.current}`;
  return move.synced === null ? text : `${text}, checked against synced ${move.synced}`;
}

/**
 * The main-checkout comparison as a phrase.
 *
 * @param untouched - The comparison; `null` when a read failed.
 * @returns `untouched since pre-flight` for `true`; for `false`, touched
 *   since pre-flight, naming `HEAD` or dirtiness; for `null`, not compared,
 *   a snapshot unread.
 */
function mainCheckoutText(untouched: boolean | null): string {
  if (untouched === null) return 'not compared (a snapshot could not be read)';
  return untouched
    ? 'untouched since pre-flight'
    : 'touched since pre-flight (HEAD or dirtiness changed)';
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
