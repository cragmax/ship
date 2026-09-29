/**
 * Fake workflow hooks for driving `runShip` in vitest: `agent()` answers from
 * a label-keyed response table and records every call; `parallel` and
 * `pipeline` run their work in order, so a recorded call sequence is
 * deterministic.
 */

import type { AgentOptions, WorkflowHooks } from '../../../../tooling/workflows/lib/hooks.types.js';

/** One recorded `agent()` call. */
export interface RecordedCall {
  /** The call's label. */
  readonly label: string;
  /** Its `agentType`, `undefined` when not given. */
  readonly agentType: string | undefined;
  /** Its `model`, `undefined` when not given. */
  readonly model: string | undefined;
  /** Its `effort`, `undefined` when not given. */
  readonly effort: string | undefined;
  /** The command words after `npx tsx` on the prompt's `Command:` line; `[]` without one. */
  readonly argv: readonly string[];
  /** The prompt. */
  readonly prompt: string;
}

/** A fake run: the hooks to pass, and what they recorded. */
export interface FakeRun {
  /** The hooks. */
  readonly hooks: WorkflowHooks;
  /** Every `agent()` call, in call order. */
  readonly calls: RecordedCall[];
  /** Every `phase()` title, in call order. */
  readonly phases: string[];
}

/** An `ok` pre-flight: master level, `gh` logged in, the warm set answering. */
export const PREFLIGHT_OK = {
  exitCode: 0,
  envelopePath: 'reports/tool/preflight.json',
  status: 'ok',
  worktree: 'C:/src/main',
  snapshot: { head: 'abc123', dirty: false },
  problems: [],
  errors: [],
};

/** An `ok` gate over the one-issue explicit run of #7. */
export const GATE_OK = {
  exitCode: 0,
  envelopePath: 'reports/tool/run-gate.json',
  verdict: 'ok',
  failures: [],
  excluded: [],
  runSet: [{ epic: null, issues: [7] }],
  edges: [],
};

/** No live run. */
export const LIVE_RUNS_NONE = {
  exitCode: 0,
  envelopePath: 'reports/tool/live-runs.json',
  status: 'ok',
  runs: [],
  errors: [],
};

/** #7 fresh, no overlap. */
export const SCOUT_FRESH = {
  issues: [{ issue: 7, stale: false, evidence: 'every named symbol present' }],
  overlaps: [],
};

/**
 * Build fake hooks answering each label from `responses` over the all-pass
 * defaults; an unknown label answers `null`, as a dead agent does.
 *
 * @param responses - Per-label answers overriding the defaults.
 * @returns The hooks and their records.
 */
export function fakeHooks(responses: Readonly<Record<string, unknown>> = {}): FakeRun {
  const table: Readonly<Record<string, unknown>> = {
    'runner:preflight': PREFLIGHT_OK,
    'runner:run-gate': GATE_OK,
    'runner:live-runs': LIVE_RUNS_NONE,
    scout: SCOUT_FRESH,
    ...responses,
  };
  const calls: RecordedCall[] = [];
  const phases: string[] = [];
  const agent = (prompt: string, options: AgentOptions): Promise<unknown> => {
    calls.push({
      label: options.label,
      agentType: options.agentType,
      model: options.model,
      effort: options.effort,
      argv: commandWords(prompt),
      prompt,
    });
    return Promise.resolve(table[options.label] ?? null);
  };
  const hooks: WorkflowHooks = {
    agent,
    parallel: async (thunks) => {
      const out = [];
      for (const thunk of thunks) out.push(await thunk());
      return out;
    },
    pipeline: async (items, step) => {
      const out = [];
      for (const item of items) out.push(await step(item));
      return out;
    },
    phase: (title) => {
      phases.push(title);
    },
    log: () => undefined,
  };
  return { hooks, calls, phases };
}

/**
 * The words after `npx tsx` on a prompt's `Command:` line.
 *
 * @param prompt - The prompt.
 * @returns The words; `[]` when the prompt has no such line.
 */
function commandWords(prompt: string): string[] {
  const line = prompt.split('\n').find((l) => l.startsWith('Command: npx tsx '));
  return line === undefined ? [] : line.slice('Command: npx tsx '.length).split(' ');
}
