/**
 * Version arithmetic for `sync-master`'s version-line rule: when both the
 * batch and `origin/master` moved the `package.json` version since their
 * merge-base, the merge takes master's version bumped by the branch's own
 * bump. That keeps the PR's net at one bump over `master`
 * (Ship ADR-0001 decision 14).
 * The rule intervenes only when both sides moved ({@link bothMoved}):
 * without it an identical bump — both sides at the same number — merges
 * clean in git, and the PR's net bump is zero. {@link bumpVersion} also
 * gives `bump`'s target: `origin/master`'s version bumped by the PR's kind.
 *
 * Only plain `x.y.z` versions take part in arithmetic; anything else (a
 * prerelease, a non-number) throws `StepFailure` step `version`.
 *
 * Pure: no filesystem or git access.
 */

import type { z } from 'zod';

import type { VersionTripleSchema } from '../envelope/schemas-run.js';
import { StepFailure } from '../envelope/types.js';

/** Which component a bump moved: the first that differs, or none. */
type VersionDelta = 'none' | 'patch' | 'minor' | 'major';

/** A `package.json` version at the merge-base and on each side. */
export type VersionTriple = z.infer<typeof VersionTripleSchema>;

/**
 * The top-level `"version"` line of this repo's `package.json`: two
 * spaces of indent, the comma kept, a CR kept. A nested (deeper) `version`
 * never matches.
 */
const VERSION_LINE = /^ {2}"version": "([^"]*)"(,?)(\r?)$/gmu;

/** A plain `x.y.z` version. */
const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

/**
 * The three components of a plain version: `[major, minor, patch]`.
 *
 * @throws StepFailure `version` unless it is a plain `x.y.z`.
 */
function components(version: string): [number, number, number] {
  const m = PLAIN_VERSION.exec(version);
  if (m === null) {
    throw new StepFailure('version', `'${version}' is not a plain x.y.z version`);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Which component moved from `from` to `to`.
 *
 * @returns The first differing component, `major` first; `none` when equal.
 * @throws StepFailure `version` unless both are plain `x.y.z`.
 */
export function versionDelta(from: string, to: string): VersionDelta {
  const a = components(from);
  const b = components(to);
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  return a[2] === b[2] ? 'none' : 'patch';
}

/**
 * Bump a version by one step of `delta`, resetting the lower components.
 *
 * @param delta - The step; `none` returns `version` unchanged.
 * @throws StepFailure `version` unless `version` is a plain `x.y.z`.
 */
export function bumpVersion(version: string, delta: VersionDelta): string {
  const [major, minor, patch] = components(version);
  switch (delta) {
    case 'major':
      return `${String(major + 1)}.0.0`;
    case 'minor':
      return `${String(major)}.${String(minor + 1)}.0`;
    case 'patch':
      return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
    case 'none':
      return version;
  }
}

/**
 * Whether both sides moved the version since the merge-base — the one case
 * the rule intervenes in.
 *
 * @returns `true` when `ours` and `theirs` both differ from `base`.
 */
export function bothMoved(v: VersionTriple): boolean {
  return v.ours !== v.base && v.theirs !== v.base;
}

/**
 * The version the merge ends on.
 *
 * @returns `theirs` when only master moved, `ours` when only the batch
 *   did; when both moved, `theirs` bumped by the batch's own bump
 *   ({@link versionDelta} of `base` → `ours`).
 * @throws StepFailure `version` when both moved and a version is not a
 *   plain `x.y.z`.
 */
export function targetVersion(v: VersionTriple): string {
  if (v.ours === v.base) return v.theirs;
  if (v.theirs === v.base) return v.ours;
  return bumpVersion(v.theirs, versionDelta(v.base, v.ours));
}

/**
 * Read the top-level version line of a `package.json` text.
 *
 * @returns The first top-level version; `null` when there is none.
 */
export function readVersionLine(text: string): string | null {
  const m = new RegExp(VERSION_LINE.source, VERSION_LINE.flags).exec(text);
  return m === null ? null : (m[1] ?? null);
}

/**
 * Rewrite the top-level version line of a `package.json` text, keeping its
 * trailing comma and line ending; every other line is untouched.
 *
 * @throws StepFailure `version` unless the text has exactly one top-level
 *   version line.
 */
export function setVersionLine(text: string, version: string): string {
  const count = text.match(VERSION_LINE)?.length ?? 0;
  if (count !== 1) {
    throw new StepFailure(
      'version',
      `package.json has ${String(count)} top-level version lines; expected exactly 1`,
    );
  }
  return text.replace(
    VERSION_LINE,
    (_line, _old: string, comma: string, cr: string) => `  "version": "${version}"${comma}${cr}`,
  );
}
