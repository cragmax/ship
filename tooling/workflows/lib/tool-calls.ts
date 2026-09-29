/**
 * The `ship` workflow's tooling calls: each runs one repo CLI command
 * through the `runner` agent, which writes the full envelope into a fresh
 * directory of its own under the call's {@link ToolPlace} and returns only
 * the fields the workflow consumes, per the command's {@link TOOL_SCHEMAS}
 * row. The shapes are the CLIs' own envelopes (`tooling/worktree/types*.ts`,
 * `tooling/lib/run-gate.ts`), narrowed; every consumed field is optional in
 * the output, since a command that exits 2 prints no verdict — a reader
 * treats a missing field as a failure, never as a pass.
 *
 * **Envelope places.** A call before the run is cut writes under
 * {@link TOOL_ENVELOPE_DIR} in the main checkout ({@link PRE_CUT}); every
 * later call writes under its run's report directory. Either way the runner
 * makes each call's directory unique, so concurrent launches and repeated
 * calls never share an envelope file.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { GateVerdict, IssueCheck } from '../../lib/run-gate.js';
import type {
  LiveRun,
  ProvisionBatchResult,
  ProvisionResult,
  ResultBase,
  TeardownResult,
} from '../../worktree/types.js';
import type {
  BumpResult,
  CutBatchResult,
  CutSliceResult,
  LandResult,
  PreflightResult,
  PublishResult,
  ServerTierResult,
  SyncMasterResult,
} from '../../worktree/types-run.js';

import type { JsonSchema, WorkflowHooks } from './hooks.types.js';
import { PROMPTS, type FileToWrite } from './prompts.js';
import { agentOptions } from './stages.js';

/** A tooling command the workflow runs. */
export type ToolName =
  | 'preflight'
  | 'run-gate'
  | 'live-runs'
  | 'check'
  | 'cut-batch'
  | 'provision-batch'
  | 'cut-slice'
  | 'provision'
  | 'land'
  | 'teardown'
  | 'server-tier'
  | 'sync-master'
  | 'bump'
  | 'publish';

/** Where the runner writes pre-cut envelopes, relative to the main checkout (gitignored). */
export const TOOL_ENVELOPE_DIR = 'reports/tool';

/** Where one call's envelope goes, and what it carries besides the command. */
export interface ToolPlace {
  /** The directory the runner makes the call's envelope directory in. */
  readonly dir: string;
  /**
   * What tells this call from the tool's other calls, `[a-z0-9-]` only
   * (`7-1`, `paper`): the label becomes `runner:<tool>:<tag>`.
   */
  readonly tag?: string;
  /** A file the command reads, written by the runner before it runs. */
  readonly write?: FileToWrite;
}

/** The place of every call before the run is cut. */
export const PRE_CUT: ToolPlace = { dir: TOOL_ENVELOPE_DIR };

/**
 * The place of a call once its run is cut: under the run's report directory.
 *
 * @param reportDir - The run's report directory.
 * @param tag - The call's {@link ToolPlace.tag}.
 * @param write - A file to write first.
 * @returns `<reportDir>/tool`, the tag and the file.
 */
export function runPlace(reportDir: string, tag: string, write?: FileToWrite): ToolPlace {
  return { dir: `${reportDir}/tool`, tag, ...(write === undefined ? {} : { write }) };
}

/** Fields every tool output carries. */
interface ToolBase {
  /** The command's exit code. */
  readonly exitCode: number;
  /** The full envelope on disk. */
  readonly envelopePath: string;
  /** The last lines of stderr; present only on exit 2. */
  readonly stderrTail?: string;
}

/** The worktree CLI's `status`, `reason` and `errors`. */
type WorktreeStatus = Partial<Pick<ResultBase, 'status' | 'reason' | 'errors'>>;

/** A worktree-CLI tool's output: the base, the status, and `K` of its envelope `R`. */
type WorktreeOutput<R, K extends keyof R> = ToolBase & WorktreeStatus & Partial<Pick<R, K>>;

/** `preflight`'s consumed fields. */
export type PreflightOutput = WorktreeOutput<PreflightResult, 'worktree' | 'snapshot' | 'problems'>;

/** `run-gate epics|issues`'s consumed fields. */
export type GateOutput = ToolBase &
  Partial<Pick<GateVerdict, 'verdict' | 'failures' | 'excluded' | 'runSet' | 'edges'>>;

/** `live-runs`'s consumed fields. */
export type LiveRunsOutput = ToolBase &
  WorktreeStatus & {
    /** Each live run, narrowed. */
    readonly runs?: readonly Pick<LiveRun, 'branch' | 'landed' | 'pr' | 'spent'>[];
  };

/** `run-gate check N`'s consumed fields. */
export type CheckOutput = ToolBase & Partial<Pick<IssueCheck, 'ready' | 'failures'>>;

/** `cut-batch`'s consumed fields. */
export type CutBatchOutput = WorktreeOutput<
  CutBatchResult,
  'worktree' | 'branch' | 'base' | 'batch' | 'reportDir'
