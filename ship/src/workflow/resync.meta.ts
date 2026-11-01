/**
 * The `resync` workflow's `meta` export, rendered as the literal that opens
 * `.claude/workflows/resync.js`. Read by `ship/src/build/render-workflows.ts`, not
 * part of the render closure.
 */

import type { WorkflowMeta } from './runtime.types.js';
import { RESYNC_PHASES } from './stages.js';

/** What the runtime lists for `resync`. */
export const RESYNC_META: WorkflowMeta = {
  name: 'resync',
  description:
    "Bring an open run branch level with origin/master (Ship ADR-0001 decision 12): the epic end's merge " +
    'step in its batch worktree, then a push through the pre-push gate, never forced; spent ' +
    'batch worktrees are torn down first.',
  whenToUse:
    'Launch with the open run branch `ship/<slug>` (e.g. `ship/epic-1025`), or the object ' +
    "{ branch }, after another PR merged into master — never GitHub's Update branch, which " +
    'lefthook never gates. It refuses while the branch has commits of its own origin lacks ' +
    "(a stopped attached run's fixes): recover them first (Ship ADR-0001 decision 17).",
  phases: RESYNC_PHASES,
};
