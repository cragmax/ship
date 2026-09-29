/**
 * npm fixture repos (per-test `mkdtemp` roots, one shared offline template)
 * with a bare `origin` and a batch worktree on `ship/r`: `bump` versions
 * the batch from its own commits, and `publish` pushes it there and opens
 * its PR through a fake `gh`.
 *
 * @integrationTier standalone
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { compareStrings, toPosix } from '../../tooling/shared.js';
import type * as ExecModule from '../../tooling/worktree/exec.js';
import { PUSH_TIMEOUT_MS, runCaptured } from '../../tooling/worktree/exec.js';
import { publish as publishInProcess } from '../../tooling/worktree/publish.js';
import type { BumpResult, PublishResult } from '../../tooling/worktree/types-run.js';
import {
  commitChanges,
  headSha,
  makeBareOrigin,
  prependPath,
  readFakePrCreated,
  writeFakeGh,
  type FakeGhResponse,
  type FakePrCreate,
} from '../helpers/worktree-fixture-git.js';
import {
  addWorktree,
  makeFixtureRepo,
  mustRun,
  porcelain,
  prepareTemplate,
  runCli,
  runIn,
} from '../helpers/worktree-fixture.js';

// A pass-through spy: every spawn still runs, and the in-process test reads
// the options each one got. The CLI-spawned tests run in their own process.
vi.mock('../../tooling/worktree/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();
  return { ...actual, runCaptured: vi.fn(actual.runCaptured) };
});

const TIMEOUT = { timeout: 60_000 };
const HOOK_SAYS = 'fixture hook: commit refused';
// Hooks run from the worktree root; `dist/index.js` is what the fixture build writes.
const PRE_PUSH_NEEDS_BUILD = [
  '#!/bin/sh',
  'if [ -f dist/index.js ]; then echo "pre-push saw the build"; exit 0; fi',
  'echo "pre-push: no build"',
  'exit 1',
  '',
].join('\n');

let templateRoot: string;
let template: string;
let root: string;
// `bump` leaves its `freshLogDir` log in the OS temp dir for its caller.
const logDirs = new Set<string>();

beforeAll(() => {
  templateRoot = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-end-tpl-')));
  template = prepareTemplate(templateRoot);
}, TIMEOUT.timeout);

afterAll(() => {
  rmSync(templateRoot, { recursive: true, force: true });
});

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-end-')));
});

afterEach(() => {
  try {
    for (const dir of [root, ...logDirs]) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
  logDirs.clear();
});

interface Run {
  readonly main: string;
  readonly bare: string;
  readonly batch: string;
}

/** An npm fixture repo (version 1.0.0, lockfile) with a bare origin and a batch on `branch`. */
function makeRun(branch = 'ship/r'): Run {
  const main = makeFixtureRepo(root, template);
  const bare = makeBareOrigin(root, main);
  const batch = addWorktree(main, `${root}/batch`, branch);
  return { main, bare, batch };
}

