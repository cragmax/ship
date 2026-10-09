/**
 * The shared body of `post-pr-comment` and `post-issue-comment`: read the
 * comment file, refuse it over {@link GH_BODY_LIMIT}, post it with
 * `gh <pr|issue> comment --body-file`, then read the comment's URL from
 * `gh`'s stdout. It mutates no worktree — the directory is only `gh`'s
 * working directory — so neither command has a linked-worktree or
 * self-hosted guard.
 */

import { readFileSync } from 'node:fs';

import { describeError } from '../lib/describe-error.js';
import { GH_BODY_LIMIT } from '../lib/gh-body-limit.js';

import { GH_TIMEOUT_MS, runCaptured } from './exec.js';
import { StepFailure } from './types.js';

/** What a comment is posted on: a pull request or an issue. */
type CommentSubject = 'pr' | 'issue';

/**
 * Post the comment file on a PR or an issue.
 *
 * @param cwd - `gh`'s working directory.
 * @param subject - `pr` or `issue`.
 * @param number - The PR or issue number.
 * @param file - The comment to post, whole.
 * @returns The comment's URL, as `gh` printed it.
 * @throws StepFailure `comment` (the file unreadable or blank) or
 *   `body-too-long` (over {@link GH_BODY_LIMIT} characters; exactly the
 *   limit is allowed), both before any `gh` call; `<subject>-comment` when
 *   `gh <subject> comment` exits non-zero; or `comment-url` when it exits 0
 *   printing no `https://` URL — the comment may have been posted, and the
 *   message never echoes stdout.
 */
export function postCommentFile(
  cwd: string,
  subject: CommentSubject,
  number: number,
  file: string,
): string {
  const comment = readComment(file);
  if (comment.length > GH_BODY_LIMIT) {
    throw new StepFailure(
      'body-too-long',
      `comment file ${file} is ${String(comment.length)} characters, over GitHub's ${String(GH_BODY_LIMIT)}-character limit`,
    );
  }
  return postComment(cwd, subject, number, file);
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
 * One `gh <subject> comment <number> --body-file <file>`.
 *
 * @param cwd - `gh`'s working directory.
 * @param subject - `pr` or `issue`.
 * @param number - The PR or issue number.
 * @param file - The comment.
 * @returns The comment's URL, as `gh` printed it.
 * @throws StepFailure `<subject>-comment` on a non-zero exit; `comment-url`
 *   when `gh` printed no `https://` URL.
 */
function postComment(cwd: string, subject: CommentSubject, number: number, file: string): string {
  const r = runCaptured('gh', [subject, 'comment', String(number), '--body-file', file], {
    cwd,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw new StepFailure(
      `${subject}-comment`,
      `gh ${subject} comment ${String(number)} exited ${String(r.exitCode)}`,
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
      `gh ${subject} comment ${String(number)} printed no comment URL; the comment may have been posted`,
    );
  }
  return url;
}
