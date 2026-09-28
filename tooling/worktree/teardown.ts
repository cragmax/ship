/**
 * `teardown <worktree>` — remove a slice or batch worktree without ever
 * letting git or a recursive delete follow a live link into its target.
 *
 * Invariant: nothing is mutated before the refusal guards pass, and
 * `git worktree remove` runs only once no link remains in the worktree and
 * no external link target has lost entries since teardown started. After
 * any outcome `registered` is re-read from git, so a caller sees a half
 * state (deregistered but not deleted) for what it is.
 */

import { existsSync } from 'node:fs';

import {
  assertNotSelfHosted,
  git,
  isInside,
  listWorktrees,
  requireWorktreeRoot,
  samePath,
} from './git.js';
import { countSource, findLinks, isRealDir, unlinkLink } from './links.js';
import {
  Refusal,
  recordFailure,
  StepFailure,
  type LinkRecord,
  type TeardownResult,
} from './types.js';

/** Seams of {@link teardownWorktree}. */
export interface TeardownDeps {
  /** Removes one link (production: {@link unlinkLink}). */
  readonly unlink: (path: string) => void;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath: string;
}

const DEFAULT_DEPS: TeardownDeps = { unlink: unlinkLink, selfPath: import.meta.filename };

/**
 * Tear down a worktree, keeping the file header's invariant.
 *
 * @param worktree - Absolute forward-slash path of the worktree.
 * @param deps - Seams; each defaults to production. `unlink` lets a test
 *   simulate a followed link or a surviving one; `selfPath` lets it
 *   exercise the self-hosted guard.
 * @returns The envelope: `ok` with `removed: true`; `refused` with `reason`
 *   and the worktree left registered; or `failed` with the step.
 */
export function teardownWorktree(
  worktree: string,
  deps: Partial<TeardownDeps> = {},
): TeardownResult {
  const { unlink, selfPath } = { ...DEFAULT_DEPS, ...deps };
  const result: TeardownResult = {
    command: 'teardown',
    status: 'ok',
    worktree,
    errors: [],
    unlinked: [],
    sources: [],
    removed: false,
    registered: true,
  };
  let main = '';
  try {
    main = requireWorktreeRoot(worktree, 'preconditions').main;
    assertGuards(worktree, main, selfPath);
    escapeCwd(worktree, main);
    const links = findLinks(worktree);
    baselineSources(worktree, links, result);
    unlinkAll(links, unlink, result);
    assertNoLinksRemain(worktree);
    assertSourcesIntact(result, 'gate');
    git(main, ['worktree', 'remove', '--force', worktree], 'remove');
    assertGone(worktree);
    result.removed = true;
    assertSourcesIntact(result, 'post-remove-recount');
  } catch (err) {
    recordFailure(result, err);
  }
  result.registered = main !== '' && listWorktrees(main).some((w) => samePath(w.path, worktree));
  return result;
}

/**
 * Refusal guards that run before any mutation (after the worktree-root
 * check, so `main` is known and `registered` can be reported).
 *
 * @param worktree - The worktree to remove.
 * @param main - The repository's main worktree.
 * @param selfPath - The running CLI's file.
 * @throws Refusal `self-hosted` when the CLI runs from inside the worktree;
 *   Refusal `main-worktree` when it is the main worktree; Refusal
 *   `nested-worktree` from {@link assertNoNestedWorktrees}.
 */
function assertGuards(worktree: string, main: string, selfPath: string): void {
  assertNotSelfHosted(worktree, selfPath);
  if (samePath(main, worktree)) {
    throw new Refusal('main-worktree', 'preconditions', `${worktree} is the main worktree`);
  }
  assertNoNestedWorktrees(worktree, main);
}

/**
 * Refuse when another registered worktree lies inside the target:
 * `git worktree remove --force` deletes the whole directory, nested
 * worktrees and their uncommitted files included, leaving them listed as prunable
 * (git 2.55, probe 2026-09-28). Containment is {@link isInside} — path
 * boundary respected, so a sibling whose name merely starts with the
 * target's does not count.
 *
 * @param worktree - The worktree to remove.
 * @param main - The repository's main worktree.
 * @throws Refusal `nested-worktree` naming every nested worktree.
 */
