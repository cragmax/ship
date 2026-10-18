/**
 * Plain fixture repos (per-test `mkdtemp` roots) with a bare `origin`: the fixture main checkout
 * sits at `<root>/main`, so the run `cut-batch` cuts lands in its `.claude/worktrees/ship-7` and
 * `reports/ship-7`. Teardown's gone-batch cases live here too, for that cut batch.
 *
 * @integrationTier standalone
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import { createJunction } from '../../tooling/worktree/links.js';
import type { RetireRunResult, TeardownResult } from '../../tooling/worktree/types.js';
import type { CutBatchResult } from '../../tooling/worktree/types-run.js';
import { commitChanges, makeBareOrigin, makeGitRepo } from '../helpers/worktree-fixture-git.js';
import { isRegistered, runCli } from '../../ship/test/helpers/worktree-cli-fixture.js';
import { addWorktree, mustRun, runIn } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };

let root: string;
let main: string;
let runRoot: string;
let batch: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-retire-')));
  main = makeGitRepo(root, { 'base.txt': 'base\n' });
  makeBareOrigin(root, main);
  runRoot = `${main}/reports/ship-7`;
  batch = `${main}/.claude/worktrees/ship-7`;
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

function cutRun(): void {
  const cut = runCli<CutBatchResult>(['cut-batch', main, '--issues', '7']);
  expect(cut.json.status, JSON.stringify(cut.json)).toBe('ok');
}

function tearDown(): void {
  const down = runCli<TeardownResult>(['teardown', batch]);
  expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
}

/** A cut run with one commit landed in `origin/master`, its batch still standing. */
function mergedRun(): void {
  cutRun();
  commitChanges(batch, {}, 'landed');
  mustRun('git', ['push', '-q', 'origin', 'ship/7:master'], main);
  mustRun('git', ['fetch', '-q', 'origin'], main);
}

/** A spent run: a merged run with its batch torn down, and the run root left holding reports. */
function spentRun(): void {
  mergedRun();
  tearDown();
  mkdirSync(`${runRoot}/plans`);
  writeFileSync(`${runRoot}/plans/x.md`, 'x\n');
}

function branchResolves(branch = 'ship/7'): boolean {
  return runIn('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], main).exitCode === 0;
}

/** Create `name` on a new commit off main's HEAD, so it is in no other branch. */
function sliceBranch(name: string): void {
  const sha = mustRun('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', name], main).trim();
  mustRun('git', ['branch', name, sha], main);
}

