/**
 * Plain fixture repos under a per-test `mkdtemp` root, committed in by the CLI run from the repo
 * root, as an interactive session runs it.
 *
 * @integrationTier standalone
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import type { CommitResult } from '../../tooling/worktree/types.js';
import {
  commitChanges,
  gitPathList,
  headSha,
  makeGitRepo,
  stagedNames,
} from '../helpers/worktree-fixture-git.js';
import { mustRun, porcelain, runCli, runIn } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const HOOK_SAYS = 'fixture hook output';

let root: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-commit-')));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

/** Point the repo's hooks at a `pre-commit` that prints {@link HOOK_SAYS} and exits `exit`. */
function installHook(main: string, exit: number): void {
  const hooks = `${root}/hooks`;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(`${hooks}/pre-commit`, `#!/bin/sh\necho "${HOOK_SAYS}"\nexit ${String(exit)}\n`);
  chmodSync(`${hooks}/pre-commit`, 0o755);
  mustRun('git', ['config', 'core.hooksPath', hooks], main);
}

function writeMessage(text: string): string {
  const file = `${root}/message.txt`;
  writeFileSync(file, text);
  return file;
}

function commitCli(main: string, files: readonly string[]) {
  const message = writeMessage('docs(docs): fixture commit\n');
  return runCli<CommitResult>(['commit', '--message-file', message, '--', ...files], {
    cwd: main,
  });
}

/** The paths a commit changed, sorted. */
function committedNames(dir: string, sha: string): string[] {
  return gitPathList(dir, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', sha]);
}

describe('commit', () => {
  it(
    'commits exactly the named paths and leaves an earlier staged change unstaged in the tree',
    TIMEOUT,
    () => {
      const main = makeGitRepo(root, { 'a.txt': 'a v1\n', 'b.txt': 'b v1\n', 'other.txt': 'o1\n' });
      writeFileSync(join(main, 'other.txt'), 'o2\n');
      mustRun('git', ['add', '--', 'other.txt'], main);
      writeFileSync(join(main, 'a.txt'), 'a v2\n');
      writeFileSync(join(main, 'b.txt'), 'b v2\n');
      const before = headSha(main);

      const r = commitCli(main, ['b.txt', './a.txt']);

      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ status: 'ok', files: ['a.txt', 'b.txt'] });
      expect(r.json.commit).toBe(headSha(main));
      expect(headSha(main, 'HEAD^')).toBe(before);
      expect(committedNames(main, headSha(main))).toEqual(['a.txt', 'b.txt']);
      expect(stagedNames(main)).toEqual([]);
      expect(porcelain(main)).toBe('M other.txt');
    },
  );

  it('keeps a passing hook output in the log, never in the envelope', TIMEOUT, () => {
    const main = makeGitRepo(root, { 'a.txt': 'a v1\n' });
    installHook(main, 0);
    writeFileSync(join(main, 'a.txt'), 'a v2\n');

    const r = commitCli(main, ['a.txt']);

    expect(r.json.status).toBe('ok');
    expect(JSON.stringify(r.json)).not.toContain(HOOK_SAYS);
    expect(readFileSync(r.json.log ?? '', 'utf8')).toContain(HOOK_SAYS);
  });

  it('makes no commit when the pre-commit hook fails, its output in the envelope', TIMEOUT, () => {
    const main = makeGitRepo(root, { 'a.txt': 'a v1\n' });
    installHook(main, 1);
    writeFileSync(join(main, 'a.txt'), 'a v2\n');
    const before = headSha(main);

    const r = commitCli(main, ['a.txt']);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', commit: null });
    expect(r.json.errors[0]?.step).toBe('commit');
    expect(r.json.errors[0]?.detail).toContain(HOOK_SAYS);
    expect(headSha(main)).toBe(before);
  });

  it('refuses during a merge and leaves the index as it was', TIMEOUT, () => {
    const main = makeGitRepo(root, { 'm.txt': 'one\nbase\nthree\n' });
    mustRun('git', ['checkout', '-q', '-b', 'side'], main);
    commitChanges(main, { write: { 'm.txt': 'one\nside\nthree\n' } }, 'side');
    mustRun('git', ['checkout', '-q', 'master'], main);
    commitChanges(main, { write: { 'm.txt': 'one\nmaster\nthree\n', 'x.txt': 'x\n' } }, 'master');
    writeFileSync(join(main, 'x.txt'), 'x2\n');
    // The merge stops on the m.txt conflict, MERGE_HEAD set.
    runIn('git', ['merge', '-q', 'side'], main);
    const before = porcelain(main);

    const r = commitCli(main, ['x.txt']);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', reason: 'merge-in-progress', log: null });
    expect(porcelain(main)).toBe(before);
  });

  it('refuses a named path that stages nothing, and commits nothing', TIMEOUT, () => {
    const main = makeGitRepo(root, { 'a.txt': 'a\n', 'same.txt': 'same\n' });
    writeFileSync(join(main, 'a.txt'), 'a v2\n');
    const before = headSha(main);

    const r = commitCli(main, ['a.txt', 'same.txt']);

    expect(r.json).toMatchObject({ status: 'refused', reason: 'staged-mismatch' });
    expect(r.json.errors[0]?.message).toContain('missing: [same.txt]');
    expect(headSha(main)).toBe(before);
  });
});
