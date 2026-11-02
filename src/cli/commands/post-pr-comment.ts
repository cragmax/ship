/**
 * `post-pr-comment <batch> --pr N --comment-file F`: post a file as one
 * comment on an open PR. An attached run posts its
 * run report this way, so the report never grows the PR's body.
 *
 * Order and failures: {@link postCommentFile} (`gh-comment.ts`), the
 * non-zero-exit step named `pr-comment`. It mutates no worktree (the batch
 * is only `gh`'s working directory), so it has no linked-worktree or
 * self-hosted guard.
 */

import { postCommentFile } from './gh-comment.js';
import type { PostPrCommentResult } from '../envelope/types-run.js';
import { recordFailure } from '../envelope/types.js';

/** Inputs of {@link postPrComment}: paths absolute with forward slashes. */
interface PostPrCommentInput {
  /** The batch worktree: only `gh`'s working directory. */
  readonly batch: string;
  /** The open PR. */
  readonly pr: number;
  /** The comment to post, whole. */
  readonly commentFile: string;
}

/**
 * Post the comment file to the PR.
 *
 * @returns The envelope: `ok` with `url`, the comment URL `gh` printed; or
 *   `failed` with `url` null at the step {@link postCommentFile} names:
 *   `comment`, `body-too-long`, `pr-comment` or `comment-url`.
 */
export function postPrComment(input: PostPrCommentInput): PostPrCommentResult {
  const { batch, pr, commentFile } = input;
  const result: PostPrCommentResult = {
    command: 'post-pr-comment',
    status: 'ok',
    worktree: batch,
    errors: [],
    pr,
    url: null,
  };

  try {
    result.url = postCommentFile(batch, 'pr', pr, commentFile);
  } catch (err) {
    recordFailure(result, err);
  }

  return result;
}
