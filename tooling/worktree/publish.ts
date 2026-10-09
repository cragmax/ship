/**
 * `publish <batch> --title T --body-file F --log L` — push the run's
 * feature branch and open its pull request (`.claude/rules/git.md`
 * § Unattended workflow runs: the PR is the sole human gate).
 *
 * Order: the guards (a linked run batch, no open PR for the branch), then
 * `npm run build` — so the pre-push gate's `manifest-coverage` reads a
 * current `dist/api-manifest.json` — then the push, then `gh pr create`.
 * A failed push opens no PR. The PR number is read from the PR URL that
 * `gh pr create` prints on stdout on success (its `--help`, observed
 * 2026-09-28); no URL is a `pr` failure with `pushed` true.
 *
 * `publish --push-only` — the push to an open PR's branch — is
 * `publish-push.ts`'s; both push through {@link pushBranch}.
 */

import { assertRunBatch } from './cut.js';
import { GH_TIMEOUT_MS, NPM_TIMEOUT_MS, PUSH_TIMEOUT_MS, runCaptured, runStep } from './exec.js';
import { git } from './git.js';
import { assertLinkedWorktree } from './harvest.js';
import { lookupPr } from './live-runs.js';
import { RUN_BASE_BRANCH } from './run-layout.js';
import type { OpenedPr, PublishResult } from './types-run.js';
import { Refusal, recordFailure, StepFailure } from './types.js';

/** Inputs of {@link publish}; paths absolute with forward slashes. */
export interface PublishInput {
  /** The batch worktree. */
  readonly batch: string;
  /** The PR title. */
  readonly title: string;
  /** The PR body, passed to `gh pr create --body-file`. */
  readonly bodyFile: string;
  /** Where the push's whole output (its pre-push gate's included) is written. */
  readonly logFile: string;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/**
 * Push the batch's run branch and open its PR.
 *
 * @returns The envelope: `ok` with `pushed` and `pr`; `refused` before any
 *   mutation (harvest's linked-worktree reasons, `not-run-batch`,
 *   `pr-exists`); or `failed` with the step — `pr-state` or `build` before
 *   the push, `push` (`pushed` false), or `pr` (`pushed` true, `pr` null).
 */
export function publish(input: PublishInput): PublishResult {
  const { batch, selfPath = import.meta.filename } = input;
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
    const branch = git(batch, ['symbolic-ref', '--short', 'HEAD'], 'preconditions');
    assertNoOpenPr(batch, branch);
    runStep('build', 'npm', ['run', 'build'], { cwd: batch, timeoutMs: NPM_TIMEOUT_MS });
    pushBranch(batch, branch, input.logFile);
    result.pushed = true;
    result.pr = createPr(batch, branch, input);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Refuse a branch with an open PR: a second `gh pr create` fails; a push would update it silently.
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
 * Push the branch to `origin`, setting its upstream; the pre-push hook runs the full gate. Never
 * forced: a push `origin` would have to lose commits for fails, and is reported — never retried
 * with force. `publish` and `publish --push-only` both push through here.
 *
 * @remarks
 * The refspec names both sides, unforced: a bare `<branch>` refspec takes its destination and force
 * from config — under `push.default=upstream` a branch tracking `origin/master` pushes to
 * `master`, and a `+` mapping in `remote.origin.push` forces it (git 2.55).
 *
 * @param branch - The run branch, short form.
 * @throws StepFailure `push` on a non-zero exit — a non-fast-forward included — spawn failure or
 *   budget kill.
 */
export function pushBranch(batch: string, branch: string, logFile: string): void {
  const ref = `refs/heads/${branch}`;
  const r = runCaptured('git', ['-C', batch, 'push', '-u', 'origin', `${ref}:${ref}`], {
    cwd: process.cwd(),
    timeoutMs: PUSH_TIMEOUT_MS,
    logFile,
  });
  if (r.exitCode !== 0) {
    throw new StepFailure(
      'push',
      `git push -u origin ${ref}:${ref} exited ${String(r.exitCode)}; output in ${logFile}`,
      r.tail,
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
    ],
    { cwd: batch, timeoutMs: GH_TIMEOUT_MS },
  );
  // gh prints the new PR's URL on stdout (gh 2.101.0, observed 2026-09-29, #1035).
  const url = /https:\/\/\S+\/pull\/(\d+)/u.exec(r.stdout);
  if (r.exitCode !== 0 || url === null) {
    throw new StepFailure('pr', `gh pr create exited ${String(r.exitCode)} for ${branch}`, r.tail);
  }
  return { number: Number(url[1]), url: url[0] };
}
