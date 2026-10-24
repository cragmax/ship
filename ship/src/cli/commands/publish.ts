/**
 * `publish <batch> --title T --body-file F --log L [--draft]` — push the run's
 * feature branch and open its pull request, as a draft with `--draft`
 * (Ship ADR-0001 decision 12: the PR is the sole human gate).
 *
 * Order: the guards (a linked run batch, no open PR for the branch, a body
 * file within {@link GH_BODY_LIMIT}), then `npm run build` — so the
 * pre-push gate's tests read a current `dist/` — then the push, then
 * `gh pr create`.
 * A failed push opens no PR. The PR number is read from the PR URL that
 * `gh pr create` prints on stdout on success; no URL is a `pr` failure with `pushed` true.
 *
 * `publish --push-only` — the push to an open PR's branch — is
 * `publish-push.ts`'s; both push through {@link pushBranch}.
 */

import { readFileSync } from 'node:fs';

import { GH_BODY_LIMIT } from '../../core/gh-body-limit.js';

import {
  GH_TIMEOUT_MS,
  NPM_TIMEOUT_MS,
  PUSH_TIMEOUT_MS,
  runCaptured,
  runStep,
} from '../git/exec.js';
import { assertRunBatch } from './cut.js';
import { git } from '../git/git.js';
import { runHooked } from '../git/hooked.js';
import { assertLinkedWorktree } from './harvest.js';
import { lookupPr } from './live-runs.js';
import { RUN_BASE_BRANCH } from '../git/run-layout.js';
import type { HookAttempt, OpenedPr, PublishResult } from '../envelope/types-run.js';
import { Refusal, recordFailure, StepFailure } from '../envelope/types.js';

/** Inputs of {@link publish}; paths absolute with forward slashes. */
interface PublishInput {
  /** The batch worktree. */
  readonly batch: string;
  /** The PR title. */
  readonly title: string;
  /** The PR body, passed to `gh pr create --body-file`. */
  readonly bodyFile: string;
  /**
   * Where the push's whole output (its pre-push gate's included) is written, a retry's beside it
   * (`retryLog` in `hooked.ts`).
   */
  readonly logFile: string;
  /** Open the PR as a draft. */
  readonly draft?: boolean;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/**
 * Push the batch's run branch and open its PR.
 *
 * @returns The envelope: `ok` with `pushed` and `pr`; `refused` before any
 *   mutation (harvest's linked-worktree reasons, `not-run-batch`,
 *   `pr-exists`); or `failed` with the step — `pr-state`, `body-too-long`
 *   (the body file over {@link GH_BODY_LIMIT} characters) or `build` before
 *   the push, `push` (`pushed` false), or `pr` (`pushed` true, `pr` null).
 */
export function publish(input: PublishInput): PublishResult {
  const { batch, selfPath = import.meta.filename } = input;
  const result = newPublishResult(batch);

  try {
    const branch = publishableBranch(batch, selfPath);
    assertNoOpenPr(batch, branch);
    assertBodyWithinLimit(input.bodyFile);
    runStep('build', 'npm', ['run', 'build'], { cwd: batch, timeoutMs: NPM_TIMEOUT_MS });
    pushBranch(batch, branch, input.logFile, result.hookAttempts);
    result.pushed = true;
    result.pr = createPr(batch, branch, input);
  } catch (err) {
    recordFailure(result, err);
  }

  return result;
}

/** A fresh `ok` envelope of either publish form. */
export function newPublishResult(batch: string): PublishResult {
  return {
    command: 'publish',
    status: 'ok',
    worktree: batch,
    errors: [],
    pushed: false,
    pr: null,
    mergeable: null,
    hookAttempts: [],
  };
}

/**
 * Run the guards both publish forms open with, a linked run batch, and read its branch.
 *
 * @param selfPath - The running CLI's file, for the self-hosted guard.
 * @returns The batch's branch, short form.
 * @throws Refusal with harvest's linked-worktree reasons, or `not-run-batch`; StepFailure
 *   `preconditions` when git fails.
 */
export function publishableBranch(batch: string, selfPath: string): string {
  assertLinkedWorktree(batch, selfPath);
  assertRunBatch(batch);

  return git(batch, ['symbolic-ref', '--short', 'HEAD'], 'preconditions');
}

/**
 * Push the branch to `origin`, setting its upstream, through the pre-push hook (Tooling ADR-0002),
 * and once more when that hook crashed: `hooked.ts`'s {@link runHooked}, the retry's output in its
 * own log beside `logFile`. Never forced: a push `origin` would have to lose commits for fails,
 * and is reported — never retried with force. `publish` and `publish --push-only` both push
 * through here.
 *
 * @remarks
 * The refspec names both sides, unforced, so push configuration cannot redirect or force it.
 *
 * @param branch - The run branch, short form.
 * @param attempts - Receives each run of the push.
 * @throws StepFailure `push` as {@link runHooked} names it — a non-fast-forward included.
 */
export function pushBranch(
  batch: string,
  branch: string,
  logFile: string,
  attempts: HookAttempt[],
): void {
  const ref = `refs/heads/${branch}`;
  const args = ['push', '-u', 'origin', `${ref}:${ref}`];

  runHooked({
    step: 'push',
    label: `git ${args.join(' ')}`,
    logFile,
    attempts,
    spawn: (log) =>
      runCaptured('git', ['-C', batch, ...args], {
        cwd: process.cwd(),
        timeoutMs: PUSH_TIMEOUT_MS,
        logFile: log,
      }),
  });
}

/**
 * Refuse, before the push, a PR body `gh pr create` would fail on after it.
 *
 * @throws StepFailure `body-too-long` naming the file and its length.
 */
function assertBodyWithinLimit(bodyFile: string): void {
  const length = readFileSync(bodyFile, 'utf8').length;

  if (length > GH_BODY_LIMIT) {
    throw new StepFailure(
      'body-too-long',
      `body file ${bodyFile} is ${String(length)} characters, over GitHub's ${String(GH_BODY_LIMIT)}-character limit`,
    );
  }
}

/**
 * Refuse a branch with an open PR.
 *
 * @throws StepFailure `pr-state` when `gh` fails or answers unreadably (never read as "no PR");
 *   Refusal `pr-exists` naming the open PR.
 */
function assertNoOpenPr(batch: string, branch: string): void {
  const { info, error } = lookupPr(batch, branch);
  if (error !== undefined) throw new StepFailure('pr-state', `${branch}: ${error}`);

  if (info.state === 'open') {
    throw new Refusal(
      'pr-exists',
      'pr-state',
      `${branch} already has open PR #${String(info.number)}`,
    );
  }
}

/**
 * Open the PR, branch → `master`.
 *
 * @returns The PR, read from the URL `gh` prints.
 * @throws StepFailure `pr` when `gh` fails or prints no PR URL.
 */
function createPr(batch: string, branch: string, input: PublishInput): OpenedPr {
  const r = runCaptured(
    'gh',
    [
      'pr',
      'create',
      '--base',
      RUN_BASE_BRANCH,
      '--head',
      branch,
      '--title',
      input.title,
      '--body-file',
      input.bodyFile,
      ...(input.draft === true ? ['--draft'] : []),
    ],
    { cwd: batch, timeoutMs: GH_TIMEOUT_MS },
  );
  const url = /https:\/\/\S+\/pull\/(\d+)/u.exec(r.stdout);

  if (r.exitCode !== 0 || url === null) {
    throw new StepFailure('pr', `gh pr create exited ${String(r.exitCode)} for ${branch}`, r.tail);
  }

  return { number: Number(url[1]), url: url[0] };
}
