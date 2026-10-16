/**
 * The worktree fixture builders' per-file template repos, under per-test `mkdtemp` roots.
 *
 * @integrationTier standalone
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import {
  commitChanges,
  headSha,
  makeBareOrigin,
  makeGitRepo,
} from '../helpers/worktree-fixture-git.js';
import {
  makeFixtureRepo,
  mustRun,
  porcelain,
  prepareTemplate,
} from '../helpers/worktree-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const VITEST_BIN = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const TIMEOUT = { timeout: 60_000 };
// Git dates a commit to the second: a repo rebuilt this long after the first gets a new sha.
const PAST_ONE_SECOND_MS = 1100;

const roots: string[] = [];

function freshRoot(): string {
  const root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-template-')));
  roots.push(root);
  return root;
}

function originUrl(repo: string): string {
  return toPosix(mustRun('git', ['remote', 'get-url', 'origin'], repo).trim());
}

async function pastOneSecond(): Promise<void> {
  await new Promise((done) => setTimeout(done, PAST_ONE_SECOND_MS));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows occasionally holds a lock on a just-used directory; the leak
      // is a bounded temp dir.
    }
  }
});

describe('makeGitRepo and makeBareOrigin', () => {
  it(
    'hand each call its own copy of one template repo, origin its own copied bare',
    TIMEOUT,
    async () => {
      const files = { 'base.txt': 'base\n' };
      const a = makeGitRepo(freshRoot(), files);
      const aBare = toPosix(makeBareOrigin(dirname(a), a));
      const base = headSha(a);
      await pastOneSecond();
      const b = makeGitRepo(freshRoot(), files);
      const bBare = toPosix(makeBareOrigin(dirname(b), b));

      expect(headSha(b)).toBe(base);
      expect(originUrl(a)).toBe(aBare);
      expect(originUrl(b)).toBe(bBare);
      expect(headSha(b, 'origin/master')).toBe(base);

      const pushed = commitChanges(b, { write: { 'b.txt': 'b\n' } }, 'b only');
      mustRun('git', ['push', '-q', 'origin', 'master'], b);
      expect(headSha(bBare, 'master')).toBe(pushed);
      expect(headSha(aBare, 'master')).toBe(base);
      expect(headSha(a)).toBe(base);
    },
  );

  it('gives a copy whose master moved an origin holding that master', TIMEOUT, () => {
    const files = { 'base.txt': 'base\n' };
    const a = makeGitRepo(freshRoot(), files);
    makeBareOrigin(dirname(a), a);
    const b = makeGitRepo(freshRoot(), files);
    const moved = commitChanges(b, { write: { 'b.txt': 'b\n' } }, 'before the origin');

    const bBare = toPosix(makeBareOrigin(dirname(b), b));

    expect(originUrl(b)).toBe(bBare);
    expect(headSha(bBare, 'master')).toBe(moved);
    expect(headSha(b, 'origin/master')).toBe(moved);
  });

  it('gives a copy whose master ref git packed an origin holding that master', TIMEOUT, () => {
    const repo = makeGitRepo(freshRoot(), { 'base.txt': 'base\n' });
    mustRun('git', ['pack-refs', '--all'], repo);

    const bare = toPosix(makeBareOrigin(dirname(repo), repo));

    expect(originUrl(repo)).toBe(bare);
    expect(headSha(repo, 'origin/master')).toBe(headSha(repo));
  });
});

describe('the template repos', () => {
  it("are removed after the test file's last test", TIMEOUT, () => {
    const temp = freshRoot();
    // The child must not inherit this worker's VITEST_* state.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );
    const child = spawnSync(
      process.execPath,
      [
        VITEST_BIN,
        'run',
        '--config',
        'vitest.config.ts',
        '--dir',
        'test/fixtures/worktree-fixture-template',
        '--reporter=dot',
        '--no-cache',
      ],
      {
        cwd: REPO_ROOT,
        env: { ...env, TEMP: temp, TMP: temp, TMPDIR: temp },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );

    expect(child.status, `${child.stdout}${child.stderr}`).toBe(0);
    expect(readdirSync(temp).filter((name) => name.startsWith('ph-repo-templates-'))).toEqual([]);
  });
});

describe('makeFixtureRepo', () => {
  it('hands each call its own copy of one template repo', TIMEOUT, async () => {
    const templateRoot = freshRoot();
    const template = prepareTemplate(templateRoot);
    const a = makeFixtureRepo(freshRoot(), template);
    const base = headSha(a);
    await pastOneSecond();
    const b = makeFixtureRepo(freshRoot(), template);

    expect(headSha(b)).toBe(base);
    expect(porcelain(b)).toBe('');
    commitChanges(b, { write: { 'b.txt': 'b\n' } }, 'b only');
    expect(headSha(a)).toBe(base);
  });
});
