/**
 * `post-pr-comment <batch> --pr N --comment-file F` — post a file as one
 * comment on an open PR (ADR-0045 decision 12): an attached run posts its
 * run report this way, so the report never grows the PR's body.
 *
 * Order: read the comment file, refuse it when it is over
 * {@link GH_BODY_LIMIT}, then `gh pr comment --body-file`, then read the
 * comment's URL from `gh`'s stdout; the first failed step ends the command
 * `failed` with `url` null ({@link postPrComment}).
 *
 * It mutates no worktree — the batch is only `gh`'s working directory — so
 * it has no linked-worktree or self-hosted guard.
 */

import { readFileSync } from 'node:fs';

import { describeError } from '../lib/describe-error.js';

import { GH_BODY_LIMIT, GH_TIMEOUT_MS, runCaptured } from './exec.js';
import type { PostPrCommentResult } from './types-run.js';
import { recordFailure, StepFailure } from './types.js';

/** Inputs of {@link postPrComment}; paths absolute with forward slashes. */
export interface PostPrCommentInput {
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
 * @param input - The batch, the PR and the comment file.
 * @returns The envelope: `ok` with `url`, the comment URL `gh` printed; or
 *   `failed` with `url` null at the step — `comment` (the file
 *   unreadable or blank) or `body-too-long` (over {@link GH_BODY_LIMIT}
 *   characters; exactly the limit is allowed), both before any `gh` call;
 *   `pr-comment` when `gh pr comment` exits non-zero; or `comment-url` when
 *   it exits 0 printing no `https://` URL — the comment may have been
 *   posted, and the message never echoes stdout.
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
    const comment = readComment(commentFile);
    if (comment.length > GH_BODY_LIMIT) {
      throw new StepFailure(
        'body-too-long',
        `comment file ${commentFile} is ${String(comment.length)} characters, over GitHub's ${String(GH_BODY_LIMIT)}-character limit`,
      );
    }
    result.url = postComment(batch, pr, commentFile);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Read the comment file.
 *
 * @param file - The comment file.
 * @returns Its text.
 * @throws StepFailure `comment` when it cannot be read or is blank.
 */
function readComment(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new StepFailure('comment', `comment file ${file} unreadable: ${describeError(err)}`);
  }
  if (text.trim() === '') throw new StepFailure('comment', `comment file ${file} is empty`);
  return text;
}

/**
 * One `gh pr comment <pr> --body-file <file>`.
 *
 * @param batch - `gh`'s working directory.
 * @param pr - The PR.
 * @param file - The comment.
 * @returns The comment's URL, as `gh` printed it.
 * @throws StepFailure `pr-comment` on a non-zero exit; `comment-url` when
 *   `gh` printed no `https://` URL.
 */
function postComment(batch: string, pr: number, file: string): string {
  const r = runCaptured('gh', ['pr', 'comment', String(pr), '--body-file', file], {
    cwd: batch,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw new StepFailure(
      'pr-comment',
      `gh pr comment ${String(pr)} exited ${String(r.exitCode)}`,
      r.tail,
    );
  }
  const url = r.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);
  if (url?.startsWith('https://') !== true) {
    throw new StepFailure(
      'comment-url',
      `gh pr comment ${String(pr)} printed no comment URL; the comment may have been posted`,
    );
  }
  return url;
}
