/**
 * The `ship` workflow's prompt builders, one per stage. A prompt carries
 * values only — the command, the paths, the issues, the caps; each stage's
 * discipline lives in its agent file (`.claude/agents/<agentType>.md`), so
 * a prompt never restates it.
 *
 * Every value sits on its own `Key: value` line. The keys an agent's
 * builders emit are exactly those its agent file's `## Inputs (from the prompt)` lists,
 * no more and no fewer. A text the agent must copy to disk byte for byte goes in a
 * {@link verbatimBlock}; a command line's words are each quoted for bash by
 * {@link shellWord}, so the agent runs the line as given. An issue's text
 * reaches an agent as a file its `Issue command:` line writes ({@link issueLines}).
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { RunEdge, RunSet } from '../../lib/run-set.js';

import { PROBE_CAP_MINUTES, PROBES_PER_ISSUE } from './stages.js';

/** A live run's changed files, for the scout's overlap judgment. */
export interface LiveRunFiles {
  /** The run branch, e.g. `ship/epic-1025`. */
  readonly branch: string;
  /** The paths it changed since its merge-base, repository-relative. */
  readonly landed: readonly string[];
}

/** A file an agent writes, verbatim, before its work. */
export interface FileToWrite {
  /** The file, absolute. */
  readonly path: string;
  /** Its whole content. */
  readonly content: string;
}

/** The runner's values: one command, where its envelope goes, and a file to write first. */
export interface RunnerValues {
  /** The command words, run from the main checkout, unquoted: the builder quotes each. */
  readonly argv: readonly string[];
  /**
   * The directory the runner makes the call's fresh envelope directory in;
   * a relative one resolves against the main checkout.
   */
  readonly envelopeDir: string;
  /** The envelope's file-name stem, `[a-z0-9-]` only: `<name>.json`, `.err` and `.exit`. */
  readonly envelopeName: string;
  /** A file the command reads, written before it runs. */
  readonly write?: FileToWrite;
}

/** The scout's values: the run set and the live runs. */
export interface ScoutValues {
  /** The run-set issues, ascending. */
  readonly issues: readonly number[];
  /** The unspent live runs — those whose files the run could still collide with. */
  readonly liveRuns: readonly LiveRunFiles[];
  /**
   * An attached run's open PR head (`origin/ship/<slug>`), the tree the scout judges; absent
   * otherwise.
   */
  readonly prHead?: string;
}

/** The overlap estimator's values: the run set and its declared edges. */
export interface OverlapValues {
  /** The run set, drops applied. */
  readonly runSet: RunSet;
  /** Its declared edges. */
  readonly edges: readonly RunEdge[];
}

/** One issue its epic landed, as the critic and the PR writer are handed it. */
export interface LandedSlice {
  /** The issue. */
  readonly issue: number;
  /** Its batch commit. */
  readonly commit: string;
}

/** Where a slice's lease runs lease from. */
export interface LeaseValues {
  /** The main checkout, whose `tooling/with-lease.ts` runs. */
  readonly main: string;
  /** `PH_PROJECT_DIR` for the lease run: the slice provision's. */
  readonly projectDir: string;
  /** The run's trimmed pool registry. */
  readonly registry: string;
}

/** `PROMPTS.tdd`'s input: the slice, its issue, and the message template its one commit fills. */
export interface TddValues {
  /** The issue. */
  readonly issue: number;
  /** The attempt. */
  readonly attempt: number;
  /** The slice worktree. */
  readonly slice: string;
  /** The commit the slice was cut at: its one commit's parent. */
  readonly base: string;
  /** The run's report directory: the issue's text is written under it. */
  readonly reportDir: string;
  /** The tdd's full report. */
  readonly reportPath: string;
  /** Where the commit message goes; the commit and the landing both read it. */
  readonly messagePath: string;
  /** The commit message, its first line and closing keyword left as placeholders. */
  readonly messageTemplate: string;
  /** The lease command's values. */
  readonly lease: LeaseValues;
}

/** A slice's one commit, as the stages after the tdd are handed it. */
export interface SliceCommitValues {
  /** The issue. */
  readonly issue: number;
  /** The slice worktree. */
  readonly slice: string;
  /** The commit the slice was cut at: its one commit's parent. */
  readonly base: string;
  /** The run's report directory: the issue's text is under it. */
  readonly reportDir: string;
  /** The slice's one commit. */
  readonly sha: string;
  /** Its changed paths. */
  readonly files: readonly string[];
}

/** The diff reviewer's values: the slice's commit and where its findings go. */
export interface DiffReviewValues extends SliceCommitValues {
  /** Where the findings go; the reviewer reads them. */
  readonly findingsPath: string;
}

/**
 * The reviewer's and the test reviewer's values: the slice's, and where its
 * server-tier runs lease from.
 */
export interface SliceReviewValues extends SliceCommitValues {
  /** The full report. */
  readonly reportPath: string;
  /** The lease command's values. */
  readonly lease: LeaseValues;
}

