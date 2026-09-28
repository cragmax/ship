/**
 * Fixture repos (per-test `mkdtemp` roots; npm ones where the refresh runs)
 * with a bare `origin`: the batch worktree sits on `ship/r`, and
 * `origin/master` moves on from a scratch clone, so `sync-master` has
 * something to merge.
 *
 * @integrationTier standalone
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import type { SyncMasterResult } from '../../tooling/worktree/types-run.js';
import {
  advanceOrigin,
  commitChanges,
  gitPathList,
  headSha,
  makeBareOrigin,
  makeGitRepo,
  stagedNames,
} from '../helpers/worktree-fixture-git.js';
import {
  addWorktree,
  makeFixtureRepo,
  mustRun,
  porcelain,
  prepareTemplate,
  runCli,
  runIn,
} from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const ADR_INDEX = 'docs/adr/readme.md';
const HOOK_SAYS = 'fixture hook: commit refused';
// What the npm fixture's `build` script writes (`dist/` is ignored).
const BUILT = 'dist/index.js';
// The npm fixture's `build` script fails while this file exists.
const FAIL_BUILD = 'FAIL_BUILD';
const LOCKFILE = 'package-lock.json';

let root: string;
// The CLI leaves its `freshLogDir` logs in the OS temp dir for its caller.
const logDirs = new Set<string>();

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-sync-')));
});

afterEach(() => {
  try {
    for (const dir of [root, ...logDirs]) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
  logDirs.clear();
});

/** Run `sync-master` on the batch, recording the log dirs it leaves. */
function sync(batch: string, ...flags: string[]): ReturnType<typeof runCli<SyncMasterResult>> {
  const r = runCli<SyncMasterResult>(['sync-master', batch, ...flags]);
  for (const log of r.json.logs) logDirs.add(dirname(log));
  return r;
}

interface Run {
  readonly main: string;
  readonly bare: string;
  readonly batch: string;
}

/** A repo with a bare origin and a batch worktree on `ship/r` cut from `master`. */
function makeRun(base: Record<string, string>): Run {
  const main = makeGitRepo(root, base);
  const bare = makeBareOrigin(root, main);
  const batch = addWorktree(main, `${root}/batch`, 'ship/r');
  return { main, bare, batch };
}

/** The parents of a commit, in order. */
function parents(dir: string, ref = 'HEAD'): string[] {
  return mustRun('git', ['rev-list', '--parents', '-n', '1', ref], dir).trim().split(' ').slice(1);
}