function assertNoNestedWorktrees(worktree: string, main: string): void {
  const nested = listWorktrees(main, 'preconditions')
    .map((w) => w.path)
    .filter((path) => !samePath(path, worktree) && isInside(path, worktree));
  if (nested.length > 0) {
    throw new Refusal(
      'nested-worktree',
      'preconditions',
      `registered worktrees lie inside ${worktree}: ${nested.join(', ')}`,
    );
  }
}

/**
 * Remove every link, recording each.
 *
 * @param links - The worktree's links.
 * @param unlink - The link remover.
 * @param result - Envelope; `unlinked` gains each link.
 */
function unlinkAll(
  links: readonly LinkRecord[],
  unlink: (path: string) => void,
  result: TeardownResult,
): void {
  for (const link of links) {
    unlink(link.path);
    result.unlinked.push(link);
  }
}

/**
 * Move this process out of the worktree when its cwd is inside it: on
 * Windows `git worktree remove` cannot delete a directory that is a live
 * process's cwd, and fails only after deregistering the worktree (probe
 * 2026-09-28). A parent shell homed inside still blocks the removal; that
 * surfaces as a `remove` failure.
 *
 * @param worktree - The worktree being removed.
 * @param main - The main worktree to move to.
 */
function escapeCwd(worktree: string, main: string): void {
  if (isInside(process.cwd(), worktree)) process.chdir(main);
}

/**
 * Baseline-count each link target that {@link TeardownResult.sources}
 * records, before any unlink.
 *
 * @param worktree - The worktree being removed.
 * @param links - Its links.
 * @param result - Envelope; gains one `sources` entry per recorded target.
 */
function baselineSources(
  worktree: string,
  links: readonly LinkRecord[],
  result: TeardownResult,
): void {
  for (const { target } of links) {
    if (isInside(target, worktree) || result.sources.some((s) => samePath(s.path, target)))
      continue;
    if (!isRealDir(target) && existsSync(target)) continue;
    result.sources.push({ path: target, before: countSource(target), after: null });
  }
}

/**
 * Re-walk the worktree after the unlink step; no link may remain, since
 * `git worktree remove` leaves the directory behind holding a live link
 * (git 2.55, probe 2026-09-28), which a later recursive delete could follow.
 *
 * @param worktree - The worktree being removed.
 * @throws Refusal `links-remain` naming every surviving link.
 */
function assertNoLinksRemain(worktree: string): void {
  const remaining = findLinks(worktree);
  if (remaining.length > 0) {
    throw new Refusal(
      'links-remain',
      'unlink',
      `links survived the unlink step: ${remaining.map((l) => l.path).join(', ')}`,
    );
  }
}

/**
 * Recount every gated source against its baseline; none may have shrunk.
 *
 * @param result - Envelope; each source's `after` is updated.
 * @param stage - `gate` (after unlink, before git runs) or
 *   `post-remove-recount` (after `git worktree remove`).
 * @throws Refusal `source-shrank` at the `gate` stage, naming every source
 *   that lost entries — nothing has been removed yet. StepFailure
 *   `post-remove-recount` at the later stage: the damage is done, but a git
 *   version that follows a live link is reported rather than silent. No
 *   fixture can make git 2.55 follow a link, so this stage is untested.
 */
function assertSourcesIntact(result: TeardownResult, stage: 'gate' | 'post-remove-recount'): void {
  for (const source of result.sources) source.after = countSource(source.path);
  const shrunk = result.sources.filter(
    (s) => s.before !== null && (s.after === null || s.after < s.before),
  );
  if (shrunk.length === 0) return;
  const message = `link source lost entries: ${shrunk.map((s) => `${s.path} ${String(s.before)} -> ${String(s.after)}`).join(', ')}`;
  if (stage === 'gate') throw new Refusal('source-shrank', stage, message);
  throw new StepFailure(stage, message);
}

/**
 * Check the worktree directory is gone after `git worktree remove`.
 *
 * @param worktree - The removed worktree.
 * @throws StepFailure `remnants` when the directory still exists.
 */
function assertGone(worktree: string): void {
  if (existsSync(worktree)) {
    throw new StepFailure('remnants', `${worktree} still exists after git worktree remove`);
  }
}