/** The Manifest TSDoc review's values: the slice's, and where its report goes. */
export interface ManifestTsdocValues extends SliceCommitValues {
  /** The full report. */
  readonly reportPath: string;
}

/** The reviewer's values: the slice's, and the diff review's findings. */
export interface ReviewerValues extends SliceReviewValues {
  /** The diff review's findings file. */
  readonly findingsPath: string;
}

/** `PROMPTS.critic`'s input: the epic's landed range, reviewed in a slice of its own. */
export interface CriticValues {
  /** The critic's slice worktree, cut from the batch head. */
  readonly slice: string;
  /** The epic's landed range, `<batch base>..HEAD`. */
  readonly range: string;
  /** Each landed issue and its commit, in landing order. */
  readonly landed: readonly LandedSlice[];
  /** The full report. */
  readonly reportPath: string;
}

/** `PROMPTS.retro`'s input: the entry's run report so far. */
export interface RetroValues {
  /** The entry's epic; `null` for an explicit list. */
  readonly epic: number | null;
  /** The run's report directory. */
  readonly reportDir: string;
  /** The entry's run report so far, JSON-serialisable. */
  readonly report: unknown;
}

/** One issue the epic landed, as the PR writer is handed it. */
export interface PrWriterLanded extends LandedSlice {
  /** Its commit subject: the tdd's bare subject, not its `type(scope):` line. */
  readonly subject: string;
}

/** `PROMPTS.prWriter`'s input: the PR's net diff and the issues it lands. */
export interface PrWriterValues {
  /** The entry's epic; `null` for an explicit list. */
  readonly epic: number | null;
  /** The batch worktree, at the head the PR pushes. */
  readonly batch: string;
  /** The PR's net diff, `<base>...HEAD`. */
  readonly range: string;
  /** Each landed issue, in landing order. */
  readonly landed: readonly PrWriterLanded[];
  /** The run's report directory. */
  readonly reportDir: string;
}

/** The doc-index resolver's values. */
export interface ResolverValues {
  /** The batch worktree, its `origin/master` merge in progress. */
  readonly batch: string;
  /** The doc-index paths still unmerged. */
  readonly pending: readonly string[];
  /** The full report. */
  readonly reportPath: string;
}

/** A word bash reads as itself unquoted. */
const PLAIN_WORD = /^[\w./:@%+=,-]+$/;

/**
 * One command word, quoted for bash when it needs it.
 *
 * @param word - The word, unquoted.
 * @returns The word itself when it holds only safe characters; otherwise
 *   the word in single quotes, each `'` spelled `'\''`.
 */
