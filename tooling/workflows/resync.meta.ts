/**
 * The `resync` workflow's `meta` export, rendered as the literal that opens
 * `.claude/workflows/resync.js`. Read by `tooling/render-workflows.ts`; not
 * part of the render closure.
 */

import type { WorkflowMeta } from './lib/hooks.types.js';
import { RESYNC_PHASES } from './lib/stages.js';

/** What the runtime lists for `resync`. */
export const RESYNC_META: WorkflowMeta = {
  name: 'resync',
  description:
    "Bring an open run branch level with origin/master (ADR-0045): the epic end's merge " +
    'step in its batch worktree, then a push through the pre-push gate, never forced; spent ' +
    'batch worktrees are torn down first.',
  whenToUse:
    'Launch with the open run branch `ship/<slug>` (e.g. `ship/epic-1025`), or the object ' +
    "{ branch }, after another PR merged into master — never GitHub's Update branch, which " +
    'lefthook never gates.',
  phases: RESYNC_PHASES,
};
