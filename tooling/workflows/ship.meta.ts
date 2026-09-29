/**
 * The `ship` workflow's `meta` export, rendered as the literal that opens
 * `.claude/workflows/ship.js`. Read by `tooling/render-workflows.ts`; not
 * part of the render closure.
 */

import type { WorkflowMeta } from './lib/hooks.types.js';
import { MAX_SLICES, SHIP_PHASES } from './lib/stages.js';

/** What the runtime lists for `ship`. */
export const SHIP_META: WorkflowMeta = {
  name: 'ship',
  description:
    'Ship epics or issue lists unattended (ADR-0045): pre-flight, then each issue planned, ' +
    'authored, reviewed and landed on its epic branch in dependency order, then the epic end ' +
    'and one pull request per epic.',
  // The main-loop model writes the launch call: given `/ship #92`, it chose `issues 92` itself (#1035).
  whenToUse:
    'Launch with `epics N...` or `issues N...` (numbers space- or comma-separated, optional #), ' +
    'plus optional `--exclude` (drop failing or stale issues with their dependents instead of ' +
    'refusing), `--preflight-only` (stop after pre-flight) and `--max-slices K` (most issues ' +
    `in flight, start until settled, default ${String(MAX_SLICES)}); or the object ` +
    '{ epics | issues, exclude?, preflightOnly?, maxSlices? }. Bare numbers are refused: ' +
    'when the user gives bare numbers, ask whether they are epics or issues — never choose.',
  phases: SHIP_PHASES,
};
