/**
 * `post-issue-comment <main> --issue N --comment-file F` — post a file as
 * one comment on an issue: an unattended run's epic end tells each issue it
 * blocked why (ADR-0045 decision 6), so the reason sits where the next
 * triage or `/to-tickets` reads it. The run changes no label.
 *
 * Order and failures: {@link postCommentFile} (`gh-comment.ts`), the
 * non-zero-exit step named `issue-comment`. It mutates no worktree — the
 * target, normally the main checkout, is only `gh`'s working directory — so
 * it has no linked-worktree or self-hosted guard.
 */

import { postCommentFile } from './gh-comment.js';
import type { PostIssueCommentResult } from '../envelope/types-run.js';
import { recordFailure } from '../envelope/types.js';

/** Inputs of {@link postIssueComment}; paths absolute with forward slashes. */
interface PostIssueCommentInput {
  /** `gh`'s working directory, a checkout of the repository. */
  readonly cwd: string;
  /** The issue. */
  readonly issue: number;
  /** The comment to post, whole. */
  readonly commentFile: string;
}

/**
 * Post the comment file to the issue.
 *
 * @param input - The directory, the issue and the comment file.
 * @returns The envelope: `ok` with `url`, the comment URL `gh` printed; or
 *   `failed` with `url` null at the step {@link postCommentFile} names —
 *   `comment`, `body-too-long`, `issue-comment` or `comment-url`.
 */
export function postIssueComment(input: PostIssueCommentInput): PostIssueCommentResult {
  const { cwd, issue, commentFile } = input;
  const result: PostIssueCommentResult = {
    command: 'post-issue-comment',
    status: 'ok',
    worktree: cwd,
    errors: [],
    issue,
    url: null,
  };
  try {
    result.url = postCommentFile(cwd, 'issue', issue, commentFile);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}
