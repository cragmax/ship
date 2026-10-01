/**
 * Plain fixture repos (per-test `mkdtemp` roots): the fixture main checkout
 * sits at `<root>/main`, so a run it cuts lands under `<root>/ph-ship/`,
 * inside the temp root. `preflight` gets a bare `origin` and a fake `gh`;
 * its RCON probe is injected in-process, never aimed at the real warm-set
 * ports, which may be live.
 *
 * @integrationTier standalone
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  main = makeGitRepo(root, { 'base.txt': 'base\n' });
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
}): Promise<PreflightResult> {
  const overlay = prependPath(writeFakeGh(root, {}, options.authExit ?? 0));
  const [key = 'PATH', value = ''] = Object.entries(overlay)[0] ?? [];
  const saved = process.env[key];
  process.env[key] = value;
  try {
    return await preflight({ main, probe: options.probe ?? (() => Promise.resolve({ ok: true })) });
  } finally {
    process.env[key] = saved;
  }
}

/** The short branch a worktree has checked out. */
function branchOf(dir: string): string {
  return mustRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
}

describe('cut-batch', () => {
  it('cuts ship/epic-E at master beside the main checkout, with reports/', TIMEOUT, () => {
    const master = headSha(main);

    const r = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      branch: 'ship/epic-900',
      base: master,
      runRoot: `${root}/ph-ship/epic-900`,
      batch: `${root}/ph-ship/epic-900/ship-epic-900`,
      reportDir: `${root}/ph-ship/epic-900/reports`,
    });
    expect(branchOf(`${root}/ph-ship/epic-900/ship-epic-900`)).toBe('ship/epic-900');
    expect(headSha(`${root}/ph-ship/epic-900/ship-epic-900`)).toBe(master);
    expect(existsSync(`${root}/ph-ship/epic-900/reports`)).toBe(true);
    expect(porcelain(main)).toBe('');
  });

  it('names an explicit-list run by its issues ascending', TIMEOUT, () => {
    const r = runCli<CutBatchResult>(['cut-batch', main, '--issues', '12,3']);

    expect(r.json).toMatchObject({
      status: 'ok',
      branch: 'ship/3-12',
      batch: `${root}/ph-ship/3-12/ship-3`,
    });
    expect(branchOf(`${root}/ph-ship/3-12/ship-3`)).toBe('ship/3-12');
  });

  it.each([
    {
      guard: 'branch-exists',
      target: () => {
        mustRun('git', ['branch', 'ship/epic-900'], main);
        return main;
      },
    },
    {
      guard: 'path-exists',
      target: () => {
        mkdirSync(`${root}/ph-ship/epic-900`, { recursive: true });
        return main;
      },
    },
    {
      guard: 'not-main-worktree',
      target: () => addWorktree(main, `${root}/linked`, 'other'),
    },
  ])('refuses $guard with the repository unchanged', TIMEOUT, ({ guard, target }) => {
    const dir = target();
    const before = repoState(main);

    const r = runCli<CutBatchResult>(['cut-batch', dir, '--epic', '900']);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: guard, branch: null });
    expect(repoState(main)).toEqual(before);
  });
});

