/**
 * Directory-link primitives for the worktree CLI.
 *
 * Never walk with recursive `readdirSync`: it descends into junctions on
 * Windows (PF-69), so a walk or count would see— and a cleanup
 * would reach — the link target's contents. Every walk here is a manual
 * `lstat` walk that stops at a link.
 */

import { lstatSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { toPosix } from '../../../../tooling/lib/strings.js';

import type { LinkRecord } from '../envelope/types.js';

/**
 * Create a directory link at `link` pointing at `target`.
 *
 * @param link - Path of the new link; must not exist.
 * @param target - Existing directory it points at.
 */
export function createJunction(link: string, target: string): void {
  symlinkSync(target, link, 'junction');
}

/**
 * The absolute target of `path` when it is a link.
 *
 * @returns The link's target, or `null` when `path` is missing or not a link.
 */
export function linkTarget(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() !== true) return null;
  return toPosix(resolve(dirname(path), readlinkSync(path)));
}

/**
 * Whether `path` is a real (non-link) directory.
 *
 * @returns `true` for an existing directory that is not a link.
 */
export function isRealDir(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink();
}

/** Collect the links under `dir` into `out`, descending into real directories only. */
function collectLinks(dir: string, out: LinkRecord[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      out.push({ path: toPosix(path), target: linkTarget(path) ?? '' });
    } else if (stat.isDirectory()) {
      collectLinks(path, out);
    }
  }
}

/**
 * Find every link under `root` without following any of them.
 *
 * @returns Each link with its absolute target, in walk order.
 */
export function findLinks(root: string): LinkRecord[] {
  const out: LinkRecord[] = [];
  collectLinks(root, out);
  return out;
}

/**
 * Count the entries at every depth beneath real directory `dir`, a link as one entry, never
 * descended. `skipDir` excludes a real direct subdirectory of `dir`, subtree included.
 */
function countEntries(dir: string, skipDir: (name: string) => boolean = () => false): number {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const real = isRealDir(path);
    if (real && skipDir(name)) continue;
    count += 1 + (real ? countEntries(path) : 0);
  }
  return count;
}

/**
 * Link-aware entry count of a link target, the teardown gate's measure.
 * Top-level dot-directories other than `.bin` are skipped: concurrent runs
 * sharing the tree create and delete tool caches there, so counting them
 * would trip the gate falsely, while a followed link wipes packages, which
 * are counted.
 *
 * @returns The count, or `null` when `dir` is not a real directory.
 */
export function countSource(dir: string): number | null {
  if (!isRealDir(dir)) return null;
  return countEntries(dir, (name) => name.startsWith('.') && name !== '.bin');
}

/** Remove a link itself; its target is never touched. */
export function unlinkLink(path: string): void {
  unlinkSync(path);
}
