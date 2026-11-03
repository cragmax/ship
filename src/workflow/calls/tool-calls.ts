/**
 * The saved workflows' tooling calls: each runs one repo CLI command through the `runner` agent,
 * which writes the full envelope into a fresh directory of its own under the call's
 * {@link ToolPlace}, so concurrent launches and repeated calls never share one, and returns only
 * the fields the workflow consumes, per the command's {@link TOOL_SCHEMAS} row.
 *
 * **Types.** Each output type is shallow-`Partial`, required fields included: a command
 * that exits 2 prints no verdict, one that threw or failed its envelope
 * schema prints only the base fields (`src/cli/worktree.ts`
 * `runWorktreeCli`), so a reader treats a missing field as a failure,
 * never as a pass.
 *
 * Render-safe (`src/build/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect. The zod sources are imported for types only.
 */

import type { z } from 'zod';

import type { GateVerdict, IssueCheck } from '../../core/gate/run-gate.js';
import type { TOOL_ENVELOPES } from '../../schemas/tool-envelopes.js';

import type { JsonSchema, WorkflowHooks } from '../runtime.types.js';
import { PROMPTS, shellWord, type FileToWrite } from './prompts.js';
import { TOOL_ENVELOPE_SCHEMAS } from '../schemas.generated.js';
import { agentOptions } from '../stages.js';

/** A tooling command the workflow runs. */
export type ToolName =
  | 'preflight'
  | 'run-gate'
  | 'live-runs'
  | 'check'
  | 'comment-only'
  | 'cut-batch'
  | 'provision-batch'
  | 'cut-slice'
  | 'provision'
  | 'land'
  | 'teardown'
  | 'retire-run'
  | 'sync-master'
  | 'bump'
  | 'check-master'
  | 'publish'
  | 'append-pr-body'
  | 'post-pr-comment'
  | 'post-issue-comment'
  | 'changed-files';

/** A worktree-CLI command the workflow runs: every tool but the run gate's and comment-only's. */
export type WorktreeToolName = Exclude<ToolName, 'run-gate' | 'check' | 'comment-only'>;

/** Where the runner writes pre-cut envelopes, relative to the main checkout (gitignored). */
const TOOL_ENVELOPE_DIR = 'reports/tool';

/** Where one call's envelope goes, and what it carries besides the command. */
export interface ToolPlace {
  /** The directory the runner makes the call's envelope directory in. */
  readonly dir: string;
  /**
   * What tells this call from the tool's other calls, `[a-z0-9-]` only
   * (`7-1`, `paper`): the label becomes `runner:<tool>:<tag>`.
   */
  readonly tag?: string;
  /** The files the command or a later one reads, written by the runner before it runs. */
  readonly write?: readonly FileToWrite[];
}

/**
 * The place of every call before the run is cut: under {@link TOOL_ENVELOPE_DIR} in the main
 * checkout.
 */
const PRE_CUT: ToolPlace = { dir: TOOL_ENVELOPE_DIR };

/** A {@link PRE_CUT} place with a tag. */
export function preCutPlace(tag: string): ToolPlace {
  return { ...PRE_CUT, tag };
}

/** A cut run, as {@link runPlace} places its calls. */
export interface RunAt {
  /** The run's report directory. */
  readonly reportDir: string;
}

/**
 * The place of a call once its run is cut: under the run's report directory.
 *
 * @returns `<reportDir>/tool`, the tag and the files.
 */
export function runPlace(at: RunAt, tag: string, ...write: FileToWrite[]): ToolPlace {
  return { dir: `${at.reportDir}/tool`, tag, ...(write.length === 0 ? {} : { write }) };
}

/** Fields every tool output carries. */
interface ToolBase {
  /** The command's exit code. */
  readonly exitCode: number;
  /** The full envelope on disk. */
  readonly envelopePath: string;
  /** The last lines of stderr, present only on exit 2. */
  readonly stderrTail?: string;
}

/** A worktree tool's output: the base and its envelope's consumed fields, each possibly absent. */
type EnvelopeOutput<N extends WorktreeToolName> = ToolBase &
  Partial<z.infer<(typeof TOOL_ENVELOPES)[N]>>;

/** `preflight`'s consumed fields. */
export type PreflightOutput = EnvelopeOutput<'preflight'>;

