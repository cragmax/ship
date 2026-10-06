/**
 * npm fixture repos (per-test `mkdtemp` roots, one shared offline template)
 * with a bare `origin` and a batch worktree on `ship/r`: `bump` versions
 * the batch from its own commits, and `publish` pushes it there and opens
 * its PR through a fake `gh`; `append-pr-body` appends a section to a fake
 * PR body; `post-pr-comment` posts a comment to a fake PR.
 *
 * @integrationTier standalone
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { compareStrings, toPosix } from '../../tooling/shared.js';
import type * as ExecModule from '../../tooling/worktree/exec.js';
import { appendPrBody as appendPrBodyInProcess } from '../../tooling/worktree/append-pr-body.js';
import { PUSH_TIMEOUT_MS, runCaptured } from '../../tooling/worktree/exec.js';
import { MERGEABLE_READS } from '../../tooling/worktree/publish-push.js';
import { publish as publishInProcess, pushBranch } from '../../tooling/worktree/publish.js';
import type {
  AppendPrBodyResult,
  BumpResult,
  PostPrCommentResult,
  PublishResult,
} from '../../tooling/worktree/types-run.js';
import { StepFailure } from '../../tooling/worktree/types.js';
import {
  advanceOrigin,
  commitChanges,
  headSha,
  makeBareOrigin,
  prependPath,
  readFakePrCommented,
  readFakePrCreated,
  readFakePrEdited,
  readFakePrViewCount,
  setFakePrBodies,
  setFakePrComment,
  setFakePrEditExit,
  setFakePrViews,
  writeFakeGh,
  type Changes,
  type FakeGhResponse,
  type FakePrComment,
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
    {
      name: 'a patch-bumped branch and a fix as a no-op',
      first: 'fix(a): one',
      next: 'fix(b): two',
      kind: 'patch',
      from: '1.0.1',
      to: '1.0.1',
      bumps: 1,
    },
    {
      name: 'a patch-bumped branch and a feat with a second bump commit at master’s minor',
      first: 'fix(a): one',
      next: 'feat(b): two',
      kind: 'minor',
      from: '1.0.1',
      to: '1.1.0',
      bumps: 2,
    },
    {
      name: 'a minor-bumped branch and a fix as a no-op',
      first: 'feat(a): one',
      next: 'fix(b): two',
      kind: 'minor',
      from: '1.1.0',
      to: '1.1.0',
      bumps: 1,
    },
  ])('reconciles $name', TIMEOUT, ({ first, next, kind, from, to, bumps }) => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, first);
    expect(runBump(run.batch).json.status).toBe('ok');
    commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, next);
    const head = headSha(run.batch);

    const r = runBump(run.batch);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', kind, from, to });
    if (bumps === 1) {
      expect(r.json.commit).toBeNull();
      expect(r.json.log).toBeNull();
      expect(headSha(run.batch)).toBe(head);
    } else {
      const bumped = headSha(run.batch);
      expect(bumped).not.toBe(head);
      expect(r.json.commit).toBe(bumped);
      expect(mustRun('git', ['log', '-1', '--format=%s', bumped], run.batch).trim()).toBe(
        'chore(build): bump version — r',
      );
      expect(commitPaths(run.batch, bumped)).toEqual(['package-lock.json', 'package.json']);
    }
    expect(versions(run.batch)).toEqual({ pkg: to, lock: to, lockRoot: to });
    expect(porcelain(run.batch)).toBe('');
    const subjects = mustRun('git', ['log', '--format=%s', 'origin/master..HEAD'], run.batch)
      .split(/\r?\n/u)
      .filter((s) => s.startsWith('chore(build): bump version'));
    expect(subjects).toHaveLength(bumps);
  });

  it('targets origin/master’s version bumped by the kind once master moved', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
    const pkg = JSON.parse(readFileSync(join(run.batch, 'package.json'), 'utf8')) as object;
    const moved = `${JSON.stringify({ ...pkg, version: '1.4.0' }, null, 2)}\n`;
    advanceOrigin(
      root,
      run.bare,
      { write: { 'package.json': moved } },
      'chore(build): bump version — elsewhere',
    );
    mustRun('git', ['fetch', '-q', 'origin'], run.batch);

    const r = runBump(run.batch);

    expect(r.json).toMatchObject({ status: 'ok', kind: 'patch', from: '1.0.0', to: '1.4.1' });
    expect(r.json.commit).toBe(headSha(run.batch));
    expect(versions(run.batch)).toEqual({ pkg: '1.4.1', lock: '1.4.1', lockRoot: '1.4.1' });
    expect(porcelain(run.batch)).toBe('');
  });

  it.each<{ name: string; changes: Changes }>([
    // A rename, not `remove`: the clone checks out under the global autocrlf and
    // the fixture config then turns it off, so `git rm` sees package.json as modified.
    { name: 'has no package.json', changes: { rename: [['package.json', 'package.old.json']] } },
    { name: 'has a package.json that is not JSON', changes: { write: { 'package.json': 'x\n' } } },
  ])(
    'fails at step version, touching nothing, when origin/master $name',
    TIMEOUT,
    ({ changes }) => {
      const run = makeRun();
      commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'fix(a): one');
      advanceOrigin(root, run.bare, changes, 'chore: break package.json');
      mustRun('git', ['fetch', '-q', 'origin'], run.batch);
      const head = headSha(run.batch);

      const r = runBump(run.batch);

      expect(r.json).toMatchObject({ status: 'failed', commit: null });
      expect(r.json.errors.map((e) => e.step)).toEqual(['version']);
      expect(headSha(run.batch)).toBe(head);
      expect(porcelain(run.batch)).toBe('');
      expect(versions(run.batch)).toEqual({ pkg: '1.0.0', lock: '1.0.0', lockRoot: '1.0.0' });
    },
  );

  it.each([
    { reason: 'nothing-to-bump', branch: 'ship/r', subjects: [] },
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

describe('publish --push-only', () => {
  const OPEN_5 = { 'ship/r': { prs: [{ number: 5, state: 'OPEN' }] } };

  /** Run `publish --push-only` on the batch, a fake `gh` answering `responses` and `views`. */
  function pushOnly(
    batch: string,
    responses: Record<string, FakeGhResponse>,
    views: Record<number, readonly string[]> = { 5: ['MERGEABLE'] },
  ): { r: ReturnType<typeof runCli<PublishResult>>; bin: string } {
    const bin = writeFakeGh(root, responses);
    setFakePrViews(bin, views);
    const r = runCli<PublishResult>(
      ['publish', batch, '--push-only', '--log', `${root}/push.log`],
      { env: { ...prependPath(bin), PH_WORKTREE_POLL_MS: '10' } },
    );
    return { r, bin };
  }

  /** A run whose batch pushed `ship/r` once, then committed one more change locally. */
  function pushedThenAhead(): Run & { readonly pushed: string; readonly head: string } {
    const run = makeRun();
    const pushed = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    mustRun('git', ['push', '-q', 'origin', 'ship/r'], run.batch);
    const head = commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, 'feat(b): two');
    return { ...run, pushed, head };
  }

  it('pushes a branch ahead of origin through pre-push and reads the open PR', TIMEOUT, () => {
    const run = pushedThenAhead();
    installHook(run.main, 'pre-push', PRE_PUSH_NEEDS_BUILD);

    const { r, bin } = pushOnly(run.batch, OPEN_5);

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      pushed: true,
      pr: { number: 5, url: 'https://github.com/fixture/repo/pull/5' },
      mergeable: 'MERGEABLE',
    });
    expect(headSha(run.bare, 'refs/heads/ship/r')).toBe(run.head);
    expect(readFakePrCreated(bin)).toBeNull();
    expect(readFileSync(`${root}/push.log`, 'utf8')).toContain('pre-push saw the build');
  });

  it.each([
    { state: 'none', prs: [] },
    { state: 'merged', prs: [{ number: 5, state: 'MERGED' }] },
    { state: 'closed', prs: [{ number: 5, state: 'CLOSED' }] },
  ])('refuses a branch whose PR is $state as no-open-pr, pushing nothing', TIMEOUT, (c) => {
    const run = pushedThenAhead();

    const { r } = pushOnly(run.batch, { 'ship/r': { prs: c.prs } });

    expect(r.json).toMatchObject({ status: 'refused', reason: 'no-open-pr', pushed: false });
    expect(r.json.errors[0]?.message).toContain(c.state);
    expect(headSha(run.bare, 'refs/heads/ship/r')).toBe(run.pushed);
  });

  it('fails pr-state when gh cannot report the PR', TIMEOUT, () => {
    const run = pushedThenAhead();

    const { r } = pushOnly(run.batch, { 'ship/r': { exit: 1 } });

    expect(r.json).toMatchObject({ status: 'failed', pushed: false });
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-state']);
  });

  it('stops at the ancestry pre-check when origin has commits the batch lacks', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    mustRun('git', ['push', '-q', 'origin', 'ship/r'], run.batch);
    const originSha = advanceOrigin(root, run.bare, { write: { 'o.txt': 'o\n' } }, 'o', 'ship/r');
    commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, 'feat(b): two');

    const { r } = pushOnly(run.batch, OPEN_5);

    expect(r.json).toMatchObject({ status: 'failed', pushed: false });
    expect(r.json.errors.map((e) => e.step)).toEqual(['push']);
    expect(r.json.errors[0]?.message).toContain('has commits the batch lacks');
    // runCaptured writes the log on every git push: no log, no push.
    expect(existsSync(`${root}/push.log`)).toBe(false);
    expect(headSha(run.bare, 'refs/heads/ship/r')).toBe(originSha);
  });

  it.each([
    {
      name: 'until it is computed',
      views: ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'],
      last: 'MERGEABLE',
      reads: 3,
    },
    {
      name: 'up to the bound, still ok',
      views: ['UNKNOWN'],
      last: 'UNKNOWN',
      reads: MERGEABLE_READS,
    },
  ])('polls the mergeable state $name', TIMEOUT, (c) => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    mustRun('git', ['push', '-q', 'origin', 'ship/r'], run.batch);

    const { r, bin } = pushOnly(run.batch, OPEN_5, { 5: c.views });

    expect(r.json).toMatchObject({ status: 'ok', mergeable: c.last });
    expect(readFakePrViewCount(bin, 5)).toBe(c.reads);
  });

  it('pushes nothing for a branch level with origin, still reading the PR', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    mustRun('git', ['push', '-q', 'origin', 'ship/r'], run.batch);
    const marker = `${root}/pre-receive-ran`;
    writeFileSync(`${run.bare}/hooks/pre-receive`, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    chmodSync(`${run.bare}/hooks/pre-receive`, 0o755);

    const { r, bin } = pushOnly(run.batch, OPEN_5);

    expect(r.json).toMatchObject({ status: 'ok', pushed: false, mergeable: 'MERGEABLE' });
    expect(existsSync(marker)).toBe(false);
    expect(readFakePrViewCount(bin, 5)).toBe(1);
  });
});

