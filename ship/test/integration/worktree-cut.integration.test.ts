/**
 * Plain fixture repos (per-test `mkdtemp` roots): the fixture main checkout
 * sits at `<root>/main` and ignores the run paths as this repo does, so a run
 * it cuts lands in its `.claude/worktrees/` and `reports/`.
 *
 * @integrationTier standalone
 */

import { existsSync, mkdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LiveRunsResult } from '../../src/cli/envelope/types.js';
import type { CutBatchResult, CutSliceResult } from '../../src/cli/envelope/types-run.js';
import {
  branchOf,
  commitChanges,
  headSha,
  prependPath,
  repoState,
  writeFakeGh,
} from '../helpers/worktree-fixture-git.js';
import {
  expectUsageFailure,
  makePlainMain,
  makeTempRoot,
  removeTempDirs,
  runCli,
} from '../helpers/worktree-cli-fixture.js';
import { addWorktree, mustRun, porcelain } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let root: string;
let main: string;

beforeEach(() => {
  root = makeTempRoot('ph-wt-cut-');
  main = makePlainMain(root);
});

afterEach(() => {
  removeTempDirs([root]);
});

describe('cut-batch', () => {
  it('cuts ship/epic-E at master in .claude/worktrees, with its reports dir', TIMEOUT, () => {
    const master = headSha(main);

    const r = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      branch: 'ship/epic-900',
      base: master,
      batch: `${main}/.claude/worktrees/ship-epic-900`,
      reportDir: `${main}/reports/ship-epic-900`,
    });
    expect(branchOf(`${main}/.claude/worktrees/ship-epic-900`)).toBe('ship/epic-900');
    expect(headSha(`${main}/.claude/worktrees/ship-epic-900`)).toBe(master);
    expect(existsSync(`${main}/reports/ship-epic-900`)).toBe(true);
    expect(porcelain(main)).toBe('');
  });

  it('names an explicit-list run by its issues ascending', TIMEOUT, () => {
    const r = runCli<CutBatchResult>(['cut-batch', main, '--issues', '12,3']);

    expect(r.json).toMatchObject({
      status: 'ok',
      branch: 'ship/3-12',
      batch: `${main}/.claude/worktrees/ship-3`,
    });
    expect(branchOf(`${main}/.claude/worktrees/ship-3`)).toBe('ship/3-12');
  });

  it.each([
    {
      guard: 'branch-exists',
      name: 'the run branch exists',
      target: () => {
        mustRun('git', ['branch', 'ship/epic-900'], main);

        return main;
      },
    },
    {
      guard: 'path-exists',
      name: 'the batch path exists',
      target: () => {
        mkdirSync(`${main}/.claude/worktrees/ship-epic-900`, { recursive: true });

        return main;
      },
    },
    {
      guard: 'path-exists',
      name: 'the report dir exists',
      target: () => {
        mkdirSync(`${main}/reports/ship-epic-900`, { recursive: true });

        return main;
      },
    },
    {
      guard: 'not-main-worktree',
      name: 'the target is a linked worktree',
      target: () => addWorktree(main, `${root}/linked`, 'other'),
    },
  ])('refuses $guard when $name, the repository unchanged', TIMEOUT, ({ guard, target }) => {
    const dir = target();
    const before = repoState(main);

    const r = runCli<CutBatchResult>(['cut-batch', dir, '--epic', '900']);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: guard, branch: null });
    expect(repoState(main)).toEqual(before);
  });
});

