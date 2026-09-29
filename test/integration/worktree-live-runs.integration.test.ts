/**
 * Plain fixture repos (per-test `mkdtemp` roots) with run, slice, agent and
 * detached worktrees; the spawned CLI finds a fake `gh` first on its `PATH`,
 * so the real one is never called.
 *
 * @integrationTier standalone
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import type { LiveRun, LiveRunsResult } from '../../tooling/worktree/types.js';
import {
  commitChanges,
  headSha,
  makeGitRepo,
  prependPath,
  writeFakeGh,
  type FakeGhResponse,
} from '../helpers/worktree-fixture-git.js';
import { addWorktree, mustRun, runCli } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };

let root: string;
let main: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-runs-')));
  main = makeGitRepo(root, { 'base.txt': 'base\n', 'r.txt': 'a file the run renames\n' });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

/** Run `live-runs` against the fixture main with a fake `gh` answering `responses`. */
function liveRuns(responses: Record<string, FakeGhResponse>): {
  code: number;
  json: LiveRunsResult;
  run: (branch: string) => LiveRun | undefined;
} {
  const bin = writeFakeGh(root, responses);
  const { code, json } = runCli<LiveRunsResult>(['live-runs', main], { env: prependPath(bin) });
  return { code, json, run: (branch) => json.runs.find((r) => r.branch === branch) };
}