/** Whether the bare origin has the branch. */
function onOrigin(bare: string, branch: string): boolean {
  return runIn('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], bare).exitCode === 0;
}

/** The `version` fields of a checkout's package.json and lockfile. */
function versions(dir: string): { pkg: string; lock: string; lockRoot: string } {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as {
    version: string;
    packages: Record<string, { version: string }>;
  };
  return { pkg: pkg.version, lock: lock.version, lockRoot: lock.packages['']?.version ?? '' };
}

/** Point the fixture repo's hooks at `<root>/hooks`, holding one `name` hook running `script`. */
function installHook(main: string, name: string, script: string): void {
  const hooks = `${root}/hooks`;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(`${hooks}/${name}`, script);
  chmodSync(`${hooks}/${name}`, 0o755);
  mustRun('git', ['config', 'core.hooksPath', hooks], main);
}

/** Run `bump` on the batch, recording the log dir it leaves. */
function runBump(batch: string): ReturnType<typeof runCli<BumpResult>> {
  const r = runCli<BumpResult>(['bump', batch]);
  if (r.json.log !== null) logDirs.add(dirname(r.json.log));
  return r;
}

/** The paths a commit changes against its first parent. */
function commitPaths(dir: string, sha: string): string[] {
  return mustRun('git', ['diff-tree', '-r', '--no-commit-id', '--name-only', sha], dir)
    .split(/\r?\n/u)
    .filter((p) => p !== '')
    .sort(compareStrings);
}

describe('bump', () => {
  it(
    'bumps minor for a feat subject, in one commit of package.json and the lockfile',
    TIMEOUT,
    () => {
      const run = makeRun();
      commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
      commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, 'feat(b): two');

      const r = runBump(run.batch);

      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ status: 'ok', kind: 'minor', from: '1.0.0', to: '1.1.0' });
      const head = headSha(run.batch);
      expect(r.json.commit).toBe(head);
      expect(mustRun('git', ['log', '-1', '--format=%B', head], run.batch).trim()).toBe(
        'chore(build): bump version — r\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      );
      expect(commitPaths(run.batch, head)).toEqual(['package-lock.json', 'package.json']);
      expect(versions(run.batch)).toEqual({ pkg: '1.1.0', lock: '1.1.0', lockRoot: '1.1.0' });
      expect(porcelain(run.batch)).toBe('');
    },
  );

  it('bumps patch for fix-only commits, ignoring a merge commit feat subject', TIMEOUT, () => {
    const run = makeRun();
    const fork = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
    const side = addWorktree(run.main, `${root}/side`, 'side', fork);
    commitChanges(side, { write: { 'c.txt': 'c\n' } }, 'fix(c): side');
    mustRun('git', ['merge', '--no-ff', '-q', '-m', 'feat(m): merged', 'side'], run.batch);

    const r = runBump(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', kind: 'patch', from: '1.0.0', to: '1.0.1' });
    expect(versions(run.batch)).toEqual({ pkg: '1.0.1', lock: '1.0.1', lockRoot: '1.0.1' });
  });

  it.each([
    { reason: 'nothing-to-bump', branch: 'ship/r', subjects: [] },
    {
      reason: 'already-bumped',
      branch: 'ship/r',
      subjects: ['feat(a): one', 'chore(build): bump version — r'],
    },
    { reason: 'not-run-batch', branch: 'feature/x', subjects: ['feat(a): one'] },
  ])('refuses $reason and touches nothing', TIMEOUT, ({ reason, branch, subjects }) => {
    const run = makeRun(branch);
    subjects.forEach((s, i) => commitChanges(run.batch, { write: { [`f${String(i)}`]: s } }, s));
    const head = headSha(run.batch);

    const r = runBump(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason, commit: null });
    expect(headSha(run.batch)).toBe(head);
    expect(porcelain(run.batch)).toBe('');
    expect(versions(run.batch).pkg).toBe('1.0.0');
  });

  it('restores both files when the commit hook fails', TIMEOUT, () => {
    const run = makeRun();
    const head = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
    installHook(run.main, 'pre-commit', `#!/bin/sh\necho "${HOOK_SAYS}"\nexit 1\n`);

    const r = runBump(run.batch);

    expect(r.json).toMatchObject({ status: 'failed', commit: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['commit']);
    expect(readFileSync(r.json.log ?? '', 'utf8')).toContain(HOOK_SAYS);
    expect(headSha(run.batch)).toBe(head);
    expect(porcelain(run.batch)).toBe('');
    expect(versions(run.batch)).toEqual({ pkg: '1.0.0', lock: '1.0.0', lockRoot: '1.0.0' });
  });
});