describe('append-pr-body', () => {
  // CRLF, non-ASCII, trailing spaces and a closing keyword: all must survive the round trip.
  const BODY = '## Summary\r\n\r\nAdds x — fixes #3.  \r\n';
  const SECTION = '## Attached run 1\n\n### Issues\n\n- fixes #8 — y\n';

  /** Run `append-pr-body` on PR 9 with a fake `gh` first on `PATH`; `root` is `gh`'s cwd. */
  function appendRun({
    bodies = { 9: BODY },
    editExit,
    section = SECTION,
  }: { bodies?: Record<number, string>; editExit?: number; section?: string | null } = {}): {
    r: ReturnType<typeof runCli<AppendPrBodyResult>>;
    bin: string;
  } {
    const bin = writeFakeGh(root, {});
    setFakePrBodies(bin, bodies);
    if (editExit !== undefined) setFakePrEditExit(bin, editExit);
    if (section !== null) writeFileSync(`${root}/pr-section.md`, section);
    const r = runCli<AppendPrBodyResult>(
      ['append-pr-body', root, '--pr', '9', '--section-file', `${root}/pr-section.md`],
      { env: prependPath(bin) },
    );
    if (typeof r.json.bodyFile === 'string') logDirs.add(dirname(r.json.bodyFile));
    return { r, bin };
  }

  it('appends the section to the PR’s body as gh read it, byte for byte', TIMEOUT, () => {
    const { r, bin } = appendRun();

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', pr: 9 });
    expect(r.json.bodyFile).toMatch(/ph-worktree-append-pr-body-[^/]+\/pr-body\.md$/);
    expect(readFakePrEdited(bin)).toEqual({
      argv: ['pr', 'edit', '9', '--body-file', r.json.bodyFile],
      body: `${BODY}\n${SECTION}`,
    });
    expect(readFileSync(r.json.bodyFile ?? '', 'utf8')).toBe(`${BODY}\n${SECTION}`);
  });

  it('fails pr-body and edits nothing when gh cannot read the body', TIMEOUT, () => {
    const { r, bin } = appendRun({ bodies: {} });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', pr: 9, bodyFile: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-body']);
    expect(r.json.errors[0]?.message).toContain('gh pr view 9 exited 3');
    expect(readFakePrEdited(bin)).toBeNull();
  });

  it('fails pr-edit, naming the body it wrote, when gh pr edit fails', TIMEOUT, () => {
    const { r } = appendRun({ editExit: 1 });

    expect(r.code).toBe(1);
    expect(r.json.status).toBe('failed');
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-edit']);
    expect(typeof r.json.bodyFile).toBe('string');
    expect(r.json.errors[0]?.message).toContain('gh pr edit 9 exited 1');
    expect(r.json.errors[0]?.message).toContain(r.json.bodyFile);
  });

  it.each([
    { name: 'missing', section: null },
    { name: 'blank', section: ' \n' },
  ])('fails section and calls no gh when the section file is $name', TIMEOUT, ({ section }) => {
    // No body configured: a body read would fail `pr-body`, so `section` alone proves none ran.
    const { r, bin } = appendRun({ bodies: {}, section });

    expect(r.code).toBe(1);
    expect(r.json.errors.map((e) => e.step)).toEqual(['section']);
    expect(r.json.bodyFile).toBeNull();
    expect(readFakePrEdited(bin)).toBeNull();
  });

  // 65,001 characters read; the new body adds one '\n', then the section.
  const LONG_BODY = `${'b'.repeat(65_000)}\n`;

  it('refuses a new body of 65,537 characters at body-too-long, editing nothing', TIMEOUT, () => {
    const { r, bin } = appendRun({ bodies: { 9: LONG_BODY }, section: `${'s'.repeat(534)}\n` });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', pr: 9 });
    expect(r.json.errors.map((e) => e.step)).toEqual(['body-too-long']);
    const bodyFile = r.json.bodyFile ?? '';
    expect(bodyFile).not.toBe('');
    expect(r.json.errors[0]?.message).toContain('65537');
    expect(r.json.errors[0]?.message).toContain('65536');
    expect(r.json.errors[0]?.message).toContain(bodyFile);
    const written = readFileSync(bodyFile, 'utf8');
    expect(written).toHaveLength(65_537);
    expect(written.startsWith(LONG_BODY)).toBe(true);
    expect(readFakePrEdited(bin)).toBeNull();
  });

  // '—' is 1 UTF-16 unit but 3 UTF-8 bytes: the limit counts the string's length, not bytes.
  it('edits a new body of exactly 65,536 characters, non-ASCII ones included', TIMEOUT, () => {
    const section = `${'—'.repeat(10)}${'s'.repeat(523)}\n`;
    const { r, bin } = appendRun({ bodies: { 9: LONG_BODY }, section });

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', errors: [] });
    expect(readFakePrEdited(bin)?.argv).toEqual([
      'pr',
      'edit',
      '9',
      '--body-file',
      r.json.bodyFile,
    ]);
    expect(readFakePrEdited(bin)?.body).toHaveLength(65_536);
    expect(readFakePrEdited(bin)?.body?.endsWith(section)).toBe(true);
  });
});

