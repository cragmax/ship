/**
 * Plain fixture repos (per-test `mkdtemp` roots) with a bare `origin`: the fixture main checkout
 * sits at `<root>/main`, so the run `cut-batch` cuts lands under `<root>/ph-ship/7`, inside the
 * temp root.
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
import { addWorktree, mustRun, runCli, runIn } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };

let root: string;
let main: string;
let runRoot: string;
let batch: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-retire-')));
  main = makeGitRepo(root, { 'base.txt': 'base\n' });
  makeBareOrigin(root, main);
  runRoot = `${root}/ph-ship/7`;
  batch = `${runRoot}/ship-7`;
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

/**
 * A spent run: one commit landed in `origin/master`, the batch torn down, and the run root left
 * holding a report and an empty slice folder.
 */
function spentRun(): void {
  cutRun();
  commitChanges(batch, {}, 'landed');
  mustRun('git', ['push', '-q', 'origin', 'ship/7:master'], main);
  mustRun('git', ['fetch', '-q', 'origin'], main);
  tearDown();
  writeFileSync(`${runRoot}/reports/x.md`, 'x\n');
  mkdirSync(`${runRoot}/slice-1-1`);
}

function branchResolves(): boolean {
  return runIn('git', ['rev-parse', '-q', '--verify', 'refs/heads/ship/7'], main).exitCode === 0;
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
    });
    expect(branchResolves()).toBe(false);
    expect(existsSync(runRoot)).toBe(false);
    expect(runCli<CutBatchResult>(['cut-batch', main, '--issues', '7']).json.status).toBe('ok');
  });

  it('refuses branch-unmerged for a branch merged only to its own upstream', TIMEOUT, () => {
    cutRun();
    commitChanges(batch, {}, 'ahead');
    // `-u`: origin/ship/7 holds the commit, origin/master does not.
    mustRun('git', ['push', '-q', '-u', 'origin', 'ship/7'], batch);
    tearDown();

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
    expect(existsSync(`${runRoot}/reports`)).toBe(true);
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
      name: 'the run root is missing',
      setup: () => {
        spentRun();
        rmSync(runRoot, { recursive: true });
      },
      step: 'internal',
      removed: false,
      kept: true,
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

  it.each([
    {
      name: 'a stray file',
      reason: 'root-not-empty',
      add: () => writeFileSync(`${runRoot}/stray.txt`, 's'),
    },
    {
      name: 'a non-empty slice folder',
      reason: 'root-not-empty',
      add: () => writeFileSync(`${runRoot}/slice-1-1/keep.txt`, 'k'),
    },
    {
      name: 'an empty folder not named slice-*',
      reason: 'root-not-empty',
      add: () => mkdirSync(`${runRoot}/other`),
    },
    {
      name: 'a file named reports',
      reason: 'root-not-empty',
      add: () => {
        rmSync(`${runRoot}/reports`, { recursive: true });
        writeFileSync(`${runRoot}/reports`, 'r');
      },
    },
    {
      name: 'a registered worktree',
      reason: 'nested-worktree',
      add: () => {
        addWorktree(main, `${runRoot}/reports/wt`, 'side');
      },
    },
    {
      name: 'a link',
      reason: 'links-remain',
      add: () => {
        mkdirSync(`${root}/outside`);
        writeFileSync(`${root}/outside/keep.txt`, 'k');
        createJunction(`${runRoot}/reports/link`, `${root}/outside`);
      },
    },
  ])('refuses $reason for $name in the run root', TIMEOUT, ({ reason, add }) => {
    spentRun();
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
    if (reason === 'links-remain')
      expect(readFileSync(`${root}/outside/keep.txt`, 'utf8')).toBe('k');
  });
});