describe('cut-slice', () => {
  it('cuts slice/<slug>/N-K at the batch HEAD, which live-runs does not list', TIMEOUT, () => {
    const cut = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']);
    const batch = cut.json.batch ?? '';
    const head = commitChanges(batch, { write: { 'landed.txt': 'landed\n' } }, 'landed');

    const r = runCli<CutSliceResult>(['cut-slice', batch, '--issue', '41', '--attempt', '2']);

    expect(r.code).toBe(0);
    const slice = `${main}/.claude/worktrees/ship-epic-900-41-2`;
    expect(r.json).toMatchObject({
      status: 'ok',
      branch: 'slice/epic-900/41-2',
      base: head,
      slice,
    });
    expect(branchOf(slice)).toBe('slice/epic-900/41-2');
    expect(headSha(slice)).toBe(head);
    const runs = runCli<LiveRunsResult>(['live-runs', main], {
      env: prependPath(writeFakeGh(root, {})),
    });

    expect(runs.json.runs.map((run) => run.path)).toEqual([batch]);
  });

  it('refuses an attempt whose slice path exists, cutting nothing', TIMEOUT, () => {
    const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';
    mkdirSync(`${main}/.claude/worktrees/ship-epic-900-41-1`);
    const before = repoState(main);

    const r = runCli<CutSliceResult>(['cut-slice', batch, '--issue', '41', '--attempt', '1']);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'path-exists', branch: null });
    expect(repoState(main)).toEqual(before);
  });

  it('refuses an attempt whose slice branch exists, cutting nothing', TIMEOUT, () => {
    const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';
    mustRun('git', ['branch', 'slice/epic-900/41-1'], main);
    const before = repoState(main);

    const r = runCli<CutSliceResult>(['cut-slice', batch, '--issue', '41', '--attempt', '1']);

    expect(r.json).toMatchObject({
      status: 'refused',
      reason: 'branch-exists',
      branch: null,
      at: expect.stringMatching(ISO_INSTANT),
    });
    expect(repoState(main)).toEqual(before);
    expect(existsSync(`${main}/.claude/worktrees/ship-epic-900-41-1`)).toBe(false);
  });

  it('refuses a linked worktree that is not on a ship/ branch', TIMEOUT, () => {
    const other = addWorktree(main, `${root}/other`, 'feature/x');

    const r = runCli<CutSliceResult>(['cut-slice', other, '--issue', '41', '--attempt', '1']);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'not-run-batch' });
  });

  it('refuses --audit-tests as a usage error, cutting nothing', TIMEOUT, () => {
    const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';
    const before = repoState(main);

    const r = runCli<CutSliceResult>(['cut-slice', batch, '--audit-tests']);

    expect(r.code).toBe(2);
    expect(r.json.errors).toEqual([{ step: 'usage', message: 'unknown flag --audit-tests' }]);
    expect(repoState(main)).toEqual(before);
    expect(existsSync(`${main}/.claude/worktrees/ship-epic-900-audit-tests`)).toBe(false);
  });

  it('names only the --issue N --attempt K form when no slice is given', TIMEOUT, () => {
    const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';

    const r = runCli<CutSliceResult>(['cut-slice', batch]);

    expect(r.code).toBe(2);
    expect(r.json.errors).toEqual([
      { step: 'usage', message: 'cut-slice takes --issue N --attempt K' },
    ]);
  });

  it('cuts an attached run’s attempt beside the earlier run’s, on an a<R>- branch', TIMEOUT, () => {
    const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';
    const head = commitChanges(batch, { write: { 'landed.txt': 'landed\n' } }, 'landed');
    mustRun('git', ['branch', 'slice/epic-900/41-1'], main);

    const attempt = runCli<CutSliceResult>([
      'cut-slice',
      batch,
      '--issue',
      '41',
      '--attempt',
      '1',
      '--attached-run',
      '2',
    ]);

    expect(attempt.code).toBe(0);
    const slice = `${main}/.claude/worktrees/ship-epic-900-a2-41-1`;
    expect(attempt.json).toMatchObject({
      status: 'ok',
      branch: 'slice/epic-900/a2-41-1',
      base: head,
      slice,
      at: expect.stringMatching(ISO_INSTANT),
    });
    expect(branchOf(slice)).toBe('slice/epic-900/a2-41-1');
  });
});

describe('usage errors', () => {
  it.each([
    { name: 'cut-batch with neither selection', args: ['cut-batch', 'm'] },
    {
      name: 'cut-batch with both selections',
      args: ['cut-batch', 'm', '--epic', '9', '--issues', '1'],
    },
    { name: 'cut-batch with a non-numeric epic', args: ['cut-batch', 'm', '--epic', 'x'] },
    { name: 'cut-batch with an empty list entry', args: ['cut-batch', 'm', '--issues', '1,,2'] },
    { name: 'cut-slice without --attempt', args: ['cut-slice', 'b', '--issue', '4'] },
    {
      name: 'cut-slice with attempt 0',
      args: ['cut-slice', 'b', '--issue', '4', '--attempt', '0'],
    },
    {
      name: 'cut-slice with attached run 0',
      args: ['cut-slice', 'b', '--issue', '4', '--attempt', '1', '--attached-run', '0'],
    },
    {
      name: 'cut-batch with --attach and --epic',
      args: ['cut-batch', 'm', '--attach', 'ship/s', '--epic', '9'],
    },
    {
      name: 'cut-batch --attached-run without --attach',
      args: ['cut-batch', 'm', '--epic', '9', '--attached-run'],
    },
    { name: 'preflight --attach without a branch', args: ['preflight', 'm', '--attach'] },
    { name: 'preflight --slug without a value', args: ['preflight', 'm', '--slug'] },
    { name: 'preflight --slug with an empty slug', args: ['preflight', 'm', '--slug', 'a,,b'] },
    { name: 'preflight --slug with a glob slug', args: ['preflight', 'm', '--slug', 'epic-1,*'] },
  ])('exits 2 with a stamped usage envelope for $name', TIMEOUT, ({ args }) => {
    const run = runCli(args, { cwd: root });
    expectUsageFailure(run);
    expect(run.json.at).toMatch(ISO_INSTANT);
  });
});
