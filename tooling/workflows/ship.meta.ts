/**
 * The `ship` workflow's `meta` export, rendered as the literal that opens
 * `.claude/workflows/ship.js`. Read by `tooling/render-workflows.ts`; not
 * part of the render closure.
 */

import type { WorkflowMeta } from './lib/hooks.types.js';
import { DEFAULT_PR_REVIEW_LEVEL, MAX_SLICES, SHIP_PHASES } from './lib/stages.js';

/** What the runtime lists for `ship`. */
export const SHIP_META: WorkflowMeta = {
  name: 'ship',
  description:
    'Ship epics or issue lists unattended (ADR-0045): pre-flight, then each issue planned, ' +
    'authored, reviewed and landed on its epic branch in dependency order, then the epic end ' +
    'and one pull request per epic, then a PR review of each.',
  // The main-loop model writes the launch call: given `/ship #92`, it chose `issues 92` itself (#1035).
  // It also reads this when deciding whether to resume a run (#1058).
  whenToUse:
    'Launch with `epics N...` or `issues N...` (numbers space- or comma-separated, optional #), ' +
    'plus optional `--exclude` (drop failing or stale issues with their dependents instead of ' +
    'refusing), `--preflight-only` (stop after pre-flight), `--max-slices K` (most issues ' +
    `in flight, start until settled, default ${String(MAX_SLICES)}) and ` +
    '`--pr-review off|xhigh|max` (the level of the PR review each opened pull request gets ' +
    `after every epic end, default ${DEFAULT_PR_REVIEW_LEVEL}, each a nested Claude Code ` +
    'session — launching consents to one per opened PR; off runs none); or the object ' +
    '{ epics | issues, exclude?, preflightOnly?, maxSlices?, prReview? }. Bare numbers are refused: ' +
    'when the user gives bare numbers, ask whether they are epics or issues — never choose. ' +
    'Resume (`resumeFromRunId`) only a run of one epic or one issue list launched with ' +
    '`--max-slices 1`, its script unchanged or changed only in code after its last finished ' +
    'call; never resume any other run once its batch is cut — recover it by hand ' +
    '(ADR-0045 decision 10).',
  phases: SHIP_PHASES,
};