describe('retire-run', () => {
  it('deletes a merged run branch and its run root, so the run can be cut again', TIMEOUT, () => {
    spentRun();

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json).toMatchObject({
      command: 'retire-run',
      status: 'ok',
      errors: [],
      branchDeleted: true,
      rootRemoved: true,
      rootAbsent: false,
    });
    expect(branchResolves()).toBe(false);
    expect(existsSync(runRoot)).toBe(false);
    expect(runCli<CutBatchResult>(['cut-batch', main, '--issues', '7']).json.status).toBe('ok');
  });

  it('retires a merged run with no run root, recording the root absent', TIMEOUT, () => {
    spentRun();
    sliceBranch('slice/7/1-1');
    rmSync(runRoot, { recursive: true });

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      errors: [],
      branchDeleted: true,
      rootRemoved: false,
      rootAbsent: true,
    });
    expect(r.json.sliceBranches).toEqual(['slice/7/1-1']);
    expect(branchResolves('slice/7/1-1')).toBe(false);
    expect(branchResolves()).toBe(false);
  });

  it("deletes the run's slice branches, none of them in origin/master", TIMEOUT, () => {
    spentRun();
    sliceBranch('slice/7/1-1');
    sliceBranch('slice/7/2-1');
    for (const b of ['slice/7/1-1', 'slice/7/2-1']) {
      expect(
        runIn(
          'git',
          ['merge-base', '--is-ancestor', `refs/heads/${b}`, 'refs/remotes/origin/master'],
          main,
        ).exitCode,
      ).toBe(1);
    }

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      errors: [],
      branchDeleted: true,
      rootRemoved: true,
    });
    expect(r.json.sliceBranches).toEqual(['slice/7/1-1', 'slice/7/2-1']);
    expect(branchResolves('slice/7/1-1')).toBe(false);
    expect(branchResolves('slice/7/2-1')).toBe(false);
  });

  it("leaves another run's slice branches, a longer slug's included", TIMEOUT, () => {
    spentRun();
    sliceBranch('slice/7/1-1');
    sliceBranch('slice/8/1-1');
    sliceBranch('slice/72/1-1');

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok' });
    expect(r.json.sliceBranches).toEqual(['slice/7/1-1']);
    expect(branchResolves('slice/7/1-1')).toBe(false);
    expect(branchResolves('slice/8/1-1')).toBe(true);
    expect(branchResolves('slice/72/1-1')).toBe(true);
  });

  it('stops at delete-slice-branch with the run branch and run root kept', TIMEOUT, () => {
    spentRun();
    sliceBranch('slice/7/1-1');
    sliceBranch('slice/7/2-1');
    mustRun('git', ['worktree', 'add', '-q', `${root}/elsewhere`, 'slice/7/2-1'], main);

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', branchDeleted: false, rootRemoved: false });
    expect(r.json.errors[0]?.step).toBe('delete-slice-branch');
    expect(r.json.sliceBranches).toEqual(['slice/7/1-1']);
    expect(branchResolves('slice/7/1-1')).toBe(false);
    expect(branchResolves('slice/7/2-1')).toBe(true);
    expect(branchResolves()).toBe(true);
    expect(existsSync(runRoot)).toBe(true);
  });

  it('refuses branch-unmerged for a branch merged only to its own upstream', TIMEOUT, () => {
    cutRun();
    commitChanges(batch, {}, 'ahead');
    // `-u`: origin/ship/7 holds the commit, origin/master does not.
    mustRun('git', ['push', '-q', '-u', 'origin', 'ship/7'], batch);
    tearDown();
    sliceBranch('slice/7/1-1');

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(1);
    expect(r.json).toMatchObject({
      status: 'refused',
      reason: 'branch-unmerged',
      branchDeleted: false,
      rootRemoved: false,
    });
    expect(r.json.errors[0]?.step).toBe('branch-guard');
    expect(branchResolves()).toBe(true);
    expect(existsSync(runRoot)).toBe(true);
    expect(r.json.sliceBranches).toEqual([]);
    expect(branchResolves('slice/7/1-1')).toBe(true);
  });

  it('refuses branch-unmerged with no run root, deleting nothing', TIMEOUT, () => {
    cutRun();
    commitChanges(batch, {}, 'ahead');
    tearDown();
    sliceBranch('slice/7/1-1');
    rmSync(runRoot, { recursive: true });

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(1);
    expect(r.json).toMatchObject({
      status: 'refused',
      reason: 'branch-unmerged',
      branchDeleted: false,
      rootRemoved: false,
    });
    expect(r.json.errors[0]?.step).toBe('branch-guard');
    expect(r.json.sliceBranches).toEqual([]);
    expect(branchResolves()).toBe(true);
    expect(branchResolves('slice/7/1-1')).toBe(true);
  });

  it.each([
    {
      name: 'the branch is missing',
      setup: () => undefined,
      step: 'branch-guard',
      removed: false,
      kept: false,
    },
    {
      name: 'the branch is checked out elsewhere',
      setup: () => {
        spentRun();
        mustRun('git', ['worktree', 'add', '-q', `${root}/elsewhere`, 'ship/7'], main);
      },
      step: 'delete-branch',
      removed: true,
      kept: true,
    },
  ])('fails at $step when $name', TIMEOUT, ({ setup, step, removed, kept }) => {
    setup();

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', branchDeleted: false, rootRemoved: removed });
    expect(r.json.errors[0]?.step).toBe(step);
    expect(branchResolves()).toBe(kept);
    expect(existsSync(runRoot)).toBe(false);
  });

  /** A real directory outside the run root, holding `keep.txt`. */
  function outside(): string {
    mkdirSync(`${root}/outside`);
    writeFileSync(`${root}/outside/keep.txt`, 'k');
    return `${root}/outside`;
  }

  it.each([
    {
      name: 'the run root is a link',
      reason: 'not-run-root',
      add: () => {
        rmSync(runRoot, { recursive: true });
        createJunction(runRoot, outside());
      },
    },
    {
      name: 'the run root is a file',
      reason: 'not-run-root',
      add: () => {
        rmSync(runRoot, { recursive: true });
        writeFileSync(runRoot, 'r');
      },
    },
    {
      name: 'a registered worktree in the run root',
      reason: 'nested-worktree',
      add: () => {
        addWorktree(main, `${runRoot}/wt`, 'side');
      },
    },
    {
      name: 'a link in the run root',
      reason: 'links-remain',
      add: () => {
        createJunction(`${runRoot}/link`, outside());
      },
    },
  ])('refuses $reason when $name', TIMEOUT, ({ reason, add }) => {
    spentRun();
    sliceBranch('slice/7/1-1');
    add();

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(1);
    expect(r.json).toMatchObject({
      status: 'refused',
      reason,
      branchDeleted: false,
      rootRemoved: false,
    });
    expect(r.json.errors[0]?.step).toBe('folder-guard');
    expect(branchResolves()).toBe(true);
    expect(existsSync(runRoot)).toBe(true);
    if (existsSync(`${root}/outside`))
      expect(readFileSync(`${root}/outside/keep.txt`, 'utf8')).toBe('k');
    expect(r.json.sliceBranches).toEqual([]);
    expect(branchResolves('slice/7/1-1')).toBe(true);
  });
});

describe('teardown — gone worktree', () => {
  it.each([
    { name: 'still registered', prune: false, listedBefore: true },
    { name: 'already pruned', prune: true, listedBefore: false },
  ])('counts a $name gone batch as torn down', TIMEOUT, ({ prune, listedBefore }) => {
    cutRun();
    rmSync(batch, { recursive: true, force: true });
    if (prune) mustRun('git', ['worktree', 'prune'], main);
    expect(isRegistered(main, batch)).toBe(listedBefore);

    const down = runCli<TeardownResult>(['teardown', batch], { cwd: main });

    expect(down.code, JSON.stringify(down.json)).toBe(0);
    expect(down.json).toMatchObject({
      command: 'teardown',
      status: 'ok',
      worktree: batch,
      removed: false,
      registered: false,
      errors: [],
      unlinked: [],
      sources: [],
    });
    expect(isRegistered(main, batch)).toBe(false);
    expect(branchResolves()).toBe(true);
  });

  it('leaves a merged run with a deleted batch retirable', TIMEOUT, () => {
    mergedRun();
    rmSync(batch, { recursive: true, force: true });
    const down = runCli<TeardownResult>(['teardown', batch], { cwd: main });
    expect(down.json.status, JSON.stringify(down.json)).toBe('ok');

    const r = runCli<RetireRunResult>(['retire-run', main, '--branch', 'ship/7']);

    expect(r.code, JSON.stringify(r.json)).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', branchDeleted: true, rootRemoved: true });
    expect(branchResolves()).toBe(false);
    expect(existsSync(runRoot)).toBe(false);
  });
});