/** HEAD, porcelain, staged set and merge state of a checkout — what "nothing mutated" compares. */
function snapshot(dir: string): Record<string, unknown> {
  return {
    head: headSha(dir),
    porcelain: porcelain(dir),
    staged: stagedNames(dir),
    merging: runIn('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], dir).exitCode === 0,
  };
}

/** A checkout's unmerged paths. */
function unmerged(dir: string): string[] {
  return gitPathList(dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
}

/** Point the fixture repo's hooks at a `pre-commit` that prints {@link HOOK_SAYS} and exits 1. */
function installFailingHook(main: string): void {
  const hooks = `${root}/hooks`;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(`${hooks}/pre-commit`, `#!/bin/sh\necho "${HOOK_SAYS}"\nexit 1\n`);
  chmodSync(`${hooks}/pre-commit`, 0o755);
  mustRun('git', ['config', 'core.hooksPath', hooks], main);
}

/** A checkout's file (the tests pin `porcelain` empty, so it is `HEAD`'s). */
function show(dir: string, path: string): string {
  return readFileSync(join(dir, path), 'utf8');
}

describe('sync-master', () => {
  it('merges a clean divergence as a two-parent merge commit', TIMEOUT, () => {
    const run = makeRun({ 'notes.md': 'one\n', 'docs/guide.md': 'guide\n' });
    const ours = commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    const theirs = advanceOrigin(root, run.bare, { write: { 'docs/guide.md': 'master\n' } });

    const r = sync(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged', pending: [] });
    expect(r.json.commit).toBe(headSha(run.batch));
    expect(parents(run.batch)).toEqual([ours, theirs]);
    expect(show(run.batch, 'docs/guide.md')).toBe('master\n');
    expect(show(run.batch, 'notes.md')).toBe('batch\n');
    expect(porcelain(run.batch)).toBe('');
  });

  it('reports up-to-date and mutates nothing when origin/master is merged', TIMEOUT, () => {
    const run = makeRun({ 'notes.md': 'one\n' });
    commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    const before = snapshot(run.batch);

    const r = sync(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', outcome: 'up-to-date', commit: null });
    expect(snapshot(run.batch)).toEqual(before);
  });

  it('refuses a src/ conflict without merging, naming the path and what landed it', TIMEOUT, () => {
    const run = makeRun({ 'src/x.ts': 'one\nshared\nthree\n', 'notes.md': 'n\n' });
    commitChanges(run.batch, { write: { 'src/x.ts': 'one\nbatch\nthree\n' } }, 'feat: batch');
    advanceOrigin(root, run.bare, { write: { 'src/x.ts': 'one\nmaster\nthree\n' } }, 'fix: x');
    advanceOrigin(root, run.bare, { write: { 'notes.md': 'master\n' } }, 'docs: notes only');
    const before = snapshot(run.batch);

    const r = sync(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'code-conflict', outcome: null });
    expect(r.json.conflicts).toEqual([{ path: 'src/x.ts', kind: 'code', landedBy: ['fix: x'] }]);
    expect(snapshot(run.batch)).toEqual(before);
  });

  it('refuses a package.json conflict as code', TIMEOUT, () => {
    const pkg = (v: string): string => `{\n  "name": "p",\n  "version": "${v}"\n}\n`;
    const run = makeRun({ 'package.json': pkg('1.0.0') });
    commitChanges(run.batch, { write: { 'package.json': pkg('1.0.1') } }, 'chore: ours');
    advanceOrigin(root, run.bare, { write: { 'package.json': pkg('1.1.0') } }, 'chore: theirs');
    const before = snapshot(run.batch);

    const r = sync(run.batch);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'code-conflict' });
    expect(r.json.conflicts).toEqual([
      { path: 'package.json', kind: 'code', landedBy: ['chore: theirs'] },
    ]);
    expect(snapshot(run.batch)).toEqual(before);
  });

  it(
    'refuses while a slice links its node_modules into the batch, fetching nothing',
    TIMEOUT,
    () => {
      const run = makeRun({ 'notes.md': 'n\n', 'docs/guide.md': 'g\n' });
      commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
      advanceOrigin(root, run.bare, { write: { 'docs/guide.md': 'master\n' } });
      mkdirSync(join(run.batch, 'node_modules', 'dep'), { recursive: true });
      const slice = addWorktree(run.main, `${root}/slice-1-1`, 'slice/r/1-1');
      symlinkSync(join(run.batch, 'node_modules'), join(slice, 'node_modules'), 'junction');
      const before = { ...snapshot(run.batch), origin: headSha(run.batch, 'origin/master') };

      const r = sync(run.batch);

      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ status: 'refused', reason: 'slices-live' });
      expect(r.json.errors[0]?.message).toContain(slice);
      expect({ ...snapshot(run.batch), origin: headSha(run.batch, 'origin/master') }).toEqual(
        before,
      );
    },
  );
});

