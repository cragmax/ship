/**
 * Plain fixture repos (per-test `mkdtemp` roots) with a bare `origin`: the
 * batch worktree sits on `ship/r`, and `origin/master` moves on from a
 * scratch clone, so `sync-master` has something to merge.
 *
 * @integrationTier standalone
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import {
  advanceOrigin,
  advanceOriginByMerge,
  commitChanges,
  gitPathList,
  headSha,
  installHook,
  makeGitRepo,
  parents,
  snapshot,
  withOriginAndBatch,
  type FixtureRun,
} from '../helpers/worktree-fixture-git.js';
import { runSyncMaster } from '../../ship/test/helpers/worktree-cli-fixture.js';
import { addWorktree, porcelain } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const ADR_INDEX = 'docs/adr/readme.md';
const HOOK_SAYS = 'fixture hook: commit refused';

let root: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-sync-')));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

/** A repo with a bare origin and a batch worktree on `ship/r` cut from `master`. */
function makeRun(base: Record<string, string>): FixtureRun {
  return withOriginAndBatch(root, makeGitRepo(root, base));
}

/** A checkout's unmerged paths. */
function unmerged(dir: string): string[] {
  return gitPathList(dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
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

    const r = runSyncMaster(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', outcome: 'merged', pending: [] });
    expect(r.json.commit).toBe(headSha(run.batch));
    expect(r.json.upstream).toBe(theirs);
    expect(parents(run.batch)).toEqual([ours, theirs]);
    expect(show(run.batch, 'docs/guide.md')).toBe('master\n');
    expect(show(run.batch, 'notes.md')).toBe('batch\n');
    expect(porcelain(run.batch)).toBe('');
  });

  it('reports up-to-date and mutates nothing when origin/master is merged', TIMEOUT, () => {
    const run = makeRun({ 'notes.md': 'one\n' });
    commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    const before = snapshot(run.batch);

    const r = runSyncMaster(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      outcome: 'up-to-date',
      commit: null,
      upstream: headSha(run.main),
    });
    expect(snapshot(run.batch)).toEqual(before);
  });

  it('reports the origin/master it found already merged as upstream', TIMEOUT, () => {
    const run = makeRun({ 'notes.md': 'one\n', 'docs/guide.md': 'guide\n' });
    commitChanges(run.batch, { write: { 'notes.md': 'batch\n' } }, 'feat: batch');
    const theirs = advanceOrigin(root, run.bare, { write: { 'docs/guide.md': 'master\n' } });
    runSyncMaster(run.batch);

    const r = runSyncMaster(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      outcome: 'up-to-date',
      commit: null,
      upstream: theirs,
    });
  });

  it('refuses a src/ conflict without merging, naming the path and what landed it', TIMEOUT, () => {
    const run = makeRun({ 'src/x.ts': 'one\nshared\nthree\n', 'notes.md': 'n\n' });
    commitChanges(run.batch, { write: { 'src/x.ts': 'one\nbatch\nthree\n' } }, 'feat: batch');
    advanceOrigin(root, run.bare, { write: { 'src/x.ts': 'one\nmaster\nthree\n' } }, 'fix: x');
    advanceOrigin(root, run.bare, { write: { 'notes.md': 'master\n' } }, 'docs: notes only');
    const before = snapshot(run.batch);

    const r = runSyncMaster(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      status: 'refused',
      reason: 'code-conflict',
      outcome: null,
      upstream: null,
    });
    expect(r.json.conflicts).toEqual([{ path: 'src/x.ts', kind: 'code', landedBy: ['fix: x'] }]);
    expect(snapshot(run.batch)).toEqual(before);
  });

  it('names the PR merge commit, not its inner commits, as what landed a conflict', TIMEOUT, () => {
    const run = makeRun({ 'src/x.ts': 'one\nshared\nthree\n' });
    commitChanges(run.batch, { write: { 'src/x.ts': 'one\nbatch\nthree\n' } }, 'feat: batch');
    advanceOriginByMerge(
      root,
      run.bare,
      [
        { write: { 'src/x.ts': 'one\nmaster\nthree\n' } },
        { write: { 'src/x.ts': 'one\nm2\nthree\n' } },
      ],
      'Merge pull request #77 from fixture/ship-x',
    );

    const r = runSyncMaster(run.batch);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'code-conflict' });
    expect(r.json.conflicts[0]?.landedBy).toEqual(['Merge pull request #77 from fixture/ship-x']);
  });

  it('fails step version on a prerelease bump, merging nothing', TIMEOUT, () => {
    const pkg = (v: string): string => `{\n  "name": "p",\n  "version": "${v}"\n}\n`;
    const run = makeRun({ 'package.json': pkg('1.0.0') });
    const ours = commitChanges(run.batch, { write: { 'package.json': pkg('1.0.1-rc.1') } }, 'o');
    advanceOrigin(root, run.bare, { write: { 'package.json': pkg('1.1.0') } }, 'chore: theirs');

    const r = runSyncMaster(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', outcome: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['version']);
    expect(snapshot(run.batch)).toMatchObject({ head: ours, porcelain: '', merging: false });
  });

  it.each([
    { name: 'beside a version-line conflict', ours: '1.0.1', theirs: '1.1.0' },
    { name: 'with no bump', ours: '1.0.0', theirs: '1.0.0' },
  ])('refuses a package.json scripts conflict $name as code', TIMEOUT, (c) => {
    // Both sides add a different script after the same line.
    const pkg = (v: string, script = ''): string =>
      `{\n  "name": "p",\n  "version": "${v}",\n  "scripts": {\n    "a": "x"${script}\n  }\n}\n`;
    const run = makeRun({ 'package.json': pkg('1.0.0') });
    const ours = pkg(c.ours, ',\n    "b": "y"');
    commitChanges(run.batch, { write: { 'package.json': ours } }, 'chore: ours');
    const theirs = pkg(c.theirs, ',\n    "c": "z"');
    advanceOrigin(root, run.bare, { write: { 'package.json': theirs } }, 'chore: theirs');
    const before = snapshot(run.batch);

    const r = runSyncMaster(run.batch);

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

      const r = runSyncMaster(run.batch);

      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ status: 'refused', reason: 'slices-live' });
      expect(r.json.errors[0]?.message).toContain(slice);
      expect({ ...snapshot(run.batch), origin: headSha(run.batch, 'origin/master') }).toEqual(
        before,
      );
    },
  );
});

