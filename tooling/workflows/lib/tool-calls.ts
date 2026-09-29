/**
 * The `ship` workflow's tooling calls: each runs one repo CLI command
 * through the `runner` agent, which writes the full envelope under
 * {@link TOOL_ENVELOPE_DIR} and returns only the fields the workflow
 * consumes, per the command's {@link TOOL_SCHEMAS} row. The shapes are the
 * CLIs' own envelopes (`tooling/worktree/types*.ts`, `tooling/lib/run-gate.ts`),
 * narrowed; every consumed field is optional in the output, since a command
 * that exits 2 prints no verdict.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { GateVerdict } from '../../lib/run-gate.js';
import type { LiveRun, LiveRunsResult } from '../../worktree/types.js';
import type { PreflightResult } from '../../worktree/types-run.js';

import type { JsonSchema, WorkflowHooks } from './hooks.types.js';
import { PROMPTS } from './prompts.js';
import { agentOptions } from './stages.js';

/** A tooling command the workflow runs. */
export type ToolName = 'preflight' | 'run-gate' | 'live-runs';

/** Where the runner writes envelopes, relative to the main checkout (gitignored). */
export const TOOL_ENVELOPE_DIR = 'reports/tool';

/** Fields every tool output carries. */
interface ToolBase {
  /** The command's exit code. */
  readonly exitCode: number;
  /** The full envelope on disk. */
  readonly envelopePath: string;
  /** The last lines of stderr; present only on exit 2. */
  readonly stderrTail?: string;
}

/** `preflight`'s consumed fields. */
export type PreflightOutput = ToolBase &
  Partial<
    Pick<PreflightResult, 'status' | 'reason' | 'errors' | 'worktree' | 'snapshot' | 'problems'>
  >;

/** `run-gate epics|issues`'s consumed fields. */
export type GateOutput = ToolBase &
  Partial<Pick<GateVerdict, 'verdict' | 'failures' | 'excluded' | 'runSet' | 'edges'>>;

/** `live-runs`'s consumed fields. */
export type LiveRunsOutput = ToolBase &
  Partial<Pick<LiveRunsResult, 'status' | 'reason' | 'errors'>> & {
    /** Each live run, narrowed. */
    readonly runs?: readonly Pick<LiveRun, 'branch' | 'landed' | 'pr' | 'spent'>[];
  };

/** Each tool's output type. */
interface ToolOutputs {
  preflight: PreflightOutput;
  'run-gate': GateOutput;
  'live-runs': LiveRunsOutput;
}

/** Each tool's command words before its arguments, run with `npx tsx` from the main checkout. */
export const TOOL_COMMANDS: Readonly<Record<ToolName, readonly string[]>> = {
  preflight: ['tooling/worktree.ts', 'preflight'],
  'run-gate': ['tooling/run-gate.ts'],
  'live-runs': ['tooling/worktree.ts', 'live-runs'],
};

const STRING = { type: 'string' } as const;
const INTEGER = { type: 'integer' } as const;
const INTEGERS = { type: 'array', items: INTEGER } as const;
const STRINGS = { type: 'array', items: STRING } as const;

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

/** Each tool's output schema: only what the workflow reads. */
export const TOOL_SCHEMAS: Readonly<Record<ToolName, JsonSchema>> = {
  preflight: toolSchema({
    ...WORKTREE_STATUS,
    worktree: STRING,
    snapshot: {
      type: ['object', 'null'],
      properties: { head: STRING, dirty: { type: 'boolean' } },
    },
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
  'live-runs': toolSchema({
    ...WORKTREE_STATUS,
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
          spent: { type: 'boolean' },
        },
        required: ['branch', 'landed', 'pr', 'spent'],
      },
    },
  }),
};

/**
 * Run one tooling command through the runner.
 *
 * @param hooks - The workflow hooks.
 * @param name - The tool.
 * @param argv - The command words after {@link TOOL_COMMANDS}'s.
 * @returns Resolves to the consumed fields; `null` when the runner returned none.
 */
export async function runTool<N extends ToolName>(
  hooks: WorkflowHooks,
  name: N,
  argv: readonly string[],
): Promise<ToolOutputs[N] | null> {
  const prompt = PROMPTS.runner({
    argv: ['npx', 'tsx', ...TOOL_COMMANDS[name], ...argv],
    envelopeStem: `${TOOL_ENVELOPE_DIR}/${name}`,
  });
  const out = await hooks.agent(prompt, agentOptions('runner', name, TOOL_SCHEMAS[name]));
  return typeof out === 'object' && out !== null ? (out as ToolOutputs[N]) : null;
}
