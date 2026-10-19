/**
 * The `ship` workflow's `meta` export, rendered as the literal that opens
 * `.claude/workflows/ship.js`. Read by `ship/src/build/render-workflows.ts`; not
 * part of the render closure.
 */

import type { WorkflowMeta } from './runtime.types.js';
import { MAX_SLICES, SHIP_PHASES } from './stages.js';

/** What the runtime lists for `ship`. */
export const SHIP_META: WorkflowMeta = {
  name: 'ship',
  description:
    'Ship epics or issue lists unattended (Ship ADR-0001): pre-flight, then each issue built from its ' +
    'brief, reviewed and landed on its epic branch in dependency order, then the epic end ' +
    'and one pull request per epic.',
  // The main-loop model writes the launch call (given a bare `/ship 92`, it chose `issues 92`)
  // and reads this when deciding whether to resume a run.
  whenToUse:
    'Launch with `epics N...` or `issues N...` (space- or comma-separated, optional #) ' +
    'plus optional `--exclude` (drop failing or stale issues and dependents), ' +
    '`--preflight-only`, `--max-slices K` (issues in flight, ' +
    `default ${String(MAX_SLICES)}), ` +
    '`--attach ship/<slug>` (`issues` only: land on that open PR); or the object ' +
    '{ epics | issues, exclude?, preflightOnly?, maxSlices?, attach? }. ' +
    'Given bare numbers, ask: epics or issues? Never choose. ' +
    'Resume (`resumeFromRunId`) only a one-epic or one-list `--max-slices 1` run ' +
    'whose script is unchanged; recover others by hand.',
  phases: SHIP_PHASES,
};