describe('sync-master doc-index resolution', () => {
  /** A batch whose merge of origin/master stops on a `docs/adr/readme.md` conflict. */
  function conflictedRun(): FixtureRun & { readonly ours: string; readonly theirs: string } {
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

    const start = runSyncMaster(run.batch);

    expect(start.code).toBe(1);
    expect(start.json).toMatchObject({
      status: 'conflict',
      outcome: 'needs-resolution',
      pending: [ADR_INDEX],
      commit: null,
      upstream: null,
    });
    expect(snapshot(run.batch)).toMatchObject({ head: run.ours, merging: true });

    // The resolver edits the file and never stages it.
    writeFileSync(join(run.batch, ADR_INDEX), '# ADRs\n\n- ours\n- theirs\n');
    const done = runSyncMaster(run.batch, '--continue');

    expect(done.code).toBe(0);
    expect(done.json).toMatchObject({
      status: 'ok',
      outcome: 'merged',
      pending: [],
      upstream: run.theirs,
    });
    expect(done.json.commit).toBe(headSha(run.batch));
    expect(parents(run.batch)).toEqual([run.ours, run.theirs]);
    expect(show(run.batch, ADR_INDEX)).toBe('# ADRs\n\n- ours\n- theirs\n');
    expect(show(run.batch, 'notes.md')).toBe('master\n');
    expect(snapshot(run.batch)).toMatchObject({ porcelain: '', merging: false });
  });

  it('refuses --continue while markers remain, staging nothing', TIMEOUT, () => {
    const run = conflictedRun();
    runSyncMaster(run.batch);
    const resolved = '# ADRs\n\n- ours\n- theirs\n';
    writeFileSync(join(run.batch, ADR_INDEX), `${resolved}<<<<<<< HEAD\n=======\n>>>>>>> x\n`);

    const r = runSyncMaster(run.batch, '--continue');

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'unresolved', pending: [ADR_INDEX] });
    expect(unmerged(run.batch)).toEqual([ADR_INDEX]);
    expect(snapshot(run.batch)).toMatchObject({ head: run.ours, merging: true });
  });

  it('aborts the merge when the commit hook fails', TIMEOUT, () => {
    const run = conflictedRun();
    runSyncMaster(run.batch);
    writeFileSync(join(run.batch, ADR_INDEX), '# ADRs\n\n- ours\n- theirs\n');
    installHook(root, run.main, 'pre-commit', `#!/bin/sh\necho "${HOOK_SAYS}"\nexit 1\n`);

    const r = runSyncMaster(run.batch, '--continue');

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', outcome: null, commit: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['commit']);
    expect(readFileSync(r.json.logs.at(-1) ?? '', 'utf8')).toContain(HOOK_SAYS);
    expect(snapshot(run.batch)).toMatchObject({ head: run.ours, porcelain: '', merging: false });
  });

  it('hands a home glossary conflict to the resolver, then --continue merges it', TIMEOUT, () => {
    const glossary = 'server-pool/GLOSSARY.md';
    const run = makeRun({ [glossary]: '# Pool\n\n- base\n' });
    const ours = commitChanges(run.batch, { write: { [glossary]: '# Pool\n\n- ours\n' } }, 'ours');
    const theirs = advanceOrigin(root, run.bare, { write: { [glossary]: '# Pool\n\n- theirs\n' } });

    const start = runSyncMaster(run.batch);

    expect(start.code).toBe(1);
    expect(start.json).toMatchObject({ status: 'conflict', pending: [glossary] });

    writeFileSync(join(run.batch, glossary), '# Pool\n\n- ours\n- theirs\n');
    const done = runSyncMaster(run.batch, '--continue');

    expect(done.json).toMatchObject({ status: 'ok', outcome: 'merged', upstream: theirs });
    expect(parents(run.batch)).toEqual([ours, theirs]);
  });

  it('hands conflicts in all nine doc indexes, root and home, to the resolver', TIMEOUT, () => {
    const indexes = [
      'GLOSSARY.md',
      'docs/adr/readme.md',
      'docs/platform-facts/readme.md',
      'ph-plugin/GLOSSARY.md',
      'ph-plugin/docs/adr/readme.md',
      'server-pool/GLOSSARY.md',
      'server-pool/docs/adr/readme.md',
      'ship/GLOSSARY.md',
      'ship/docs/adr/readme.md',
    ];
    const side = (text: string): Record<string, string> =>
      Object.fromEntries(indexes.map((path) => [path, `# Index\n\n- ${text}\n`]));
    const run = makeRun(side('base'));
    commitChanges(run.batch, { write: side('ours') }, 'ours');
    advanceOrigin(root, run.bare, { write: side('theirs') });

    const r = runSyncMaster(run.batch);

    expect(r.json).toMatchObject({ status: 'conflict', pending: indexes });
  });

  it('refuses a conflict in a home file that is not an index', TIMEOUT, () => {
    const notIndex = 'server-pool/CLAUDE.md';
    const run = makeRun({ [notIndex]: '# Pool\n\nbase\n' });
    commitChanges(run.batch, { write: { [notIndex]: '# Pool\n\nours\n' } }, 'ours');
    advanceOrigin(root, run.bare, { write: { [notIndex]: '# Pool\n\ntheirs\n' } }, 'docs: pool');
    const before = snapshot(run.batch);

    const r = runSyncMaster(run.batch);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'code-conflict' });
    expect(r.json.conflicts).toEqual([{ path: notIndex, kind: 'code', landedBy: ['docs: pool'] }]);
    expect(snapshot(run.batch)).toEqual(before);
  });

  it('refuses --continue without a merge in progress', TIMEOUT, () => {
    const run = makeRun({ 'notes.md': 'n\n' });
    const before = snapshot(run.batch);

    const r = runSyncMaster(run.batch, '--continue');

    expect(r.json).toMatchObject({ status: 'refused', reason: 'no-merge-in-progress' });
    expect(snapshot(run.batch)).toEqual(before);
  });
});