>;

/** `provision-batch`'s consumed fields. */
export type ProvisionBatchOutput = WorktreeOutput<ProvisionBatchResult, 'registry' | 'env'>;

/** `cut-slice`'s consumed fields. */
export type CutSliceOutput = WorktreeOutput<CutSliceResult, 'branch' | 'base' | 'slice'>;

/** `provision`'s consumed fields. */
export type ProvisionOutput = WorktreeOutput<ProvisionResult, 'env'>;

/** `land`'s consumed fields. */
export type LandOutput = WorktreeOutput<
  LandResult,
  'commit' | 'files' | 'conflicts' | 'rolledBack' | 'batchClean'
>;

/** `teardown`'s consumed fields. */
export type TeardownOutput = WorktreeOutput<TeardownResult, 'removed' | 'registered'>;

/** `server-tier`'s consumed fields. */
export type ServerTierOutput = WorktreeOutput<ServerTierResult, 'engine' | 'tests' | 'lease'>;

/** `sync-master`'s consumed fields. */
export type SyncMasterOutput = WorktreeOutput<
  SyncMasterResult,
  'outcome' | 'commit' | 'conflicts' | 'pending'
>;

/** `bump`'s consumed fields. */
export type BumpOutput = WorktreeOutput<BumpResult, 'kind' | 'from' | 'to' | 'commit'>;

/** `publish`'s consumed fields. */
export type PublishOutput = WorktreeOutput<PublishResult, 'pushed' | 'pr'>;

/** Each tool's output type. */
interface ToolOutputs {
  preflight: PreflightOutput;
  'run-gate': GateOutput;
  'live-runs': LiveRunsOutput;
  check: CheckOutput;
  'cut-batch': CutBatchOutput;
  'provision-batch': ProvisionBatchOutput;
  'cut-slice': CutSliceOutput;
  provision: ProvisionOutput;
  land: LandOutput;
  teardown: TeardownOutput;
  'server-tier': ServerTierOutput;
  'sync-master': SyncMasterOutput;
  bump: BumpOutput;
  publish: PublishOutput;
}

/** The worktree CLI's entry, relative to the main checkout. */
const WORKTREE_CLI = 'tooling/worktree.ts';

/** The run gate's entry, relative to the main checkout. */
const RUN_GATE_CLI = 'tooling/run-gate.ts';

/** Each tool's command words before its arguments, run with `npx tsx` from the main checkout. */
export const TOOL_COMMANDS: Readonly<Record<ToolName, readonly string[]>> = {
  preflight: [WORKTREE_CLI, 'preflight'],
  'run-gate': [RUN_GATE_CLI],
  'live-runs': [WORKTREE_CLI, 'live-runs'],
  check: [RUN_GATE_CLI, 'check'],
  'cut-batch': [WORKTREE_CLI, 'cut-batch'],
  'provision-batch': [WORKTREE_CLI, 'provision-batch'],
  'cut-slice': [WORKTREE_CLI, 'cut-slice'],
  provision: [WORKTREE_CLI, 'provision'],
  land: [WORKTREE_CLI, 'land'],
  teardown: [WORKTREE_CLI, 'teardown'],
  'server-tier': [WORKTREE_CLI, 'server-tier'],
  'sync-master': [WORKTREE_CLI, 'sync-master'],
  bump: [WORKTREE_CLI, 'bump'],
  publish: [WORKTREE_CLI, 'publish'],
};

/** A string property's schema. */
export const STRING = { type: 'string' } as const;
/** An integer property's schema. */
export const INTEGER = { type: 'integer' } as const;
/** An integer-array property's schema. */
export const INTEGERS = { type: 'array', items: INTEGER } as const;
/** A string-array property's schema. */
export const STRINGS = { type: 'array', items: STRING } as const;
/** A boolean property's schema. */
export const BOOLEAN = { type: 'boolean' } as const;
/** A string-or-null property's schema. */
const NULLABLE_STRING = { type: ['string', 'null'] } as const;

/** The worktree CLI's `status`, `reason` and `errors`. */
const WORKTREE_STATUS = {
  status: { type: 'string', enum: ['ok', 'failed', 'refused', 'conflict'] },
  reason: STRING,
  errors: {
    type: 'array',
    items: {
      type: 'object',
      properties: { step: STRING, message: STRING },
      required: ['step', 'message'],
    },
  },
} as const;

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
 * An object property's schema.
 *
 * @param properties - Its properties' schemas.
 * @param required - Its required keys.
 * @returns The schema, `null` allowed.
 */
function nullableObject(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): JsonSchema {
  return { type: ['object', 'null'], properties, required };
}

/**
 * A tool output's schema: the base fields plus the tool's consumed fields.
 *
 * @param consumed - The consumed fields' property schemas.
 * @returns The schema.
 */
