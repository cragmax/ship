/**
 * npm fixture repos (per-test `mkdtemp` roots, one shared offline template)
 * with a bare `origin`: the batch worktree sits on `ship/r`, and
 * `origin/master` moves on from a scratch clone, so `sync-master` has
 * something to merge and a batch to refresh.
 *
 * @integrationTier standalone
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  advanceOrigin,
  commitChanges,
  headSha,
  installHook,
  parents,
  snapshot,
  withOriginAndBatch,
  type FixtureRun,
} from '../../../tooling/test/helpers/worktree-fixture-git.js';
import {
  makeFixtureRepo,
  makeTempRoot,
  prebuildNpmTemplate,
  removeTempDirs,
  runSyncMaster,
} from '../helpers/worktree-cli-fixture.js';
import { mustRun, porcelain } from '../../../tooling/test/helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const HOOK_SAYS = 'fixture hook: commit refused';
// What the npm fixture's `build` script writes (`dist/` is ignored).
const BUILT = 'dist/index.js';
// The npm fixture's `build` script fails while this file exists.
const FAIL_BUILD = 'FAIL_BUILD';
const LOCKFILE = 'package-lock.json';

prebuildNpmTemplate();

let root: string;

beforeEach(() => {
  root = makeTempRoot('ph-wt-sync-');
});

afterEach(() => {
  removeTempDirs([root]);
});

/**
 * Point the fixture repo's hooks at a `pre-commit` that appends `MERGE_HEAD`
 * (empty when none) to a log and passes.
 *
 * @returns The log's path.
 */
function recordCommits(main: string): string {
  const log = `${root}/pre-commit.log`;
  installHook(
    root,
    main,
    'pre-commit',
    `#!/bin/sh\ngit rev-parse -q --verify MERGE_HEAD >> "${log}"\nexit 0\n`,
  );

  return log;
}

/** A checkout's file (the tests pin `porcelain` empty, so it is `HEAD`'s). */
function show(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf8');
}

interface Lockfile {
  readonly version: string;
  readonly packages: Record<string, { readonly version?: string } | undefined>;
}

/** A checkout's parsed lockfile. */
function lockOf(dir: string): Lockfile {
  return JSON.parse(show(dir, LOCKFILE)) as Lockfile;
}

/** The `version` fields of a checkout's package.json and lockfile. */
function versionsOf(dir: string): { pkg: string; lock: string; lockRoot: string } {
  const pkg = JSON.parse(show(dir, 'package.json')) as { version: string };
  const lock = lockOf(dir);

  return { pkg: pkg.version, lock: lock.version, lockRoot: lock.packages['']?.version ?? '' };
}

