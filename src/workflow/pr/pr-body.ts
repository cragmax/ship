/**
 * The `ship` workflow's texts that land in git and on GitHub: commit messages, an epic's pull
 * request title and body, fitted to GitHub's limit by moving run-report sections into PR comments
 * ({@link fitPrBody}), and an attached run's PR-body section and run report.
 *
 * **Closing keywords are the workflow's own.** Only this file writes one: `fixes #N`, for a landed
 * issue whose tdd says so, in its commit message and once in a PR body's or attached
 * section's Issues list ({@link landedLine}), never in a run report. Every other issue, the epic
 * container included, is `see #N`, and every text carrying agent- or tool-written words, each
 * moved section included, passes through {@link neutralText}. The body a
 * section is appended to is never neutralised again.
 *
 * Render-safe (`src/build/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

import { CO_AUTHOR_TRAILER } from '../../core/commit-trailer.js';
import { GH_BODY_LIMIT } from '../../core/gh-body-limit.js';
import { parseLeaseLines, type LeaseAggregate, type LeaseTiming } from './lease-timings.js';
import { isPlatformWide, MAX_RELATED_FILES, type PushedChanges } from './push-scope.js';

import type {
  CommitSpec,
  EpicReviewOutput,
  PrWriterOutput,
  ProbeRecord,
  RetroFinding,
  SliceWork,
  TddOutput,
} from '../calls/agent-calls.js';
import type { ReleasedEdge } from '../../core/scheduler/run-scheduler.types.js';
import type { ForwardMove, PassedMasterCheck } from '../epic-end/master-check.js';
import { codeSpan, evidenceBullet, oneLine } from './pr-evidence.js';
import type { OverlapEdge, OverlapRecord, UnsurePair } from '../preflight.js';
import { mergeDangerLines, summaryLines } from './pr-writer-sections.js';
import type { SyncStepResult } from '../epic-end/sync-master-step.js';
import type { BumpOutput, KeptWork } from '../calls/tool-calls.js';

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
interface RoleLeaseLines {
  /** The agent whose lease runs printed them. */
  readonly role: 'tdd' | 'spec-review' | 'test-review' | 'standards-review';
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
      /** How the blocking issue settled without landing, releasing the edge, absent when not. */
      readonly released?: ReleasedEdge['trigger'];
    };

/** A landed slice's size, as the `land` envelope measured its commit. */
export interface SliceSize {
  /** The paths the commit changes. */
  readonly files: number;
  /** The lines it changes: insertions plus deletions over its text files. */
  readonly lines: number;
}

/** One issue's line of an entry's schedule. */
export interface ScheduleEntry {
  /** The issue. */
  readonly issue: number;
  /** Its blockers in the scheduled graph, ascending, each with its source. */
  readonly blockers: readonly ScheduleBlocker[];
  /** How many attempts it took, 0 when it never started. */
  readonly attempts: number;
  /** When its final attempt's slice was cut, `null` when none was. */
  readonly startedAt: string | null;
  /** When its commit landed, `null` unless it landed. */
  readonly committedAt: string | null;
  /** Its landed commit's size, `null` unless it landed. */
  readonly size: SliceSize | null;
  /** Each of its attempts that ended `agent-died`, in order, empty when none did. */
  readonly deaths: readonly AgentDeath[];
}

/** One attempt of an issue that ended `agent-died`. */
export interface AgentDeath {
  /** The attempt's number, 1 for the first. */
  readonly attempt: number;
  /** The stage or runner step that died. */
  readonly stage: string;
  /** Why it counts as dead. */
  readonly cause: string;
}

/** The epic review's part of an epic end. */
export interface EpicReviewReport {
  /** The verdict, `null` when the review returned none and nothing forced one. */
  readonly verdict: EpicReviewOutput['verdict'] | null;
  /** Judged on the landed issues' criteria alone, with no epic's: a list's or attached run's. */
  readonly profiled: boolean;
  /** What forced `rejected` on the verdict: the issues that did not land. */
  readonly forced?: string;
  /** Why the review gave no answer. */
  readonly notRun?: string;
  /** Its answer, `null` when it gave none. */
  readonly answer: EpicReviewOutput | null;
}

