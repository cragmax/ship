/**
 * Plain fixture repos (per-test `mkdtemp` roots) holding a batch worktree and
 * the slice worktrees whose single commits `land` harvests and commits; the
 * message file and the commit log live in the temp root, outside every
 * worktree.
 *
 * @integrationTier standalone
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compareStrings, toPosix } from '../../../tooling/lib/strings.js';
import type * as ExecModule from '../../src/cli/git/exec.js';
import { COMMIT_TIMEOUT_MS, runCaptured } from '../../src/cli/git/exec.js';
import { rollback } from '../../src/cli/commands/harvest.js';
import { land as landInProcess } from '../../src/cli/commands/land.js';
import type { LandResult } from '../../src/cli/envelope/types-run.js';
import type { ResultBase } from '../../src/cli/envelope/types.js';
import {
  commitChanges,
  headSha,
  installHook,
  makeGitRepo,
  stagedNames,
  type Changes,
} from '../../../tooling/test/helpers/worktree-fixture-git.js';
import { runCli } from '../helpers/worktree-cli-fixture.js';
import { addWorktree, mustRun, porcelain } from '../../../tooling/test/helpers/worktree-fixture.js';

// A pass-through spy: every spawn still runs, and the in-process test reads
// the options each one got. The CLI-spawned tests run in their own process.
vi.mock('../../src/cli/git/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();
  return { ...actual, runCaptured: vi.fn(actual.runCaptured) };
});

const TIMEOUT = { timeout: 60_000 };
const WIN32 = process.platform === 'win32';
const MESSAGE = 'feat(build): land one slice\n\nBody line of the slice commit.\n';
const HOOK_SAYS = 'fixture hook: commit refused';
// `dist/` is ignored by the real .gitignore, so the build leaves the batch clean.
const BUILD_MARKER = 'dist/built.txt';
const BUILD_SCRIPT = `require('fs').mkdirSync('dist', { recursive: true });\nrequire('fs').writeFileSync('${BUILD_MARKER}', 'built\\n');\n`;
const FIXTURE_PACKAGE = `${JSON.stringify({ name: 'land-fixture', private: true, scripts: { build: 'node build.js' } })}\n`;
// A package.json change that keeps the fixture's build script.
const BUMPED_PACKAGE = FIXTURE_PACKAGE.replace('"private"', '"version":"2.0.0","private"');

let root: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-land-')));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

interface Run {
  readonly main: string;
  readonly batch: string;
  readonly slice: string;
  /** The batch HEAD the slice was cut from. */
  readonly cut: string;
}

/** A repo with a batch worktree (on `ship/r` by default) and a slice worktree cut from its HEAD. */
function makeRun(base: Record<string, string>, batchBranch = 'ship/r'): Run {
  const main = makeGitRepo(root, base);
  const batch = addWorktree(main, `${root}/batch`, batchBranch);
  const cut = headSha(batch);
  const slice = addWorktree(main, `${root}/slice`, 'slice/r/1-1', cut);
  return { main, batch, slice, cut };
}

/** Write the message file and run `land` for `sha` cut at `cut`. */
function land(batch: string, sha: string, cut: string): ReturnType<typeof runCli<LandResult>> {
  writeFileSync(`${root}/msg.txt`, MESSAGE);
  return runCli<LandResult>([
    'land',
    batch,
    sha,
    '--base',
    cut,
    '--message-file',
    `${root}/msg.txt`,
    '--log',
    `${root}/commit.log`,
  ]);
}

/** The paths a commit changes against its parent, a rename as both endpoints. */
function commitPaths(dir: string, sha: string): string[] {
  return mustRun(
    'git',
    ['diff-tree', '-r', '--no-commit-id', '--name-only', '--no-renames', sha],
    dir,
  )
    .split(/\r?\n/u)
    .filter((p) => p !== '')
    .sort(compareStrings);
}

/** HEAD, porcelain and staged set of a checkout — what "nothing touched" compares. */
function snapshot(dir: string): { head: string; porcelain: string; staged: string[] } {
  return { head: headSha(dir), porcelain: porcelain(dir), staged: stagedNames(dir) };
}

/** The raw message of a commit, exactly as stored. */
function rawMessage(dir: string, sha: string): string {
  const raw = mustRun('git', ['cat-file', 'commit', sha], dir);
  // execa strips the final newline git's stored message always ends with.
  return `${raw.slice(raw.indexOf('\n\n') + 2)}\n`;
}

/** The Windows budget-kill warning for a child started in `cwd`, hand-written as the oracle. */
function orphanLine(cwd: string): string {
  return `warning: the budget kill reached only the direct child, started in ${cwd}; its descendants, and the program itself when that child was a launcher, may still be running`;
}

