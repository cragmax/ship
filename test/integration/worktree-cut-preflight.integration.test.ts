/**
 * Plain fixture repos (per-test `mkdtemp` roots): the fixture main checkout
 * sits at `<root>/main` and ignores the run paths as this repo does, so a run
 * it cuts lands in its `.claude/worktrees/` and `reports/`. `preflight` gets a
 * bare `origin` and a fake `gh`; its RCON probe is injected in-process, never
 * aimed at the real warm-set ports, which may be live.
 *
 * @integrationTier standalone
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareStrings, toPosix } from '../../tooling/shared.js';
import { preflight, type WarmProbe } from '../../tooling/worktree/preflight.js';
import type { LiveRunsResult } from '../../tooling/worktree/types.js';
import type {
  CutBatchResult,
  CutSliceResult,
  PreflightResult,
} from '../../tooling/worktree/types-run.js';
import {
  advanceOrigin,
  commitChanges,
  headSha,
  makeBareOrigin,
  makeGitRepo,
  prependPath,
  writeFakeGh,
  type Changes,
  type FakeGhResponse,
} from '../helpers/worktree-fixture-git.js';
import { addWorktree, mustRun, porcelain, runCli } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REGISTRY = 'src/server-pool/registry/pool-registry.json';
const REAL_REGISTRY = resolve(import.meta.dirname, '../..', REGISTRY);

let root: string;
let main: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-cut-')));
  main = makeGitRepo(root, {
    'base.txt': 'base\n',
    '.gitignore': '/.claude/worktrees/\n/reports/\n',
  });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

/** HEAD, porcelain, branches and worktree list of the fixture main — "nothing mutated". */
function repoState(dir: string): Record<string, string> {
  return {
    head: headSha(dir),
    porcelain: porcelain(dir),
    branches: mustRun('git', ['branch', '--list', '--format=%(refname)'], dir),
    worktrees: mustRun('git', ['worktree', 'list', '--porcelain'], dir),
  };
}

/**
 * Run `preflight` on the fixture main in-process, with a fake `gh` first on
 * `PATH` and the warm-set probe replaced (every member reachable by default).
 */
async function preflightWith(options: {
  readonly authExit?: number;
  readonly probe?: WarmProbe;
  readonly attach?: string;
  readonly slugs?: readonly string[];
  readonly responses?: Record<string, FakeGhResponse>;
}): Promise<PreflightResult> {
  const overlay = prependPath(writeFakeGh(root, options.responses ?? {}, options.authExit ?? 0));
  const [key = 'PATH', value = ''] = Object.entries(overlay)[0] ?? [];
  const saved = process.env[key];
  process.env[key] = value;
  try {
    return await preflight({
      main,
      ...(options.attach === undefined ? {} : { attach: options.attach }),
      ...(options.slugs === undefined ? {} : { slugs: options.slugs }),
      probe: options.probe ?? (() => Promise.resolve({ ok: true })),
    });
  } finally {
    process.env[key] = saved;
  }
}

/** The short branch a worktree has checked out. */
function branchOf(dir: string): string {
  return mustRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
}

/** Run `work` in a throwaway worktree on an existing branch, which is removed again. */
function inThrowawayWorktree(branch: string, work: (dir: string) => string): string {
  const tmp = mkdtempSync(join(root, 'wt-'));
  rmSync(tmp, { recursive: true });
  mustRun('git', ['worktree', 'add', '-q', tmp, branch], main);
  const sha = work(tmp);
  mustRun('git', ['worktree', 'remove', tmp], main);
  return sha;
}

/** Commit `changes` on an existing branch through a throwaway worktree. */
function commitOn(branch: string, changes: Changes, message: string): string {
  return inThrowawayWorktree(branch, (dir) => commitChanges(dir, changes, message));
}

/** Check an existing branch out at `path`. */
function addWorktreeAt(path: string, branch: string): void {
  mustRun('git', ['worktree', 'add', '-q', path, branch], main);
}

/**
 * Advance `bare`'s master, then merge it into `branch` with `--no-ff`,
 * unpushed — a resync's merge. The merge runs in `checkout` when given (a
 * worktree already on `branch`), else in a throwaway worktree.
 */