describe('post-pr-comment', () => {
  // CRLF and non-ASCII: both must reach gh unchanged.
  const COMMENT = '<details><summary>Run report — attached run 2</summary>\r\n\r\n## Landed\r\n';

  /** Run `post-pr-comment` on PR 9 with a fake `gh` first on `PATH`; `root` is `gh`'s cwd. */
  function commentRun({
    comment = COMMENT,
    gh,
  }: { comment?: string | null; gh?: FakePrComment } = {}): {
    r: ReturnType<typeof runCli<PostPrCommentResult>>;
    bin: string;
    file: string;
  } {
    const bin = writeFakeGh(root, {});
    if (gh !== undefined) setFakePrComment(bin, gh);
    const file = `${root}/pr-report-comment.md`;
    if (comment !== null) writeFileSync(file, comment);
    const r = runCli<PostPrCommentResult>(
      ['post-pr-comment', root, '--pr', '9', '--comment-file', file],
      { env: prependPath(bin) },
    );
    return { r, bin, file };
  }

  it('posts the comment file to the PR and returns the comment’s URL', TIMEOUT, () => {
    const { r, bin, file } = commentRun();

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      pr: 9,
      url: 'https://github.com/fixture/repo/pull/9#issuecomment-1',
    });
    expect(readFakePrCommented(bin)).toEqual({
      argv: ['pr', 'comment', '9', '--body-file', file],
      body: COMMENT,
    });
  });

  it('fails pr-comment when gh pr comment exits non-zero', TIMEOUT, () => {
    const { r } = commentRun({ gh: { exit: 1 } });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-comment']);
    expect(r.json.errors[0]?.message).toContain('gh pr comment 9 exited 1');
  });

  // A warning line before the URL, whitespace around it and trailing blank lines.
  it('returns the last non-empty line gh printed, trimmed, as the URL', TIMEOUT, () => {
    const stdout =
      'Warning: 1 uncommitted change\n  https://github.com/fixture/repo/pull/9#issuecomment-7 \r\n\r\n';
    const { r } = commentRun({ gh: { stdout } });

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      url: 'https://github.com/fixture/repo/pull/9#issuecomment-7',
    });
  });

  it.each([
    { name: 'nothing', gh: { printUrl: false } },
    { name: 'a last line that is no https URL', gh: { stdout: 'https://x/1\nComment posted\n' } },
  ])('fails comment-url when gh pr comment exits 0 printing $name', TIMEOUT, ({ gh }) => {
    const { r } = commentRun({ gh });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['comment-url']);
    expect(r.json.errors[0]?.message).toBe(
      'gh pr comment 9 printed no comment URL; the comment may have been posted',
    );
  });

  it.each([
    { name: 'missing', comment: null },
    { name: 'blank', comment: ' \n' },
  ])('fails comment and calls no gh when the comment file is $name', TIMEOUT, ({ comment }) => {
    const { r, bin } = commentRun({ comment });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['comment']);
    expect(readFakePrCommented(bin)).toBeNull();
  });

  it('refuses a comment of 65,537 characters at body-too-long, calling no gh', TIMEOUT, () => {
    const { r, bin } = commentRun({ comment: 'c'.repeat(65_537) });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['body-too-long']);
    expect(r.json.errors[0]?.message).toContain('65537');
    expect(r.json.errors[0]?.message).toContain('65536');
    expect(readFakePrCommented(bin)).toBeNull();
  });

  // '—' is 1 UTF-16 unit but 3 UTF-8 bytes: the limit counts the string's length, not bytes.
  it('posts a comment of exactly 65,536 characters, non-ASCII ones included', TIMEOUT, () => {
    const comment = `${'—'.repeat(10)}${'c'.repeat(65_526)}`;
    const { r, bin } = commentRun({ comment });

    expect(r.json.status).toBe('ok');
    expect(readFakePrCommented(bin)?.body).toBe(comment);
  });
});