describe('publish', () => {
  const TITLE = 'feat(build): ship r';
  const BODY = '## Summary\n\nfixes #1\n';

  /** Run `publish` on the batch with a fake `gh` first on `PATH`. */
  function publish(
    batch: string,
    gh: { responses?: Record<string, FakeGhResponse>; create?: FakePrCreate } = {},
  ): { r: ReturnType<typeof runCli<PublishResult>>; bin: string } {
    const bin = writeFakeGh(root, gh.responses ?? {}, 0, gh.create ?? { number: 42 });
    writeFileSync(`${root}/body.md`, BODY);
    const r = runCli<PublishResult>(
      [
        'publish',
        batch,
        '--title',
        TITLE,
        '--body-file',
        `${root}/body.md`,
        '--log',
        `${root}/push.log`,
      ],
      { env: prependPath(bin) },
    );
    return { r, bin };
  }

  it('pushes the run branch and opens its PR with the title and body file', TIMEOUT, () => {
    const run = makeRun();
    const head = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');

    const { r, bin } = publish(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      pushed: true,
      pr: { number: 42, url: 'https://github.com/fixture/repo/pull/42' },
    });
    expect(headSha(run.bare, 'refs/heads/ship/r')).toBe(head);
    expect(readFakePrCreated(bin)).toEqual({
      argv: [
        'pr',
        'create',
        '--base',
        'master',
        '--head',
        'ship/r',
        '--title',
        TITLE,
        '--body-file',
        `${root}/body.md`,
      ],
      body: BODY,
    });
  });

  it('pushes to the run branch, not master, under push.default=upstream', TIMEOUT, () => {
    const run = makeRun();
    const master = headSha(run.bare, 'refs/heads/master');
    const head = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    // A bare `<branch>` refspec would follow this upstream to master.
    mustRun('git', ['config', 'push.default', 'upstream'], run.main);
    mustRun('git', ['branch', '--set-upstream-to=origin/master'], run.batch);

    const { r } = publish(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', pushed: true });
    expect(headSha(run.bare, 'refs/heads/ship/r')).toBe(head);
    expect(headSha(run.bare, 'refs/heads/master')).toBe(master);
  });

  it('builds before pushing, so the pre-push gate sees a current dist', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    installHook(run.main, 'pre-push', PRE_PUSH_NEEDS_BUILD);

    const { r } = publish(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', pushed: true });
    expect(readFileSync(`${root}/push.log`, 'utf8')).toContain('pre-push saw the build');
  });

  it.each([
    { name: 'a branch outside ship/', branch: 'feature/x', open: [], reason: 'not-run-batch' },
    { name: 'a branch with an open PR', branch: 'ship/r', open: [7], reason: 'pr-exists' },
  ])('refuses $name and pushes nothing', TIMEOUT, ({ branch, open, reason }) => {
    const run = makeRun(branch);
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    const prs = open.map((number) => ({ number, state: 'OPEN' }));

    const { r, bin } = publish(run.batch, { responses: { [branch]: { prs } } });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason, pushed: false, pr: null });
    expect(onOrigin(run.bare, branch)).toBe(false);
    expect(readFakePrCreated(bin)).toBeNull();
  });

  it('reports a push the origin rejects, opening no PR', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    writeFileSync(`${run.bare}/hooks/pre-receive`, '#!/bin/sh\necho "origin says no"\nexit 1\n');
    chmodSync(`${run.bare}/hooks/pre-receive`, 0o755);

    const { r, bin } = publish(run.batch);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', pushed: false, pr: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['push']);
    expect(readFileSync(`${root}/push.log`, 'utf8')).toContain('origin says no');
    expect(onOrigin(run.bare, 'ship/r')).toBe(false);
    expect(readFakePrCreated(bin)).toBeNull();
  });
});

describe('usage errors', () => {
  it.each([
    {
      name: 'server-tier with an unknown engine',
      args: ['server-tier', 'b', '--engine', 'vanilla', '--registry', 'r', '--log', 'l'],
    },
    { name: 'publish without --title', args: ['publish', 'b', '--body-file', 'f', '--log', 'l'] },
  ])('exits 2 with a usage envelope for $name', TIMEOUT, ({ args }) => {
    const run = runCli(args, { cwd: root });
    expect(run.code).toBe(2);
    expect(run.json.errors[0]?.step).toBe('usage');
  });
});

describe('publish (in-process)', () => {
  it('gives the push spawn the push budget and the log file', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    writeFileSync(`${root}/body.md`, 'body\n');
    const [key = 'PATH', value = ''] = Object.entries(prependPath(writeFakeGh(root, {})))[0] ?? [];
    const saved = process.env[key];
    process.env[key] = value;
    vi.mocked(runCaptured).mockClear();
    try {
      const r = publishInProcess({
        batch: run.batch,
        title: 't',
        bodyFile: `${root}/body.md`,
        logFile: `${root}/push.log`,
      });
      expect(r).toMatchObject({ status: 'ok', pushed: true });
    } finally {
      process.env[key] = saved;
    }

    const pushes = vi
      .mocked(runCaptured)
      .mock.calls.filter(([file, args]) => file === 'git' && args.includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.[2]).toMatchObject({
      timeoutMs: PUSH_TIMEOUT_MS,
      logFile: `${root}/push.log`,
    });
    // The budget is a contract of its own, not only a name: pin its value.
    expect(PUSH_TIMEOUT_MS).toBe(2_700_000);
  });
});
