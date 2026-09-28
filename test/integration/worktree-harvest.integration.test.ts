/**
 * Plain fixture repos (per-test `mkdtemp` roots, no npm template — harvest
 * and staged-guard never install or build), each holding a batch worktree
 * and the slice worktrees whose commits it harvests; never this
 * repository's own worktrees. Case-collision and case-rename cases are
 * win32-only: that filesystem behaviour has been observed there alone.
 *
 * @integrationTier standalone
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import { harvest } from '../../tooling/worktree/harvest.js';
import type { HarvestResult, StagedGuardResult } from '../../tooling/worktree/types.js';
import {
  commitChanges,
  headSha,
  makeGitRepo,
  stagedNames,
  untrackedNames,
  type Changes,
} from '../helpers/worktree-fixture-git.js';
import { addWorktree, mustRun, porcelain, runCli, runIn } from '../helpers/worktree-fixture.js';

const WIN32 = process.platform === 'win32';
const TIMEOUT = { timeout: 60_000 };

let root: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-harvest-')));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

interface Pair {
  readonly main: string;
  readonly batch: string;
  readonly sha: string;
}

/**
 * A repo whose `ship/batch` worktree and `slice-1` worktree both start at
 * the base commit; the slice commits `slice`, then the batch commits `batch`.
 */
function slicePair(base: Record<string, string>, slice: Changes, batch?: Changes): Pair {
  const main = makeGitRepo(root, base);
  const batchWt = addWorktree(main, `${root}/batch`, 'ship/batch');
  const sliceWt = addWorktree(main, `${root}/slice`, 'slice-1', 'ship/batch');
  const sha = commitChanges(sliceWt, slice, 'S');
  if (batch !== undefined) commitChanges(batchWt, batch, 'B');
  return { main, batch: batchWt, sha };
}

/** HEAD, porcelain and staged set of a checkout — what "nothing touched" compares. */
function snapshot(dir: string): { head: string; porcelain: string; staged: string[] } {
  return { head: headSha(dir), porcelain: porcelain(dir), staged: stagedNames(dir) };
}

