/**
 * npm fixture repos (per-test `mkdtemp` roots, one shared offline template)
 * with a bare `origin` and a batch worktree on `ship/r`: `bump` versions
 * the batch from its own commits.
 *
 * @integrationTier standalone
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareStrings } from '../../src/core/strings.js';
import type { BumpResult } from '../../src/cli/envelope/types-run.js';
import {
  advanceOrigin,
  commitChanges,
  headSha,
  installHook,
  withOriginAndBatch,
  type Changes,
  type FixtureRun,
} from '../helpers/worktree-fixture-git.js';
import {
  makeFixtureRepo,
  makeTempRoot,
  prebuildNpmTemplate,
  removeTempDirs,
  runCli,
} from '../helpers/worktree-cli-fixture.js';
import { addWorktree, mustRun, porcelain } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const HOOK_SAYS = 'fixture hook: commit refused';

prebuildNpmTemplate();

let root: string;
// `bump` leaves its `freshLogDir` log in the OS temp dir for its caller.
const logDirs = new Set<string>();

beforeEach(() => {
  root = makeTempRoot('ph-wt-end-');
});

afterEach(() => {
  removeTempDirs([root, ...logDirs]);
  logDirs.clear();
});

describe('bump', () => {
  it(
    'bumps minor for a feat subject, in one commit of package.json and the lockfile',
    TIMEOUT,
    () => {
      const run = makeRun();
      commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
      commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, 'feat(b): two');

      const r = runBump(run.batch);

      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ status: 'ok', kind: 'minor', from: '1.0.0', to: '1.1.0' });
      const head = headSha(run.batch);
      expect(r.json.commit).toBe(head);
      expect(mustRun('git', ['log', '-1', '--format=%B', head], run.batch).trim()).toBe(
        'chore(build): bump version — r\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      );
      expect(commitPaths(run.batch, head)).toEqual(['package-lock.json', 'package.json']);
      expect(versions(run.batch)).toEqual({ pkg: '1.1.0', lock: '1.1.0', lockRoot: '1.1.0' });
      expect(porcelain(run.batch)).toBe('');
    },
  );

  it('bumps patch for fix-only commits, ignoring a merge commit feat subject', TIMEOUT, () => {
    const run = makeRun();
    const fork = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
    const side = addWorktree(run.main, `${root}/side`, 'side', fork);
    commitChanges(side, { write: { 'c.txt': 'c\n' } }, 'fix(c): side');
    mustRun('git', ['merge', '--no-ff', '-q', '-m', 'feat(m): merged', 'side'], run.batch);

    const r = runBump(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', kind: 'patch', from: '1.0.0', to: '1.0.1' });
    expect(versions(run.batch)).toEqual({ pkg: '1.0.1', lock: '1.0.1', lockRoot: '1.0.1' });
  });

  it.each([
    {
      name: 'a patch-bumped branch and a fix as a no-op',
      first: 'fix(a): one',
      next: 'fix(b): two',
      kind: 'patch',
      from: '1.0.1',
      to: '1.0.1',
      bumps: 1,
    },
    {
      name: 'a patch-bumped branch and a feat with a second bump commit at master’s minor',
      first: 'fix(a): one',
      next: 'feat(b): two',
      kind: 'minor',
      from: '1.0.1',
      to: '1.1.0',
      bumps: 2,
    },
    {
      name: 'a minor-bumped branch and a fix as a no-op',
      first: 'feat(a): one',
      next: 'fix(b): two',
      kind: 'minor',
      from: '1.1.0',
      to: '1.1.0',
      bumps: 1,
    },
  ])('reconciles $name', TIMEOUT, ({ first, next, kind, from, to, bumps }) => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, first);
    expect(runBump(run.batch).json.status).toBe('ok');
    commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, next);
    const head = headSha(run.batch);

    const r = runBump(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', kind, from, to });

    if (bumps === 1) {
      expect(r.json.commit).toBeNull();
      expect(r.json.log).toBeNull();
      expect(headSha(run.batch)).toBe(head);
    } else {
      const bumped = headSha(run.batch);
      expect(bumped).not.toBe(head);
      expect(r.json.commit).toBe(bumped);
      expect(mustRun('git', ['log', '-1', '--format=%s', bumped], run.batch).trim()).toBe(
        'chore(build): bump version — r',
      );
      expect(commitPaths(run.batch, bumped)).toEqual(['package-lock.json', 'package.json']);
    }

    expect(versions(run.batch)).toEqual({ pkg: to, lock: to, lockRoot: to });
    expect(porcelain(run.batch)).toBe('');
    const subjects = mustRun('git', ['log', '--format=%s', 'origin/master..HEAD'], run.batch)
      .split(/\r?\n/u)
      .filter((s) => s.startsWith('chore(build): bump version'));

    expect(subjects).toHaveLength(bumps);
  });

  it('targets origin/master’s version bumped by the kind once master moved', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
    const pkg = JSON.parse(readFileSync(join(run.batch, 'package.json'), 'utf8')) as object;
    const moved = `${JSON.stringify({ ...pkg, version: '1.4.0' }, null, 2)}\n`;
    advanceOrigin(
      root,
      run.bare,
      { write: { 'package.json': moved } },
      'chore(build): bump version — elsewhere',
    );
    mustRun('git', ['fetch', '-q', 'origin'], run.batch);

    const r = runBump(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', kind: 'patch', from: '1.0.0', to: '1.4.1' });
    expect(r.json.commit).toBe(headSha(run.batch));
    expect(versions(run.batch)).toEqual({ pkg: '1.4.1', lock: '1.4.1', lockRoot: '1.4.1' });
    expect(porcelain(run.batch)).toBe('');
  });

  it.each<{ name: string; changes: Changes }>([
    // A rename, not `remove`: the clone checks out under the global autocrlf and
    // the fixture config then turns it off, so `git rm` sees package.json as modified.
    { name: 'has no package.json', changes: { rename: [['package.json', 'package.old.json']] } },
    { name: 'has a package.json that is not JSON', changes: { write: { 'package.json': 'x\n' } } },
  ])(
    'fails at step version, touching nothing, when origin/master $name',
    TIMEOUT,
    ({ changes }) => {
      const run = makeRun();
      commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
      advanceOrigin(root, run.bare, changes, 'chore: break package.json');
      mustRun('git', ['fetch', '-q', 'origin'], run.batch);
      const head = headSha(run.batch);

      const r = runBump(run.batch);

      expect(r.json).toMatchObject({ status: 'failed', commit: null });
      expect(r.json.errors.map((e) => e.step)).toEqual(['version']);
      expect(headSha(run.batch)).toBe(head);
      expect(porcelain(run.batch)).toBe('');
      expect(versions(run.batch)).toEqual({ pkg: '1.0.0', lock: '1.0.0', lockRoot: '1.0.0' });
    },
  );

  it.each([
    { reason: 'nothing-to-bump', branch: 'ship/r', subjects: [] },
    { reason: 'not-run-batch', branch: 'feature/x', subjects: ['feat(a): one'] },
  ])('refuses $reason and touches nothing', TIMEOUT, ({ reason, branch, subjects }) => {
    const run = makeRun(branch);
    subjects.forEach((s, i) => commitChanges(run.batch, { write: { [`f${String(i)}`]: s } }, s));
    const head = headSha(run.batch);

    const r = runBump(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason, commit: null });
    expect(headSha(run.batch)).toBe(head);
    expect(porcelain(run.batch)).toBe('');
    expect(versions(run.batch).pkg).toBe('1.0.0');
  });

  it('restores both files when the commit hook fails', TIMEOUT, () => {
    const run = makeRun();
    const head = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
    installHook(root, run.main, 'pre-commit', `#!/bin/sh\necho "${HOOK_SAYS}"\nexit 1\n`);

    const r = runBump(run.batch);

    expect(r.json).toMatchObject({ status: 'failed', commit: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['commit']);
    expect(readFileSync(r.json.log ?? '', 'utf8')).toContain(HOOK_SAYS);
    expect(headSha(run.batch)).toBe(head);
    expect(porcelain(run.batch)).toBe('');
    expect(versions(run.batch)).toEqual({ pkg: '1.0.0', lock: '1.0.0', lockRoot: '1.0.0' });
  });
});

/** The paths a commit changes against its first parent. */
function commitPaths(dir: string, sha: string): string[] {
  return mustRun('git', ['diff-tree', '-r', '--no-commit-id', '--name-only', sha], dir)
    .split(/\r?\n/u)
    .filter((p) => p !== '')
    .sort(compareStrings);
}

/** Run `bump` on the batch, recording the log dir it leaves. */
function runBump(batch: string): ReturnType<typeof runCli<BumpResult>> {
  const r = runCli<BumpResult>(['bump', batch]);
  if (r.json.log !== null) logDirs.add(dirname(r.json.log));

  return r;
}

/** The `version` fields of a checkout's package.json and lockfile. */
function versions(dir: string): { pkg: string; lock: string; lockRoot: string } {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
    version: string;
    packages: Record<string, { version: string }>;
  };

  return { pkg: pkg.version, lock: lock.version, lockRoot: lock.packages['']?.version ?? '' };
}

/** An npm fixture repo (version 1.0.0, lockfile) with a bare origin and a batch on `branch`. */
function makeRun(branch = 'ship/r'): FixtureRun {
  return withOriginAndBatch(root, makeFixtureRepo(root), branch);
}
