/**
 * The `package.json` and lockfile side of `sync-master`: the version-line
 * rule's git and npm I/O (the rule's arithmetic, and why it exists, is
 * `package-version.ts`'s), and the lockfile's regeneration after a
 * conflict. Every git call reads — `git show`, `git merge-file` over temp
 * copies — except {@link applyVersionRule} and {@link regenerateLockfile},
 * which run mid-merge and stage by name.
 *
 * `git show` reaches the CLI through `runCaptured`, which strips one final
 * newline from stdout; npm always ends `package.json` with one, so each
 * copy read, and the merged text written back, gets exactly one again.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NPM_TIMEOUT_MS, runCaptured, runStep } from './exec.js';
import { git } from './git.js';
import {
  bothMoved,
  readVersionLine,
  setVersionLine,
  targetVersion,
  type VersionTriple,
} from './package-version.js';
import { RUN_UPSTREAM } from './run-layout.js';
import type { VersionLine } from './types-run.js';
import { StepFailure } from './types.js';

/** The lockfile, regenerated rather than merged by hand. */
export const LOCKFILE = 'package-lock.json';

/** The manifest whose top-level version line the rule rewrites. */
export const PACKAGE_JSON = 'package.json';

/** The three `package.json` copies of a merge, and their versions. */
interface PackageCopies {
  /** The versions read from the copies' top-level version lines. */
  readonly versions: VersionTriple;
  /** Each copy's text, one final newline restored. */
  readonly texts: VersionTriple;
}

/** The version rule's intervention: the merged `package.json` and the version it carries. */
export interface VersionRule {
  readonly merged: string;
  readonly target: string;
}

/** The largest `git merge-file` exit that counts conflicts; above it is an error. */
const MERGE_FILE_MAX_CONFLICTS = 127;

/**
 * Read the three versions and decide whether the version rule intervenes:
 * only when both sides moved the version, and the `package.json` copies
 * merge once their version lines agree.
 *
 * @param batch - The batch worktree.
 * @param mergeBase - The merge-base of `HEAD` and `origin/master`.
 * @returns `version` for the envelope — `null` when a copy is missing or
 *   has no top-level version line — and `rule`, `null` when the rule stays
 *   out of the merge.
 * @throws StepFailure `version` when both sides moved and a version is not a
 *   plain `x.y.z`, or `git merge-file` fails.
 */
export function planVersionRule(
  batch: string,
  mergeBase: string,
): { readonly version: VersionLine | null; readonly rule: VersionRule | null } {
  const copies = readVersions(batch, mergeBase);
  if (copies === null) return { version: null, rule: null };
  const target = targetVersion(copies.versions);
  const version = { ...copies.versions, result: target };
  if (!bothMoved(copies.versions)) return { version, rule: null };
  const merged = mergedPackageJson(batch, copies);
  return { version, rule: merged === null ? null : { merged, target } };
}

/**
 * Read `package.json` at the merge-base, the batch's `HEAD` and
 * `origin/master`.
 *
 * @param batch - The batch worktree.
 * @param mergeBase - The merge-base of `HEAD` and `origin/master`.
 * @returns The copies and their versions; `null` when any copy is missing
 *   (or git cannot show it) or has no top-level version line — never a throw.
 */
function readVersions(batch: string, mergeBase: string): PackageCopies | null {
  const base = showPackageJson(batch, mergeBase);
  const ours = showPackageJson(batch, 'HEAD');
  const theirs = showPackageJson(batch, RUN_UPSTREAM);
  if (base === null || ours === null || theirs === null) return null;
  const b = readVersionLine(base);
  const o = readVersionLine(ours);
  const t = readVersionLine(theirs);
  if (b === null || o === null || t === null) return null;
  return { versions: { base: b, ours: o, theirs: t }, texts: { base, ours, theirs } };
}

/**
 * One `package.json` copy.
 *
 * @param batch - The batch worktree.
 * @param rev - The revision.
 * @returns Its text with one final newline; `null` when git cannot show it.
 */
function showPackageJson(batch: string, rev: string): string | null {
  const r = runCaptured('git', ['-C', batch, 'show', `${rev}:${PACKAGE_JSON}`], {
    cwd: process.cwd(),
  });
  return r.exitCode === 0 ? `${r.stdout}\n` : null;
}