/** `run-gate epics|issues`'s consumed fields. */
export type GateOutput = ToolBase &
  Partial<Pick<GateVerdict, 'verdict' | 'failures' | 'excluded' | 'runSet' | 'edges'>>;

/** `live-runs`'s consumed fields. */
export type LiveRunsOutput = EnvelopeOutput<'live-runs'>;

/** One live run as `live-runs`' output carries it. */
export type LiveRunOutput = NonNullable<LiveRunsOutput['runs']>[number];

/** `run-gate check N`'s consumed fields. */
export type CheckOutput = ToolBase & Partial<Pick<IssueCheck, 'ready' | 'failures'>>;

/** `comment-only --json`'s consumed fields. */
export type CommentOnlyOutput = ToolBase & {
  /** Every changed non-TypeScript file. */
  readonly notCompared?: readonly string[];
};

/** `cut-batch`'s consumed fields. */
export type CutBatchOutput = EnvelopeOutput<'cut-batch'>;

/** `provision-batch`'s consumed fields. */
export type ProvisionBatchOutput = EnvelopeOutput<'provision-batch'>;

/** `cut-slice`'s consumed fields. */
export type CutSliceOutput = EnvelopeOutput<'cut-slice'>;

/** `provision`'s consumed fields. */
export type ProvisionOutput = EnvelopeOutput<'provision'>;

/** `land`'s consumed fields. */
export type LandOutput = EnvelopeOutput<'land'>;

/** `teardown`'s consumed fields. */
export type TeardownOutput = EnvelopeOutput<'teardown'>;

/** The paths a teardown kept a slice's work at, `null` for each it did not write. */
export type KeptWork = NonNullable<TeardownOutput['kept']>;

/** `retire-run`'s consumed fields. */
export type RetireRunOutput = EnvelopeOutput<'retire-run'>;

/** `sync-master`'s consumed fields. */
export type SyncMasterOutput = EnvelopeOutput<'sync-master'>;

/** `bump`'s consumed fields. */
export type BumpOutput = EnvelopeOutput<'bump'>;

/** `check-master`'s consumed fields. */
export type CheckMasterOutput = EnvelopeOutput<'check-master'>;

/** `publish`'s consumed fields. */
export type PublishOutput = EnvelopeOutput<'publish'>;

/** `append-pr-body`'s consumed fields. */
export type AppendPrBodyOutput = EnvelopeOutput<'append-pr-body'>;

/** `post-pr-comment`'s consumed fields. */
export type PostPrCommentOutput = EnvelopeOutput<'post-pr-comment'>;

/** `post-issue-comment`'s consumed fields. */
export type PostIssueCommentOutput = EnvelopeOutput<'post-issue-comment'>;

/** `changed-files`' consumed fields. */
export type ChangedFilesOutput = EnvelopeOutput<'changed-files'>;

/** Each tool's output type. */
export interface ToolOutputs {
  preflight: PreflightOutput;
  'run-gate': GateOutput;
  'live-runs': LiveRunsOutput;
  check: CheckOutput;
  'comment-only': CommentOnlyOutput;
  'cut-batch': CutBatchOutput;
  'provision-batch': ProvisionBatchOutput;
  'cut-slice': CutSliceOutput;
  provision: ProvisionOutput;
  land: LandOutput;
  teardown: TeardownOutput;
  'retire-run': RetireRunOutput;
  'sync-master': SyncMasterOutput;
  bump: BumpOutput;
  'check-master': CheckMasterOutput;
  publish: PublishOutput;
  'append-pr-body': AppendPrBodyOutput;
  'post-pr-comment': PostPrCommentOutput;
  'post-issue-comment': PostIssueCommentOutput;
  'changed-files': ChangedFilesOutput;
}

/** The worktree CLI's entry, relative to the main checkout: the installed package's build. */
const WORKTREE_CLI = 'node_modules/@cragmax/ship/dist/cli/worktree.js';

/** The run gate's entry, relative to the main checkout: the installed package's build. */
const RUN_GATE_CLI = 'node_modules/@cragmax/ship/dist/cli/run-gate.js';

/** The comment-only proof's entry, relative to the main checkout: the consumer's own command. */
const COMMENT_ONLY_CLI = 'tooling/git/comment-only.ts';

