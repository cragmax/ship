/**
 * The `ship` workflow's prompt builders, one per stage. A prompt carries
 * values only — the command, the paths, the issues, the caps; each stage's
 * discipline lives in its agent file (`.claude/agents/<agentType>.md`), so
 * a prompt never restates it.
 *
 * Every value sits on its own `Key: value` line. The keys an agent's builders emit, with
 * the `Checkout:` line {@link withCheckout} adds, are exactly those its agent file's
 * `## Inputs (from the prompt)` lists, no more and no fewer. A text the agent must copy to
 * disk byte for byte goes in a {@link verbatimBlock}; a command line's words are each quoted
 * for bash by {@link shellWord}, so the agent runs the line as given. An issue's text reaches
 * an agent as a file its `Issue command:` line writes ({@link issueLines}).
 *
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { RunEdge, RunSet } from '../../core/run-set.js';

import type { WorkflowHooks } from '../runtime.types.js';
import { PROBE_CAP_MINUTES, PROBES_PER_STAGE } from '../stages.js';

/** A live run's changed files, for `issue-overlap`'s judgment. */
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

/** The runner's values: one command, where its envelope goes, and the files to write first. */
interface RunnerValues {
  /** The command words, run from the main checkout, unquoted: the builder quotes each. */
  readonly argv: readonly string[];
  /**
   * The directory the runner makes the call's fresh envelope directory in;
   * a relative one resolves against the main checkout.
   */
  readonly envelopeDir: string;
  /** The envelope's file-name stem, `[a-z0-9-]` only: `<name>.json`, `.err` and `.exit`. */
  readonly envelopeName: string;
  /** The files the command or a later one reads, written before it runs, in order. */
  readonly write?: readonly FileToWrite[];
}

/** `issue-readiness`'s values: the run set, and an attached run's PR head. */
export interface IssueReadinessValues {
  /** The run-set issues, ascending. */
  readonly issues: readonly number[];
  /**
   * An attached run's open PR head (`origin/ship/<slug>`), the tree it judges; absent
   * otherwise.
   */
  readonly prHead?: string;
}

/** `issue-overlap`'s values: the run set, its declared edges and the live runs. */
export interface IssueOverlapValues {
  /** The run set, drops applied. */
  readonly runSet: RunSet;
  /** Its declared edges. */
  readonly edges: readonly RunEdge[];
  /** The unspent live runs — those whose files the run could still collide with. */
  readonly liveRuns: readonly LiveRunFiles[];
  /**
   * An attached run's open PR head (`origin/ship/<slug>`), the tree it judges; absent
   * otherwise.
   */
  readonly prHead?: string;
}

/** One issue its epic landed, as the PR writer is handed it. */
export interface LandedSlice {
  /** The issue. */
  readonly issue: number;
  /** Its batch commit. */
  readonly commit: string;
}

/** Where a slice's lease runs lease from. */
export interface LeaseValues {
  /** The main checkout, whose `with-lease` and `tooling/integration/run-integration.ts` run. */
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
  /** Where the attempt's work and report are kept should it not land. */
  readonly keptDir: string;
  /** Where the commit message goes; the commit and the landing both read it. */
  readonly messagePath: string;
  /** The commit message, its first line and closing keyword left as placeholders. */
  readonly messageTemplate: string;
  /** The lease command's values. */
  readonly lease: LeaseValues;
}

/** A slice's one commit, as the test review is handed it: no changed paths. */
export interface SliceHeadValues {
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
}

/** A slice's one commit, as the stages after the tdd but the test review are handed it. */
export interface SliceCommitValues extends SliceHeadValues {
  /** Its changed paths. */
  readonly files: readonly string[];
}

/** A slice review's values: the slice's, and where its server-tier runs lease from. */
export interface SliceReviewValues extends SliceCommitValues {
  /** The full report. */
  readonly reportPath: string;
  /** The lease command's values. */
  readonly lease: LeaseValues;
}

/**
 * The test review's values: a slice review's but the changed paths, so the agent pins its own diff
 * from the slice base.
 */