/** The last non-blank line of `text`. */
function lastLine(text: string): string | undefined {
  return text.trimEnd().split(/\r?\n/u).at(-1);
}

describe('land', () => {
  it(
    'turns a one-commit slice into exactly one batch commit with the file message',
    TIMEOUT,
    () => {
      const run = makeRun({ 'mod.txt': 'v1\n', 'del.txt': 'delete me\n' });
      const changes: Changes = {
        write: { 'mod.txt': 'v2\n', 'docs/added.md': '# added\n' },
        remove: ['del.txt'],
      };
      const sha = commitChanges(run.slice, changes, 'slice S');

      const r = land(run.batch, sha, run.cut);

      expect(r.code).toBe(0);
      expect(r.json.status).toBe('ok');
      const head = headSha(run.batch);
      expect(r.json.commit).toBe(head);
      expect(headSha(run.batch, 'HEAD^')).toBe(run.cut);
      expect(rawMessage(run.batch, head)).toBe(MESSAGE);
      expect(r.json.files).toEqual(['del.txt', 'docs/added.md', 'mod.txt']);
      expect(commitPaths(run.batch, head)).toEqual(r.json.files);
      // one line deleted, one added, one rewritten (an insertion and a deletion)
      expect(r.json.lines).toBe(4);
      expect(porcelain(run.batch)).toBe('');
      expect(r.json).toMatchObject({ rolledBack: false, batchClean: true, conflicts: [] });
    },
  );

  it('refuses a two-commit slice and leaves the batch untouched', TIMEOUT, () => {
    const run = makeRun({ 'base.txt': 'base\n' });
    commitChanges(run.slice, { write: { 'one.txt': '1\n' } }, 'first');
    const sha = commitChanges(run.slice, { write: { 'two.txt': '2\n' } }, 'second');
    const before = snapshot(run.batch);

    const r = land(run.batch, sha, run.cut);

    expect(r.code).toBe(1);
    expect(r.json.status).toBe('refused');
    expect(r.json.reason).toBe('slice-not-single-commit');
    expect(r.json.commit).toBeNull();
    expect(snapshot(run.batch)).toEqual(before);
    expect(existsSync(join(run.batch, 'two.txt'))).toBe(false);
  });

  it('reports a conflicting slice rolled back, the batch clean at its HEAD', TIMEOUT, () => {
    const run = makeRun({ 'mod.txt': 'one\nshared\nthree\n' });
    const sha = commitChanges(
      run.slice,
      { write: { 'mod.txt': 'one\nslice\nthree\n', 'fresh.txt': 'fresh\n' } },
      'slice',
    );
    commitChanges(run.batch, { write: { 'mod.txt': 'one\nbatch\nthree\n' } }, 'landed first');
    const head = headSha(run.batch);

    const r = land(run.batch, sha, run.cut);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      status: 'conflict',
      conflicts: ['mod.txt'],
      rolledBack: true,
      batchClean: true,
      commit: null,
    });
    expect(headSha(run.batch)).toBe(head);
    expect(porcelain(run.batch)).toBe('');
    expect(existsSync(join(run.batch, 'fresh.txt'))).toBe(false);
  });

  it('rolls back a commit its pre-commit hook fails, the hook output in the log', TIMEOUT, () => {
    const run = makeRun({ 'base.txt': 'base\n' });
    const sha = commitChanges(run.slice, { write: { 'added.txt': 'added\n' } }, 'slice');
    // The hook is installed only after the slice commit, so only land's commit runs it.
    installHook(root, run.main, 'pre-commit', `#!/bin/sh\necho "${HOOK_SAYS}"\nexit 1\n`);

    const r = land(run.batch, sha, run.cut);

    expect(r.code).toBe(1);
    expect(r.json.status).toBe('failed');
    expect(r.json.errors[0]?.step).toBe('commit');
    expect(r.json).toMatchObject({ rolledBack: true, batchClean: true, commit: null });
    expect(headSha(run.batch)).toBe(run.cut);
    expect(porcelain(run.batch)).toBe('');
    expect(readFileSync(`${root}/commit.log`, 'utf8')).toContain(HOOK_SAYS);
  });

  it.each([
    { path: 'framework/src/feature.ts', content: 'changed\n', built: true },
    { path: 'tsconfig.json', content: 'changed\n', built: true },
    { path: 'framework/tsconfig.json', content: 'changed\n', built: true },
    { path: 'src/feature.ts', content: 'changed\n', built: false },
    { path: 'package.json', content: BUMPED_PACKAGE, built: true },
    { path: 'tooling/tool.ts', content: 'changed\n', built: false },
    { path: 'docs/notes.md', content: 'changed\n', built: false },
  ])('builds the batch before committing $path: $built', TIMEOUT, ({ path, content, built }) => {
    const run = makeRun({ 'package.json': FIXTURE_PACKAGE, 'build.js': BUILD_SCRIPT });
    const sha = commitChanges(run.slice, { write: { [path]: content } }, 'slice');

    const r = land(run.batch, sha, run.cut);

    expect(r.json.status).toBe('ok');
    expect(existsSync(join(run.batch, BUILD_MARKER))).toBe(built);
  });

  it('rolls back a slice whose build fails, the batch clean at the cut', TIMEOUT, () => {
    const run = makeRun({ 'package.json': FIXTURE_PACKAGE, 'build.js': 'process.exit(3);\n' });
    const sha = commitChanges(
      run.slice,
      { write: { 'framework/src/feature.ts': 'changed\n' } },
      'slice',
    );

    const r = land(run.batch, sha, run.cut);

    // The envelope `landingEvent` (commit-queue.ts) maps to `blocked`, not an epic halt.
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      status: 'failed',
      rolledBack: true,
      batchClean: true,
      commit: null,
    });
    expect(r.json.errors[0]?.step).toBe('build');
    expect(headSha(run.batch)).toBe(run.cut);
    expect(porcelain(run.batch)).toBe('');
    expect(existsSync(join(run.batch, 'framework/src/feature.ts'))).toBe(false);
  });

  it.each([
    {
      dirt: 'an untracked file',
      make: (batch: string) => writeFileSync(join(batch, 'stray.txt'), 'stray\n'),
    },
    {
      dirt: 'a staged change',
      make: (batch: string) => {
        writeFileSync(join(batch, 'base.txt'), 'staged edit\n');
        mustRun('git', ['add', '--', 'base.txt'], batch);
      },
    },
  ])('refuses a batch holding $dirt and touches nothing', TIMEOUT, ({ make }) => {
    const run = makeRun({ 'base.txt': 'base\n' });
    const sha = commitChanges(run.slice, { write: { 'added.txt': 'added\n' } }, 'slice');
    make(run.batch);
    const before = snapshot(run.batch);

    const r = land(run.batch, sha, run.cut);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'batch-dirty', batchClean: false });
    expect(snapshot(run.batch)).toEqual(before);
    expect(existsSync(join(run.batch, 'added.txt'))).toBe(false);
  });

  it('refuses a batch that is not on a ship/ run branch and touches nothing', TIMEOUT, () => {
    const run = makeRun({ 'base.txt': 'base\n' }, 'feature/x');
    const sha = commitChanges(run.slice, { write: { 'added.txt': 'added\n' } }, 'slice');
    const before = snapshot(run.batch);

    const r = land(run.batch, sha, run.cut);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'not-run-batch', commit: null });
    expect(snapshot(run.batch)).toEqual(before);
    expect(existsSync(join(run.batch, 'added.txt'))).toBe(false);
  });
});