describe('cut-batch --attach', () => {
  const BATCH = (): string => `${root}/ph-ship/s/ship-s`;
  const OPEN_9 = { 'ship/s': { prs: [{ number: 9, state: 'OPEN' }] } };
  let bare: string;

  beforeEach(() => {
    bare = makeBareOrigin(root, main);
  });

  /** Commit `changes` on an existing branch through a throwaway worktree, which is removed again. */
  function commitOn(branch: string, changes: Changes, message: string): string {
    const tmp = mkdtempSync(join(root, 'wt-'));
    rmSync(tmp, { recursive: true });
    mustRun('git', ['worktree', 'add', '-q', tmp, branch], main);
    const sha = commitChanges(tmp, changes, message);
    mustRun('git', ['worktree', 'remove', tmp], main);
    return sha;
  }

  /** Create local `ship/s` from master with one commit of its own; no worktree left on it. */
  function localBranch(): string {
    mustRun('git', ['branch', 'ship/s'], main);
    return commitOn('ship/s', { write: { 's.txt': 's\n' } }, 's1');
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
      runRoot: `${root}/ph-ship/s`,
      batch: BATCH(),
      reportDir: `${root}/ph-ship/s/reports`,
      attach: { created: true, fastForwarded: false, pr: 9 },
    });
    expect(branchOf(BATCH())).toBe('ship/s');
    expect(headSha(BATCH())).toBe(tip);
    expect(existsSync(`${root}/ph-ship/s/reports`)).toBe(true);
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
      reportDir: `${root}/ph-ship/s/reports`,
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
    mustRun('git', ['push', '-q', 'origin', 'ship/s'], main);
    advanceOrigin(root, bare, { write: { 'o.txt': 'o\n' } }, 'o', 'ship/s');
    const local = commitOn('ship/s', { write: { 'l.txt': 'l\n' } }, 'l');

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'branch-diverged' });
    expect(headSha(main, 'refs/heads/ship/s')).toBe(local);
    expect(existsSync(BATCH())).toBe(false);
  });

  it('checks out a local branch ahead of origin as it is, never rewinding it', TIMEOUT, () => {
    localBranch();
    mustRun('git', ['push', '-q', 'origin', 'ship/s'], main);
    // An unpushed resync merge: local has a commit origin lacks, and nothing the other way.
    const local = commitOn('ship/s', { write: { 'l.txt': 'l\n' } }, 'l');

    const r = attach(OPEN_9);

    expect(r.json).toMatchObject({
      status: 'ok',
      base: local,
      attach: { created: true, fastForwarded: false },
    });
    expect(headSha(main, 'refs/heads/ship/s')).toBe(local);
    expect(headSha(BATCH())).toBe(local);
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
    expect(existsSync(`${root}/ph-ship/s/reports`)).toBe(false);
  });

  /** Check an existing branch out at `path`. */
  function addWorktreeAt(path: string, branch: string): void {
    mustRun('git', ['worktree', 'add', '-q', path, branch], main);
  }
});

describe('cut-slice', () => {
  it('cuts slice/<slug>/N-K at the batch HEAD, which live-runs does not list', TIMEOUT, () => {
    const cut = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']);
    const batch = cut.json.batch ?? '';
    const head = commitChanges(batch, { write: { 'landed.txt': 'landed\n' } }, 'landed');

    const r = runCli<CutSliceResult>(['cut-slice', batch, '--issue', '41', '--attempt', '2']);

    expect(r.code).toBe(0);
    const slice = `${root}/ph-ship/epic-900/slice-41-2`;
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
    mkdirSync(`${root}/ph-ship/epic-900/slice-41-1`);
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
    expect(existsSync(`${root}/ph-ship/epic-900/slice-41-1`)).toBe(false);
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
      const slice = `${root}/ph-ship/epic-900/slice-critic`;
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
});

describe('preflight', () => {
  it('refuses a linked worktree before checking anything', TIMEOUT, () => {
    const linked = addWorktree(main, `${root}/linked`, 'other');

    const r = runCli<PreflightResult>(['preflight', linked]);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'not-main-worktree', ahead: null });
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
      name: 'cut-slice with --critic and an issue attempt',
      args: ['cut-slice', 'b', '--critic', '--issue', '4', '--attempt', '1'],
    },
    { name: 'cut-slice with neither selector', args: ['cut-slice', 'b'] },
    {
      name: 'cut-batch with --attach and --epic',
      args: ['cut-batch', 'm', '--attach', 'ship/s', '--epic', '9'],
    },
  ])('exits 2 with a stamped usage envelope for $name', TIMEOUT, ({ args }) => {
    const run = runCli(args, { cwd: root });
    expect(run.code).toBe(2);
    expect(run.json.errors[0]?.step).toBe('usage');
    expect(run.json.at).toMatch(ISO_INSTANT);
  });
});