export type TestReviewValues = Omit<SliceReviewValues, 'files'>;

/** The Script API TSDoc review's values: the slice's, and where its report goes. */
export interface ScriptApiTsdocValues extends SliceCommitValues {
  /** The full report. */
  readonly reportPath: string;
}

/** An issue of the run that did not land, as the epic review is handed it. */
export interface UnlandedValues {
  /** The issue. */
  readonly issue: number;
  /** How it ended. */
  readonly outcome: string;
  /** Why, when known. */
  readonly reason?: string;
}

/** `PROMPTS.epicReview`'s input: the run's landed change, once the last slice has landed. */
export interface EpicReviewValues {
  /** The batch worktree, before the `origin/master` merge and the bump. */
  readonly batch: string;
  /** The run's landed range, `<batch base>..HEAD`. */
  readonly range: string;
  /** The entry's epic; `null` for an explicit list, whose verdict is profiled. */
  readonly epic: number | null;
  /** The landed issues, in landing order: their texts are under the report dir. */
  readonly issues: readonly number[];
  /** Every other issue of the entry. */
  readonly unlanded: readonly UnlandedValues[];
  /** The landed slices' review reports. */
  readonly sliceReports: readonly string[];
  /** The run's report directory. */
  readonly reportDir: string;
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

/**
 * Hooks bound to the run's main checkout: every agent prompt, runner and judgment stage alike,
 * starts with a `Checkout: <checkout>` line, so an agent works from it, never from its start
 * directory, which a session `cd` moves mid-run (PF-94). A run binds once, from its first call's
 * envelope; only that call runs unbound.
 *
 * @param checkout - The main checkout, absolute.
 */
export function withCheckout(hooks: WorkflowHooks, checkout: string): WorkflowHooks {
  return {
    ...hooks,
    agent: (prompt, options) => hooks.agent(`Checkout: ${checkout}\n${prompt}`, options),
  };
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

/** The vitest config a slice worktree's server-tier runs use. */
const WORKTREE_INTEGRATION_CONFIG = 'vitest.worktree.integration.config.ts';

/** `npx tsx` running the main checkout's repo-relative `tool` on the slice's project, registry. */
function mainToolPrefix(lease: LeaseValues, tool: string): string[] {
  return [
    `PH_PROJECT_DIR=${shellWord(lease.projectDir)}`,
    `PH_POOL_REGISTRY=${shellWord(lease.registry)}`,
    'npx tsx',
    shellWord(`${lease.main}/${tool}`),
  ];
}

/**
 * The lease command template a slice's server-tier runs use.
 *
 * @param lease - Its values.
 * @returns The command, `<angle>` placeholders for the agent to fill.
 */
function leaseCommand(lease: LeaseValues): string {
  return [
    ...mainToolPrefix(lease, 'server-pool/src/with-lease.ts'),
    '--type <paper|folia> --version <version>',
    `--registry ${shellWord(lease.registry)}`,
    `--timeout 600000 -- npx vitest run --config ${WORKTREE_INTEGRATION_CONFIG} <files>`,
  ].join(' ');
}

/**
 * The command a slice's full server-tier run uses: the main checkout's pool runner over the run's
 * registry, every shard of both engines at once under `with-lease`, nothing stood up.
 *
 * @param lease - Its values.
 */
function fullServerTierCommand(lease: LeaseValues): string {
  return [
    ...mainToolPrefix(lease, 'tooling/integration/run-integration.ts'),
    `pool --no-standup --config ${WORKTREE_INTEGRATION_CONFIG}`,
  ].join(' ');
}

/**
 * A slice's server-tier recipe: the lease command template, where its
 * version comes from, the full server-tier command, and the probe caps.
 */
function serverTierLines(lease: LeaseValues): string[] {
  return [
    `Lease command: ${leaseCommand(lease)}`,
    `Lease version: the version of the chosen type's entry in ${lease.registry}`,
    `Full server tier: ${fullServerTierCommand(lease)}`,
    `Probe caps: ${String(PROBE_CAP_MINUTES)} min per probe, ${String(PROBES_PER_STAGE)} probes per stage`,
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
 * `key` names the two lines (`<key> file:`, `<key> command:`).
 */
function issueLines(issue: number, reportDir: string, key = 'Issue'): string[] {
  const dir = `${reportDir}/issues`;
  const file = issueFile(issue, reportDir);
  return [
    `${key} file: ${file}`,
    [
      `${key} command: mkdir -p ${shellWord(dir)} &&`,
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
      ...(values.write ?? []).flatMap((file) => verbatimBlock('Write first', file)),
    ].join('\n'),
  issueReadiness: (values: IssueReadinessValues): string =>
    [
      `Run-set issues: ${values.issues.map(issueRef).join(', ')}`,
      ...(values.prHead === undefined ? [] : [`PR head: ${values.prHead}`]),
    ].join('\n'),
  issueOverlap: (values: IssueOverlapValues): string =>
    [
      `Run set (JSON): ${JSON.stringify(values.runSet)}`,
      `Declared edges (JSON): ${JSON.stringify(values.edges)}`,
      `Live runs (JSON): ${JSON.stringify(values.liveRuns)}`,
      ...(values.prHead === undefined ? [] : [`PR head: ${values.prHead}`]),
    ].join('\n'),
  tdd: (values: TddValues): string =>
    [
      `Issue: ${issueRef(values.issue)}`,
      `Attempt: ${String(values.attempt)}`,
      `Slice worktree: ${values.slice}`,
      `Slice base: ${values.base}`,
      ...issueLines(values.issue, values.reportDir),
      `Report file: ${values.reportPath}`,
      `Kept dir: ${values.keptDir}`,
      ...serverTierLines(values.lease),
      ...verbatimBlock('Commit message template', {
        path: values.messagePath,
        content: values.messageTemplate,
      }),
    ].join('\n'),
  specReview: (values: SliceReviewValues): string => sliceReviewPrompt(values),
  testReview: (values: TestReviewValues): string =>
    [
      ...sliceHeadLines(values),
      `Issue file: ${issueFile(values.issue, values.reportDir)}`,
      `Report file: ${values.reportPath}`,
      ...serverTierLines(values.lease),
    ].join('\n'),
  standardsReview: (values: SliceReviewValues): string => sliceReviewPrompt(values),
  scriptApiTsdoc: (values: ScriptApiTsdocValues): string =>
    [...sliceCommitLines(values), `Report file: ${values.reportPath}`].join('\n'),
  resolver: (values: ResolverValues): string =>
    [
      `Batch worktree: ${values.batch}`,
      `Pending paths: ${values.pending.join(', ')}`,
      `Report file: ${values.reportPath}`,
    ].join('\n'),
  epicReview: (values: EpicReviewValues): string =>
    [
      `Batch worktree: ${values.batch}`,
      `Epic range: ${values.range}`,
      ...(values.epic === null
        ? ['Scope: profiled']
        : [
            `Scope: epic ${issueRef(values.epic)}`,
            ...issueLines(values.epic, values.reportDir, 'Epic'),
          ]),
      `Issue files: ${values.issues.map((issue) => issueFile(issue, values.reportDir)).join(', ')}`,
      `Unlanded (JSON): ${JSON.stringify(values.unlanded)}`,
      `Slice reports: ${values.sliceReports.join(', ')}`,
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

function sliceHeadLines(values: SliceHeadValues): string[] {
  return [
    `Issue: ${issueRef(values.issue)}`,
    `Slice worktree: ${values.slice}`,
    `Slice base: ${values.base}`,
    `Slice commit: ${values.sha}`,
  ];
}

function sliceCommitLines(values: SliceCommitValues): string[] {
  return [...sliceHeadLines(values), `Changed files: ${values.files.join(', ')}`];
}

/** The prompt of a stage that reviews the slice's commit and may amend it. */
function sliceReviewPrompt(values: SliceReviewValues): string {
  return [
    ...sliceCommitLines(values),
    `Issue file: ${issueFile(values.issue, values.reportDir)}`,
    `Report file: ${values.reportPath}`,
    ...serverTierLines(values.lease),
  ].join('\n');
}
