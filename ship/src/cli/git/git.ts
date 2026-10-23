/**
 * Git and path-identity helpers for the worktree CLI. Every git call runs as
 * `git -C <dir>` with captured output ({@link runCaptured}); git prints
 * forward-slash absolute paths on every platform. Local plumbing runs under
 * the default budget; the fetch and the hooked commit take theirs from
 * `exec.ts`.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { toPosix } from '../../../../tooling/lib/strings.js';

import { COMMIT_TIMEOUT_MS, FETCH_TIMEOUT_MS, runCaptured, runStep } from './exec.js';
import { Refusal, StepFailure } from '../envelope/types.js';

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
 * Run a path-listing git command with `-z` (git C-quotes unusual paths without it) and split it.
 *
 * @param args - Git subcommand first, then its options (`-z` is inserted
 *   right after the subcommand).
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
 * Resolve a commit-ish to a full commit sha.
 *
 * @param dir - Any checkout of the repository.
 * @param ref - Any commit-ish; never read as an option.
 * @throws StepFailure for `step` when it does not resolve to a commit.
 */
export function resolveCommit(dir: string, ref: string, step: string): string {
  return git(dir, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], step);
}

/**
 * Fetch `origin` into a checkout's remote-tracking refs, under `FETCH_TIMEOUT_MS`.
 *
 * @throws StepFailure `fetch` carrying the output tail, on a non-zero exit,
 *   spawn failure or budget kill.
 */
export function fetchOrigin(dir: string): void {
  runStep('fetch', 'git', ['-C', dir, 'fetch', '-q', 'origin'], {
    cwd: process.cwd(),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

/**
 * Read one ref of `origin` live with `git ls-remote`, under
 * `FETCH_TIMEOUT_MS` — never the checkout's remote-tracking copy of it.
 *
 * @param dir - The checkout whose `origin` is asked.
 * @param ref - The full ref name, e.g. `refs/heads/master`.
 * @returns The sha `origin` names for exactly `ref`; `null` when `origin`
 *   has no such ref.
 * @throws StepFailure for `step` carrying the output tail, on a non-zero
 *   exit, spawn failure or budget kill.
 */
export function lsRemoteRef(dir: string, ref: string, step: string): string | null {
  const r = runCaptured('git', ['-C', dir, 'ls-remote', 'origin', ref], {
    cwd: process.cwd(),
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  if (r.exitCode !== 0) {
    throw new StepFailure(
      step,
      `git ls-remote origin ${ref} exited ${String(r.exitCode)} in ${dir}`,
      r.tail,
    );
  }

  for (const line of r.stdout.split(/\r?\n/u)) {
    const [sha = '', name] = line.split('\t');
    if (name === ref) return sha;
  }

  return null;
}

/**
 * Commit with the hooks (the pre-commit gate), under `COMMIT_TIMEOUT_MS`,
 * the whole output to a log file.
 *
 * @param args - `git commit`'s arguments (`-F <file>`, `--no-edit`).
 * @throws StepFailure `commit` carrying the output tail, on a non-zero exit,
 *   spawn failure or budget kill.
 */
export function commitWithHooks(dir: string, args: readonly string[], logFile: string): void {
  const r = runCaptured('git', ['-C', dir, 'commit', ...args], {
    cwd: process.cwd(),
    timeoutMs: COMMIT_TIMEOUT_MS,
    logFile,
  });

  if (r.exitCode !== 0) {
    throw new StepFailure(
      'commit',
      `git commit ${args.join(' ')} exited ${String(r.exitCode)} in ${dir}; output in ${logFile}`,
      r.tail,
    );
  }
}

/**
 * Whether a ref resolves in a checkout — for the per-worktree in-progress
 * refs (`MERGE_HEAD`, …), which {@link git} cannot probe since it throws on
 * the non-zero exit an absent ref gives.
 *
 * @returns `true` when `git rev-parse -q --verify` resolves it.
 */
export function refExists(dir: string, ref: string): boolean {
  return (
    runCaptured('git', ['-C', dir, 'rev-parse', '-q', '--verify', ref], { cwd: process.cwd() })
      .exitCode === 0
  );
}

/**
 * The local branches under `prefix` (`git for-each-ref refs/heads/<prefix>`), short form, in ref
 * order; end `prefix` with `/` to match whole path components.
 *
 * @throws StepFailure for `step` when git cannot list them.
 */
export function branchesUnder(dir: string, prefix: string, step: string): string[] {
  return git(dir, ['for-each-ref', '--format=%(refname:lstrip=2)', `refs/heads/${prefix}`], step)
    .split(/\r?\n/u)
    .filter((name) => name !== '');
}

/**
 * The lines of `git status --porcelain` for a checkout.
 *
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
 * @throws StepFailure for `step` when `path` is missing or not inside a git
 *   repository.
 */
function worktreeIdentity(path: string, step: string): WorktreeIdentity {
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
 * Require `path` to be the repository's main worktree root.
 *
 * @throws StepFailure for `step` when `path` is not a worktree root;
 *   Refusal `not-main-worktree` when it is a linked worktree.
 */
export function assertMainWorktree(path: string, step: string): void {
  const identity = requireWorktreeRoot(path, step);

  if (!samePath(identity.main, path)) {
    throw new Refusal(
      'not-main-worktree',
      step,
      `${path} is not the main worktree (the main worktree is ${identity.main})`,
    );
  }
}

/**
 * Refuse when the running CLI's own file lies inside the worktree a
 * command mutates: its tsx loader keeps `esbuild.exe` running from that
 * checkout's `node_modules`, so an `npm ci` or removal there would hit a
 * running executable, which win32 refuses to delete or overwrite (Ship PF-11).
 *
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
 * @returns `true` when their canonical forms match.
 */
export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Whether `child` is `parent` or lies beneath it.
 *
 * @returns `true` when `child` is inside `parent` (inclusive).
 */
export function isInside(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);

  return c === p || c.startsWith(`${p}/`);
}
