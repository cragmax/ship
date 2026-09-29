/**
 * Plain fixture repos (per-test `mkdtemp` roots): the fixture main checkout
 * sits at `<root>/main`, so a run it cuts lands under `<root>/ph-runs/`,
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
} from '../helpers/worktree-fixture-git.js';
import { addWorktree, mustRun, porcelain, runCli } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
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
      runRoot: `${root}/ph-runs/epic-900`,
      batch: `${root}/ph-runs/epic-900/batch`,
      reportDir: `${root}/ph-runs/epic-900/reports`,
    });
    expect(branchOf(`${root}/ph-runs/epic-900/batch`)).toBe('ship/epic-900');
    expect(headSha(`${root}/ph-runs/epic-900/batch`)).toBe(master);
    expect(existsSync(`${root}/ph-runs/epic-900/reports`)).toBe(true);
    expect(porcelain(main)).toBe('');
  });

  it('names an explicit-list run by its issues ascending', TIMEOUT, () => {
    const r = runCli<CutBatchResult>(['cut-batch', main, '--issues', '12,3']);

    expect(r.json).toMatchObject({ status: 'ok', branch: 'ship/3-12' });
    expect(branchOf(`${root}/ph-runs/3-12/batch`)).toBe('ship/3-12');
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
        mkdirSync(`${root}/ph-runs/epic-900`, { recursive: true });
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

describe('cut-slice', () => {
  it('cuts slice/<slug>/N-K at the batch HEAD, which live-runs does not list', TIMEOUT, () => {
    const cut = runCli<CutBatchResult>(['cut-batch', main, '--epic', '900']);
    const batch = cut.json.batch ?? '';
    const head = commitChanges(batch, { write: { 'landed.txt': 'landed\n' } }, 'landed');

    const r = runCli<CutSliceResult>(['cut-slice', batch, '--issue', '41', '--attempt', '2']);

    expect(r.code).toBe(0);
    const slice = `${root}/ph-runs/epic-900/slice-41-2`;
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
    mkdirSync(`${root}/ph-runs/epic-900/slice-41-1`);
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
    expect(existsSync(`${root}/ph-runs/epic-900/slice-41-1`)).toBe(false);
  });

  it('refuses a linked worktree that is not on a ship/ branch', TIMEOUT, () => {
    const other = addWorktree(main, `${root}/other`, 'feature/x');

    const r = runCli<CutSliceResult>(['cut-slice', other, '--issue', '41', '--attempt', '1']);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'not-run-batch' });
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
    expect(r.snapshot).toEqual({ head: headSha(main), dirty: false });
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
    expect(sorted).toEqual(['localhost:25701:testpassword', 'localhost:25711:testpassword']);
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
    expect(r.snapshot).toEqual({ head: headSha(main), dirty: true });
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
  ])('exits 2 with a usage envelope for $name', TIMEOUT, ({ args }) => {
    const run = runCli(args, { cwd: root });
    expect(run.code).toBe(2);
    expect(run.json.errors[0]?.step).toBe('usage');
  });
});