describe('sync-master batch refresh', () => {
  let templateRoot: string;
  let template: string;

  beforeAll(() => {
    templateRoot = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-sync-tpl-')));
    template = prepareTemplate(templateRoot);
  }, TIMEOUT.timeout);

  afterAll(() => {
    rmSync(templateRoot, { recursive: true, force: true });
  });

  /** An npm fixture repo (build script, `file:` dependency, lockfile) with a bare origin and a batch. */
  function makeNpmRun(): Run {
    const main = makeFixtureRepo(root, template);
    const bare = makeBareOrigin(root, main);
    const batch = addWorktree(main, `${root}/batch`, 'ship/r');
    return { main, bare, batch };
  }

  it.each([
    { changed: 'src/feature.ts', build: true },
    { changed: 'tooling/tool.ts', build: true },
    { changed: 'docs/notes.md', build: false },
  ])('builds before reporting when master changed $changed: $build', TIMEOUT, (c) => {
    const run = makeNpmRun();
    commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    advanceOrigin(root, run.bare, { write: { [c.changed]: 'master\n' } });

    const r = sync(run.batch);

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

    const r = sync(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged', pending: [] });
    expect(r.json.conflicts).toMatchObject([{ path: LOCKFILE, kind: 'lockfile' }]);
    expect(r.json.refreshed).toEqual({ ci: true, build: true });
    expect(parents(run.batch)).toEqual([ours, theirs]);
    // npm rewrote the name from package.json: the lock is regenerated, not either side's.
    expect(show(run.batch, LOCKFILE)).toBe(lock);
    expect(existsSync(join(run.batch, 'node_modules', 'fake-dep', 'index.js'))).toBe(true);
    expect(existsSync(join(run.batch, BUILT))).toBe(true);
    expect(porcelain(run.batch)).toBe('');
  });

  it('keeps a clean merge whose refresh fails, failing step build', TIMEOUT, () => {
    const run = makeNpmRun();
    const ours = commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    const theirs = advanceOrigin(root, run.bare, {
      write: { 'src/feature.ts': 'master\n', [FAIL_BUILD]: '' },
    });

    const r = sync(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', outcome: 'merged' });
    expect(r.json.errors.map((e) => e.step)).toEqual(['build']);
    expect(r.json.commit).toBe(headSha(run.batch));
    expect(parents(run.batch)).toEqual([ours, theirs]);
    expect(snapshot(run.batch)).toMatchObject({ porcelain: '', merging: false });
  });

  it('aborts its merge when the refresh before a resolver fails', TIMEOUT, () => {
    const run = makeNpmRun();
    const ours = commitChanges(run.batch, { write: { [ADR_INDEX]: '- ours\n' } }, 'docs: ours');
    advanceOrigin(root, run.bare, {
      write: { [ADR_INDEX]: '- theirs\n', 'src/feature.ts': 'master\n', [FAIL_BUILD]: '' },
    });

    const r = sync(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', outcome: null, commit: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['build']);
    expect(snapshot(run.batch)).toMatchObject({ head: ours, porcelain: '', merging: false });
  });
});

describe('sync-master doc-index resolution', () => {
  /** A batch whose merge of origin/master stops on a `docs/adr/readme.md` conflict. */
  function conflictedRun(): Run & { readonly ours: string; readonly theirs: string } {
    const run = makeRun({ [ADR_INDEX]: '# ADRs\n\n- base\n', 'notes.md': 'n\n' });
    const ours = commitChanges(run.batch, { write: { [ADR_INDEX]: '# ADRs\n\n- ours\n' } }, 'ours');
    const theirs = advanceOrigin(
      root,
      run.bare,
      { write: { [ADR_INDEX]: '# ADRs\n\n- theirs\n', 'notes.md': 'master\n' } },
      'docs: theirs',
    );
    return { ...run, ours, theirs };
  }

  it('stops for a resolver, then --continue stages by name and commits', TIMEOUT, () => {
    const run = conflictedRun();

    const start = sync(run.batch);

    expect(start.code).toBe(1);
    expect(start.json).toMatchObject({
      status: 'conflict',
      outcome: 'needs-resolution',
      pending: [ADR_INDEX],
      commit: null,
    });
    expect(snapshot(run.batch)).toMatchObject({ head: run.ours, merging: true });

    // The resolver edits the file and never stages it.
    writeFileSync(join(run.batch, ADR_INDEX), '# ADRs\n\n- ours\n- theirs\n');
    const done = sync(run.batch, '--continue');

    expect(done.code).toBe(0);
    expect(done.json).toMatchObject({ status: 'ok', outcome: 'merged', pending: [] });
    expect(done.json.commit).toBe(headSha(run.batch));
    expect(parents(run.batch)).toEqual([run.ours, run.theirs]);
    expect(show(run.batch, ADR_INDEX)).toBe('# ADRs\n\n- ours\n- theirs\n');
    expect(show(run.batch, 'notes.md')).toBe('master\n');
    expect(snapshot(run.batch)).toMatchObject({ porcelain: '', merging: false });
  });

  it('refuses --continue while markers remain, staging nothing', TIMEOUT, () => {
    const run = conflictedRun();
    sync(run.batch);
    const resolved = '# ADRs\n\n- ours\n- theirs\n';
    writeFileSync(join(run.batch, ADR_INDEX), `${resolved}<<<<<<< HEAD\n=======\n>>>>>>> x\n`);

    const r = sync(run.batch, '--continue');

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'unresolved', pending: [ADR_INDEX] });
    expect(unmerged(run.batch)).toEqual([ADR_INDEX]);
    expect(snapshot(run.batch)).toMatchObject({ head: run.ours, merging: true });
  });

  it('aborts the merge when the commit hook fails', TIMEOUT, () => {
    const run = conflictedRun();
    sync(run.batch);
    writeFileSync(join(run.batch, ADR_INDEX), '# ADRs\n\n- ours\n- theirs\n');
    installFailingHook(run.main);

    const r = sync(run.batch, '--continue');

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', outcome: null, commit: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['commit']);
    expect(readFileSync(r.json.logs.at(-1) ?? '', 'utf8')).toContain(HOOK_SAYS);
    expect(snapshot(run.batch)).toMatchObject({ head: run.ours, porcelain: '', merging: false });
  });

  it('refuses --continue without a merge in progress', TIMEOUT, () => {
    const run = makeRun({ 'notes.md': 'n\n' });
    const before = snapshot(run.batch);

    const r = sync(run.batch, '--continue');

    expect(r.json).toMatchObject({ status: 'refused', reason: 'no-merge-in-progress' });
    expect(snapshot(run.batch)).toEqual(before);
  });
});