describe('land (in-process)', () => {
  it('gives the commit spawn the commit budget and the log file', TIMEOUT, () => {
    const run = makeRun({ 'base.txt': 'base\n' });
    const sha = commitChanges(run.slice, { write: { 'added.txt': 'added\n' } }, 'slice');
    writeFileSync(`${root}/msg.txt`, MESSAGE);
    vi.mocked(runCaptured).mockClear();

    const r = landInProcess({
      batch: run.batch,
      sha,
      base: run.cut,
      messageFile: `${root}/msg.txt`,
      logFile: `${root}/commit.log`,
    });

    expect(r.status).toBe('ok');
    const commits = vi
      .mocked(runCaptured)
      .mock.calls.filter(([file, args]) => file === 'git' && args.includes('commit'));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.[2]).toMatchObject({
      timeoutMs: COMMIT_TIMEOUT_MS,
      logFile: `${root}/commit.log`,
    });
    // The budget is a contract of its own, not only a name: pin its value.
    expect(COMMIT_TIMEOUT_MS).toBe(900_000);
  });

  it('reports a landed commit as ok even when its log cannot be written', TIMEOUT, () => {
    const run = makeRun({ 'base.txt': 'base\n' });
    const sha = commitChanges(run.slice, { write: { 'added.txt': 'added\n' } }, 'slice');
    writeFileSync(`${root}/msg.txt`, MESSAGE);

    const r = landInProcess({
      batch: run.batch,
      sha,
      base: run.cut,
      messageFile: `${root}/msg.txt`,
      logFile: `${root}/no-such-dir/commit.log`,
    });

    expect(r).toMatchObject({ status: 'ok', rolledBack: false, batchClean: true });
    expect(r.commit).toBe(headSha(run.batch));
    expect(headSha(run.batch, 'HEAD^')).toBe(run.cut);
  });

  it.each([
    { target: 'the main worktree', sub: '' },
    { target: 'a subdirectory of the main worktree', sub: '/sub' },
  ])('refuses to roll back $target, keeping its work', TIMEOUT, ({ sub }) => {
    const run = makeRun({ 'base.txt': 'base\n', 'sub/keep.txt': 'keep\n' });
    writeFileSync(join(run.main, 'base.txt'), 'main wip\n');
    const envelope: ResultBase & { rolledBack: boolean } = {
      command: 'land',
      status: 'ok',
      worktree: run.main,
      errors: [],
      rolledBack: false,
    };

    rollback(`${run.main}${sub}`, envelope);

    expect(readFileSync(join(run.main, 'base.txt'), 'utf8')).toBe('main wip\n');
    expect(envelope).toMatchObject({ status: 'failed', rolledBack: false });
    expect(envelope.errors[0]?.step).toBe('rollback');
  });
});

