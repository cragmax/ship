/**
 * The `ship` workflow's prompt builders, one per stage. A prompt carries
 * values only — the command, the paths, the issues, the caps; each stage's
 * discipline lives in its agent file (`.claude/agents/<agentType>.md`), so
 * a prompt never restates it.
 *
 * Every value sits on its own `Key: value` line, which the agent file names.
 * A text the agent must copy to disk byte for byte goes in a
 * {@link verbatimBlock}; a command line's words are each quoted for bash by
 * {@link shellWord}, so the agent runs the line as given.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

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
}

/** One issue its epic landed earlier in the run, for a later issue's planner. */
export interface PriorSlice {
  /** The issue. */
  readonly issue: number;
  /** Its batch commit. */
  readonly commit: string;
  /** Its plan file. */
  readonly plan: string;
}

/** The planner's values; `apply` mode applies a plan review's findings once. */
export interface PlannerValues {
  /** `plan`: write the plan; `apply`: apply the findings to it. */
  readonly mode: 'plan' | 'apply';
  /** The issue. */
  readonly issue: number;
  /** The attempt, 1 for the first. */
  readonly attempt: number;
  /** The slice worktree, cut from the epic's branch head. */
  readonly slice: string;
  /** The run's report directory. */
  readonly reportDir: string;
  /** The plan file. */
  readonly planPath: string;
  /** The plan review's findings; `apply` mode only. */
  readonly findingsPath?: string;
  /** What the epic landed before this issue, in landing order. */
  readonly priorSlices: readonly PriorSlice[];
}

/** The plan reviewer's values. */
export interface PlanReviewerValues {
  /** The issue. */
  readonly issue: number;
  /** The slice worktree. */
  readonly slice: string;
  /** The plan file. */
  readonly planPath: string;
  /** Where the findings go. */
  readonly findingsPath: string;
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

/** The tdd's values. */
export interface TddValues {
  /** The issue. */
  readonly issue: number;
  /** The attempt. */
  readonly attempt: number;
  /** The slice worktree. */
  readonly slice: string;
  /** The commit the slice was cut at: its one commit's parent. */
  readonly base: string;
  /** The plan file. */
  readonly planPath: string;
  /** The tdd's full report. */
  readonly reportPath: string;
  /** Where the commit message goes; the commit and the landing both read it. */
  readonly messagePath: string;
  /** The commit message. */
  readonly message: string;
  /** The lease command's values. */
  readonly lease: LeaseValues;
}

/** The reviewer's and the test reviewer's values. */
export interface SliceReviewValues {
  /** The issue. */
  readonly issue: number;
  /** The slice worktree. */
  readonly slice: string;
  /** The plan file. */
  readonly planPath: string;
  /** The slice's one commit. */
  readonly sha: string;
  /** Its changed paths. */
  readonly files: readonly string[];
  /** The full report. */
  readonly reportPath: string;
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
 *
 * @param title - The value's name.
 * @param file - The file and its content.
 * @returns The block's lines.
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
 * An issue's number as prompts spell it.
 *
 * @param issue - The issue.
 * @returns `#<issue>`.
 */
function issueRef(issue: number): string {
  return `#${String(issue)}`;
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
      `Live runs (JSON): ${JSON.stringify(values.liveRuns)}`,
    ].join('\n'),
  planner: (values: PlannerValues): string =>
    [
      `Mode: ${values.mode}`,
      `Issue: ${issueRef(values.issue)}`,
      `Attempt: ${String(values.attempt)}`,
      `Slice worktree: ${values.slice}`,
      `Report dir: ${values.reportDir}`,
      `Plan file: ${values.planPath}`,
      ...(values.findingsPath === undefined ? [] : [`Findings file: ${values.findingsPath}`]),
      `Prior slices (JSON): ${JSON.stringify(values.priorSlices)}`,
    ].join('\n'),
  planReviewer: (values: PlanReviewerValues): string =>
    [
      `Issue: ${issueRef(values.issue)}`,
      `Slice worktree: ${values.slice}`,
      `Plan file: ${values.planPath}`,
      `Findings file: ${values.findingsPath}`,
    ].join('\n'),
  tdd: (values: TddValues): string =>
    [
      `Issue: ${issueRef(values.issue)}`,
      `Attempt: ${String(values.attempt)}`,
      `Slice worktree: ${values.slice}`,
      `Slice base: ${values.base}`,
      `Plan file: ${values.planPath}`,
      `Report file: ${values.reportPath}`,
      `Lease command: ${leaseCommand(values.lease)}`,
      `Lease version: the version of the chosen type's entry in ${values.lease.registry}`,
      `Probe caps: ${String(PROBE_CAP_MINUTES)} min per probe, ${String(PROBES_PER_ISSUE)} probes per issue`,
      ...verbatimBlock('Commit message file', {
        path: values.messagePath,
        content: values.message,
      }),
    ].join('\n'),
  reviewer: (values: SliceReviewValues): string =>
    ['Mode: review', sliceReviewPrompt(values)].join('\n'),
  testReview: (values: SliceReviewValues): string => sliceReviewPrompt(values),
  resolver: (values: ResolverValues): string =>
    [
      'Mode: resolve',
      `Batch worktree: ${values.batch}`,
      `Pending paths: ${values.pending.join(', ')}`,
      `Report file: ${values.reportPath}`,
    ].join('\n'),
};

/**
 * The prompt of a stage that reviews the slice's commit and may amend it.
 *
 * @param values - The slice's values.
 * @returns The prompt.
 */
function sliceReviewPrompt(values: SliceReviewValues): string {
  return [
    `Issue: ${issueRef(values.issue)}`,
    `Slice worktree: ${values.slice}`,
    `Plan file: ${values.planPath}`,
    `Slice commit: ${values.sha}`,
    `Changed files: ${values.files.join(', ')}`,
    `Report file: ${values.reportPath}`,
  ].join('\n');
}