function mergeOn(bare: string, branch: string, checkout?: string): string {
  advanceOrigin(root, bare, { write: { 'm.txt': 'm\n' } }, 'm');
  mustRun('git', ['fetch', '-q', 'origin'], main);
  const merge = (dir: string): string => {
    mustRun('git', ['merge', '--no-ff', '-q', '-m', 'Merge origin/master', 'origin/master'], dir);
    return headSha(dir);
  };
  return checkout === undefined ? inThrowawayWorktree(branch, merge) : merge(checkout);
}

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
    const tip = commitOn('ship/s', { write: { 's.txt': 's\n' } }, 's1');
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
    addWorktreeAt(BATCH(), 'ship/s');
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
        addWorktreeAt(`${root}/elsewhere`, 'ship/s');
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
    const local = mergeOn(bare, 'ship/s');

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
    if (reuse) addWorktreeAt(BATCH(), 'ship/s');
    const local = reuse ? mergeOn(bare, 'ship/s', BATCH()) : mergeOn(bare, 'ship/s');

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
        addWorktreeAt(BATCH(), 'ship/s');
        commitChanges(BATCH(), { write: { 'l.txt': 'l\n' } }, 'l');
      } else {
        commitOn('ship/s', { write: { 'l.txt': 'l\n' } }, 'l');
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
    mustRun('git', ['branch', 'slice/s/critic'], main);
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
      mustRun('git', ['branch', 'slice/s/a1-critic'], main);

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
      addWorktreeAt(BATCH(), 'ship/s');
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
    addWorktreeAt(BATCH(), 'ship/s');
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
    addWorktreeAt(BATCH(), 'ship/s');
    rmSync(BATCH(), { recursive: true, force: true });
    const before = repoState(main);

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'branch-checked-out', batch: null });
    expect(r.json.errors[0]?.message).toContain('(prunable)');
    expect(repoState(main)).toEqual(before);
    expect(existsSync(`${main}/reports/ship-s`)).toBe(false);
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

    expect(r.json).toMatchObject({ status: 'refused', reason: 'branch-exists', branch: null });
    expect(repoState(main)).toEqual(before);
    expect(existsSync(`${main}/.claude/worktrees/ship-epic-900-41-1`)).toBe(false);
  });

  it('refuses a linked worktree that is not on a ship/ branch', TIMEOUT, () => {
    const other = addWorktree(main, `${root}/other`, 'feature/x');

    const r = runCli<CutSliceResult>(['cut-slice', other, '--issue', '41', '--attempt', '1']);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'not-run-batch' });
  });

  it(
    'cuts the critic slice slice/<slug>/critic at the batch HEAD, stamping the envelope',
    TIMEOUT,
    () => {
      const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';
      const head = commitChanges(batch, { write: { 'landed.txt': 'landed\n' } }, 'landed');

      const r = runCli<CutSliceResult>(['cut-slice', batch, '--critic']);

      expect(r.code).toBe(0);
      const slice = `${main}/.claude/worktrees/ship-epic-900-critic`;
      expect(r.json).toMatchObject({
        status: 'ok',
        branch: 'slice/epic-900/critic',
        base: head,
        slice,
        at: expect.stringMatching(ISO_INSTANT),
      });
      expect(branchOf(slice)).toBe('slice/epic-900/critic');
      expect(headSha(slice)).toBe(head);
    },
  );

  it(
    'cuts an attached run’s attempt and critic slices beside the earlier run’s, on a<R>- branches',
    TIMEOUT,
    () => {
      const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';
      const head = commitChanges(batch, { write: { 'landed.txt': 'landed\n' } }, 'landed');
      mustRun('git', ['branch', 'slice/epic-900/41-1'], main);
      mustRun('git', ['branch', 'slice/epic-900/critic'], main);

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
      const critic = runCli<CutSliceResult>([
        'cut-slice',
        batch,
        '--critic',
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
      });
      expect(branchOf(slice)).toBe('slice/epic-900/a2-41-1');
      expect(critic.json).toMatchObject({
        status: 'ok',
        branch: 'slice/epic-900/a2-critic',
        slice: `${main}/.claude/worktrees/ship-epic-900-a2-critic`,
      });
    },
  );

  it('refuses a second critic cut as branch-exists, stamped, cutting nothing', TIMEOUT, () => {
    const batch = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']).json.batch ?? '';
    runCli<CutSliceResult>(['cut-slice', batch, '--critic']);
    const before = repoState(main);

    const r = runCli<CutSliceResult>(['cut-slice', batch, '--critic']);

    expect(r.json).toMatchObject({
      status: 'refused',
      reason: 'branch-exists',
      branch: null,
      at: expect.stringMatching(ISO_INSTANT),
    });
    expect(repoState(main)).toEqual(before);
  });
});