/** Everything an epic's pull request body reports. */
export interface PrBodyInput {
  /** The epic, `null` for an explicit list. */
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
  /** The bump, `null` when the runner returned none. */
  readonly bump: BumpOutput | null;
  /** The master check, passed: a failed check opens no PR. */
  readonly masterCheck: PassedMasterCheck;
  /**
   * Whether the main checkout's `HEAD` and dirtiness equal pre-flight's,
   * read before the push, `null` when a read failed.
   */
  readonly mainUntouched: boolean | null;
  /** The epic review's part: it leads the body, and `rejected` or no verdict opens a draft PR. */
  readonly epicReview: EpicReviewReport;
  /** The paths the push changes, which decide the tests pre-push runs on it. */
  readonly pushed: PushedChanges;
  /** The overlap edges pre-flight added to the entry. */
  readonly overlap: OverlapRecord;
  /** Each issue's schedule, in the entry's order. */
  readonly schedule: readonly ScheduleEntry[];
  /** The entry's lease totals. */
  readonly leases: LeaseAggregate;
  /** The retro's findings, `null` when it returned none. */
  readonly retro: readonly RetroFinding[] | null;
  /** The PR writer's answer, `null` when it returned none. */
  readonly writer: PrWriterOutput | null;
}

/**
 * Everything an attached run's section of the open PR's body reports: the
 * PR body's inputs but the PR writer's, which an attached run never runs.
 */
export interface AttachedSectionInput extends Omit<PrBodyInput, 'writer'> {
  /** The attached run's number R (`cut-batch --attached-run`'s). */
  readonly run: number;
  /**
   * The URL of the PR comment carrying the run's report
   * ({@link renderAttachedReport}), `null` when it was not posted.
   */
  readonly reportComment: string | null;
}

/** What a blocked issue's comment says about its run. */
interface BlockedCommentInput {
  /** The issue. */
  readonly issue: number;
  /** Why the run blocked it, as the run report records it, absent when unknown. */
  readonly reason?: string;
  /** The run's pull request, when it opened one. */
  readonly pr?: number;
  /** The run branch. */
  readonly branch: string;
  /** The run's report directory. */
  readonly reportDir: string;
  /** Where the issue's unlanded attempt's work was kept, when any was. */
  readonly kept?: KeptWork;
}

/**
 * The comment an unattended run posts on an issue it blocked
 * (`post-issue-comment`), so the reason sits on the issue the next triage or
 * `/to-tickets` reads.
 *
 * @returns A quote line saying the run changed nothing on the issue; the
 *   reason (`no reason recorded` without one) with every closing keyword
 *   defused ({@link neutralText}); then the run (`PR #N`, or its branch
 *   and `no pull request`) and the kept paths (`Kept: patch …, tdd report …`), or the report
 *   dir when nothing was kept; a trailing newline.
 */
export function renderBlockedComment(input: BlockedCommentInput): string {
  const run =
    input.pr === undefined
      ? `branch \`${input.branch}\`, no pull request`
      : `PR #${String(input.pr)}`;

  return [
    '> *Posted by an unattended `/ship` run. It changed nothing on this issue; the labels stand.*',
    '',
    `**Not landed: blocked.** ${neutralText(input.reason ?? 'no reason recorded')}`,
    '',
    `Run: ${run}. ${whereKept(input)}`,
    '',
  ].join('\n');
}

/**
 * A landed issue's commit message, newline-terminated: the subject line, a blank line, `fixes #N`
 * or `see #N` per its tdd, a blank line, then {@link CO_AUTHOR_TRAILER}.
 */
export function commitMessage(issue: number, tdd: Pick<TddOutput, 'commit' | 'closes'>): string {
  return issueMessage(subjectLine(tdd.commit), `${tdd.closes} #${String(issue)}`);
}

/**
 * The {@link commitMessage} the tdd fills: its subject line `<type>(<scope>): <subject>` and its
 * cite `<fixes|see> #N`, placeholders for the tdd's own answer.
 */
