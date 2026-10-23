/** The opening both publish forms share: `publish.ts`'s and `publish-push.ts`'s. */

import { assertRunBatch } from './cut.js';
import { git } from '../git/git.js';
import { assertLinkedWorktree } from './harvest.js';
import type { PublishResult } from '../envelope/types-run.js';
import { recordFailure } from '../envelope/types.js';

/**
 * Start a `publish` envelope and run the guards both publish forms open with: a linked run batch,
 * then its branch read.
 *
 * @param selfPath - The running CLI's file, for the self-hosted guard.
 * @returns A fresh `ok` envelope and the batch's branch, short form; `branch` is `null` when a
 *   guard refused or failed, which the envelope records (harvest's linked-worktree reasons,
 *   `not-run-batch`, or a `preconditions` failure).
 */
export function openPublish(
  batch: string,
  selfPath: string,
): { readonly result: PublishResult; readonly branch: string | null } {
  const result: PublishResult = {
    command: 'publish',
    status: 'ok',
    worktree: batch,
    errors: [],
    pushed: false,
    pr: null,
    mergeable: null,
  };
  try {
    assertLinkedWorktree(batch, selfPath);
    assertRunBatch(batch);
    return { result, branch: git(batch, ['symbolic-ref', '--short', 'HEAD'], 'preconditions') };
  } catch (err) {
    recordFailure(result, err);
    return { result, branch: null };
  }
}