describe('usage errors', () => {
  // #1059: the epic end's local server tier moved to PR CI
  it('exits 2 naming server-tier an unknown command', TIMEOUT, () => {
    const run = runCli(['server-tier', 'b', '--engine', 'paper', '--registry', 'r', '--log', 'l'], {
      cwd: root,
    });
    expect(run.code).toBe(2);
    expect(run.json.errors[0]).toEqual({
      step: 'usage',
      message: "unknown command 'server-tier'",
    });
  });

  it.each([
    { name: 'publish without --title', args: ['publish', 'b', '--body-file', 'f', '--log', 'l'] },
    {
      name: 'publish --push-only with --title',
      args: ['publish', 'b', '--push-only', '--title', 't', '--log', 'l'],
    },
    {
      name: 'publish --push-only with --body-file',
      args: ['publish', 'b', '--push-only', '--body-file', 'f', '--log', 'l'],
    },
    { name: 'publish --push-only without --log', args: ['publish', 'b', '--push-only'] },
    {
      name: 'append-pr-body without --section-file',
      args: ['append-pr-body', 'b', '--pr', '9'],
    },
    {
      name: 'append-pr-body with pr 0',
      args: ['append-pr-body', 'b', '--pr', '0', '--section-file', 'f'],
    },
    {
      name: 'post-pr-comment without --comment-file',
      args: ['post-pr-comment', 'b', '--pr', '9'],
    },
    {
      name: 'post-pr-comment with pr 0',
      args: ['post-pr-comment', 'b', '--pr', '0', '--comment-file', 'f'],
    },
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

  it('never forces: a push origin would lose commits for fails, origin unchanged', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    mustRun('git', ['push', '-q', 'origin', 'ship/r'], run.batch);
    const originSha = advanceOrigin(root, run.bare, { write: { 'o.txt': 'o\n' } }, 'o', 'ship/r');
    commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, 'feat(b): two');

    let thrown: unknown = null;
    try {
      pushBranch(run.batch, 'ship/r', `${root}/push.log`);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StepFailure);
    expect((thrown as StepFailure).step).toBe('push');
    expect(headSha(run.bare, 'refs/heads/ship/r')).toBe(originSha);
  });
});

describe('append-pr-body (in-process)', () => {
  // The fake gh only prints well-formed body JSON, so the read is stubbed here.
  it(
    'fails pr-body without echoing gh’s output, editing nothing, when gh prints no body JSON',
    TIMEOUT,
    () => {
      writeFileSync(`${root}/pr-section.md`, '## Attached run 1\n');
      vi.mocked(runCaptured).mockClear();
      vi.mocked(runCaptured).mockReturnValueOnce({
        exitCode: 0,
        stdout: 'gh-printed <html>',
        tail: '',
      });

      const r = appendPrBodyInProcess({ batch: root, pr: 9, sectionFile: `${root}/pr-section.md` });

      expect(r).toMatchObject({ status: 'failed', pr: 9, bodyFile: null });
      expect(r.errors).toEqual([
        { step: 'pr-body', message: 'gh pr view 9 printed no readable body JSON' },
      ]);
      expect(vi.mocked(runCaptured)).toHaveBeenCalledTimes(1);
    },
  );
});
