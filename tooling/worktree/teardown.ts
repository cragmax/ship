/**
 * `teardown <worktree>` — remove a slice or batch worktree without ever
 * letting git or a recursive delete follow a live link into its target.
 *
 * Invariant: nothing is mutated before the refusal guards pass, and
 * `git worktree remove` runs only once no link remains in the worktree and
 * no external link target has lost entries since teardown started. After
 * any outcome `registered` is re-read from git, so a caller sees a half
 * state (deregistered but not deleted) for what it is.
 *
 * An absent worktree path counts as torn down: nothing at the path is
 * touched, its repository is taken from the cwd, and one
 * `git worktree prune` drops a still-registered entry.
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
 * @returns The envelope: `ok` with `removed: true`, or with `removed: false`
 *   when the path was already absent; `refused` with `reason` and the
 *   worktree left registered; or `failed` with the step.
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
    if (existsSync(worktree)) {
      main = requireWorktreeRoot(worktree, 'preconditions').main;
      removeWorktree(worktree, main, { unlink, selfPath }, result);
    } else {
      main = pruneGoneWorktree();
    }
  } catch (err) {
    recordFailure(result, err);
  }
  result.registered = main !== '' && listWorktrees(main).some((w) => samePath(w.path, worktree));
  return result;
}

/**
 * The guarded removal of an existing worktree, in the order the file header's invariant fixes;
 * sets `result.removed` once git has removed it.
 */
function removeWorktree(
  worktree: string,
  main: string,
  { unlink, selfPath }: TeardownDeps,
  result: TeardownResult,
): void {
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
}

/**
 * Prune the cwd's repository: `git -C` cannot enter a missing directory.
 *
 * @returns The repository's main checkout, as git lists it first.
 * @throws StepFailure `preconditions` when the cwd is in no repository; `prune` if the prune fails.
 */
function pruneGoneWorktree(): string {
  const main = listWorktrees(process.cwd(), 'preconditions')[0]?.path ?? process.cwd();
  git(main, ['worktree', 'prune'], 'prune');
  return main;
}

/**
 * The refusal guards, run before any mutation and after the worktree-root check (so `main` is known
 * and `registered` can be reported): Refusal `self-hosted` when the CLI runs inside the worktree,
 * `main-worktree` when it is the main one, `nested-worktree` from {@link assertNoNestedWorktrees}.
 */
function assertGuards(worktree: string, main: string, selfPath: string): void {
  assertNotSelfHosted(worktree, selfPath);
  if (samePath(main, worktree)) {
    throw new Refusal('main-worktree', 'preconditions', `${worktree} is the main worktree`);
  }
  assertNoNestedWorktrees(worktree, main);
}

/**
 * Refuse `nested-worktree`, naming each registered worktree inside the target ({@link isInside}).
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

/** Remove every link, recording each on `result.unlinked`. */
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

/** Leave the worktree when cwd is inside it. */
function escapeCwd(worktree: string, main: string): void {
  if (isInside(process.cwd(), worktree)) process.chdir(main);
}

/** Baseline-count each link target {@link TeardownResult.sources} records, before any unlink. */
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
 * No link may remain after the unlink step: `git worktree remove` leaves the directory behind
 * holding a live link, which a later recursive delete could follow (PF-91).
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
 * Recount every gated source against its baseline; none may have shrunk. Throws Refusal
 * `source-shrank` at `gate` (nothing removed yet); StepFailure `post-remove-recount` later: the
 * damage is done, but a git that follows a live link is reported rather than silent.
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
 * @throws StepFailure `remnants` when the directory still exists.
 */
function assertGone(worktree: string): void {
  if (existsSync(worktree)) {
    throw new StepFailure('remnants', `${worktree} still exists after git worktree remove`);
  }
}
