/**
 * `check-master <main> --local SHA --remote SHA [--synced SHA]` — whether local `master` and
 * `origin`'s only moved forward since the launch shas given, and `origin`'s also since the
 * `--synced` sha, when given: the `origin/master` the epic end's own sync merged or found merged
 * (#1080, #1095). The epic end runs it just before its push. `origin`'s side is read live with
 * `git ls-remote`, never the remote-tracking ref, which only says what the last fetch saw. Each
 * ref's move is one of the moves `schemas-run.ts` `MasterMoveSchema` defines.
 *
 * **Fail closed.** A sha the object store lacks — launch, synced or current — triggers a fetch of
 * `origin`, then a second look; a sha still missing makes the move `undecidable`, which refuses
 * like `deleted` and `rewound`. Only `equal` and `forward` on both refs pass.
 *
 * Read-only toward every worktree, so there is no self-hosted guard: the fetch writes only
 * `.git`'s remote-tracking refs.
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
  /**
   * `origin`'s high-water sha, kept as given; `null` judges `origin` against
   * its launch sha only. Optional only so a run whose saved workflow script
   * predates #1113 — which never passes `--synced` — still reaches its push;
   * every current caller passes it.
   */
  readonly synced: string | null;
}

/** The ref both sides are read at. */
const MASTER_REF = `refs/heads/${RUN_BASE_BRANCH}`;

/**
 * Check both `master` refs against their launch shas, and `origin`'s
 * against the synced sha.
 *
 * @returns The envelope: `ok` with both moves `equal` or `forward`;
 *   `refused` `master-not-forward` at step `check`, naming each other ref
 *   with its move, its launch sha, `origin`'s synced sha and its current sha;
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
    const local = localMaster(main);
    result.local = {
      launch: input.local,
      synced: null,
      current: local,
      move: moveFrom(main, input.local, local, fetchOnce),
    };
    result.remote = remoteMove(main, input, lsRemoteRef(main, MASTER_REF, 'ls-remote'), fetchOnce);
    assertForward(result.local, result.remote);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Read local `master`'s sha; `null` when the ref does not exist.
 *
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
 * Judge `origin`'s move from its launch sha; when that move is `equal` or `forward` and a synced
 * sha was given, the move from the synced sha instead.
 *
 * @throws StepFailure `fetch` when the fetch a missing sha needs fails.
 */
function remoteMove(
  main: string,
  input: CheckMasterInput,
  current: string | null,
  fetchOnce: () => void,
): MasterMove {
  const fromLaunch = moveFrom(main, input.remote, current, fetchOnce);
  const move: MasterMove = {
    launch: input.remote,
    synced: input.synced,
    current,
    move: fromLaunch,
  };
  if (input.synced === null || (fromLaunch !== 'equal' && fromLaunch !== 'forward')) return move;
  return { ...move, move: moveFrom(main, input.synced, current, fetchOnce) };
}

/**
 * Decide one ref's move from a reference sha to its current one (`null`: the ref is gone).
 *
 * @throws StepFailure `fetch` when the fetch a missing sha needs fails.
 */
function moveFrom(
  main: string,
  from: string,
  current: string | null,
  fetchOnce: () => void,
): MasterMove['move'] {
  if (current === null) return 'deleted';
  if (current === from) return 'equal';
  let pair = knownPair(main, from, current);
  if (pair === null) {
    fetchOnce();
    pair = knownPair(main, from, current);
  }
  if (pair === null) return 'undecidable';
  return ancestry(main, pair[0], pair[1]);
}

/** Both shas of a move as full shas; `null` when either is not in the object store. */
function knownPair(main: string, launch: string, current: string): [string, string] | null {
  const from = knownCommit(main, launch);
  const to = knownCommit(main, current);
  return from === null || to === null ? null : [from, to];
}

/**
 * Resolve a sha, never read as an option, to a full commit sha; `null` when no such commit is in
 * the object store.
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
 * Whether full sha `launch` is an ancestor of `current`; `undecidable` when git cannot answer.
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
 * @throws Refusal `master-not-forward` at step `check`, naming each ref that is neither, its move
 *   and both shas.
 */
function assertForward(local: MasterMove, remote: MasterMove): void {
  const parts = (
    [
      ['local', local],
      ['origin', remote],
    ] as const
  )
    .filter(([, m]) => m.move !== 'equal' && m.move !== 'forward')
    .map(
      ([which, m]) =>
        `${which} ${m.move} (launch ${m.launch}${m.synced === null ? '' : `, synced ${m.synced}`}, now ${m.current ?? 'deleted'})`,
    );
  if (parts.length === 0) return;
  throw new Refusal(
    'master-not-forward',
    'check',
    `master is not forward of its launch: ${parts.join('; ')}`,
  );
}
