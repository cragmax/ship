/**
 * The worktree fixture builders' per-file template repos, under per-test `mkdtemp` roots.
 *
 * @integrationTier standalone
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../../tooling/lib/strings.js';
import {
  commitChanges,
  headSha,
  makeBareOrigin,
  makeGitRepo,
} from '../../../tooling/test/helpers/worktree-fixture-git.js';
import { makeFixtureRepo, prebuildNpmTemplate } from '../helpers/worktree-cli-fixture.js';
import {
  copyTemplateRepo,
  mustRun,
  porcelain,
} from '../../../tooling/test/helpers/worktree-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const VITEST_BIN = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const TIMEOUT = { timeout: 60_000 };
// Git dates a commit to the second: a repo rebuilt this long after the first gets a new sha.
const PAST_ONE_SECOND_MS = 1100;

prebuildNpmTemplate();

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
        'config/vitest.config.ts',
        '--dir',
        'ship/test/fixtures/worktree-fixture-template',
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

describe('copyTemplateRepo', () => {
  it('rebuilds a template whose first build threw', TIMEOUT, () => {
    const key = 'build throws once';
    expect(() => {
      copyTemplateRepo(key, join(freshRoot(), 'a'), () => {
        throw new Error('first build failed');
      });
    }).toThrow('first build failed');

    const b = join(freshRoot(), 'b');
    copyTemplateRepo(key, b, (dir) => {
      writeFileSync(join(dir, 'base.txt'), 'base\n');
    });

    expect(mustRun('git', ['ls-files'], b).trim()).toBe('base.txt');
  });
});

describe('makeFixtureRepo', () => {
  it('hands each call its own copy of one template repo', TIMEOUT, async () => {
    const a = makeFixtureRepo(freshRoot());
    const base = headSha(a);
    await pastOneSecond();
    const b = makeFixtureRepo(freshRoot());

    expect(headSha(b)).toBe(base);
    expect(porcelain(b)).toBe('');
    commitChanges(b, { write: { 'b.txt': 'b\n' } }, 'b only');
    expect(headSha(a)).toBe(base);
  });
});
