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
 */

import { z } from 'zod';

import { assertRunBatch } from './cut.js';
import { GH_TIMEOUT_MS, NPM_TIMEOUT_MS, PUSH_TIMEOUT_MS, runCaptured, runStep } from './exec.js';
import { git } from './git.js';
import { assertLinkedWorktree } from './harvest.js';
import { RUN_BASE_BRANCH } from './run-layout.js';
import type { OpenedPr, PublishResult } from './types-run.js';
import { Refusal, recordFailure, StepFailure } from './types.js';

/** `gh pr list --json number,state` output; unknown keys are tolerated. */
const PrListSchema = z.array(z.object({ number: z.number() }));

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
 * @param input - Batch, title, body and log files, and the self-hosted seam.
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
  };
  try {
    assertLinkedWorktree(batch, selfPath);
    assertRunBatch(batch);
    const branch = git(batch, ['symbolic-ref', '--short', 'HEAD'], 'preconditions');
    assertNoOpenPr(batch, branch);
    runStep('build', 'npm', ['run', 'build'], { cwd: batch, timeoutMs: NPM_TIMEOUT_MS });
    push(batch, branch, input.logFile);
    result.pushed = true;
    result.pr = createPr(batch, branch, input);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Refuse a branch that already has an open PR: a second `gh pr create`
 * fails, and a push would silently update the open one.
 *
 * @param batch - The batch worktree (`gh`'s working directory).
 * @param branch - The run branch, short form.
 * @throws StepFailure `pr-state` when `gh` fails or answers unreadably —
 *   never read as "no PR"; Refusal `pr-exists` naming the open PR.
 */
function assertNoOpenPr(batch: string, branch: string): void {
  const r = runCaptured(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,state'],
    { cwd: batch, timeoutMs: GH_TIMEOUT_MS },
  );
  if (r.exitCode !== 0) {
    throw new StepFailure(
      'pr-state',
      `gh pr list exited ${String(r.exitCode)} for ${branch}`,
      r.tail,
    );
  }
  const open = parseOpenPrs(r.stdout);
  if (open === null) {
    throw new StepFailure('pr-state', `gh pr list printed unreadable JSON for ${branch}`, r.stdout);
  }
  const [first] = open;
  if (first !== undefined) {
    throw new Refusal(
      'pr-exists',
      'pr-state',
      `${branch} already has open PR #${String(first.number)}`,
    );
  }
}

/**
 * Parse `gh pr list --json number,state` output.
 *
 * @param stdout - `gh`'s stdout.
 * @returns The PRs, or `null` unless it is JSON matching {@link PrListSchema}.
 */
function parseOpenPrs(stdout: string): z.infer<typeof PrListSchema> | null {
  try {
    const parsed = PrListSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Push the branch to `origin`, setting its upstream; the pre-push hook runs
 * the full gate.
 *
 * @remarks
 * The refspec names both sides, unforced: a bare `<branch>` refspec takes
 * its destination and force from config — under `push.default=upstream` a
 * branch tracking `origin/master` pushes to `master`, and a `+` mapping in
 * `remote.origin.push` forces it (git 2.55, observed 2026-09-28).
 *
 * @param batch - The batch worktree.
 * @param branch - The run branch, short form.
 * @param logFile - Where the output goes.
 * @throws StepFailure `push` on a non-zero exit, spawn failure or budget kill.
 */
function push(batch: string, branch: string, logFile: string): void {
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
 * @param batch - The batch worktree (`gh`'s working directory).
 * @param branch - The run branch, short form.
 * @param input - The title and body file.
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
  const url = /https:\/\/\S+\/pull\/(\d+)/u.exec(r.stdout);
  if (r.exitCode !== 0 || url === null) {
    throw new StepFailure('pr', `gh pr create exited ${String(r.exitCode)} for ${branch}`, r.tail);
  }
  return { number: Number(url[1]), url: url[0] };
}