export function commitMessageTemplate(issue: number): string {
  return issueMessage('<type>(<scope>): <subject>', `<fixes|see> #${String(issue)}`);
}

/**
 * An epic's pull request title.
 *
 * @returns The one landed issue's subject line, `<branch>: <n> issues` for several.
 */
export function prTitle(input: Pick<PrBodyInput, 'branch' | 'landed'>): string {
  const [only] = input.landed;
  if (input.landed.length === 1 && only !== undefined) return subjectLine(only.tdd.commit);

  return `${input.branch}: ${String(input.landed.length)} issues`;
}

/** The slice agents' answers that carry lease lines. */
type SliceLeaseWork = Pick<SliceWork, 'tdd' | 'specReview' | 'testReview' | 'standardsReview'>;

/**
 * A slice's lease lines by role: the one reader of each slice agent's `leaseLines`.
 *
 * @returns The tdd's, the spec review's, the test review's, then the standards review's. No
 *   test-review entry when it was skipped. Lines unparsed and unfiltered.
 */
export function sliceLeaseLines(work: SliceLeaseWork): RoleLeaseLines[] {
  const test = work.testReview;

  return [
    { role: 'tdd', lines: work.tdd.leaseLines },
    { role: 'spec-review', lines: work.specReview.leaseLines },
    ...(typeof test === 'string' ? [] : [{ role: 'test-review' as const, lines: test.leaseLines }]),
    { role: 'standards-review', lines: work.standardsReview.leaseLines },
  ];
}

/**
 * An epic's pull request body.
 *
 * @returns Markdown, neutralised whole but for the landed `fixes` issues,
 *   the PR writer's prose included: `## Epic review` per {@link epicReviewLines};
 *   `## Summary` per {@link summaryLines};
 *   `## Evidence` per {@link evidenceList}; `## Merge Danger` per {@link mergeDangerLines};
 *   `## Tests at push` per {@link testsAtPushLines}; `## Issues` per {@link issueListLines};
 *   `## Recorded` per {@link recordedSection}; then the run report per {@link reportBlock}.
 *   Each section per {@link section}.
 */
export function renderPrBody(input: PrBodyInput): string {
  return prBody(input, new Set());
}

/** A run-report section moved out of an over-limit PR body, to be posted as its own PR comment. */
interface MovedSection {
  /** The comment file's name in the report dir (`pr-comment-<section>.md`). */
  readonly file: string;
  /** The section as the whole body renders it, its `## <heading>` line first. */
  readonly text: string;
}

/** A PR body fitted to GitHub's limit, with the sections it moved out. */
interface FittedPrBody {
  /** The body to publish. */
  readonly body: string;
  /** The moved sections, in moving order, none when the body fit whole. */
  readonly comments: readonly MovedSection[];
}

/**
 * An epic's pull request body within GitHub's body limit, as far as moving
 * the run report's bulky sections out reaches.
 *
 * @returns The {@link renderPrBody} body and no comment when it is within
 *   {@link GH_BODY_LIMIT}. Otherwise every movable section with at least one
 *   line moves out (`Overlap edges`, `Unsure overlap pairs`, `Schedule`, and
 *   `Retro findings`, in that order), its lines in the body
 *   replaced by one line naming the limit and the comment's report-dir file.
 *   An empty one stays in the body as `None.`, but for `Unsure overlap pairs`, left out.
 *   A body still over the limit after the move is returned as it is:
 *   `publish` refuses it before the push.
 */
export function fitPrBody(input: PrBodyInput): FittedPrBody {
  const whole = renderPrBody(input);
  if (whole.length <= GH_BODY_LIMIT) return { body: whole, comments: [] };
  const moving = MOVABLE_SECTIONS.filter((m) => m.lines(input).length > 0);
  const closing = closingIssues(input.landed);

  return {
    body: prBody(input, new Set(moving)),
    comments: moving.map((m) => ({
      file: m.file,
      text: neutralText(section(m.heading, m.lines(input)).join('\n'), closing),
    })),
  };
}

