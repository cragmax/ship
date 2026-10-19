/**
 * `publish <batch> --push-only --log L` — push a run branch whose PR is already open, then read
 * that PR's mergeable state: the `/resync` workflow's last step, after `sync-master` merged
 * `origin/master` into the batch (ADR-0045 decision 6).
 *
 * Order: the guards (a linked run batch; an open PR for the branch), the fetch, the ancestry
 * pre-check against `origin/<branch>`, then — only when the batch is ahead — `npm run build` and
 * the push through `publish.ts`'s {@link pushBranch}, which is never forced; then the mergeable
 * read, polled while GitHub still computes it. A level branch pushes nothing, so no pre-push gate
 * runs; the mergeable state is still read. `UNKNOWN` at the read bound is still `ok`: the envelope
 * reports the raw value, and the caller reads anything but `MERGEABLE` as unconfirmed. It never
 * runs `gh pr create`.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { assertRunBatch } from './cut.js';
import { GH_TIMEOUT_MS, NPM_TIMEOUT_MS, runCaptured, runStep } from '../git/exec.js';
import { fetchOrigin, git, refExists, resolveCommit } from '../git/git.js';
import { assertLinkedWorktree } from './harvest.js';
import { lookupPr } from './live-runs.js';
import { pushBranch } from './publish.js';
import type { PublishResult } from '../envelope/types-run.js';
import { Refusal, recordFailure, StepFailure } from '../envelope/types.js';

/** The most `gh pr view` reads while the mergeable state is `UNKNOWN`. */
export const MERGEABLE_READS = 10;

/** The wait between two mergeable reads. */
const MERGEABLE_POLL_MS = 15_000;

const UNCOMPUTED = 'UNKNOWN';

/** `gh pr view --json mergeable,url` output. */
const PrViewSchema = z.object({ mergeable: z.string(), url: z.string() });

/** Inputs of {@link publishPushOnly}; paths absolute with forward slashes. */
interface PushOnlyInput {
  /** The batch worktree. */
  readonly batch: string;
  /** Where the push's whole output (its pre-push gate's included) is written. */
  readonly logFile: string;
  /** The wait between mergeable reads; default {@link MERGEABLE_POLL_MS}. */
  readonly pollMs?: number;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath?: string;
}

/**
 * Push the batch's run branch to its open PR and read the PR's mergeable
 * state, keeping the file header's order.
 *
 * @returns Resolves to the envelope: `ok` with `pushed`, `pr` and
 *   `mergeable`; `refused` before any mutation (harvest's linked-worktree
 *   reasons, `not-run-batch`, `no-open-pr`); or `failed` with the step —
 *   `pr-state` or `fetch` before the push, `push` (the ancestry pre-check,
 *   or the push itself; `pushed` false), `build`, or `mergeable` (`pushed`
 *   kept). Never rejects.
 */
export async function publishPushOnly(input: PushOnlyInput): Promise<PublishResult> {
  const { batch, selfPath = import.meta.filename, pollMs = MERGEABLE_POLL_MS } = input;
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
    const number = openPrNumber(batch, branch);
    fetchOrigin(batch);
    if (aheadOfOrigin(batch, branch)) {
      runStep('build', 'npm', ['run', 'build'], { cwd: batch, timeoutMs: NPM_TIMEOUT_MS });
      pushBranch(batch, branch, input.logFile);
      result.pushed = true;
    }
    const view = await readMergeable(batch, number, pollMs);
    result.pr = { number, url: view.url };
    result.mergeable = view.mergeable;
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * The number of the branch's open PR.
 *
 * @throws StepFailure `pr-state` when `gh` fails or answers unreadably; Refusal `no-open-pr`
 *   naming the state and number otherwise.
 */
function openPrNumber(batch: string, branch: string): number {
  const { info, error } = lookupPr(batch, branch);
  if (error !== undefined) throw new StepFailure('pr-state', `${branch}: ${error}`);
  if (info.state !== 'open' || info.number === null) {
    const pr = info.number === null ? '' : ` (#${String(info.number)})`;
    throw new Refusal('no-open-pr', 'pr-state', `${branch} has no open PR: ${info.state}${pr}`);
  }
  return info.number;
}

/**
 * `true` when `origin/<branch>` is absent or a strict ancestor of `HEAD`, `false` when level; the
 * batch must be freshly fetched.
 *
 * @throws StepFailure `push` when origin has commits the batch lacks, or git cannot tell.
 */
function aheadOfOrigin(batch: string, branch: string): boolean {
  const remote = `refs/remotes/origin/${branch}`;
  if (!refExists(batch, remote)) return true;
  const origin = resolveCommit(batch, remote, 'push');
  if (origin === resolveCommit(batch, 'HEAD', 'push')) return false;
  const r = runCaptured('git', ['-C', batch, 'merge-base', '--is-ancestor', origin, 'HEAD'], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return true;
  if (r.exitCode === 1) {
    throw new StepFailure('push', `origin/${branch} has commits the batch lacks; nothing pushed`);
  }
  throw new StepFailure('push', `git merge-base --is-ancestor failed in ${batch}`, r.tail);
}

/**
 * Read the PR's mergeable state, again every `pollMs` while {@link UNCOMPUTED}, at most
 * {@link MERGEABLE_READS} reads; resolves to the last read's `mergeable` and the PR's URL.
 *
 * @throws StepFailure `mergeable` when `gh` fails or answers unreadably.
 */
async function readMergeable(
  batch: string,
  number: number,
  pollMs: number,
): Promise<z.infer<typeof PrViewSchema>> {
  let view = viewPr(batch, number);
  for (let read = 1; view.mergeable === UNCOMPUTED && read < MERGEABLE_READS; read++) {
    await sleep(pollMs);
    view = viewPr(batch, number);
  }
  return view;
}

/**
 * One `gh pr view <number> --json mergeable,url`: the PR's mergeable state and URL.
 *
 * @throws StepFailure `mergeable` when `gh` fails or answers unreadably.
 */
function viewPr(batch: string, number: number): z.infer<typeof PrViewSchema> {
  const r = runCaptured('gh', ['pr', 'view', String(number), '--json', 'mergeable,url'], {
    cwd: batch,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw new StepFailure(
      'mergeable',
      `gh pr view ${String(number)} exited ${String(r.exitCode)}`,
      r.tail,
    );
  }
  const parsed = parseView(r.stdout);
  if (parsed === null) {
    throw new StepFailure(
      'mergeable',
      `gh pr view ${String(number)} printed unreadable JSON: ${r.stdout}`,
    );
  }
  return parsed;
}

/**
 * Parse `gh pr view --json mergeable,url` output.
 *
 * @returns The fields, or `null` unless it is JSON matching {@link PrViewSchema}.
 */
function parseView(stdout: string): z.infer<typeof PrViewSchema> | null {
  try {
    const parsed = PrViewSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