describe('live-runs', () => {
  it('reports every ship/* worktree with its commits, files, status and PR', TIMEOUT, () => {
    const a = addWorktree(main, `${root}/a`, 'ship/a');
    commitChanges(a, { write: { 'add.txt': 'added\n' } }, 'a1');
    commitChanges(
      a,
      { rename: [['r.txt', 'r2.txt']], write: { 'base.txt': 'edited by a\n' } },
      'a2',
    );
    writeFileSync(join(a, 'untracked.txt'), 'wip\n');
    const b = addWorktree(main, `${root}/b`, 'ship/b');
    const bTip = commitChanges(b, { write: { 'b.txt': 'b\n' } }, 'b1');
    addWorktree(main, `${root}/c`, 'ship/c');
    addWorktree(main, `${root}/slice`, 'slice-1');
    addWorktree(main, `${main}/.claude/worktrees/agent-x`, 'worktree-agent-x');
    mustRun('git', ['worktree', 'add', '-q', '--detach', `${root}/detached`], main);

    const { code, json, run } = liveRuns({
      'ship/a': { prs: [{ number: 11, state: 'OPEN' }] },
      'ship/b': { prs: [{ number: 12, state: 'MERGED', headRefOid: bTip }] },
    });

    expect(code).toBe(0);
    expect(json.status).toBe('ok');
    expect(json.runs.map((r) => r.branch)).toEqual(['ship/a', 'ship/b', 'ship/c']);
    expect(run('ship/a')).toMatchObject({
      ahead: 2,
      mergeBase: mustRun('git', ['merge-base', 'master', 'ship/a'], main).trim(),
      landed: ['add.txt', 'base.txt', 'r.txt', 'r2.txt'],
      dirty: true,
      pr: { state: 'open', number: 11 },
      spent: false,
      nested: [],
    });
    expect(run('ship/b')).toMatchObject({
      ahead: 1,
      landed: ['b.txt'],
      dirty: false,
      pr: { state: 'merged', number: 12, headOid: bTip },
      spent: true,
      spentUnverified: false,
    });
    expect(run('ship/c')).toMatchObject({
      ahead: 0,
      landed: [],
      dirty: false,
      pr: { state: 'none', number: null },
      spent: false,
    });
  });

  it('counts landed files from the merge-base, excluding merged-in master changes', TIMEOUT, () => {
    const r = addWorktree(main, `${root}/r`, 'ship/r');
    commitChanges(r, { write: { 'r-own.txt': 'run file\n' } }, 'r1');
    const m1 = commitChanges(main, { write: { 'm.txt': 'master before the resync\n' } }, 'm1');
    mustRun('git', ['merge', '-q', '--no-edit', 'master'], r);
    commitChanges(main, { write: { 'm2.txt': 'master after the resync\n' } }, 'm2');

    const { json, run } = liveRuns({});

    expect(json.status).toBe('ok');
    // master's tip is m2 by now, so the merge-base is distinguishable from it.
    expect(run('ship/r')?.mergeBase).toBe(m1);
    expect(run('ship/r')?.landed).toEqual(['r-own.txt']);
  });

  it('lists nested worktrees and reports a run whose directory is gone', TIMEOUT, () => {
    const n = addWorktree(main, `${root}/n`, 'ship/n');
    const agent = addWorktree(main, `${n}/.claude/worktrees/agent-y`, 'worktree-agent-y');
    const g = addWorktree(main, `${root}/g`, 'ship/g');
    rmSync(g, { recursive: true, force: true });

    const { json, run } = liveRuns({});

    expect(json.status).toBe('ok');
    expect(run('ship/n')).toMatchObject({ nested: [agent], dirty: false });
    expect(run('ship/g')).toMatchObject({
      dirty: null,
      ahead: 0,
      landed: [],
      pr: { state: 'none', number: null },
      nested: [],
    });
  });

  it('prefers an open PR over a closed one and marks a closed-only run spent', TIMEOUT, () => {
    addWorktree(main, `${root}/p`, 'ship/p');
    const q = addWorktree(main, `${root}/q`, 'ship/q');

    const { run } = liveRuns({
      'ship/p': {
        prs: [
          { number: 20, state: 'CLOSED' },
          { number: 21, state: 'OPEN' },
        ],
      },
      'ship/q': { prs: [{ number: 22, state: 'CLOSED', headRefOid: headSha(q) }] },
    });

    expect(run('ship/p')).toMatchObject({ pr: { state: 'open', number: 21 }, spent: false });
    expect(run('ship/q')).toMatchObject({ pr: { state: 'closed', number: 22 }, spent: true });
  });

  it('keeps a run re-cut after its PR merged live: its tip is beyond the PR head', TIMEOUT, () => {
    const x = addWorktree(main, `${root}/x`, 'ship/x');
    const merged = commitChanges(x, { write: { 'x.txt': 'x\n' } }, 'x1');
    commitChanges(x, { write: { 'x.txt': 'x2\n' } }, 'x2');

    const { run } = liveRuns({
      'ship/x': { prs: [{ number: 40, state: 'MERGED', headRefOid: merged }] },
    });

    expect(run('ship/x')).toMatchObject({
      pr: { state: 'merged', number: 40, headOid: merged },
      spent: false,
      spentUnverified: false,
    });
  });

  it('leaves a merged run unverified when the PR head is absent or unnamed', TIMEOUT, () => {
    addWorktree(main, `${root}/u`, 'ship/u');
    addWorktree(main, `${root}/v`, 'ship/v');

    const { run } = liveRuns({
      'ship/u': { prs: [{ number: 50, state: 'MERGED', headRefOid: 'f'.repeat(40) }] },
      'ship/v': { prs: [{ number: 51, state: 'MERGED' }] },
    });

    expect(run('ship/u')).toMatchObject({ spent: false, spentUnverified: true });
    expect(run('ship/v')).toMatchObject({
      pr: { state: 'merged', number: 51, headOid: null },
      spent: false,
      spentUnverified: true,
    });
  });

  it('fails loudly when gh cannot report a PR, still listing every run', TIMEOUT, () => {
    addWorktree(main, `${root}/e`, 'ship/e');
    const f = addWorktree(main, `${root}/f`, 'ship/f');
    commitChanges(f, { write: { 'f.txt': 'f\n' } }, 'f1');

    const { code, json, run } = liveRuns({
      'ship/e': { exit: 1 },
      'ship/f': { prs: [{ number: 30, state: 'OPEN' }] },
    });

    expect(code).toBe(1);
    expect(json.status).toBe('failed');
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0]?.step).toBe('pr-state');
    expect(json.errors[0]?.message).toContain('ship/e');
    expect(run('ship/e')?.pr).toEqual({ state: 'unknown', number: null, headOid: null });
    expect(run('ship/f')).toMatchObject({
      ahead: 1,
      landed: ['f.txt'],
      pr: { state: 'open', number: 30 },
    });
  });

  it(
    'fails preconditions when given a linked worktree instead of the main checkout',
    TIMEOUT,
    () => {
      const linked = addWorktree(main, `${root}/linked`, 'ship/linked');
      const bin = writeFakeGh(root, {});

      const run = runCli<LiveRunsResult>(['live-runs', linked], { env: prependPath(bin) });

      expect(run.code).toBe(1);
      expect(run.json.status).toBe('failed');
      expect(run.json.errors[0]?.step).toBe('preconditions');
    },
  );
});

describe('usage errors', () => {
  it.each([
    { name: 'live-runs without a path', args: ['live-runs'] },
    { name: 'live-runs with an extra argument', args: ['live-runs', 'main', 'extra'] },
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
