/**
 * The `ship` workflow's entry (ADR-0045): ships epics or explicit issue
 * lists unattended, one pull request per epic. Rendered into
 * `.claude/workflows/ship.js` by `tooling/render-workflows.ts` — edit this
 * source and run `npm run codegen`, never the rendered file.
 *
 * {@link runShip} parses the launch arguments, runs the pre-flight phase,
 * and reports. Any refusal ends the run before anything is cut; a
 * `preflightOnly` launch stops after a clean pre-flight with the graph it
 * would schedule. The full run is not wired yet: any other launch is
 * refused `full-run-unavailable`.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { RunGraph } from '../lib/run-set.js';

import { parseShipArgs } from './lib/args.js';
import type { WorkflowHooks } from './lib/hooks.types.js';
import { runPreflight, type DroppedIssue, type ShipRefusal } from './lib/preflight.js';
import { PHASE_TITLES } from './lib/stages.js';

/** One run-set entry's result; pre-flight reports none. */
export interface EpicReport {
  /** The entry's epic, or `null` for an explicit list. */
  readonly epic: number | null;
  /** The entry's feature branch. */
  readonly branch: string;
  /** How the entry ended. */
  readonly outcome: 'pr' | 'halted' | 'nothing-landed' | 'stopped';
  /** The pull request opened, when one was. */
  readonly pr?: number;
  /** Each issue's outcome. */
  readonly issues: readonly { readonly issue: number; readonly outcome: string }[];
}

/** What the workflow returns. */
export interface ShipReport {
  /** `refused`: nothing was cut; `preflight-ok`: a `preflightOnly` launch passed. */
  readonly status: 'refused' | 'preflight-ok';
  /** Every refusal; present only when `refused`. */
  readonly refusals?: readonly ShipRefusal[];
  /** Every issue exclude mode dropped. */
  readonly dropped: readonly DroppedIssue[];
  /** The graph the run would schedule; present only when `preflight-ok`. */
  readonly graph?: RunGraph;
  /** Each entry's result. */
  readonly epics: readonly EpicReport[];
}

/**
 * Run the `ship` workflow.
 *
 * @param hooks - The workflow hooks.
 * @param rawArgs - `args` as the runtime passed it.
 * @returns Resolves to the run report.
 */
export async function runShip(hooks: WorkflowHooks, rawArgs: unknown): Promise<ShipReport> {
  const parsed = parseShipArgs(rawArgs);
  if (parsed.refusal !== undefined) return refusedReport([parsed.refusal], []);
  hooks.phase(PHASE_TITLES.preflight);
  const pre = await runPreflight(hooks, parsed.args);
  if (pre.refusals.length > 0 || pre.graph === null) {
    return refusedReport(pre.refusals, pre.dropped);
  }
  if (parsed.args.preflightOnly) {
    return { status: 'preflight-ok', dropped: pre.dropped, graph: pre.graph, epics: [] };
  }
  return refusedReport(
    [{ kind: 'full-run-unavailable', message: 'only --preflight-only launches are wired so far' }],
    pre.dropped,
  );
}

/**
 * A `refused` report.
 *
 * @param refusals - Every refusal.
 * @param dropped - Every drop.
 * @returns The report.
 */
function refusedReport(
  refusals: readonly ShipRefusal[],
  dropped: readonly DroppedIssue[],
): ShipReport {
  return { status: 'refused', refusals, dropped, epics: [] };
}
