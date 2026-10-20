/**
 * Plain fixture repos (per-test `mkdtemp` roots), read through the CLI.
 *
 * @integrationTier standalone
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../../tooling/lib/strings.js';
import type { ChangedFilesResult } from '../../src/cli/envelope/types-run.js';
import { commitChanges, headSha, makeGitRepo } from '../../../test/helpers/worktree-fixture-git.js';
import { runCli } from '../helpers/worktree-cli-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const GHOST = '0123456789abcdef0123456789abcdef01234567';

let root: string;
let repo: string;
let base: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-changed-')));
  repo = makeGitRepo(root, {
    'kept.txt': 'kept\n',
    'edited.txt': 'one\n',
    'b/old.txt': 'moved\n',
    'gone.txt': 'gone\n',
  });
  base = headSha(repo);
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

describe('changed-files', () => {
  it(
    'lists every path the range changes, across its commits, both ends of a rename, sorted',
    TIMEOUT,
    () => {
      commitChanges(repo, { write: { 'z/added.txt': 'z\n', 'edited.txt': 'two\n' } }, 'first');
      const head = commitChanges(
        repo,
        { rename: [['b/old.txt', 'b/new.txt']], remove: ['gone.txt'] },
        'second',
      );

      const r = runCli<ChangedFilesResult>(['changed-files', repo, head, '--base', base]);

      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({
        command: 'changed-files',
        status: 'ok',
        worktree: repo,
        errors: [],
        files: ['b/new.txt', 'b/old.txt', 'edited.txt', 'gone.txt', 'z/added.txt'],
      });
    },
  );

  it.each(['sha', 'base'])(
    'fails at resolve, listing nothing, for a %s that names no commit, exit 1',
    TIMEOUT,
    (end) => {
      const head = commitChanges(repo, { write: { 'z/added.txt': 'z\n' } }, 'first');
      const [sha, from] = end === 'sha' ? [GHOST, base] : [head, GHOST];

      const r = runCli<ChangedFilesResult>(['changed-files', repo, sha, '--base', from]);

      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ status: 'failed', files: [] });
      expect(r.json.errors.map((e) => e.step)).toEqual(['resolve']);
    },
  );
});