describe('harvest', () => {
  it(
    'stages exactly the slice commit in the batch, then staged-guard accepts its file list',
    TIMEOUT,
    () => {
      const main = makeGitRepo(root, {
        'mod.txt': 'mod v1\n',
        'del.txt': 'delete me\n',
        'old-name.txt': 'a file whose content survives the rename unchanged\n',
        'skill.md': '# skill\n',
      });
      const batch = addWorktree(main, `${root}/batch`, 'ship/batch');
      commitChanges(batch, { write: { 'p.txt': 'landed slice P\n' } }, 'P');
      const slice = addWorktree(main, `${root}/slice`, 'slice-1', 'ship/batch');
      const sha = commitChanges(
        slice,
        {
          rename: [
            ['old-name.txt', 'new-name.txt'],
            ['skill.md', 'SKILL.md'],
          ],
          // A space and non-ASCII letters: git C-quotes the latter outside `-z`.
          write: {
            'added.txt': 'added\n',
            'mod.txt': 'mod v2\n',
            'dir with space/naïve café.txt': 'unicode\n',
          },
          remove: ['del.txt'],
        },
        'S',
      );
      // Q edits P's file, so a transport that re-applies P (a range from
      // master rather than sha^..sha) conflicts instead of picking empty.
      commitChanges(batch, { write: { 'p.txt': 'landed slice P, amended by Q\n' } }, 'Q');

      const run = runCli<HarvestResult>(['harvest', batch, sha.slice(0, 10)]);

      expect(run.code).toBe(0);
      expect(run.json.status).toBe('ok');
      expect(run.json.sha).toBe(sha);
      expect(run.json.files).toEqual([
        'SKILL.md',
        'added.txt',
        'del.txt',
        'dir with space/naïve café.txt',
        'mod.txt',
        'new-name.txt',
        'old-name.txt',
        'skill.md',
      ]);
      expect(mustRun('git', ['diff', '--cached', '--no-renames'], batch)).toBe(
        mustRun('git', ['diff', '--no-renames', `${sha}^`, sha], batch),
      );
      expect(mustRun('git', ['diff'], batch)).toBe('');
      expect(untrackedNames(batch)).toEqual([]);
      expect(readdirSync(batch)).toContain('SKILL.md');
      expect(readdirSync(batch)).not.toContain('skill.md');

      const guard = runCli<StagedGuardResult>(['staged-guard', batch, ...run.json.files]);
      expect(guard.code).toBe(0);
      expect(guard.json.status).toBe('ok');
      expect(guard.json.staged).toEqual(run.json.files);
    },
  );

  it('reports a content conflict and leaves the batch clean at its HEAD', TIMEOUT, () => {
    const { batch, sha } = slicePair(
      { 'mod.txt': 'one\nshared\nthree\n' },
      { write: { 'mod.txt': 'one\nslice\nthree\n', 'fresh.txt': 'fresh\n' } },
      { write: { 'mod.txt': 'one\nbatch\nthree\n' } },
    );
    const head = headSha(batch);

    const run = runCli<HarvestResult>(['harvest', batch, sha]);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('conflict');
    expect(run.json.conflicts).toEqual(['mod.txt']);
    expect(run.json.rolledBack).toBe(true);
    expect(porcelain(batch)).toBe('');
    expect(headSha(batch)).toBe(head);
    expect(existsSync(join(batch, 'fresh.txt'))).toBe(false);
  });

  it.each([
    {
      shape: 'add/add',
      base: {},
      slice: { write: { 'addadd.txt': 'slice side\n' } },
      batch: { write: { 'addadd.txt': 'batch side\n' } },
      conflicts: ['addadd.txt'],
    },
    {
      shape: 'modify/delete',
      base: { 'moddel.txt': 'base\n' },
      slice: { write: { 'moddel.txt': 'slice edit\n' } },
      batch: { remove: ['moddel.txt'] },
      conflicts: ['moddel.txt'],
    },
    {
      shape: 'rename/rename',
      base: { 'x.txt': 'a file renamed differently on each side\n' },
      slice: { rename: [['x.txt', 'y.txt']] as const },
      batch: { rename: [['x.txt', 'z.txt']] as const },
      conflicts: ['x.txt', 'y.txt', 'z.txt'],
    },
  ])(
    'reports a $shape conflict with its unmerged paths and rolls back',
    TIMEOUT,
    ({ base, slice, batch: batchChanges, conflicts }) => {
      const { batch, sha } = slicePair(base, slice, batchChanges);
      const head = headSha(batch);

      const run = runCli<HarvestResult>(['harvest', batch, sha]);

      expect(run.code).toBe(1);
      expect(run.json.status).toBe('conflict');
      expect(run.json.conflicts).toEqual(conflicts);
      expect(porcelain(batch)).toBe('');
      expect(untrackedNames(batch)).toEqual([]);
      expect(headSha(batch)).toBe(head);
    },
  );

  // The slice is cut before the batch gains foo.txt: on win32 a checkout
  // already tracking foo.txt cannot author Foo.txt at all.
  it.skipIf(!WIN32)(
    'reports a case collision git accepts silently and restores the batch file',
    TIMEOUT,
    () => {
      const { batch, sha } = slicePair(
        {},
        { write: { 'Foo.txt': 'slice Foo\n' } },
        { write: { 'foo.txt': 'batch foo\n' } },
      );

      const run = runCli<HarvestResult>(['harvest', batch, sha]);

      expect(run.code).toBe(1);
      expect(run.json.status).toBe('conflict');
      expect(run.json.conflicts).toEqual(['foo.txt']);
      expect(run.json.rolledBack).toBe(true);
      expect(porcelain(batch)).toBe('');
      expect(readdirSync(batch)).toContain('foo.txt');
      expect(readFileSync(join(batch, 'foo.txt'), 'utf8')).toBe('batch foo\n');
    },
  );

  it.each([
    {
      dirt: 'an untracked file',
      make: (batch: string) => writeFileSync(join(batch, 'stray.txt'), 'stray\n'),
      survives: (batch: string) => expect(untrackedNames(batch)).toEqual(['stray.txt']),
    },
    {
      dirt: 'a staged change',
      make: (batch: string) => {
        writeFileSync(join(batch, 'staged.txt'), 'staged\n');
        mustRun('git', ['add', '--', 'staged.txt'], batch);
      },
      survives: (batch: string) => expect(stagedNames(batch)).toEqual(['staged.txt']),
    },
    {
      dirt: 'an unstaged modification',
      make: (batch: string) => writeFileSync(join(batch, 'base.txt'), 'edited\n'),
      survives: (batch: string) => expect(porcelain(batch)).toBe('M base.txt'),
    },
    {
      dirt: 'a merge in progress with an empty porcelain',
      make: (batch: string) => {
        // The merged side must have diverged: merging an ancestor starts no merge.
        const side = mustRun(
          'git',
          ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'side'],
          batch,
        ).trim();
        commitChanges(batch, {}, 'batch side');
        mustRun('git', ['merge', '--no-ff', '--no-commit', side], batch);
        expect(porcelain(batch)).toBe('');
      },
      survives: (batch: string) =>
        expect(runIn('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], batch).exitCode).toBe(0),
    },
    {
      dirt: 'a cherry-pick stopped as empty with an empty porcelain',
      make: (batch: string) => {
        // Picking HEAD's own change onto HEAD comes out empty: git 2.55 stops
        // with exit 1 and CHERRY_PICK_HEAD set, the porcelain clean.
        commitChanges(batch, { write: { 'same.txt': 'same\n' } }, 'batch same');
        const again = mustRun(
          'git',
          ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD~1', '-m', 'same again'],
          batch,
        ).trim();
        expect(runIn('git', ['cherry-pick', again], batch).exitCode).toBe(1);
        expect(porcelain(batch)).toBe('');
      },
      survives: (batch: string) =>
        expect(
          runIn('git', ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], batch).exitCode,
        ).toBe(0),
    },
  ])('refuses a batch holding $dirt and touches nothing', TIMEOUT, ({ make, survives }) => {
    const { batch, sha } = slicePair(
      { 'base.txt': 'base\n' },
      { write: { 'slice-added.txt': 'slice\n' } },
    );
    make(batch);
    const head = headSha(batch);

    const run = runCli<HarvestResult>(['harvest', batch, sha]);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('refused');
    expect(run.json.reason).toBe('batch-dirty');
    survives(batch);
    expect(headSha(batch)).toBe(head);
    expect(existsSync(join(batch, 'slice-added.txt'))).toBe(false);
  });

  it.each([
    {
      name: 'a nonexistent sha',
      sha: (_slice: string) => '0123456789abcdef0123456789abcdef01234567',
    },
    {
      name: 'a merge commit',
      sha: (slice: string) => {
        const other = mustRun(
          'git',
          ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'other'],
          slice,
        ).trim();
        return mustRun(
          'git',
          ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-p', other, '-m', 'merge'],
          slice,
        ).trim();
      },
    },
    { name: 'an empty commit', sha: (slice: string) => commitChanges(slice, {}, 'empty') },
  ])('fails preconditions for $name and leaves the batch alone', TIMEOUT, ({ sha }) => {
    const main = makeGitRepo(root, { 'base.txt': 'base\n' });
    const batch = addWorktree(main, `${root}/batch`, 'ship/batch');
    const slice = addWorktree(main, `${root}/slice`, 'slice-1');
    const before = snapshot(batch);

    const run = runCli<HarvestResult>(['harvest', batch, sha(slice)]);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('failed');
    expect(run.json.errors[0]?.step).toBe('preconditions');
    expect(snapshot(batch)).toEqual(before);
  });

  it.each([
    { target: 'the main checkout', path: (p: Pair) => p.main, reason: 'main-worktree' },
    {
      target: 'a subdirectory of the batch',
      path: (p: Pair) => `${p.batch}/sub`,
      reason: 'unregistered-worktree',
    },
    {
      target: 'a plain directory',
      path: () => {
        mkdirSync(`${root}/plain`);
        return `${root}/plain`;
      },
      reason: 'unregistered-worktree',
    },
  ])('refuses $target as a target and touches nothing', TIMEOUT, ({ path, reason }) => {
    const pair = slicePair(
      { 'sub/keep.txt': 'keep\n' },
      { write: { 'slice-added.txt': 'slice\n' } },
    );
    const before = { main: snapshot(pair.main), batch: snapshot(pair.batch) };

    const run = runCli<HarvestResult>(['harvest', path(pair), pair.sha]);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('refused');
    expect(run.json.reason).toBe(reason);
    expect({ main: snapshot(pair.main), batch: snapshot(pair.batch) }).toEqual(before);
    expect(existsSync(join(pair.main, 'slice-added.txt'))).toBe(false);
    expect(existsSync(join(pair.batch, 'slice-added.txt'))).toBe(false);
  });

  it('fails the staged check on an empty pick and rolls back', TIMEOUT, () => {
    const { batch, sha } = slicePair(
      {},
      { write: { 'same.txt': 'same\n' } },
      { write: { 'same.txt': 'same\n' } },
    );

    const run = runCli<HarvestResult>(['harvest', batch, sha]);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('failed');
    expect(run.json.errors[0]?.step).toBe('staged-check');
    expect(run.json.errors[0]?.message).toContain('same.txt');
    expect(run.json.rolledBack).toBe(true);
    expect(porcelain(batch)).toBe('');
  });

  it('reports a rollback that cannot run as failed, not rolled back', TIMEOUT, () => {
    const { batch, sha } = slicePair({}, { write: { 'slice-added.txt': 'slice\n' } });
    const head = headSha(batch);
    // A held index.lock fails the pick before it writes anything, and the
    // reset after it too.
    const gitDir = mustRun('git', ['rev-parse', '--absolute-git-dir'], batch).trim();
    writeFileSync(join(gitDir, 'index.lock'), '');

    const run = runCli<HarvestResult>(['harvest', batch, sha]);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('failed');
    expect(run.json.errors.map((e) => e.step)).toEqual(['cherry-pick', 'rollback']);
    expect(run.json.rolledBack).toBe(false);
    expect(headSha(batch)).toBe(head);
    expect(existsSync(join(batch, 'slice-added.txt'))).toBe(false);
  });
});

