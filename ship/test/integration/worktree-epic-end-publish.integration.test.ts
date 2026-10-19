/**
 * npm fixture repos (per-test `mkdtemp` roots, one shared offline template)
 * with a bare `origin` and a batch worktree on `ship/r`: `publish` pushes
 * the batch there and opens its PR through a fake `gh`.
 *
 * @integrationTier standalone
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toPosix } from '../../../tooling/lib/shared.js';
import type * as ExecModule from '../../src/cli/git/exec.js';
import { PUSH_TIMEOUT_MS, runCaptured } from '../../src/cli/git/exec.js';
import { MERGEABLE_READS } from '../../src/cli/commands/publish-push.js';
import { publish as publishInProcess, pushBranch } from '../../src/cli/commands/publish.js';
import type { PublishResult } from '../../src/cli/envelope/types-run.js';
import { StepFailure } from '../../src/cli/envelope/types.js';
import {
  advanceOrigin,
  commitChanges,
  headSha,
  installHook,
  prependPath,
  readFakePrCreated,
  readFakePrViewCount,
  setFakePrViews,
  withOriginAndBatch,
  writeFakeGh,
  type FakeGhResponse,
  type FakePrCreate,
  type FixtureRun,
} from '../../../test/helpers/worktree-fixture-git.js';
import { makeFixtureRepo, prebuildNpmTemplate, runCli } from '../helpers/worktree-cli-fixture.js';
import { mustRun, runIn } from '../../../test/helpers/worktree-fixture.js';

// A pass-through spy: every spawn still runs, and the in-process test reads
// the options each one got. The CLI-spawned tests run in their own process.
vi.mock('../../src/cli/git/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();
  return { ...actual, runCaptured: vi.fn(actual.runCaptured) };
});

const TIMEOUT = { timeout: 60_000 };
// Hooks run from the worktree root; `dist/index.js` is what the fixture build writes.
const PRE_PUSH_NEEDS_BUILD = [
  '#!/bin/sh',
  'if [ -f dist/index.js ]; then echo "pre-push saw the build"; exit 0; fi',
  'echo "pre-push: no build"',
  'exit 1',
  '',
].join('\n');

prebuildNpmTemplate();

let root: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-end-')));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

/** An npm fixture repo (version 1.0.0, lockfile) with a bare origin and a batch on `branch`. */
function makeRun(branch = 'ship/r'): FixtureRun {
  return withOriginAndBatch(root, makeFixtureRepo(root), branch);
}

/** Whether the bare origin has the branch. */
function onOrigin(bare: string, branch: string): boolean {
  return runIn('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], bare).exitCode === 0;
}

describe('publish', () => {
  const TITLE = 'feat(build): ship r';
  const BODY = '## Summary\n\nfixes #1\n';

  /** Run `publish` on the batch with a fake `gh` first on `PATH`. */
  function publish(
    batch: string,
    gh: { responses?: Record<string, FakeGhResponse>; create?: FakePrCreate } = {},
    body = BODY,
    extra: readonly string[] = [],
  ): { r: ReturnType<typeof runCli<PublishResult>>; bin: string } {
    const bin = writeFakeGh(root, gh.responses ?? {}, 0, gh.create ?? { number: 42 });
    writeFileSync(`${root}/body.md`, body);
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
        ...extra,
      ],
      { env: prependPath(bin) },
    );
    return { r, bin };
  }

  it('opens the PR as a draft with --draft', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');

    const { r, bin } = publish(run.batch, {}, BODY, ['--draft']);

    expect(r.json).toMatchObject({ status: 'ok', pushed: true, pr: { number: 42 } });
    expect(readFakePrCreated(bin)?.argv.at(-1)).toBe('--draft');
  });

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
    installHook(root, run.main, 'pre-push', PRE_PUSH_NEEDS_BUILD);

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

  it('refuses a body over the limit before the push, opening no PR', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');

    const { r, bin } = publish(run.batch, {}, 'x'.repeat(65_537));

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', pushed: false, pr: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['body-too-long']);
    expect(r.json.errors[0]?.message).toContain('65537 characters');
    expect(existsSync(`${run.batch}/dist/index.js`)).toBe(false);
    expect(onOrigin(run.bare, 'ship/r')).toBe(false);
    expect(readFakePrCreated(bin)).toBeNull();
  });

  it('opens the PR with a body of exactly the limit', TIMEOUT, () => {
    const run = makeRun();
    commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    const body = 'x'.repeat(65_536);

    const { r, bin } = publish(run.batch, {}, body);

    expect(r.json).toMatchObject({ status: 'ok', pushed: true, pr: { number: 42 } });
    expect(readFakePrCreated(bin)?.body).toBe(body);
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
  function pushedThenAhead(): FixtureRun & { readonly pushed: string; readonly head: string } {
    const run = makeRun();
    const pushed = commitChanges(run.batch, { write: { 'a.txt': 'a\n' } }, 'feat(a): one');
    mustRun('git', ['push', '-q', 'origin', 'ship/r'], run.batch);
    const head = commitChanges(run.batch, { write: { 'b.txt': 'b\n' } }, 'feat(b): two');
    return { ...run, pushed, head };
  }

  it('pushes a branch ahead of origin through pre-push and reads the open PR', TIMEOUT, () => {
    const run = pushedThenAhead();
    installHook(root, run.main, 'pre-push', PRE_PUSH_NEEDS_BUILD);

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
