/**
 * Git and path-identity helpers for the worktree CLI. Every git call runs as
 * `git -C <dir>` with captured output ({@link runCaptured}); git prints
 * forward-slash absolute paths on every platform.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { toPosix } from '../shared.js';

import { runCaptured } from './exec.js';
import { Refusal, StepFailure } from './types.js';

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Worktree root as git prints it. */
  readonly path: string;
  /** Checked-out branch ref, or `null` when detached or bare. */
  readonly branch: string | null;
  /** Git marks the entry prunable: its directory no longer exists. */
  readonly prunable: boolean;
}

/** Where a worktree sits in its repository. */
export interface WorktreeIdentity {
  /** `git rev-parse --show-toplevel` of the path. */
  readonly toplevel: string;
  /** The repository's shared `.git` directory. */
  readonly commonDir: string;
  /** The repository's main worktree (first `git worktree list` entry). */
  readonly main: string;
}

/**
 * Run `git -C <dir> <args>`.
 *
 * @param dir - Directory git operates on.
 * @param args - Git arguments.
 * @param step - Step name reported on failure.
 * @returns Git's stdout without trailing whitespace (leading whitespace is
 *   significant in porcelain output).
 * @throws StepFailure for `step`, carrying git's output tail, on a non-zero exit.
 */
export function git(dir: string, args: readonly string[], step = 'git'): string {
  const r = runCaptured('git', ['-C', dir, ...args], { cwd: process.cwd() });
  if (r.exitCode !== 0) {
    throw new StepFailure(step, `git ${args.join(' ')} failed in ${dir}`, r.tail);
  }
  return r.stdout.trimEnd();
}

/**
 * List the repository's worktrees; the first entry is the main worktree.
 *
 * @param dir - Any directory inside the repository.
 * @param step - Step name reported on failure.
 * @returns Worktree entries in git's order.
 * @throws StepFailure for `step` when git fails.
 */
export function listWorktrees(dir: string, step = 'git'): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of git(dir, ['worktree', 'list', '--porcelain'], step).split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) continue;
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null;
    const prunable = lines.some((l) => l === 'prunable' || l.startsWith('prunable '));
    entries.push({ path, branch, prunable });
  }
  return entries;
}

/**
 * Run a path-listing git command with `-z` and split its output: without
 * `-z` git C-quotes a non-ASCII or otherwise unusual path, which would then
 * never equal the caller's spelling of it.
 *
 * @param dir - Directory git operates on.
 * @param args - Git subcommand first, then its options (`-z` is inserted
 *   right after the subcommand).
 * @param step - Step name reported on failure.
 * @returns The listed paths in git's order, empty entries dropped.
 * @throws StepFailure for `step` when git fails.
 */
export function gitPaths(dir: string, args: readonly string[], step: string): string[] {
  const [subcommand = '', ...rest] = args;
  return git(dir, [subcommand, '-z', ...rest], step)
    .split('\0')
    .filter((path) => path !== '');
}

/**
 * Whether a ref resolves in a checkout — for the per-worktree in-progress
 * refs (`MERGE_HEAD`, …), which {@link git} cannot probe since it throws on
 * the non-zero exit an absent ref gives.
 *
 * @param dir - The checkout.
 * @param ref - The ref to look up.
 * @returns `true` when `git rev-parse -q --verify` resolves it.
 */
export function refExists(dir: string, ref: string): boolean {
  return (
    runCaptured('git', ['-C', dir, 'rev-parse', '-q', '--verify', ref], { cwd: process.cwd() })
      .exitCode === 0
  );
}

/**
 * The lines of `git status --porcelain` for a checkout.
 *
 * @param dir - The checkout.
 * @param step - Step name reported on failure.
 * @returns One entry per changed, untracked or deleted path (`''`-free).
 * @throws StepFailure for `step` when git fails.
 */
export function statusEntries(dir: string, step: string): string[] {
  return git(dir, ['status', '--porcelain'], step)
    .split(/\r?\n/u)
    .filter((line) => line !== '');
}

/**
 * Check provisioning added nothing `git status` can see — every scaffold
 * path must be ignored, so none can ever be staged and committed.
 *
 * @param dir - The provisioned checkout.
 * @param before - Its status entries before any mutation.
 * @throws StepFailure `post-check` listing every new entry.
 */
export function assertStatusUnchanged(dir: string, before: readonly string[]): void {
  const added = statusEntries(dir, 'post-check').filter((line) => !before.includes(line));
  if (added.length > 0) {
    throw new StepFailure(
      'post-check',
      `provisioning left paths git does not ignore: ${added.join(', ')}`,
    );
  }
}

/**
 * Resolve where `path` sits in its repository.
 *
 * @param path - Directory to identify.
 * @param step - Step name reported on failure.
 * @returns Its toplevel, the shared git dir, and the main worktree.
 * @throws StepFailure for `step` when `path` is missing or not inside a git
 *   repository.
 */
export function worktreeIdentity(path: string, step: string): WorktreeIdentity {
  const [toplevel = '', commonDir = ''] = git(
    path,
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
    step,
  ).split(/\r?\n/u);
  const main = listWorktrees(path, step)[0]?.path ?? '';
  return { toplevel, commonDir, main };
}

/**
 * Identify `path` and require it to be a registered worktree root.
 *
 * @param path - Directory that must be a worktree root.
 * @param step - Step name reported on failure.
 * @returns Its identity.
 * @throws StepFailure for `step` when `path` is missing, outside any
 *   repository, or only a subdirectory of a worktree.
 */
export function requireWorktreeRoot(path: string, step: string): WorktreeIdentity {
  const identity = worktreeIdentity(path, step);
  if (!samePath(identity.toplevel, path)) {
    throw new StepFailure(step, `${path} is not a worktree root (toplevel ${identity.toplevel})`);
  }
  return identity;
}

/**
 * Refuse when the running CLI's own file lies inside the worktree a
 * command mutates: its tsx loader keeps `esbuild.exe` running from that
 * checkout's `node_modules`, so an `npm ci` or removal there would hit a
 * running executable.
 *
 * @param target - The worktree the command mutates.
 * @param selfPath - The running CLI module's file.
 * @throws Refusal `self-hosted` when `selfPath` is inside `target`.
 */
export function assertNotSelfHosted(target: string, selfPath: string): void {
  if (isInside(selfPath, target)) {
    throw new Refusal(
      'self-hosted',
      'preconditions',
      `the CLI (${toPosix(selfPath)}) runs from inside ${target}; run it from another checkout`,
    );
  }
}

/**
 * Canonical comparison form of a path: absolute, symlinks resolved when the
 * path exists, forward slashes, no trailing slash, case-folded on win32.
 *
 * @param path - Path to canonicalise.
 * @returns The comparison key.
 */
function canonical(path: string): string {
  const abs = resolve(path);
  const real = existsSync(abs) ? realpathSync.native(abs) : abs;
  const posix = toPosix(real);
  const trimmed = posix.endsWith('/') ? posix.slice(0, -1) : posix;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Whether two paths name the same location.
 *
 * @param a - First path.
 * @param b - Second path.
 * @returns `true` when their canonical forms match.
 */
export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Whether `child` is `parent` or lies beneath it.
 *
 * @param child - Candidate path.
 * @param parent - Containing directory.
 * @returns `true` when `child` is inside `parent` (inclusive).
 */
export function isInside(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(`${p}/`);
}