describe('harvest (in-process)', () => {
  it(
    'harvests into the named batch despite a foreign GIT_DIR, as a git hook exports',
    TIMEOUT,
    () => {
      const { batch, sha } = slicePair({}, { write: { 'slice-added.txt': 'slice\n' } });
      const foreign = makeGitRepo(root, { 'f.txt': 'foreign\n' }, { name: 'foreign' });
      const foreignBefore = snapshot(foreign);
      const saved = process.env.GIT_DIR;
      process.env.GIT_DIR = `${foreign}/.git`;
      let run: HarvestResult;
      try {
        run = harvest({ batch, sha });
      } finally {
        if (saved === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = saved;
      }

      expect(run.status).toBe('ok');
      expect(stagedNames(batch)).toEqual(['slice-added.txt']);
      expect(snapshot(foreign)).toEqual(foreignBefore);
    },
  );

  it('refuses a CLI hosted inside the batch and stages nothing', TIMEOUT, () => {
    const { batch, sha } = slicePair({}, { write: { 'slice-added.txt': 'slice\n' } });

    const run = harvest({ batch, sha, selfPath: `${batch}/tooling/worktree.ts` });

    expect(run.status).toBe('refused');
    expect(run.reason).toBe('self-hosted');
    expect(porcelain(batch)).toBe('');
    expect(stagedNames(batch)).toEqual([]);
  });
});

describe('staged-guard', () => {
  it(
    'accepts the exact staged set, a rename as both endpoints, in any order and spelling',
    TIMEOUT,
    () => {
      const main = makeGitRepo(root, {
        'a.txt': 'renamed without change\n',
        'dir/m.txt': 'm v1\n',
        'd.txt': 'deleted\n',
      });
      mustRun('git', ['mv', 'a.txt', 'b.txt'], main);
      writeFileSync(join(main, 'dir', 'm.txt'), 'm v2\n');
      writeFileSync(join(main, 'n.txt'), 'new\n');
      mustRun('git', ['add', '--', 'dir/m.txt', 'n.txt'], main);
      mustRun('git', ['rm', '-q', '--', 'd.txt'], main);

      const run = runCli<StagedGuardResult>([
        'staged-guard',
        main,
        './n.txt',
        'b.txt',
        'dir\\m.txt',
        'd.txt',
        'a.txt',
      ]);

      expect(run.code).toBe(0);
      expect(run.json.status).toBe('ok');
      expect(run.json.staged).toEqual(['a.txt', 'b.txt', 'd.txt', 'dir/m.txt', 'n.txt']);
    },
  );

  it('refuses a mismatch naming both one-sided differences', TIMEOUT, () => {
    const main = makeGitRepo(root, {});
    writeFileSync(join(main, 'a.txt'), 'a\n');
    writeFileSync(join(main, 'b.txt'), 'b\n');
    mustRun('git', ['add', '--', 'a.txt', 'b.txt'], main);

    const run = runCli<StagedGuardResult>(['staged-guard', main, 'b.txt', 'c.txt']);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('refused');
    expect(run.json.reason).toBe('staged-mismatch');
    expect(run.json.missing).toEqual(['c.txt']);
    expect(run.json.unexpected).toEqual(['a.txt']);
  });

  it('fails preconditions for a subdirectory of a worktree', TIMEOUT, () => {
    // Staged and expected sets match, so only the root check can stop it.
    const main = makeGitRepo(root, { 'sub/k.txt': 'k v1\n' });
    writeFileSync(join(main, 'sub', 'k.txt'), 'k v2\n');
    mustRun('git', ['add', '--', 'sub/k.txt'], main);

    const run = runCli<StagedGuardResult>(['staged-guard', `${main}/sub`, 'sub/k.txt']);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('failed');
    expect(run.json.errors[0]?.step).toBe('preconditions');
  });

  it('compares case-exactly on any filesystem', TIMEOUT, () => {
    const main = makeGitRepo(root, { 'skill.md': '# v1\n' });
    writeFileSync(join(main, 'skill.md'), '# v2\n');
    mustRun('git', ['add', '--', 'skill.md'], main);

    const run = runCli<StagedGuardResult>(['staged-guard', main, 'skill.md', 'SKILL.md']);

    expect(run.code).toBe(1);
    expect(run.json.status).toBe('refused');
    expect(run.json.missing).toEqual(['SKILL.md']);
    expect(run.json.unexpected).toEqual([]);
  });

  // regression: #562's skill.md → SKILL.md rename, lost by a reset plus
  // add-by-name after the harvest had staged it correctly.
  it.skipIf(!WIN32)(
    'refuses the case-only rename a reset plus add-by-name drops after a harvest',
    TIMEOUT,
    () => {
      const { batch, sha } = slicePair(
        { 'skill.md': '# skill\n' },
        { rename: [['skill.md', 'SKILL.md']] },
      );
      const harvested = runCli<HarvestResult>(['harvest', batch, sha]);
      expect(harvested.json.status).toBe('ok');
      mustRun('git', ['reset', '-q'], batch);
      mustRun('git', ['add', '--', 'skill.md', 'SKILL.md'], batch);

      const run = runCli<StagedGuardResult>(['staged-guard', batch, ...harvested.json.files]);

      expect(run.code).toBe(1);
      expect(run.json.status).toBe('refused');
      expect(run.json.missing).toEqual(['SKILL.md', 'skill.md']);
    },
  );
});

describe('usage errors', () => {
  it.each([
    { name: 'harvest without a sha', args: ['harvest', 'batch'] },
    { name: 'harvest with two shas', args: ['harvest', 'batch', 'a', 'b'] },
    { name: 'staged-guard without files', args: ['staged-guard', 'wt'] },
  ])('exits 2 with a usage envelope for $name', TIMEOUT, ({ args }) => {
    const run = runCli(args, { cwd: root });
    expect(run.code).toBe(2);
    expect(run.json.status).toBe('failed');
    expect(run.json.errors[0]?.step).toBe('usage');
    const message = run.json.errors[0]?.message ?? '';
    expect(message).not.toBe('');
    expect(run.stderr).toContain(`worktree: ${message}`);
  });
});