describe('preflight (in-process)', () => {
  beforeEach(() => {
    main = makeGitRepo(
      root,
      { 'base.txt': 'base\n', [REGISTRY]: readFileSync(REAL_REGISTRY) },
      {
        name: 'pf-main',
      },
    );
    makeBareOrigin(root, main);
  });

  it('passes a level master, a logged-in gh and a reachable warm set', TIMEOUT, async () => {
    const r = await preflightWith({});

    expect(r).toMatchObject({ status: 'ok', ahead: 0, behind: 0, problems: [] });
    expect(r.snapshot).toEqual({
      head: headSha(main),
      dirty: false,
      master: { local: headSha(main), remote: headSha(main) },
    });
  });

  it('refuses one unpushed local master commit as master-ahead', TIMEOUT, async () => {
    commitChanges(main, { write: { 'local.txt': 'not pushed\n' } }, 'local only');

    const r = await preflightWith({});

    expect(r).toMatchObject({ status: 'refused', reason: 'preflight-failed', ahead: 1, behind: 0 });
    expect(r.problems.map((p) => p.check)).toEqual(['master-ahead']);
    expect(r.problems[0]?.message).toContain('1 commit');
  });

  it('refuses a master behind origin/master, which only the fetch reveals', TIMEOUT, async () => {
    advanceOrigin(root, `${root}/origin.git`, { write: { 'remote.txt': 'pushed elsewhere\n' } });

    const r = await preflightWith({});

    expect(r).toMatchObject({ status: 'refused', ahead: 0, behind: 1 });
    expect(r.problems.map((p) => p.check)).toEqual(['master-behind']);
  });

  it('refuses a gh that is not logged in', TIMEOUT, async () => {
    const r = await preflightWith({ authExit: 1 });

    expect(r).toMatchObject({ status: 'refused', reason: 'preflight-failed' });
    expect(r.problems.map((p) => p.check)).toEqual(['gh-auth']);
  });

  it('names the one warm member the probe cannot reach', TIMEOUT, async () => {
    const probed: string[] = [];
    const r = await preflightWith({
      probe: (target) => {
        probed.push(`${target.host}:${String(target.port)}:${target.password}`);
        return Promise.resolve(
          target.port === 25711
            ? { ok: false, stage: 'connect', error: new Error('ECONNREFUSED') }
            : { ok: true },
        );
      },
    });

    const sorted = [...probed].sort(compareStrings);
    expect(sorted).toEqual([
      'localhost:25701:testpassword',
      'localhost:25703:testpassword',
      'localhost:25711:testpassword',
      'localhost:25713:testpassword',
    ]);
    expect(r.status).toBe('refused');
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]?.check).toBe('warm-unreachable');
    expect(r.problems[0]?.message).toContain('folia@localhost:25711');
    expect(r.problems[0]?.message).not.toContain('25701');
  });

  it('snapshots a dirty main checkout without refusing it', TIMEOUT, async () => {
    writeFileSync(join(main, 'wip.txt'), 'uncommitted\n');

    const r = await preflightWith({});

    expect(r.status).toBe('ok');
    expect(r.snapshot).toEqual({
      head: headSha(main),
      dirty: true,
      master: { local: headSha(main), remote: headSha(main) },
    });
  });

  it(
    "snapshots origin's master as ls-remote reports it, apart from local master",
    TIMEOUT,
    async () => {
      const pushed = advanceOrigin(root, `${root}/origin.git`, {
        write: { 'remote.txt': 'pushed elsewhere\n' },
      });

      const r = await preflightWith({});

      expect(r.status).toBe('refused');
      expect(r.problems.map((p) => p.check)).toEqual(['master-behind']);
      expect(r.snapshot).toEqual({
        head: headSha(main),
        dirty: false,
        master: { local: headSha(main), remote: pushed },
      });
    },
  );

  it(
    'snapshots local master, not HEAD, when the main checkout is on another branch',
    TIMEOUT,
    async () => {
      const master = headSha(main);
      mustRun('git', ['checkout', '-q', '-b', 'side'], main);
      const side = commitChanges(main, { write: { 'side.txt': 'side work\n' } }, 'side work');

      const r = await preflightWith({});

      expect(r.status).toBe('ok');
      expect(r.snapshot).toEqual({
        head: side,
        dirty: false,
        master: { local: master, remote: master },
      });
    },
  );

  it('fails at step snapshot when origin has no master', TIMEOUT, async () => {
    // No prune: the stale tracking ref survives, so the master-level check
    // passes whatever the global config says.
    mustRun('git', ['config', 'fetch.prune', 'false'], main);
    mustRun('git', ['push', '-q', 'origin', 'master:refs/heads/keep'], main);
    mustRun('git', ['symbolic-ref', 'HEAD', 'refs/heads/keep'], `${root}/origin.git`);
    mustRun('git', ['update-ref', '-d', 'refs/heads/master'], `${root}/origin.git`);

    const r = await preflightWith({});

    expect(r).toMatchObject({
      status: 'failed',
      snapshot: null,
      errors: [
        { step: 'snapshot', message: 'git ls-remote origin refs/heads/master names no ref' },
      ],
    });
  });

  it(
    'refuses a slice branch of a --slug run as stale-slice-branch, naming it',
    TIMEOUT,
    async () => {
      mustRun('git', ['branch', 'slice/epic-9/1212-1'], main);

      const r = await preflightWith({ slugs: ['epic-9'] });

      expect(r).toMatchObject({
        status: 'refused',
        reason: 'preflight-failed',
        ahead: 0,
        behind: 0,
      });
      expect(r.problems).toEqual([
        {
          check: 'stale-slice-branch',
          message: 'slice/epic-9/1212-1 is left over from a run of ship/epic-9',
        },
      ]);
      expect(r.snapshot?.head).toBe(headSha(main));
    },
  );

  it('passes with only another slug’s or a longer slug’s slice branches', TIMEOUT, async () => {
    mustRun('git', ['branch', 'slice/epic-8/1-1'], main);
    mustRun('git', ['branch', 'slice/epic-92/1-1'], main);

    const r = await preflightWith({ slugs: ['epic-9'] });

    expect(r).toMatchObject({ status: 'ok', problems: [] });
  });

  it('names every slice branch of every slug, slug by slug', TIMEOUT, async () => {
    mustRun('git', ['branch', 'slice/epic-1/1-1'], main);
    mustRun('git', ['branch', 'slice/epic-2/critic'], main);
    mustRun('git', ['branch', 'slice/epic-2/3-1'], main);

    const r = await preflightWith({ slugs: ['epic-1', 'epic-2'] });

    expect(r.problems.map((p) => p.message)).toEqual([
      'slice/epic-1/1-1 is left over from a run of ship/epic-1',
      'slice/epic-2/3-1 is left over from a run of ship/epic-2',
      'slice/epic-2/critic is left over from a run of ship/epic-2',
    ]);
    expect(r.problems.every((p) => p.check === 'stale-slice-branch')).toBe(true);
  });

  describe('preflight --attach (in-process)', () => {
    const OPEN_9 = { 'ship/s': { prs: [{ number: 9, state: 'OPEN' }] } };
    const CLOSED_9 = { 'ship/s': { prs: [{ number: 9, state: 'CLOSED' }] } };

    beforeEach(() => {
      mustRun('git', ['branch', 'ship/s'], main);
      commitOn('ship/s', { write: { 's.txt': 's\n' } }, 's1');
      mustRun('git', ['push', '-q', 'origin', 'ship/s'], main);
    });

    /** Check `ship/s` out as its batch and link a slice's `node_modules` into the batch's. */
    function liveSlice(): void {
      const batch = `${main}/.claude/worktrees/ship-s`;
      const slice = `${main}/.claude/worktrees/ship-s-a1-7-1`;
      addWorktreeAt(batch, 'ship/s');
      mkdirSync(`${batch}/node_modules/dep`, { recursive: true });
      addWorktree(main, slice, 'slice/s/a1-7-1');
      symlinkSync(`${batch}/node_modules`, `${slice}/node_modules`, 'junction');
    }

    /** Commit one change of its own on `ship/s`, unpushed. */
    function unpublished(): void {
      commitOn('ship/s', { write: { 'l.txt': 'l\n' } }, 'l');
    }

    it('passes an open PR with no live slice and nothing unpublished', TIMEOUT, async () => {
      const r = await preflightWith({ attach: 'ship/s', responses: OPEN_9 });

      expect(r).toMatchObject({ status: 'ok', problems: [] });
    });

    it.each([
      {
        name: 'a closed PR',
        responses: CLOSED_9,
        setup: () => undefined,
        problem: { check: 'no-open-pr', message: 'ship/s has no open PR: closed (#9)' },
      },
      {
        name: 'a gh that cannot report the PR',
        responses: { 'ship/s': { exit: 1 } },
        setup: () => undefined,
        problem: {
          check: 'no-open-pr',
          message: expect.stringContaining('ship/s: gh pr list exited 1') as string,
        },
      },
      {
        name: 'a live slice',
        responses: OPEN_9,
        setup: liveSlice,
        problem: {
          check: 'slices-live',
          message: expect.stringContaining('ship-s-a1-7-1') as string,
        },
      },
      {
        name: 'an unpublished commit',
        responses: OPEN_9,
        setup: unpublished,
        problem: {
          check: 'unpublished-commits',
          message: expect.stringContaining('1 commit') as string,
        },
      },
    ])('refuses $name', TIMEOUT, async ({ responses, setup, problem }) => {
      setup();

      const r = await preflightWith({ attach: 'ship/s', responses });

      expect(r).toMatchObject({ status: 'refused', reason: 'preflight-failed' });
      expect(r.problems).toEqual([problem]);
    });

    it('names every attach problem in one envelope, in check order', TIMEOUT, async () => {
      // git refuses the throwaway worktree on ship/s once the batch has it checked out.
      unpublished();
      liveSlice();

      const r = await preflightWith({ attach: 'ship/s', responses: CLOSED_9 });

      expect(r.problems.map((p) => p.check)).toEqual([
        'no-open-pr',
        'slices-live',
        'unpublished-commits',
      ]);
    });

    it('passes a branch ahead of origin only by an unpushed merge', TIMEOUT, async () => {
      mergeOn(`${root}/origin.git`, 'ship/s');
      // Level local master with the origin/master the merge advanced: only the attach checks
      // are under test.
      mustRun('git', ['merge', '--ff-only', '-q', 'origin/master'], main);

      const r = await preflightWith({ attach: 'ship/s', responses: OPEN_9 });

      expect(r).toMatchObject({ status: 'ok', problems: [] });
    });

    it('refuses a branch outside ship/ as not-run-batch', TIMEOUT, async () => {
      const r = await preflightWith({ attach: 'feature/s', responses: OPEN_9 });

      expect(r).toMatchObject({ status: 'refused', reason: 'not-run-batch' });
    });
  });
});