/** Each tool's command words before its arguments, as {@link toolWords} launches them. */
export const TOOL_COMMANDS: Readonly<Record<ToolName, readonly string[]>> = {
  preflight: [WORKTREE_CLI, 'preflight'],
  'run-gate': [RUN_GATE_CLI],
  'live-runs': [WORKTREE_CLI, 'live-runs'],
  check: [RUN_GATE_CLI, 'check'],
  'comment-only': [COMMENT_ONLY_CLI, '--json'],
  'cut-batch': [WORKTREE_CLI, 'cut-batch'],
  'provision-batch': [WORKTREE_CLI, 'provision-batch'],
  'cut-slice': [WORKTREE_CLI, 'cut-slice'],
  provision: [WORKTREE_CLI, 'provision'],
  land: [WORKTREE_CLI, 'land'],
  teardown: [WORKTREE_CLI, 'teardown'],
  'retire-run': [WORKTREE_CLI, 'retire-run'],
  'sync-master': [WORKTREE_CLI, 'sync-master'],
  bump: [WORKTREE_CLI, 'bump'],
  'check-master': [WORKTREE_CLI, 'check-master'],
  publish: [WORKTREE_CLI, 'publish'],
  'append-pr-body': [WORKTREE_CLI, 'append-pr-body'],
  'post-pr-comment': [WORKTREE_CLI, 'post-pr-comment'],
  'post-issue-comment': [WORKTREE_CLI, 'post-issue-comment'],
  'changed-files': [WORKTREE_CLI, 'changed-files'],
};

/** A string property's schema. */
const STRING = { type: 'string' } as const;
/** An integer property's schema. */
const INTEGER = { type: 'integer' } as const;
/** An integer-array property's schema. */
const INTEGERS = { type: 'array', items: INTEGER } as const;
/** A boolean property's schema. */
const BOOLEAN = { type: 'boolean' } as const;

/** A run graph: `runSet` entries and `edges`. */
const RUN_GRAPH = {
  runSet: {
    type: 'array',
    items: {
      type: 'object',
      properties: { epic: { type: ['integer', 'null'] }, issues: INTEGERS },
      required: ['epic', 'issues'],
    },
  },
  edges: {
    type: 'array',
    items: {
      type: 'object',
      properties: { blocker: INTEGER, dependent: INTEGER },
      required: ['blocker', 'dependent'],
    },
  },
} as const;

/**
 * Each tool's output schema: only what the workflow reads. A worktree tool's row is
 * `schemas.generated.ts`' emission of its pick in `src/schemas/tool-envelopes.ts`,
 * the one source of the consumed fields, their schema and their type, and of which are required,
 * plus the runner's own fields ({@link toolSchema}). The `run-gate` and `check` rows are
 * hand-written from `src/core/gate/run-gate.ts`' types: every consumed field required,
 * save those a failure or exclusion kind may lack. The `comment-only` row is hand-written from
 * the `--json` object `tooling/git/comment-only.ts` prints, its consumed field required.
 */
export const TOOL_SCHEMAS: Readonly<Record<ToolName, JsonSchema>> = {
  preflight: envelopeSchema('preflight'),
  'run-gate': toolSchema({
    properties: {
      verdict: { type: 'string', enum: ['ok', 'refused'] },
      // `issue` is absent on the run-level failure kinds.
      failures: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kind: STRING, issue: INTEGER, message: STRING },
          required: ['kind', 'message'],
        },
      },
      excluded: {
        type: 'array',
        items: {
          type: 'object',
          properties: { issue: INTEGER, cause: STRING, blockers: INTEGERS },
          required: ['issue', 'cause'],
        },
      },
      ...RUN_GRAPH,
    },
    required: ['verdict', 'failures', 'excluded', 'runSet', 'edges'],
  }),
  'live-runs': envelopeSchema('live-runs'),
  check: toolSchema({
    properties: {
      ready: BOOLEAN,
      failures: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kind: STRING, issue: INTEGER, message: STRING },
          required: ['kind', 'issue', 'message'],
        },
      },
    },
    required: ['ready', 'failures'],
  }),
  'comment-only': toolSchema({
    properties: { notCompared: { type: 'array', items: STRING } },
    required: ['notCompared'],
  }),
  'cut-batch': envelopeSchema('cut-batch'),
  'provision-batch': envelopeSchema('provision-batch'),
  'cut-slice': envelopeSchema('cut-slice'),
  provision: envelopeSchema('provision'),
  land: envelopeSchema('land'),
  teardown: envelopeSchema('teardown'),
  'retire-run': envelopeSchema('retire-run'),
  'sync-master': envelopeSchema('sync-master'),
  bump: envelopeSchema('bump'),
  'check-master': envelopeSchema('check-master'),
  publish: envelopeSchema('publish'),
  'append-pr-body': envelopeSchema('append-pr-body'),
  'post-pr-comment': envelopeSchema('post-pr-comment'),
  'post-issue-comment': envelopeSchema('post-issue-comment'),
  'changed-files': envelopeSchema('changed-files'),
};

