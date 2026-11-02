/**
 * `teardown <worktree>`: remove a slice or batch worktree without ever
 * letting git or a recursive delete follow a live link into its target.
 *
 * Invariant: nothing is mutated before the refusal guards pass, any work asked kept
 * ({@link KeepRequest}) is written before the first unlink, and
 * `git worktree remove` runs only once no link remains in the worktree and
 * no external link target has lost entries since teardown started. After
 * any outcome `registered` is re-read from git, so a caller sees a half
 * state (deregistered but not deleted) for what it is.
 *
 * An absent worktree path counts as torn down: nothing at the path is
 * touched, its repository is taken from the cwd, and one
 * `git worktree prune` drops a still-registered entry.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { posix } from 'node:path';

import { describeError } from '../../core/describe-error.js';
import { runCaptured } from '../git/exec.js';
import {
  assertNotSelfHosted,
  git,
  isInside,
  listWorktrees,
  requireWorktreeRoot,
  resolveCommit,
  samePath,
} from '../git/git.js';
import { countSource, findLinks, isRealDir, unlinkLink } from '../git/links.js';
import { restartSessionTsserver, skipped } from './tsserver-restart.js';
import {
  Refusal,
  recordFailure,
  StepFailure,
  type LinkRecord,
  type TeardownResult,
  type TsserverRestart,
} from '../envelope/types.js';

/** Seams of {@link teardownWorktree}. */
interface TeardownDeps {
  /** Removes one link (production: {@link unlinkLink}). */
  readonly unlink: (path: string) => void;
  /** The running CLI's file, for the self-hosted guard (production: this module). */
  readonly selfPath: string;
  /**
   * Restarts the session's tsserver once a worktree is removed (production:
   * {@link restartSessionTsserver}).
   */
  readonly restartTsserver: () => TsserverRestart;
}

const DEFAULT_DEPS: TeardownDeps = {
  unlink: unlinkLink,
  selfPath: import.meta.filename,
  restartTsserver: restartSessionTsserver,
};

/** What to keep before the worktree goes: `--keep-to <dir> --base <sha> [--report <file>]`. */
export interface KeepRequest {
  /** Where the work is kept, absolute with forward slashes. Created when missing. */
  readonly dir: string;
  /** The commit the patch is taken from: the slice base. */
  readonly base: string;
  /** A file copied into `dir` under its own name, when it exists. */
  readonly report?: string;
}

/** The patch's file name in {@link KeepRequest.dir}. */
const PATCH_FILE = 'slice.patch';

/**
 * Tear down a worktree, keeping the file header's invariant.
 *
 * @param worktree - Absolute forward-slash path of the worktree.
 * @param deps - Seams. Each defaults to production. `unlink` lets a test
 *   simulate a followed link or a surviving one, and `selfPath` lets it
 *   exercise the self-hosted guard.
 * @param keep - Work to keep first ({@link keepWork}). An absent worktree keeps nothing.
 * @returns The envelope: `ok` with `removed: true`, or with `removed: false`
 *   when the path was already absent; `refused` with `reason` and the
 *   worktree left registered; or `failed` with the step, `keep` leaving the worktree in place.
 */
export function teardownWorktree(
  worktree: string,
  deps: Partial<TeardownDeps> = {},
  keep: KeepRequest | null = null,
): TeardownResult {
  const { unlink, selfPath, restartTsserver } = { ...DEFAULT_DEPS, ...deps };
  const result: TeardownResult = {
    command: 'teardown',
    status: 'ok',
    worktree,
    errors: [],
    unlinked: [],
    sources: [],
    removed: false,
    registered: true,
    kept: null,
    tsserverRestart: skipped('not-removed'),
  };
  let main = '';

  try {
    if (existsSync(worktree)) {
      main = requireWorktreeRoot(worktree, 'preconditions').main;
      removeWorktree(worktree, main, { unlink, selfPath }, keep, result);
    } else {
      main = pruneGoneWorktree();
    }
  } catch (err) {
    recordFailure(result, err);
  }

  result.registered = main !== '' && listWorktrees(main).some((w) => samePath(w.path, worktree));
  if (result.removed) result.tsserverRestart = restartTsserver();

  return result;
}

/**
 * The guarded removal of an existing worktree, in the order the file header's invariant fixes.
 * Sets `result.removed` once git has removed it.
 */
function removeWorktree(
  worktree: string,
  main: string,
  { unlink, selfPath }: Pick<TeardownDeps, 'unlink' | 'selfPath'>,
  keep: KeepRequest | null,
  result: TeardownResult,
): void {
  assertGuards(worktree, main, selfPath);
  if (keep !== null) result.kept = keepWork(worktree, keep);
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
 * Pins the kept patch's format against the user's git config, which can otherwise strip its
 * prefixes, colour it, drop its context or textconv it, each unappliable (unprobed beyond
 * `diff.noprefix` and `color.diff`).
 */
const PATCH_FORMAT = [
  '--binary',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--unified=3',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/',
] as const;

/**
 * Write {@link PATCH_FILE} (the diff from `keep.base` to every unignored file, staged in the
 * worktree's own index first) and the copy of `keep.report`, each only when it exists, into
 * `keep.dir`, created only then. @throws StepFailure `keep` when the base, git or a write fails.
 */
function keepWork(worktree: string, keep: KeepRequest): NonNullable<TeardownResult['kept']> {
  const base = resolveCommit(worktree, keep.base, 'keep');
  git(worktree, ['add', '-A'], 'keep');
  const changed = indexDiffers(worktree, base);
  const source = keep.report !== undefined && existsSync(keep.report) ? keep.report : null;
  if (!changed && source === null) return { patch: null, report: null };
  keepWrite(() => mkdirSync(keep.dir, { recursive: true }));
  const patch = changed ? `${keep.dir}/${PATCH_FILE}` : null;
  // git writes the file itself: a text diff of a non-UTF-8 file never passes through a decode.
  if (patch !== null)
    git(worktree, ['diff', '--cached', ...PATCH_FORMAT, `--output=${patch}`, base], 'keep');

  return { patch, report: source === null ? null : copyInto(source, keep.dir) };
}

/** Copy `source` into `dir` under its own name. @throws StepFailure `keep` when the copy fails. */
function copyInto(source: string, dir: string): string {
  const to = `${dir}/${posix.basename(source)}`;
  keepWrite(() => copyFileSync(source, to));

  return to;
}

/** Whether the worktree's index differs from `base`. @throws StepFailure `keep` when git fails. */
function indexDiffers(worktree: string, base: string): boolean {
  const r = runCaptured('git', ['-C', worktree, 'diff', '--cached', '--quiet', base], {
    cwd: process.cwd(),
  });

  if (r.exitCode !== 0 && r.exitCode !== 1)
    throw new StepFailure('keep', `git diff failed in ${worktree}`, r.tail);

  return r.exitCode === 1;
}

/** Run `write`, a throw becoming a `keep` failure. */
function keepWrite(write: () => unknown): void {
  try {
    write();
  } catch (err) {
    throw new StepFailure('keep', describeError(err));
  }
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
 * holding a live link, which a later recursive delete could follow.
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
 * Recount every gated source against its baseline: none may have shrunk. Throws Refusal
 * `source-shrank` at `gate` (nothing removed yet), or StepFailure `post-remove-recount` later: the
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