describe('preflight', () => {
  it('refuses a linked worktree before checking anything', TIMEOUT, () => {
    const linked = addWorktree(main, `${root}/linked`, 'other');

    const r = runCli<PreflightResult>(['preflight', linked]);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'not-main-worktree', ahead: null });
  });

  it('hands --attach’s branch to the attach checks', TIMEOUT, () => {
    // An empty registry names no warm member, so no RCON probe leaves the process.
    mkdirSync(join(main, 'src/server-pool/registry'), { recursive: true });
    writeFileSync(join(main, REGISTRY), '[]\n');
    makeBareOrigin(root, main);
    const bin = writeFakeGh(root, { 'ship/s': { prs: [{ number: 9, state: 'CLOSED' }] } });

    const r = runCli<PreflightResult>(['preflight', main, '--attach', 'ship/s'], {
      env: prependPath(bin),
    });

    expect(r.json).toMatchObject({ status: 'refused', reason: 'preflight-failed' });
    expect(r.json.problems.filter((p) => p.check !== 'warm-unreachable')).toEqual([
      { check: 'no-open-pr', message: 'ship/s has no open PR: closed (#9)' },
    ]);
  });

  it('hands --slug’s comma-separated slugs to the slice-branch check', TIMEOUT, () => {
    // An empty registry names no warm member, so no RCON probe leaves the process.
    mkdirSync(join(main, 'src/server-pool/registry'), { recursive: true });
    writeFileSync(join(main, REGISTRY), '[]\n');
    makeBareOrigin(root, main);
    const bin = writeFakeGh(root, {});
    mustRun('git', ['branch', 'slice/epic-2/1-1'], main);

    const r = runCli<PreflightResult>(['preflight', main, '--slug', 'epic-1,epic-2'], {
      env: prependPath(bin),
    });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'preflight-failed' });
    expect(r.json.problems.filter((p) => p.check !== 'warm-unreachable')).toEqual([
      {
        check: 'stale-slice-branch',
        message: 'slice/epic-2/1-1 is left over from a run of ship/epic-2',
      },
    ]);
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
      name: 'cut-slice with --critic and an issue attempt',
      args: ['cut-slice', 'b', '--critic', '--issue', '4', '--attempt', '1'],
    },
    { name: 'cut-slice with neither selector', args: ['cut-slice', 'b'] },
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
    expect(run.code).toBe(2);
    expect(run.json.errors[0]?.step).toBe('usage');
    expect(run.json.at).toMatch(ISO_INSTANT);
  });
});