function toolSchema(consumed: Readonly<Record<string, unknown>>): JsonSchema {
  return {
    type: 'object',
    properties: {
      exitCode: INTEGER,
      envelopePath: STRING,
      stderrTail: { type: 'string', description: 'the last 20 lines of stderr; only on exit 2' },
      ...consumed,
    },
    required: ['exitCode', 'envelopePath'],
  };
}

/**
 * A worktree-CLI tool's schema: {@link toolSchema} with the CLI's status fields.
 *
 * @param consumed - The tool's own consumed fields.
 * @returns The schema.
 */
function worktreeSchema(consumed: Readonly<Record<string, unknown>>): JsonSchema {
  return toolSchema({ ...WORKTREE_STATUS, ...consumed });
}

/** Each tool's output schema: only what the workflow reads. */
export const TOOL_SCHEMAS: Readonly<Record<ToolName, JsonSchema>> = {
  preflight: worktreeSchema({
    worktree: STRING,
    snapshot: nullableObject({ head: STRING, dirty: BOOLEAN }, ['head', 'dirty']),
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: { check: STRING, message: STRING },
        required: ['check', 'message'],
      },
    },
  }),
  'run-gate': toolSchema({
    verdict: { type: 'string', enum: ['ok', 'refused'] },
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
  }),
  'live-runs': worktreeSchema({
    runs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          branch: STRING,
          landed: STRINGS,
          pr: {
            type: 'object',
            properties: { state: STRING, number: { type: ['integer', 'null'] } },
            required: ['state'],
          },
          spent: BOOLEAN,
        },
        required: ['branch', 'landed', 'pr', 'spent'],
      },
    },
  }),
  check: toolSchema({
    ready: BOOLEAN,
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: STRING, issue: INTEGER, message: STRING },
        required: ['kind', 'message'],
      },
    },
  }),
  'cut-batch': worktreeSchema({
    worktree: STRING,
    branch: NULLABLE_STRING,
    base: NULLABLE_STRING,
    batch: NULLABLE_STRING,
    reportDir: NULLABLE_STRING,
  }),
  'provision-batch': worktreeSchema({
    registry: NULLABLE_STRING,
    env: nullableObject({ PH_PROJECT_DIR: STRING, PH_POOL_REGISTRY: STRING }, [
      'PH_PROJECT_DIR',
      'PH_POOL_REGISTRY',
    ]),
  }),
  'cut-slice': worktreeSchema({
    branch: NULLABLE_STRING,
    base: NULLABLE_STRING,
    slice: NULLABLE_STRING,
  }),
  provision: worktreeSchema({
    env: nullableObject({ PH_PROJECT_DIR: STRING }, ['PH_PROJECT_DIR']),
  }),
  land: worktreeSchema({
    commit: NULLABLE_STRING,
    files: STRINGS,
    conflicts: STRINGS,
    rolledBack: BOOLEAN,
    batchClean: BOOLEAN,
  }),
  teardown: worktreeSchema({ removed: BOOLEAN, registered: BOOLEAN }),
  'server-tier': worktreeSchema({
    engine: { type: 'string', enum: ['paper', 'folia'] },
    tests: nullableObject({ passed: INTEGER, failed: INTEGER, skipped: INTEGER }, [
      'passed',
      'failed',
      'skipped',
    ]),
    lease: nullableObject(
      {
        type: STRING,
        endpoint: STRING,
        waitedSeconds: { type: 'number' },
        heldSeconds: { type: 'number' },
      },
      ['type', 'endpoint', 'waitedSeconds', 'heldSeconds'],
    ),
  }),
  'sync-master': worktreeSchema({
    outcome: { type: ['string', 'null'], enum: ['up-to-date', 'merged', 'needs-resolution', null] },
    commit: NULLABLE_STRING,
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: STRING, kind: STRING, landedBy: STRINGS },
        required: ['path', 'kind'],
      },
    },
    pending: STRINGS,
  }),
  bump: worktreeSchema({
    kind: { type: ['string', 'null'], enum: ['minor', 'patch', null] },
    from: NULLABLE_STRING,
    to: NULLABLE_STRING,
    commit: NULLABLE_STRING,
  }),
  publish: worktreeSchema({
    pushed: BOOLEAN,
    pr: nullableObject({ number: INTEGER, url: STRING }, ['number', 'url']),
  }),
};

/**
 * Run one tooling command through the runner.
 *
 * @param hooks - The workflow hooks.
 * @param name - The tool.
 * @param argv - The command words after {@link TOOL_COMMANDS}'s, unquoted.
 * @param place - Where the envelope goes, the call's tag and a file to
 *   write first; default {@link PRE_CUT}.
 * @returns Resolves to the consumed fields; `null` when the runner returned none.
 */
export async function runTool<N extends ToolName>(
  hooks: WorkflowHooks,
  name: N,
  argv: readonly string[],
  place: ToolPlace = PRE_CUT,
): Promise<ToolOutputs[N] | null> {
  const prompt = PROMPTS.runner({
    argv: ['npx', 'tsx', ...TOOL_COMMANDS[name], ...argv],
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
