/**
 * Plain fixture repos (per-test `mkdtemp` roots): the fixture main checkout
 * sits at `<root>/main` and ignores the run paths as this repo does, so a run
 * it cuts lands in its `.claude/worktrees/` and `reports/`. `preflight` gets a
 * bare `origin` and a fake `gh`; its RCON probe is injected in-process, never
 * aimed at the real warm-set ports, which may be live.
 *
 * @integrationTier standalone
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareStrings, toPosix } from '../../../tooling/lib/strings.js';
import { preflight, type WarmProbe } from '../../src/cli/commands/preflight.js';
import type { PreflightResult } from '../../src/cli/envelope/types-run.js';
import {
  addWorktreeAt,
  advanceOrigin,
  commitChanges,
  commitOn,
  headSha,
  makeBareOrigin,
  makeGitRepo,
  mergeOn,
  prependPath,
  writeFakeGh,
  type FakeGhResponse,
} from '../../../tooling/test/helpers/worktree-fixture-git.js';
import { runCli } from '../helpers/worktree-cli-fixture.js';
import { addWorktree, mustRun } from '../../../tooling/test/helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const REGISTRY = 'server-pool/src/registry/pool-registry.json';
const REAL_REGISTRY = resolve(import.meta.dirname, '../../..', REGISTRY);

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

describe('preflight (in-process)', () => {
  beforeEach(() => {
    main = makeGitRepo(
      root,
      { 'base.txt': 'base\n', [REGISTRY]: readFileSync(REAL_REGISTRY, 'utf8') },
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
    mustRun('git', ['branch', 'slice/epic-2/3-2'], main);
    mustRun('git', ['branch', 'slice/epic-2/3-1'], main);

    const r = await preflightWith({ slugs: ['epic-1', 'epic-2'] });

    expect(r.problems.map((p) => p.message)).toEqual([
      'slice/epic-1/1-1 is left over from a run of ship/epic-1',
      'slice/epic-2/3-1 is left over from a run of ship/epic-2',
      'slice/epic-2/3-2 is left over from a run of ship/epic-2',
    ]);
    expect(r.problems.every((p) => p.check === 'stale-slice-branch')).toBe(true);
  });

  describe('preflight --attach (in-process)', () => {
    const OPEN_9 = { 'ship/s': { prs: [{ number: 9, state: 'OPEN' }] } };
    const CLOSED_9 = { 'ship/s': { prs: [{ number: 9, state: 'CLOSED' }] } };

    beforeEach(() => {
      mustRun('git', ['branch', 'ship/s'], main);
      commitOn(main, 'ship/s', { write: { 's.txt': 's\n' } }, 's1');
      mustRun('git', ['push', '-q', 'origin', 'ship/s'], main);
    });

    /** Check `ship/s` out as its batch and link a slice's `node_modules` into the batch's. */
    function liveSlice(): void {
      const batch = `${main}/.claude/worktrees/ship-s`;
      const slice = `${main}/.claude/worktrees/ship-s-a1-7-1`;
      addWorktreeAt(main, batch, 'ship/s');
      mkdirSync(`${batch}/node_modules/dep`, { recursive: true });
      addWorktree(main, slice, 'slice/s/a1-7-1');
      symlinkSync(`${batch}/node_modules`, `${slice}/node_modules`, 'junction');
    }

    /** Commit one change of its own on `ship/s`, unpushed. */
    function unpublished(): void {
      commitOn(main, 'ship/s', { write: { 'l.txt': 'l\n' } }, 'l');
    }

    it('passes an open PR with no live slice and nothing unpublished', TIMEOUT, async () => {
      const r = await preflightWith({ attach: 'ship/s', responses: OPEN_9 });

      expect(r).toMatchObject({ status: 'ok', problems: [] });
    });

    it.each([
      {
        name: 'a closed PR',
        responses: CLOSED_9,
        setup: (): void => undefined,
        problem: { check: 'no-open-pr', message: 'ship/s has no open PR: closed (#9)' },
      },
      {
        name: 'a gh that cannot report the PR',
        responses: { 'ship/s': { exit: 1 } },
        setup: (): void => undefined,
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
      mergeOn(main, `${root}/origin.git`, 'ship/s');
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
    mkdirSync(join(main, 'server-pool/src/registry'), { recursive: true });
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
    mkdirSync(join(main, 'server-pool/src/registry'), { recursive: true });
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