/**
 * An attached run's section of the open PR's body, appended after the body already there:
 * markdown, neutralised whole but for this run's landed `fixes` issues. `## Attached run <R>`, a
 * blank line; `### Epic review` per {@link epicReviewLines}; `### Evidence` per
 * {@link evidenceList}; `### Tests at push` per {@link testsAtPushLines}; `### Issues` per
 * {@link issueRefLines}, no container line; `### Recorded`
 * per {@link recordedSection}; then one run-report line and a blank line:
 * `Run report: [PR comment](<url>)` with a `reportComment`, else
 * `Run report: not posted to this PR; it is in <reportDir>.`, the report dir in a code span.
 * No run report, no Summary and no Merge Danger: the report is posted as its own PR comment
 * ({@link renderAttachedReport}), and an attached run has no PR writer.
 */
export function renderAttachedSection(input: AttachedSectionInput): string {
  const report =
    input.reportComment === null
      ? `Run report: not posted to this PR; it is in \`${input.reportDir}\`.`
      : `Run report: [PR comment](${input.reportComment})`;
  const body = [
    `## Attached run ${String(input.run)}`,
    '',
    ...section('Epic review', epicReviewLines(input.epicReview), 3),
    ...section('Evidence', evidenceList(input.landed), 3),
    ...section('Tests at push', testsAtPushLines(input.pushed), 3),
    ...section('Issues', issueRefLines(input), 3),
    ...recordedSection(input.landed, 3),
    report,
    '',
  ].join('\n');

  return neutralText(body, closingIssues(input.landed));
}

/**
 * An attached run's report, posted as one comment on the open PR.
 *
 * @returns The run report per {@link runReportLines}, folded
 *   ({@link foldedReport}, summary `Run report — attached run <R>`), every
 *   closing keyword neutralised, this run's landed `fixes` issues included:
 *   a run report never closes an issue.
 */
export function renderAttachedReport(input: Omit<AttachedSectionInput, 'reportComment'>): string {
  const text = foldedReport(
    `Run report — attached run ${String(input.run)}`,
    runReportLines(input),
  ).join('\n');

  return neutralText(text);
}

function prBody(input: PrBodyInput, moved: ReadonlySet<MovableSection>): string {
  const body = [
    ...section('Epic review', epicReviewLines(input.epicReview)),
    ...section('Summary', summaryLines(input.writer)),
    ...section('Evidence', evidenceList(input.landed)),
    ...section('Merge Danger', mergeDangerLines(input.writer)),
    ...section('Tests at push', testsAtPushLines(input.pushed)),
    ...section('Issues', issueListLines(input)),
    ...recordedSection(input.landed, 2),
    ...reportBlock(input, moved),
  ].join('\n');

  return neutralText(body, closingIssues(input.landed));
}

function issueMessage(subject: string, cite: string): string {
  return [subject, '', cite, '', CO_AUTHOR_TRAILER, ''].join('\n');
}

/**
 * A commit's first line.
 *
 * @returns `<type>(<scope>): <subject>`, neutralised whole.
 */
function subjectLine(commit: CommitSpec): string {
  return neutralText(`${commit.type}(${commit.scope}): ${commit.subject}`);
}

/** The blocked comment's pointer: the kept paths, or the report dir when nothing was kept. */
function whereKept(input: BlockedCommentInput): string {
  const { patch = null, report = null } = input.kept ?? {};
  const parts = [
    ...(patch === null ? [] : [`patch \`${patch}\``]),
    ...(report === null ? [] : [`tdd report \`${report}\``]),
  ];

  return parts.length === 0 ? `Report dir: \`${input.reportDir}\`.` : `Kept: ${parts.join(', ')}.`;
}

/**
 * A text with every closing keyword defused: each `<keyword> <ref>` becomes
 * `<keyword> (see <ref>)`, but for the bare `#N` form of the `closing` issues (none by default).
 */
