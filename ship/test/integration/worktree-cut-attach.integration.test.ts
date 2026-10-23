/**
 * Plain fixture repos (per-test `mkdtemp` roots): the fixture main checkout
 * sits at `<root>/main` and ignores the run paths as this repo does, so a run
 * it attaches lands in its `.claude/worktrees/` and `reports/`.
 * `cut-batch --attach` gets a bare `origin` and a fake `gh`.
 *
 * @integrationTier standalone
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CutBatchResult } from '../../src/cli/envelope/types-run.js';
import {
  addWorktreeAt,
  advanceOrigin,
  branchOf,
  commitChanges,
  commitOn,
  headSha,
  makeBareOrigin,
  mergeOn,
  prependPath,
  repoState,
  writeFakeGh,
  type FakeGhResponse,
} from '../../../tooling/test/helpers/worktree-fixture-git.js';
import {
  makePlainMain,
  makeTempRoot,
  removeTempDirs,
  runCli,
} from '../helpers/worktree-cli-fixture.js';
import { mustRun } from '../../../tooling/test/helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };

let root: string;
let main: string;

beforeEach(() => {
  root = makeTempRoot('ph-wt-cut-');
  main = makePlainMain(root);
});

afterEach(() => {
  removeTempDirs([root]);
});

describe('cut-batch --attach', () => {
  const BATCH = (): string => `${main}/.claude/worktrees/ship-s`;
  const OPEN_9 = { 'ship/s': { prs: [{ number: 9, state: 'OPEN' }] } };
  let bare: string;

  beforeEach(() => {
    bare = makeBareOrigin(root, main);
  });

  /**
   * Create `ship/s` from master with one commit of its own, pushed as an open
   * PR's branch is; no worktree left on it.
   */
  function localBranch(): string {
    mustRun('git', ['branch', 'ship/s'], main);
    const tip = commitOn(main, 'ship/s', { write: { 's.txt': 's\n' } }, 's1');
    mustRun('git', ['push', '-q', 'origin', 'ship/s'], main);

    return tip;
  }

  /** Run `cut-batch --attach` with a fake `gh` answering `responses`. */
  function attach(
    responses: Record<string, FakeGhResponse>,
    branch = 'ship/s',
  ): ReturnType<typeof runCli<CutBatchResult>> {
    const bin = writeFakeGh(root, responses);

    return runCli<CutBatchResult>(['cut-batch', main, '--attach', branch], {
      env: prependPath(bin),
    });
  }

  it('checks out a local run branch as the layout batch, with reports/', TIMEOUT, () => {
    const tip = localBranch();

    const r = attach(OPEN_9);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      branch: 'ship/s',
      base: tip,
      batch: BATCH(),
      reportDir: `${main}/reports/ship-s`,
      attach: { created: true, fastForwarded: false, pr: 9 },
    });
    expect(branchOf(BATCH())).toBe('ship/s');
    expect(headSha(BATCH())).toBe(tip);
    expect(existsSync(`${main}/reports/ship-s`)).toBe(true);
  });

  it('checks out a branch only origin has as a new tracking branch', TIMEOUT, () => {
    const clone = mkdtempSync(join(root, 'clone-'));
    mustRun('git', ['clone', '-q', bare, clone], root);
    mustRun('git', ['config', 'user.name', 'f'], clone);
    mustRun('git', ['config', 'user.email', 'f@example.invalid'], clone);
    mustRun('git', ['checkout', '-q', '-b', 'ship/s'], clone);
    const tip = commitChanges(clone, { write: { 's.txt': 's\n' } }, 's1');
    mustRun('git', ['push', '-q', 'origin', 'ship/s'], clone);

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({ status: 'ok', base: tip, attach: { created: true } });
    expect(headSha(main, 'refs/heads/ship/s')).toBe(tip);
    expect(mustRun('git', ['rev-parse', '--abbrev-ref', 'ship/s@{upstream}'], main).trim()).toBe(
      'origin/ship/s',
    );
    expect(headSha(BATCH())).toBe(tip);
  });

  it('reuses the batch already checked out at the layout path, mutating nothing', TIMEOUT, () => {
    mustRun('git', ['branch', 'ship/s'], main);
    addWorktreeAt(main, BATCH(), 'ship/s');
    const before = repoState(main);

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({
      status: 'ok',
      batch: BATCH(),
      reportDir: `${main}/reports/ship-s`,
      attach: { created: false, fastForwarded: false, pr: 9 },
    });
    expect(repoState(main)).toEqual(before);
  });

  it.each([
    { guard: 'branch-missing', branch: 'ship/s', setup: () => undefined },
    {
      guard: 'path-exists',
      branch: 'ship/s',
      setup: () => {
        localBranch();
        mkdirSync(BATCH(), { recursive: true });
      },
    },
    {
      guard: 'branch-checked-out',
      branch: 'ship/s',
      setup: () => {
        localBranch();
        addWorktreeAt(main, `${root}/elsewhere`, 'ship/s');
      },
    },
    {
      guard: 'not-run-batch',
      branch: 'feature/s',
      setup: () => mustRun('git', ['branch', 'feature/s'], main),
    },
  ])('refuses $guard with the repository unchanged', TIMEOUT, ({ guard, branch, setup }) => {
    setup();
    const hadBatch = existsSync(BATCH());
    const before = repoState(main);

    const r = attach({ [branch]: OPEN_9['ship/s'] }, branch);

    expect(r.json).toMatchObject({ status: 'refused', reason: guard, batch: null });
    expect(repoState(main)).toEqual(before);
    expect(existsSync(BATCH())).toBe(hadBatch);
  });

  it.each([
    { state: 'merged', prs: [{ number: 9, state: 'MERGED' }] },
    { state: 'closed', prs: [{ number: 9, state: 'CLOSED' }] },
    { state: 'none', prs: [] },
  ])('refuses a branch whose PR is $state as no-open-pr, creating no batch', TIMEOUT, (c) => {
    localBranch();

    const r = attach({ 'ship/s': { prs: c.prs } });

    expect(r.json).toMatchObject({ status: 'refused', reason: 'no-open-pr' });
    expect(r.json.errors[0]?.message).toContain(c.state);
    expect(existsSync(BATCH())).toBe(false);
  });

  it('fails pr-state when gh cannot report the PR', TIMEOUT, () => {
    localBranch();

    const r = attach({ 'ship/s': { exit: 1 } });

    expect(r.json).toMatchObject({ status: 'failed' });
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-state']);
    expect(existsSync(BATCH())).toBe(false);
  });

  it('fast-forwards a local branch strictly behind origin before checking it out', TIMEOUT, () => {
    localBranch();
    mustRun('git', ['push', '-q', 'origin', 'ship/s'], main);
    const ahead = advanceOrigin(root, bare, { write: { 'o.txt': 'o\n' } }, 'o', 'ship/s');

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({ status: 'ok', base: ahead, attach: { fastForwarded: true } });
    expect(headSha(main, 'refs/heads/ship/s')).toBe(ahead);
    expect(headSha(BATCH())).toBe(ahead);
  });

  it('refuses a local branch diverged from origin, its ref unchanged', TIMEOUT, () => {
    localBranch();
    advanceOrigin(root, bare, { write: { 'o.txt': 'o\n' } }, 'o', 'ship/s');
    // A merge, not a commit of its own: that would refuse unpublished-commits first.
    const local = mergeOn(main, bare, 'ship/s');

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'branch-diverged' });
    expect(headSha(main, 'refs/heads/ship/s')).toBe(local);
    expect(existsSync(BATCH())).toBe(false);
  });

  it.each([
    { name: 'checked out anew', reuse: false },
    { name: 'reused', reuse: true },
  ])('attaches a branch ahead of origin only by an unpushed merge, $name', TIMEOUT, ({ reuse }) => {
    localBranch();
    if (reuse) addWorktreeAt(main, BATCH(), 'ship/s');
    const local = reuse ? mergeOn(main, bare, 'ship/s', BATCH()) : mergeOn(main, bare, 'ship/s');

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({
      status: 'ok',
      base: local,
      attach: { created: !reuse, fastForwarded: false },
    });
    expect(headSha(main, 'refs/heads/ship/s')).toBe(local);
    expect(headSha(BATCH())).toBe(local);
  });

  it.each([
    { name: 'checked out anew', reuse: false },
    { name: 'reused', reuse: true },
  ])(
    'refuses a branch with a commit of its own origin lacks as unpublished-commits, $name, mutating nothing',
    TIMEOUT,
    ({ reuse }) => {
      localBranch();

      if (reuse) {
        addWorktreeAt(main, BATCH(), 'ship/s');
        commitChanges(BATCH(), { write: { 'l.txt': 'l\n' } }, 'l');
      } else {
        commitOn(main, 'ship/s', { write: { 'l.txt': 'l\n' } }, 'l');
      }

      const before = repoState(main);

      const r = attach(OPEN_9);

      expect(r.json).toMatchObject({
        status: 'refused',
        reason: 'unpublished-commits',
        batch: null,
      });
      expect(r.json.errors[0]?.message).toContain('1 commit');
      expect(repoState(main)).toEqual(before);
      if (!reuse) expect(existsSync(BATCH())).toBe(false);
    },
  );

  /** Run `cut-batch --attach ship/s --attached-run` with a fake `gh` answering `responses`. */
  function attachRun(
    responses: Record<string, FakeGhResponse>,
  ): ReturnType<typeof runCli<CutBatchResult>> {
    const bin = writeFakeGh(root, responses);

    return runCli<CutBatchResult>(['cut-batch', main, '--attach', 'ship/s', '--attached-run'], {
      env: prependPath(bin),
    });
  }

  /** The unattached run's leftovers: report files and its slice branches. */
  function unattachedLeftovers(): void {
    mkdirSync(`${main}/reports/ship-s/plans`, { recursive: true });
    writeFileSync(`${main}/reports/ship-s/pr-body.md`, 'body\n');
    mustRun('git', ['branch', 'slice/s/7-1'], main);
    mustRun('git', ['branch', 'slice/s/7-2'], main);
  }

  it(
    'gives the first attached run attach-1 beside the unattached run’s reports and branches',
    TIMEOUT,
    () => {
      localBranch();
      unattachedLeftovers();

      const r = attachRun(OPEN_9);

      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({
        status: 'ok',
        reportDir: `${main}/reports/ship-s/attach-1`,
        attach: { created: true, run: 1 },
      });
      expect(existsSync(`${main}/reports/ship-s/attach-1`)).toBe(true);
    },
  );

  it(
    'gives a second attached run attach-2 when the first left its folder and branches',
    TIMEOUT,
    () => {
      localBranch();
      unattachedLeftovers();
      mkdirSync(`${main}/reports/ship-s/attach-1`);
      mustRun('git', ['branch', 'slice/s/a1-7-1'], main);
      mustRun('git', ['branch', 'slice/s/a1-7-2'], main);

      const r = attachRun(OPEN_9);

      expect(r.json).toMatchObject({
        status: 'ok',
        reportDir: `${main}/reports/ship-s/attach-2`,
        attach: { run: 2 },
      });
      expect(existsSync(`${main}/reports/ship-s/attach-2`)).toBe(true);
    },
  );

  it('counts an earlier attached run’s slice branch whose report folder is gone', TIMEOUT, () => {
    localBranch();
    mustRun('git', ['branch', 'slice/s/a1-7-1'], main);

    const r = attachRun(OPEN_9);

    expect(r.json).toMatchObject({
      status: 'ok',
      reportDir: `${main}/reports/ship-s/attach-2`,
      attach: { run: 2 },
    });
  });

  it(
    'counts an earlier attached run’s report folder whose slice branches are gone',
    TIMEOUT,
    () => {
      localBranch();
      mkdirSync(`${main}/reports/ship-s/attach-1`, { recursive: true });

      const r = attachRun(OPEN_9);

      expect(r.json).toMatchObject({
        status: 'ok',
        reportDir: `${main}/reports/ship-s/attach-2`,
        attach: { run: 2 },
      });
    },
  );

  it.each([{ written: true }, { written: false }])(
    'names the batch’s trimmed registry when written is $written, with no run number',
    TIMEOUT,
    ({ written }) => {
      const registry = `${main}/reports/ship-s/pool-registry.batch.json`;
      mustRun('git', ['branch', 'ship/s'], main);
      addWorktreeAt(main, BATCH(), 'ship/s');

      if (written) {
        mkdirSync(`${main}/reports/ship-s`, { recursive: true });
        writeFileSync(registry, '[]\n');
      }

      const r = attach(OPEN_9);

      expect(r.json.attach).toEqual({
        created: false,
        fastForwarded: false,
        pr: 9,
        run: null,
        registry: written ? registry : null,
      });
      expect(r.json.reportDir).toBe(`${main}/reports/ship-s`);
    },
  );

  // An attached run that checks the batch out anew provisions into its own
  // attach-<R>/, a /ship or /resync into reports/; mtimes (seconds) order them.
  it.each([
    { name: 'only an attached run provisioned', rootAt: null, attachedAt: 1_000, want: 'attach' },
    { name: 'an attached run provisioned last', rootAt: 1_000, attachedAt: 2_000, want: 'attach' },
    { name: 'a resync provisioned last', rootAt: 2_000, attachedAt: 1_000, want: 'root' },
  ])('names the newest trimmed registry when $name', TIMEOUT, ({ rootAt, attachedAt, want }) => {
    const reports = `${main}/reports/ship-s`;
    const rootRegistry = `${reports}/pool-registry.batch.json`;
    const attachedRegistry = `${reports}/attach-1/pool-registry.batch.json`;
    mustRun('git', ['branch', 'ship/s'], main);
    addWorktreeAt(main, BATCH(), 'ship/s');
    mkdirSync(`${reports}/attach-1`, { recursive: true });
    writeFileSync(attachedRegistry, '[]\n');
    utimesSync(attachedRegistry, attachedAt, attachedAt);

    if (rootAt !== null) {
      writeFileSync(rootRegistry, '[]\n');
      utimesSync(rootRegistry, rootAt, rootAt);
    }

    const r = attach(OPEN_9);

    expect(r.json.attach?.registry).toBe(want === 'root' ? rootRegistry : attachedRegistry);
  });

  it('creates no run folder when the attach refuses', TIMEOUT, () => {
    localBranch();

    const r = attachRun({ 'ship/s': { prs: [{ number: 9, state: 'CLOSED' }] } });

    expect(r.json).toMatchObject({ status: 'refused', reason: 'no-open-pr' });
    expect(existsSync(`${main}/reports/ship-s/attach-1`)).toBe(false);
  });

  it('refuses a batch entry whose directory is gone as branch-checked-out', TIMEOUT, () => {
    localBranch();
    addWorktreeAt(main, BATCH(), 'ship/s');
    rmSync(BATCH(), { recursive: true, force: true });
    const before = repoState(main);

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'branch-checked-out', batch: null });
    expect(r.json.errors[0]?.message).toContain('(prunable)');
    expect(repoState(main)).toEqual(before);
    expect(existsSync(`${main}/reports/ship-s`)).toBe(false);
  });
});