/**
 * Run one tooling command through the runner.
 *
 * @param argv - The command words after {@link TOOL_COMMANDS}'s, unquoted.
 * @param place - Where the envelope goes, the call's tag, and a file to
 *   write first. Default {@link PRE_CUT}.
 * @returns Resolves to the consumed fields, `null` when the runner returned none.
 */
export async function runTool<N extends ToolName>(
  hooks: WorkflowHooks,
  name: N,
  argv: readonly string[],
  place: ToolPlace = PRE_CUT,
): Promise<ToolOutputs[N] | null> {
  const prompt = PROMPTS.runner({
    argv: toolWords(name, argv),
    envelopeDir: place.dir,
    envelopeName: place.tag === undefined ? name : `${name}-${place.tag}`,
    ...(place.write === undefined ? {} : { write: place.write }),
  });
  const out = await hooks.agent(
    prompt,
    agentOptions(
      'runner',
      place.tag === undefined ? name : `${name}:${place.tag}`,
      TOOL_SCHEMAS[name],
    ),
  );

  return typeof out === 'object' && out !== null ? (out as ToolOutputs[N]) : null;
}

/** The word a {@link toolCommandLine} leaves unquoted, for a person to fill: the PR's number. */
export const PR_PLACEHOLDER = '<pr>';

/**
 * A tool call's command line, as {@link runTool}'s runner runs it: each word quoted for bash, but
 * {@link PR_PLACEHOLDER}.
 */
export function toolCommandLine(name: ToolName, argv: readonly string[]): string {
  return toolWords(name, argv)
    .map((word) => (word === PR_PLACEHOLDER ? word : shellWord(word)))
    .join(' ');
}

/**
 * One line naming a worktree-CLI tool's non-`ok` outcome: how every stage
 * reports a tool that let it down (pre-flight's refusals, whose outputs may
 * carry no `status`, word theirs apart).
 *
 * @param out - Its output, `null` when the runner returned none.
 * @returns `<tool> <status>[ (<reason>)]: <first error or stderr tail>`.
 */
export function envelopeProblem(
  tool: string,
  out: {
    readonly status?: string;
    readonly reason?: string;
    readonly errors?: readonly { readonly message: string }[];
    readonly stderrTail?: string;
  } | null,
): string {
  if (out === null) return `the runner returned nothing for ${tool}`;
  const reason = out.reason === undefined ? '' : ` (${out.reason})`;
  const detail = out.errors?.[0]?.message ?? out.stderrTail ?? 'no error named';

  return `${tool} ${out.status ?? 'without a status'}${reason}: ${detail}`;
}

/**
 * A tool call's command words, as the runner runs them from the main checkout: `node --import tsx`,
 * never `npx tsx`, whose Git Bash shim orphans the tool from the session's process tree.
 */
function toolWords(name: ToolName, argv: readonly string[]): string[] {
  return ['node', '--import', 'tsx', ...TOOL_COMMANDS[name], ...argv];
}

/** A worktree tool's schema: {@link toolSchema} over its emitted row. */
function envelopeSchema(name: WorktreeToolName): JsonSchema {
  return toolSchema(TOOL_ENVELOPE_SCHEMAS[name]);
}

/**
 * A tool output's schema: the runner's fields (`exitCode` and
 * `envelopePath` required, `stderrTail` not) plus the tool's consumed
 * fields, their `required` kept.
 */
function toolSchema(consumed: {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
}): JsonSchema {
  return {
    type: 'object',
    properties: {
      exitCode: INTEGER,
      envelopePath: STRING,
      stderrTail: { type: 'string', description: 'the last 20 lines of stderr; only on exit 2' },
      ...consumed.properties,
    },
    required: ['exitCode', 'envelopePath', ...consumed.required],
  };
}