function neutralText(text: string, closing: ReadonlySet<number> = new Set()): string {
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

/** The Evidence section's lines: one bullet per landed issue, in landing order. */
function evidenceList(landed: readonly LandedIssue[]): string[] {
  return landed.flatMap((l) => evidenceBullet(l.issue, l.tdd.evidence));
}

/**
 * The one line saying what pre-push ran: both tiers in full, naming the
 * Platform-wide paths; else the standalone tier in full past {@link MAX_RELATED_FILES} files, or
 * targeted tests, the server tier left to the nightly; or not known, naming the failed read.
 */
function testsAtPushLines(pushed: PushedChanges): string[] {
  if (pushed.kind === 'unresolved') {
    return [`Not known: the pushed range could not be read (${pushed.why}).`];
  }

  const wide = pushed.paths.filter((path) => isPlatformWide(path));

  if (wide.length > 0) {
    const paths = wide.map((path) => codeSpan(path)).join(', ');

    return [
      `The full standalone and server tiers ran at push: the Platform-wide paths ${paths} changed.`,
    ];
  }

  const nightly = 'the full server tier runs in the next nightly after merge';

  if (pushed.paths.length > MAX_RELATED_FILES) {
    const count = String(pushed.paths.length);

    return [
      `The full standalone tier ran at push: ${count} files changed, past the ${String(MAX_RELATED_FILES)} \`vitest related\` takes; ${nightly}.`,
    ];
  }

  return [`Targeted tests only at push: no Platform-wide path changed; ${nightly}.`];
}

/**
 * Each landed issue's {@link recordedItems}, nested under its `- #N` line, in a `Recorded`
 * section at `depth`. An issue with none is left out, and no lines at all when no issue has any.
 */
function recordedSection(landed: readonly LandedIssue[], depth: 2 | 3): string[] {
  const lines = landed.flatMap((l) => {
    const items = recordedItems(l);

    return items.length === 0
      ? []
      : [`- #${String(l.issue)}`, ...items.map((item) => `  - ${item}`)];
  });

  return lines.length === 0 ? [] : section('Recorded', lines, depth);
}

/**
 * A landed issue's recorded values in the tdd's order, each per {@link oneLine}, blanks dropped,
 * as a {@link codeSpan} so its markdown and mentions render inert (unprobed). Its closing keywords
 * are left to the body's {@link neutralText}.
 */
function recordedItems(landed: LandedIssue): string[] {
  return landed.tdd.recorded
    .map(oneLine)
    .filter((entry) => entry !== '')
    .map(codeSpan);
}

/** The issues a text may close: each landed issue whose tdd says `fixes`. */
function closingIssues(landed: readonly LandedIssue[]): ReadonlySet<number> {
  return new Set(landed.filter((l) => l.tdd.closes === 'fixes').map((l) => l.issue));
}

/**
 * The run report as the body carries it, less the sections {@link fitPrBody} moved out: folded,
 * unless the PR writer returned nothing.
 */
function reportBlock(input: PrBodyInput, moved: ReadonlySet<MovableSection>): string[] {
  const report = runReportLines(input, moved);
  if (input.writer === null) return report;

  return foldedReport('Run report', report);
}

/** A run report folded in `<details>`, `summary` its `<summary>` text. */
function foldedReport(summary: string, lines: readonly string[]): string[] {
  return [`<details><summary>${summary}</summary>`, '', ...lines, '</details>', ''];
}

/**
 * The run report, folded or not per {@link reportBlock}. Always folded in an attached run's report
 * comment ({@link renderAttachedReport}). A section in `moved` keeps only its pointer line
 * ({@link movableSection}).
 */
function runReportLines(
  input: Omit<PrBodyInput, 'writer'>,
  moved: ReadonlySet<MovableSection> = new Set(),
): string[] {
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
    ...movableSection(input, OVERLAP_EDGES_SECTION, moved),
    ...(input.overlap.unsure.length === 0
      ? []
      : movableSection(input, UNSURE_PAIRS_SECTION, moved)),
    ...movableSection(input, SCHEDULE_SECTION, moved),
    ...section('Lease timings', leaseLines(input.leases)),
    ...movableSection(input, RETRO_FINDINGS_SECTION, moved),
  ];
}

/** A run-report section {@link fitPrBody} may move to a PR comment. */
interface MovableSection {
  readonly heading: string;
  /** Its comment file's name in the report dir. */
  readonly file: string;
  readonly lines: (input: Omit<PrBodyInput, 'writer'>) => string[];
}