describe('sync-master batch refresh', () => {
  /** An npm fixture (build script, `file:` dependency, lockfile) with a bare origin and a batch. */
  function makeNpmRun(): FixtureRun {
    return withOriginAndBatch(root, makeFixtureRepo(root));
  }

  /** Bump a checkout's version with `npm version` and commit both files. */
  function bumpIn(dir: string, kind: string, message: string): string {
    mustRun('npm', ['version', kind, '--no-git-tag-version'], dir);
    mustRun('git', ['add', '--', 'package.json', LOCKFILE], dir);
    mustRun('git', ['commit', '-q', '-m', message], dir);

    return headSha(dir);
  }

  /** Bump `master` in the main checkout and push it, moving `origin/master`. */
  function bumpOrigin(run: FixtureRun, kind: string, message: string): string {
    const sha = bumpIn(run.main, kind, message);
    mustRun('git', ['push', '-q', 'origin', 'master'], run.main);

    return sha;
  }

  /** An npm run whose batch and `origin/master` each bumped `patch` from the same base. */
  function identicalBumps(): { run: FixtureRun; ours: string; theirs: string } {
    const run = makeNpmRun();
    const ours = bumpIn(run.batch, 'patch', 'chore: ours');
    const theirs = bumpOrigin(run, 'patch', 'chore: theirs');

    return { run, ours, theirs };
  }

  /**
   * Run `sync-master` on `batch`, assert it failed at `step` before committing and left the batch
   * clean at `ours` with no merge in progress, and return the run.
   */
  function expectHeldMergeAborted(
    batch: string,
    ours: string,
    step: string,
  ): ReturnType<typeof runSyncMaster> {
    const r = runSyncMaster(batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', outcome: null, commit: null });
    expect(r.json.errors.map((e) => e.step)).toEqual([step]);
    expect(snapshot(batch)).toMatchObject({ head: ours, porcelain: '', merging: false });

    return r;
  }

  it.each([
    { changed: 'src/feature.ts', build: true },
    { changed: 'tsconfig.json', build: true },
    { changed: 'config/tsconfig.build.json', build: true },
    { changed: 'tooling/tool.ts', build: false },
    { changed: 'docs/notes.md', build: false },
  ])('builds before reporting when master changed $changed: $build', TIMEOUT, (c) => {
    const run = makeNpmRun();
    commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    advanceOrigin(root, run.bare, { write: { [c.changed]: 'master\n' } });

    const r = runSyncMaster(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged' });
    expect(r.json.refreshed).toEqual({ ci: false, build: c.build });
    expect(existsSync(join(run.batch, BUILT))).toBe(c.build);
    expect(porcelain(run.batch)).toBe('');
  });

  it('regenerates a conflicted lockfile, merges, and reinstalls', TIMEOUT, () => {
    const run = makeNpmRun();
    const lock = readFileSync(join(run.batch, LOCKFILE), 'utf8');
    const renamed = (name: string): string =>
      lock.replace('"name": "wt-fixture"', `"name": "${name}"`);
    const ours = commitChanges(run.batch, { write: { [LOCKFILE]: renamed('ours') } }, 'ours');
    const theirs = advanceOrigin(root, run.bare, { write: { [LOCKFILE]: renamed('theirs') } });

    const r = runSyncMaster(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged' });
    expect(r.json.conflicts).toMatchObject([{ path: LOCKFILE, kind: 'lockfile' }]);
    expect(r.json.refreshed).toEqual({ ci: true, build: true });
    expect(parents(run.batch)).toEqual([ours, theirs]);
    // npm rewrote the name from package.json: the lock is regenerated, not either side's.
    expect(show(run.batch, LOCKFILE)).toBe(lock);
    expect(existsSync(join(run.batch, 'node_modules', 'fake-dep', 'index.js'))).toBe(true);
    expect(existsSync(join(run.batch, BUILT))).toBe(true);
    expect(porcelain(run.batch)).toBe('');
  });

  it('resolves a version-line conflict to master bumped by the branch bump', TIMEOUT, () => {
    const run = makeNpmRun();
    const baseLock = lockOf(run.batch);
    const ours = bumpIn(run.batch, 'patch', 'chore: ours');
    const theirs = bumpOrigin(run, 'minor', 'chore: theirs');

    const r = runSyncMaster(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged' });
    expect(r.json.conflicts).toEqual([
      { path: LOCKFILE, kind: 'lockfile', landedBy: ['chore: theirs'] },
      { path: 'package.json', kind: 'package', landedBy: ['chore: theirs'] },
    ]);
    expect(r.json.version).toEqual({
      base: '1.0.0',
      ours: '1.0.1',
      theirs: '1.1.0',
      result: '1.1.1',
    });
    expect(r.json.upstream).toBe(theirs);
    expect(versionsOf(run.batch)).toEqual({ pkg: '1.1.1', lock: '1.1.1', lockRoot: '1.1.1' });
    expect(lockOf(run.batch).packages['node_modules/fake-dep']).toEqual(
      baseLock.packages['node_modules/fake-dep'],
    );
    expect(parents(run.batch)).toEqual([ours, theirs]);
    expect(porcelain(run.batch)).toBe('');
  });

  it('re-bumps an identical bump, committing the merge through the hooks', TIMEOUT, () => {
    const { run, ours, theirs } = identicalBumps();
    const hookLog = recordCommits(run.main);

    const r = runSyncMaster(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged' });
    expect(r.json.version?.result).toBe('1.0.2');
    expect(versionsOf(run.batch)).toEqual({ pkg: '1.0.2', lock: '1.0.2', lockRoot: '1.0.2' });
    expect(parents(run.batch)).toEqual([ours, theirs]);
    // The hook saw MERGE_HEAD: it ran for this merge's own commit.
    expect(readFileSync(hookLog, 'utf8').trim()).toBe(theirs);
    expect(porcelain(run.batch)).toBe('');
  });

  it('takes master version when only master bumped', TIMEOUT, () => {
    const run = makeNpmRun();
    commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    bumpOrigin(run, 'patch', 'chore: theirs');

    const r = runSyncMaster(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged' });
    expect(r.json.version).toEqual({
      base: '1.0.0',
      ours: '1.0.0',
      theirs: '1.0.1',
      result: '1.0.1',
    });
    expect(r.json.conflicts.filter((c) => c.kind === 'package')).toEqual([]);
    expect(versionsOf(run.batch).pkg).toBe('1.0.1');
  });

  it('keeps a clean merge whose refresh fails, failing step build', TIMEOUT, () => {
    const run = makeNpmRun();
    const ours = commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    const theirs = advanceOrigin(root, run.bare, {
      write: { 'src/feature.ts': 'master\n', [FAIL_BUILD]: '' },
    });

    const r = runSyncMaster(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', outcome: 'merged' });
    expect(r.json.errors.map((e) => e.step)).toEqual(['build']);
    expect(r.json.commit).toBe(headSha(run.batch));
    expect(r.json.upstream).toBe(theirs);
    expect(parents(run.batch)).toEqual([ours, theirs]);
    expect(snapshot(run.batch)).toMatchObject({ porcelain: '', merging: false });
  });

  it('aborts its held merge when the refresh before the commit fails', TIMEOUT, () => {
    const { run, ours } = identicalBumps();
    advanceOrigin(root, run.bare, {
      write: { 'src/feature.ts': 'master\n', [FAIL_BUILD]: '' },
    });

    expectHeldMergeAborted(run.batch, ours, 'build');
  });

  it('aborts its held merge when the commit hook fails', TIMEOUT, () => {
    const { run, ours } = identicalBumps();
    installHook(root, run.main, 'pre-commit', `#!/bin/sh\necho "${HOOK_SAYS}"\nexit 1\n`);

    const r = expectHeldMergeAborted(run.batch, ours, 'commit');
    expect(readFileSync(r.json.logs.at(-1) ?? '', 'utf8')).toContain(HOOK_SAYS);
  });
});