export function shellWord(word: string): string {
  return PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * A text to copy to disk byte for byte: `<title>: <path>`, then the text's
 * lines between a begin and an end marker line. The file holds those lines,
 * each ending in a newline.
 */
function verbatimBlock(title: string, file: FileToWrite): string[] {
  const body = file.content.endsWith('\n') ? file.content.slice(0, -1) : file.content;
  return [`${title}: ${file.path}`, '----- BEGIN FILE -----', body, '----- END FILE -----'];
}

/**
 * The lease command template a slice's server-tier runs use.
 *
 * @param lease - Its values.
 * @returns The command, `<angle>` placeholders for the agent to fill.
 */
function leaseCommand(lease: LeaseValues): string {
  return [
    `PH_PROJECT_DIR=${shellWord(lease.projectDir)}`,
    `PH_POOL_REGISTRY=${shellWord(lease.registry)}`,
    'npx tsx',
    shellWord(`${lease.main}/tooling/with-lease.ts`),
    '--type <paper|folia> --version <version>',
    `--registry ${shellWord(lease.registry)}`,
    '--timeout 600000 -- npx vitest run --config vitest.worktree.integration.config.ts <files>',
  ].join(' ');
}

/**
 * A slice's server-tier recipe: the lease command template, where its
 * version comes from, and the probe caps.
 */
function serverTierLines(lease: LeaseValues): string[] {
  return [
    `Lease command: ${leaseCommand(lease)}`,
    `Lease version: the version of the chosen type's entry in ${lease.registry}`,
    `Probe caps: ${String(PROBE_CAP_MINUTES)} min per probe, ${String(PROBES_PER_ISSUE)} probes per issue`,
  ];
}

/**
 * The jq program that prints an issue as markdown: a `# <title>` line, the
 * state and labels, the body, then each comment under a
 * `----- comment by <login> at <instant> -----` line. It holds no `'`, so
 * {@link shellWord} quotes it whole.
 */
const ISSUE_TEXT_JQ =
  '"# \\(.title)", "state: \\(.state)", "labels: \\([.labels[].name] | join(", "))", "", .body, ' +
  '(.comments[] | "", "----- comment by \\(.author.login) at \\(.createdAt) -----", .body)';

/** Where an issue's text goes: `<reportDir>/issues/<issue>.md`. */
function issueFile(issue: number, reportDir: string): string {
  return `${reportDir}/issues/${String(issue)}.md`;
}

/**
 * Where an issue's text goes and the command that writes it there — so the
 * agent reads the issue from a file, never from `gh` output in its context.
 */
function issueLines(issue: number, reportDir: string): string[] {
  const dir = `${reportDir}/issues`;
  const file = issueFile(issue, reportDir);
  return [
    `Issue file: ${file}`,
    [
      `Issue command: mkdir -p ${shellWord(dir)} &&`,
      `gh issue view ${String(issue)} --json title,state,labels,body,comments`,
      `--jq ${shellWord(ISSUE_TEXT_JQ)} > ${shellWord(file)}`,
    ].join(' '),
  ];
}

/** An issue's number as prompts spell it. */
function issueRef(issue: number): string {
  return `#${String(issue)}`;
}

/**
 * An entry's epic as the epic-end prompts spell it.
 *
 * @param epic - The epic; `null` for an explicit list.
 * @returns `an explicit issue list` for `null`, else `#<epic>`.
 */
function epicLabel(epic: number | null): string {
  return epic === null ? 'an explicit issue list' : issueRef(epic);
}

/** Every stage's prompt builder. */
export const PROMPTS = {
  runner: (values: RunnerValues): string =>
    [
      `Command: ${values.argv.map(shellWord).join(' ')}`,
      `Envelope dir: ${values.envelopeDir}`,
      `Envelope name: ${values.envelopeName}`,
      ...(values.write === undefined ? [] : verbatimBlock('Write first', values.write)),
    ].join('\n'),
  scout: (values: ScoutValues): string =>
    [
      `Run-set issues: ${values.issues.map(issueRef).join(', ')}`,
      ...(values.prHead === undefined ? [] : [`PR head: ${values.prHead}`]),
      `Live runs (JSON): ${JSON.stringify(values.liveRuns)}`,
    ].join('\n'),
  overlapEstimator: (values: OverlapValues): string =>
    [
      `Run set (JSON): ${JSON.stringify(values.runSet)}`,
      `Declared edges (JSON): ${JSON.stringify(values.edges)}`,
    ].join('\n'),
  tdd: (values: TddValues): string =>
    [
      `Issue: ${issueRef(values.issue)}`,
      `Attempt: ${String(values.attempt)}`,
      `Slice worktree: ${values.slice}`,
      `Slice base: ${values.base}`,
      ...issueLines(values.issue, values.reportDir),
      `Report file: ${values.reportPath}`,
      ...serverTierLines(values.lease),
      ...verbatimBlock('Commit message template', {
        path: values.messagePath,
        content: values.messageTemplate,
      }),
    ].join('\n'),
  diffReview: (values: DiffReviewValues): string =>
    [
      ...sliceCommitLines(values),
      `Findings file: ${values.findingsPath}`,
      ...issueLines(values.issue, values.reportDir),
    ].join('\n'),
  reviewer: (values: ReviewerValues): string => sliceReviewPrompt(values, values.findingsPath),
  manifestTsdoc: (values: ManifestTsdocValues): string =>
    [...sliceCommitLines(values), `Report file: ${values.reportPath}`].join('\n'),
  testReview: (values: SliceReviewValues): string => sliceReviewPrompt(values),
  resolver: (values: ResolverValues): string =>
    [
      `Batch worktree: ${values.batch}`,
      `Pending paths: ${values.pending.join(', ')}`,
      `Report file: ${values.reportPath}`,
    ].join('\n'),
  critic: (values: CriticValues): string =>
    [
      `Critic slice: ${values.slice}`,
      `Epic range: ${values.range}`,
      `Landed (JSON): ${JSON.stringify(values.landed)}`,
      `Report file: ${values.reportPath}`,
    ].join('\n'),
  retro: (values: RetroValues): string =>
    [
      `Epic: ${epicLabel(values.epic)}`,
      `Report dir: ${values.reportDir}`,
      `Run report (JSON): ${JSON.stringify(values.report)}`,
    ].join('\n'),
  prWriter: (values: PrWriterValues): string =>
    [
      `Epic: ${epicLabel(values.epic)}`,
      `Batch worktree: ${values.batch}`,
      `Diff range: ${values.range}`,
      `Landed (JSON): ${JSON.stringify(values.landed)}`,
      `Report dir: ${values.reportDir}`,
    ].join('\n'),
};

function sliceCommitLines(values: SliceCommitValues): string[] {
  return [
    `Issue: ${issueRef(values.issue)}`,
    `Slice worktree: ${values.slice}`,
    `Slice base: ${values.base}`,
    `Slice commit: ${values.sha}`,
    `Changed files: ${values.files.join(', ')}`,
  ];
}

/**
 * The prompt of a stage that reviews the slice's commit and may amend it.
 *
 * @param findingsPath - The diff review's findings file; the reviewer's only.
 */
function sliceReviewPrompt(values: SliceReviewValues, findingsPath?: string): string {
  return [
    ...sliceCommitLines(values),
    `Issue file: ${issueFile(values.issue, values.reportDir)}`,
    `Report file: ${values.reportPath}`,
    ...(findingsPath === undefined ? [] : [`Findings file: ${findingsPath}`]),
    ...serverTierLines(values.lease),
  ].join('\n');
}