const OVERLAP_EDGES_SECTION: MovableSection = {
  heading: 'Overlap edges',
  file: 'pr-comment-overlap-edges.md',
  lines: (input) => overlapLines(input.overlap.added),
};

const UNSURE_PAIRS_SECTION: MovableSection = {
  heading: 'Unsure overlap pairs',
  file: 'pr-comment-unsure-overlap-pairs.md',
  lines: (input) => input.overlap.unsure.map(unsurePairLine),
};

const SCHEDULE_SECTION: MovableSection = {
  heading: 'Schedule',
  file: 'pr-comment-schedule.md',
  lines: (input) => input.schedule.map(scheduleLine),
};

const RETRO_FINDINGS_SECTION: MovableSection = {
  heading: 'Retro findings',
  file: 'pr-comment-retro-findings.md',
  lines: (input) => retroLines(input.retro),
};

/** The movable sections, in the order {@link fitPrBody} moves them. */
const MOVABLE_SECTIONS: readonly MovableSection[] = [
  OVERLAP_EDGES_SECTION,
  UNSURE_PAIRS_SECTION,
  SCHEDULE_SECTION,
  RETRO_FINDINGS_SECTION,
];

function movableSection(
  input: Omit<PrBodyInput, 'writer'>,
  movable: MovableSection,
  moved: ReadonlySet<MovableSection>,
): string[] {
  if (!moved.has(movable)) return section(movable.heading, movable.lines(input));
  const limit = String(GH_BODY_LIMIT);
  const path = codeSpan(`${input.reportDir}/${movable.file}`);

  return section(movable.heading, [
    `Moved to a PR comment: the body was over GitHub's ${limit}-character limit. Also in ${path}.`,
  ]);
}

/**
 * The Issues list.
 *
 * @returns The {@link epicLine}, then the {@link issueRefLines}.
 */
function issueListLines(input: Pick<PrBodyInput, 'epic' | 'landed' | 'unlanded'>): string[] {
  return [epicLine(input.epic), ...issueRefLines(input)];
}

/** The Issues list's issue lines: the landed in landing order, then the unlanded in input order. */
function issueRefLines(input: Pick<PrBodyInput, 'landed' | 'unlanded'>): string[] {
  return [...input.landed.map(landedLine), ...input.unlanded.map(unlandedLine)];
}

/**
 * The Issues list's container line.
 *
 * @returns `- Epic: see #E`, or `- An explicit issue list` for `null`.
 */
function epicLine(epic: number | null): string {
  return epic === null ? '- An explicit issue list' : `- Epic: see #${String(epic)}`;
}

/**
 * One landed issue's Issues-list line: `fixes #N` only when its tdd says so, else `see #N` with
 * `(its acceptance needs a human)`. The subject is the tdd's bare one, not `type(scope):`.
 */
function landedLine(landed: LandedIssue): string {
  const ref = `#${String(landed.issue)}`;
  const subject = landed.tdd.commit.subject;

  return landed.tdd.closes === 'fixes'
    ? `- fixes ${ref} — ${subject}`
    : `- see ${ref} — ${subject} (its acceptance needs a human)`;
}

/** One body section, its heading at `depth` (3 in an attached run's). An empty one says `None.`. */
function section(heading: string, lines: readonly string[], depth: 2 | 3 = 2): string[] {
  return [`${'#'.repeat(depth)} ${heading}`, '', ...(lines.length === 0 ? ['None.'] : lines), ''];
}

/**
 * The epic review's verdict line, `(profiled)` beside a profiled one; what forced it and why the
 * review gave no answer; then its answer: its summary, the criteria met of the total, each
 * criterion not met, each finding, each view it could not read.
 */
function epicReviewLines(review: EpicReviewReport): string[] {
  const profiled = review.profiled ? ' (profiled)' : '';
  const { answer } = review;

  return [
    `**Verdict:** ${review.verdict ?? 'not run'}${profiled}`,
    '',
    ...(review.forced === undefined ? [] : [`- Forced rejected: ${review.forced}`]),
    ...(review.notRun === undefined ? [] : [`- Not run: ${review.notRun}`]),
    ...(answer === null ? [] : epicAnswerLines(answer)),
  ];
}