/**
 * Merge the three copies with every version line set to the base's, so a
 * version-only difference never conflicts, then set the version line to
 * {@link targetVersion}'s.
 *
 * @param batch - The batch worktree (`git`'s directory).
 * @param copies - The three copies from {@link readVersions}.
 * @returns The merged text; `null` when the copies conflict beyond the
 *   version line.
 * @throws StepFailure `version` when a copy has not exactly one top-level
 *   version line, a version is not plain `x.y.z`, or `git merge-file` fails.
 */
function mergedPackageJson(batch: string, copies: PackageCopies): string | null {
  const { versions, texts } = copies;
  const target = targetVersion(versions);
  const dir = mkdtempSync(join(tmpdir(), 'ph-worktree-version-'));
  try {
    const path = (name: keyof VersionTriple): string => {
      const file = join(dir, `${name}.json`);
      writeFileSync(file, setVersionLine(texts[name], versions.base));
      return file;
    };
    const [ours, base, theirs] = [path('ours'), path('base'), path('theirs')];
    const r = runCaptured('git', ['-C', batch, 'merge-file', '-p', ours, base, theirs], {
      cwd: process.cwd(),
    });
    if (r.exitCode === 0) return setVersionLine(`${r.stdout}\n`, target);
    if (r.exitCode > 0 && r.exitCode <= MERGE_FILE_MAX_CONFLICTS) return null;
    throw new StepFailure('version', `git merge-file exited ${String(r.exitCode)}`, r.tail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Apply the rule mid-merge: write and stage the merged `package.json`, then
 * — when the lockfile is tracked — regenerate it against that file (from
 * `origin/master`'s copy when it conflicted) and stage it.
 *
 * @param batch - The batch worktree, `MERGE_HEAD` set.
 * @param merged - {@link mergedPackageJson}'s text.
 * @param target - The version it carries.
 * @param lockConflicted - Whether the lockfile is unmerged.
 * @throws StepFailure `version` when git cannot stage `package.json`;
 *   `lockfile` when git or npm fails, or the regenerated lockfile's
 *   `version` or `packages[""].version` is not `target`.
 */
export function applyVersionRule(
  batch: string,
  merged: string,
  target: string,
  lockConflicted: boolean,
): void {
  writeFileSync(`${batch}/${PACKAGE_JSON}`, merged);
  git(batch, ['add', '--', PACKAGE_JSON], 'version');
  if (!trackedAtHead(batch, LOCKFILE)) return;
  regenerateLockfile(batch, lockConflicted);
  assertLockVersion(batch, target);
}

/**
 * Resolve the lockfile by regeneration, never by hand: take
 * `origin/master`'s lockfile when it conflicted, let npm rewrite it against
 * the merged `package.json`, and stage it by name.
 *
 * @param batch - The batch worktree, mid-merge.
 * @param conflicted - Whether the lockfile is unmerged; `origin/master`'s
 *   copy is checked out first then.
 * @throws StepFailure `lockfile` when git or npm fails.
 */
export function regenerateLockfile(batch: string, conflicted: boolean): void {
  if (conflicted) git(batch, ['checkout', '--theirs', '--', LOCKFILE], 'lockfile');
  runStep('lockfile', 'npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: batch,
    timeoutMs: NPM_TIMEOUT_MS,
  });
  git(batch, ['add', '--', LOCKFILE], 'lockfile');
}

/**
 * Whether `HEAD` tracks a path.
 *
 * @param batch - The batch worktree.
 * @param path - Repository-relative path.
 * @returns `true` when `git cat-file -e HEAD:<path>` succeeds.
 */
function trackedAtHead(batch: string, path: string): boolean {
  return (
    runCaptured('git', ['-C', batch, 'cat-file', '-e', `HEAD:${path}`], { cwd: process.cwd() })
      .exitCode === 0
  );
}

/**
 * Require the regenerated lockfile to carry the target version.
 *
 * @param batch - The batch worktree.
 * @param target - The version.
 * @throws StepFailure `lockfile` naming what it carries instead.
 */
function assertLockVersion(batch: string, target: string): void {
  const lock = JSON.parse(readFileSync(`${batch}/${LOCKFILE}`, 'utf8')) as {
    readonly version?: unknown;
    readonly packages?: Readonly<Record<string, { readonly version?: unknown } | undefined>>;
  };
  const root = lock.packages?.['']?.version;
  if (lock.version !== target || root !== target) {
    throw new StepFailure(
      'lockfile',
      `regenerated ${LOCKFILE} carries ${String(lock.version)} / ${String(root)}, not ${target}`,
    );
  }
}