describe('runCaptured budget kill (in-process)', () => {
  it('names the timeout in the tail and the log after the child printed', TIMEOUT, () => {
    const log = `${root}/killed.log`;
    const r = runCaptured(
      process.execPath,
      ['-e', "console.log('child started'); setTimeout(() => {}, 60_000);"],
      { cwd: root, timeoutMs: 3_000, logFile: log },
    );

    expect(r.exitCode).toBe(-1);
    expect(r.tail).toContain('child started');
    expect(r.tail).toContain('timed out after 3000 milliseconds');
    expect(readFileSync(log, 'utf8')).toContain('timed out after 3000 milliseconds');
  });

  it.skipIf(!WIN32)(
    'ends the tail and the log with the orphan warning naming the cwd on win32',
    TIMEOUT,
    () => {
      const log = `${root}/killed.log`;
      const r = runCaptured(
        process.execPath,
        ['-e', "console.log('child started'); setTimeout(() => {}, 60_000);"],
        { cwd: root, timeoutMs: 3_000, logFile: log },
      );

      expect(r.exitCode).toBe(-1);
      expect(r.tail).toContain('timed out after 3000 milliseconds');
      expect(lastLine(r.tail)).toBe(orphanLine(root));
      expect(lastLine(readFileSync(log, 'utf8'))).toBe(orphanLine(root));
    },
  );

  it.skipIf(!WIN32)(
    'ends the tail and the log with the orphan warning on win32 when the child printed nothing',
    TIMEOUT,
    () => {
      const log = `${root}/silent.log`;
      const r = runCaptured(process.execPath, ['-e', 'setTimeout(() => {}, 60_000);'], {
        cwd: root,
        timeoutMs: 3_000,
        logFile: log,
      });

      expect(r.exitCode).toBe(-1);
      expect(r.tail).toContain('timed out after 3000 milliseconds');
      expect(lastLine(r.tail)).toBe(orphanLine(root));
      expect(lastLine(readFileSync(log, 'utf8'))).toBe(orphanLine(root));
    },
  );

  it('carries no orphan warning when the child fails fast within its budget', TIMEOUT, () => {
    const log = `${root}/failed.log`;
    // `exitCode`, not `process.exit(3)`: the child exits only after stdout flushed.
    const r = runCaptured(
      process.execPath,
      ['-e', "console.log('child failed'); process.exitCode = 3;"],
      { cwd: root, timeoutMs: 3_000, logFile: log },
    );

    expect(r.exitCode).toBe(3);
    expect(lastLine(r.tail)).toBe('child failed');
    expect(lastLine(readFileSync(log, 'utf8'))).toBe('child failed');
  });

  it.skipIf(WIN32)('carries no orphan warning after a budget kill off win32', TIMEOUT, () => {
    const log = `${root}/killed.log`;
    const r = runCaptured(
      process.execPath,
      ['-e', "console.log('child started'); setTimeout(() => {}, 60_000);"],
      { cwd: root, timeoutMs: 3_000, logFile: log },
    );

    expect(r.exitCode).toBe(-1);
    expect(r.tail).toContain('timed out after 3000 milliseconds');
    expect(r.tail).not.toContain(orphanLine(root));
    expect(readFileSync(log, 'utf8')).not.toContain(orphanLine(root));
  });
});

describe('usage errors', () => {
  it.each([
    {
      name: 'land without --base',
      args: ['land', 'b', 'sha', '--message-file', 'm', '--log', 'l'],
    },
    {
      name: 'land without a sha',
      args: ['land', 'b', '--base', 'c', '--message-file', 'm', '--log', 'l'],
    },
  ])('exits 2 with a usage envelope for $name', TIMEOUT, ({ args }) => {
    const run = runCli(args, { cwd: root });
    expect(run.code).toBe(2);
    expect(run.json.errors[0]?.step).toBe('usage');
  });
});