function epicAnswerLines(answer: EpicReviewOutput): string[] {
  const met = answer.criteria.filter((c) => c.state === 'met').length;

  return [
    `- ${answer.summary}`,
    `- Criteria: ${String(met)} of ${String(answer.criteria.length)} met`,
    ...answer.criteria
      .filter((c) => c.state !== 'met')
      .map((c) => `- #${String(c.issue)} ${c.state}: ${c.criterion} — ${c.evidence}`),
    ...answer.findings.map((f) => `- [${f.view}, ${f.severity}] ${f.summary} — ${f.source}`),
    ...answer.unchecked.map((view) => `- Unchecked: ${view}`),
  ];
}

/**
 * One `- #B → #D1, #D2: <reason>` line per group of edges sharing blocker and reason. Groups and
 * dependents in edge order.
 */
function overlapLines(edges: readonly OverlapEdge[]): string[] {
  const groups = new Map<string, { readonly edge: OverlapEdge; readonly dependents: string[] }>();

  for (const edge of edges) {
    const key = JSON.stringify([edge.blocker, edge.reason]);
    const dependent = `#${String(edge.dependent)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { edge, dependents: [dependent] });
    else group.dependents.push(dependent);
  }

  return [...groups.values()].map(
    ({ edge, dependents }) =>
      `- #${String(edge.blocker)} → ${dependents.join(', ')}: ${edge.reason}`,
  );
}

/**
 * `- #A and #B, reported, not ordered; shared <paths>: <reason>`, each path a code span, the
 * `; shared <paths>` part left out when the pair names none.
 */
function unsurePairLine(pair: UnsurePair): string {
  const shared = pair.shared.length === 0 ? '' : `; shared ${pair.shared.map(codeSpan).join(', ')}`;

  return `- #${String(pair.a)} and #${String(pair.b)}, reported, not ordered${shared}: ${oneLine(pair.reason)}`;
}

/**
 * One issue's schedule line: `never` for a missing instant, `none` for no blockers or size, then
 * its deaths when it has any.
 */
function scheduleLine(entry: ScheduleEntry): string {
  const blockers =
    entry.blockers.length === 0 ? 'none' : entry.blockers.map(blockerText).join(', ');
  const size =
    entry.size === null
      ? 'none'
      : `${String(entry.size.files)} files, ${String(entry.size.lines)} lines`;
  const deaths = entry.deaths.map(
    (death) => `attempt ${String(death.attempt)} at ${death.stage} (${oneLine(death.cause)})`,
  );

  return (
    `- #${String(entry.issue)}: blockers ${blockers}; started ${entry.startedAt ?? 'never'}; ` +
    `committed ${entry.committedAt ?? 'never'}; attempts ${String(entry.attempts)}; size ${size}` +
    (deaths.length === 0 ? '' : `; died ${deaths.join(', ')}`)
  );
}

/**
 * `#B (declared)` or `#B (overlap)`, a released edge's parentheses ending `, released: <trigger>`.
 */
function blockerText(blocker: ScheduleBlocker): string {
  if (blocker.source === 'declared') return `#${String(blocker.issue)} (declared)`;
  const released = blocker.released === undefined ? '' : `, released: ${blocker.released}`;

  return `#${String(blocker.issue)} (overlap${released})`;
}

/** The lease totals' lines: per engine, per issue, then each unparsed line. */
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
    ...leases.unparsed.map((u) => `- unparsed (#${String(u.issue)}): ${u.line}`),
  ];
}

/** One line per retro finding, a note line when the retro returned nothing. */
function retroLines(retro: readonly RetroFinding[] | null): string[] {
  if (retro === null) return ['- The retro returned nothing.'];

  return retro.map((f) => `- ${f.title} (${f.kind}): ${f.evidence} — ${f.suggestion}`);
}

