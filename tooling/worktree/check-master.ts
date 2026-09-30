/**
 * `check-master <main> --local SHA --remote SHA` — whether local `master`
 * and `origin`'s only moved forward since the launch shas given (#1080):
 * the epic end runs it just before its push. `origin`'s side is read live
 * with `git ls-remote`, never the remote-tracking ref, which only says what
 * the last fetch saw. Each ref's move is one of the moves
 * `schemas-run.ts` `MasterMoveSchema` defines.
 *
 * **Fail closed.** A sha the object store lacks triggers a fetch of
 * `origin`, then a second look; a sha still missing makes the move
 * `undecidable`, which refuses like `deleted` and `rewound`. Only `equal`
 * and `forward` on both refs pass.
 *
 * Read-only toward every worktree, so there is no self-hosted guard (like
 * `preflight`): the fetch writes only `.git`'s remote-tracking refs.
 */

import { runCaptured } from './exec.js';
import { assertMainWorktree, fetchOrigin, lsRemoteRef } from './git.js';
import { RUN_BASE_BRANCH } from './run-layout.js';
import type { CheckMasterResult, MasterMove } from './types-run.js';
import { Refusal, recordFailure, StepFailure } from './types.js';

/** Inputs of {@link checkMaster}. */
export interface CheckMasterInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** Local `master`'s launch sha, kept as given. */
  readonly local: string;
  /** `origin`'s `master` launch sha, kept as given. */
  readonly remote: string;
}

/** The ref both sides are read at. */
const MASTER_REF = `refs/heads/${RUN_BASE_BRANCH}`;

/**
 * Check both `master` refs against their launch shas.
 *
 * @param input - The main checkout and the two launch shas.
 * @returns The envelope: `ok` with both moves `equal` or `forward`;
 *   `refused` `master-not-forward` at step `check`, naming each other ref;
 *   `refused` `not-main-worktree`; or `failed` with the step
 *   (`preconditions`, `local-master`, `ls-remote`, `fetch`).
 */
export function checkMaster(input: CheckMasterInput): CheckMasterResult {
  const { main } = input;
  const result: CheckMasterResult = {
    command: 'check-master',
    status: 'ok',
    worktree: main,
    errors: [],
    local: null,
    remote: null,
  };
  let fetched = false;
  const fetchOnce = (): void => {
    if (fetched) return;
    fetched = true;
    fetchOrigin(main);
  };
  try {
    assertMainWorktree(main, 'preconditions');
    result.local = moveOf(main, input.local, localMaster(main), fetchOnce);
    result.remote = moveOf(
      main,
      input.remote,
      lsRemoteRef(main, MASTER_REF, 'ls-remote'),
      fetchOnce,
    );
    assertForward(result.local, result.remote);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Read local `master`.
 *
 * @param main - The main checkout.
 * @returns Its sha; `null` when the ref does not exist.
 * @throws StepFailure `local-master` on any other non-zero exit.
 */
function localMaster(main: string): string | null {
  const r = runCaptured('git', ['-C', main, 'rev-parse', '-q', '--verify', MASTER_REF], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return r.stdout.trim();
  if (r.exitCode === 1) return null;
  throw new StepFailure(
    'local-master',
    `git rev-parse ${MASTER_REF} exited ${String(r.exitCode)} in ${main}`,
    r.tail,
  );
}

/**
 * Decide one ref's move from its launch sha to its current one.
 *
 * @param main - The main checkout.
 * @param launch - The launch sha, as given.
 * @param current - The current sha; `null` when the ref is gone.
 * @param fetchOnce - Fetches `origin`; a no-op after the command's first fetch.
 * @returns The move.
 * @throws StepFailure `fetch` when the fetch a missing sha needs fails.
 */
function moveOf(
  main: string,
  launch: string,
  current: string | null,
  fetchOnce: () => void,
): MasterMove {
  if (current === null) return { launch, current, move: 'deleted' };
  if (current === launch) return { launch, current, move: 'equal' };
  let pair = knownPair(main, launch, current);
  if (pair === null) {
    fetchOnce();
    pair = knownPair(main, launch, current);
  }
  if (pair === null) return { launch, current, move: 'undecidable' };
  return { launch, current, move: ancestry(main, pair[0], pair[1]) };
}

/**
 * Resolve both shas of a move.
 *
 * @param main - The main checkout.
 * @param launch - The launch sha.
 * @param current - The current sha.
 * @returns Both as full shas; `null` when either is not in the object store.
 */
function knownPair(main: string, launch: string, current: string): [string, string] | null {
  const from = knownCommit(main, launch);
  const to = knownCommit(main, current);
  return from === null || to === null ? null : [from, to];
}

/**
 * Resolve a sha to a commit the checkout holds.
 *
 * @param main - The main checkout.
 * @param sha - The sha; never read as an option.
 * @returns The full sha; `null` when no such commit is in the object store
 *   (the `^{commit}` peel is what makes an absent full sha fail).
 */
function knownCommit(main: string, sha: string): string | null {
  const r = runCaptured(
    'git',
    ['-C', main, 'rev-parse', '-q', '--verify', '--end-of-options', `${sha}^{commit}`],
    { cwd: process.cwd() },
  );
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * Whether `launch` is an ancestor of `current`.
 *
 * @param main - The main checkout.
 * @param launch - A resolved full sha.
 * @param current - A resolved full sha.
 * @returns `forward` on exit 0, `rewound` on exit 1, `undecidable` otherwise.
 */
function ancestry(main: string, launch: string, current: string): MasterMove['move'] {
  const r = runCaptured('git', ['-C', main, 'merge-base', '--is-ancestor', launch, current], {
    cwd: process.cwd(),
  });
  if (r.exitCode === 0) return 'forward';
  return r.exitCode === 1 ? 'rewound' : 'undecidable';
}

/**
 * Refuse unless both refs are `equal` or `forward`.
 *
 * @param local - Local `master`'s move.
 * @param remote - `origin`'s `master` move.
 * @throws Refusal `master-not-forward` at step `check`, naming each ref
 *   that is neither, its move and both shas.
 */
function assertForward(local: MasterMove, remote: MasterMove): void {
  const parts = (
    [
      ['local', local],
      ['origin', remote],
    ] as const
  )
    .filter(([, m]) => m.move !== 'equal' && m.move !== 'forward')
    .map(([which, m]) => `${which} ${m.move} (launch ${m.launch}, now ${m.current ?? 'deleted'})`);
  if (parts.length === 0) return;
  throw new Refusal(
    'master-not-forward',
    'check',
    `master is not forward of its launch: ${parts.join('; ')}`,
  );
}