/** One landed issue's run-report section. Its Issue line carries no closing keyword. */
function issueSection(landed: LandedIssue): string[] {
  return [
    `### ${subjectLine(landed.tdd.commit)}`,
    '',
    `- Issue: #${String(landed.issue)}, landed as ${landed.commit}`,
    reviewLine('Spec review', landed.specReview),
    reviewLine('Test review', landed.testReview),
    reviewLine('Standards review', landed.standardsReview),
    reviewLine('Script API TSDoc', landed.scriptApiTsdoc),
    `- Lease timings: ${sliceLeaseText(landed)}`,
    ...probeLines(landed.tdd.probes),
    '',
  ];
}

/** One review's line: its verdict and summary, or `skipped` and why when a reason stands in. */
function reviewLine(label: string, out: { verdict: string; summary: string } | string): string {
  return typeof out === 'string'
    ? `- ${label}: skipped — ${out}`
    : `- ${label}: ${out.verdict} — ${out.summary}`;
}

/** A slice's probe lines: one nested line per tdd probe record. */
function probeLines(probes: readonly ProbeRecord[]): string[] {
  if (probes.length === 0) return ['- Probes: no probe needed'];

  return ['- Probes:', ...probes.map(probeLine)];
}

function probeLine(probe: ProbeRecord): string {
  const followUp = probe.followUp === '' ? '' : `; follow-up: ${probe.followUp}`;

  return `  - ${probe.claim}: ${probe.verdict} in ${durationText(probe.seconds)}${followUp}`;
}

/** A probe's measured duration in whole seconds as a phrase: `42s` below 60, `11m 04s` from 60. */
function durationText(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const rest = String(seconds % 60).padStart(2, '0');

  return `${String(Math.floor(seconds / 60))}m ${rest}s`;
}

/**
 * A slice's lease timings as one phrase, by role in {@link sliceLeaseLines} order. A role with no
 * release line is omitted, and the phrase is `none` when no role has one.
 */
function sliceLeaseText(work: SliceLeaseWork): string {
  const parts = sliceLeaseLines(work).flatMap(({ role, lines }) => {
    const timings = parseLeaseLines(lines.join('\n'));

    return timings.length === 0 ? [] : [`${role}: ${leaseText(timings)}`];
  });

  return parts.length === 0 ? 'none' : parts.join('; ');
}

/** At least one parsed release line as one phrase, naming the holder waited on when a line does. */
function leaseText(timings: readonly LeaseTiming[]): string {
  return timings
    .map((t) => {
      const on = t.waitedOn === undefined ? '' : ` on ${t.waitedOn}`;

      return `${t.type}@${t.endpoint} waited ${String(t.waitedSeconds)}s${on}, held ${String(t.heldSeconds)}s`;
    })
    .join('; ');
}

function unlandedLine(issue: UnlandedIssue): string {
  const reason = issue.reason === undefined ? '' : `: ${issue.reason}`;

  return `- see #${String(issue.issue)} — not landed: ${issue.outcome}${reason}`;
}

function masterCheckText(check: PassedMasterCheck): string {
  return `passed — local ${forwardText(check.local)}; origin ${forwardText(check.remote)}`;
}

/** One ref's passing move as a phrase. A move carrying a synced sha (`origin`) names it. */
function forwardText(move: ForwardMove): string {
  const text =
    move.move === 'equal'
      ? `equal at ${move.current}`
      : `forward, ${move.launch} → ${move.current}`;

  return move.synced === null ? text : `${text}, checked against synced ${move.synced}`;
}

/** The main-checkout comparison as a phrase. `null` means a snapshot read failed. */
function mainCheckoutText(untouched: boolean | null): string {
  if (untouched === null) return 'not compared (a snapshot could not be read)';

  return untouched
    ? 'untouched since pre-flight'
    : 'touched since pre-flight (HEAD or dirtiness changed)';
}

/** The bump as one phrase. An `ok` with a `null` commit found the version already at its target. */
function bumpText(bump: BumpOutput | null): string {
  if (bump?.status !== 'ok') return `not applied (${bump?.status ?? 'no result'})`;
  if (bump.commit === null) return `${bump.kind ?? '?'}, already at ${bump.to ?? '?'} — no commit`;

  return `${bump.kind ?? '?'}, ${bump.from ?? '?'} → ${bump.to ?? '?'}`;
}
