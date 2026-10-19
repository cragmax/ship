import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commitChanges,
  headSha,
  makeGitRepo,
} from '../../../../test/helpers/worktree-fixture-git.js';
import { mustRun, runIn } from '../../../../test/helpers/worktree-fixture.js';

// A test spawning git or the CLI through tsx runs near 5s under the gate's parallel load.
vi.setConfig({ testTimeout: 20_000 });

const BASE = readFileSync(new URL('../../fixtures/comment-only/base.txt', import.meta.url), 'utf8');

describe('comment-only CLI', () => {
  const CLI = fileURLToPath(new URL('../../../src/cli/comment-only.ts', import.meta.url));
  // An absolute loader URL, so the child resolves tsx from any cwd.
  const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'comment-only-cli-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 on a clean em dash and 1 naming the line of a double-encoded one', () => {
    const dir = makeGitRepo(root, { 'a.ts': BASE });
    const run = () => runIn(process.execPath, ['--import', TSX_LOADER_URL, CLI], dir);
    writeFileSync(join(dir, 'a.ts'), BASE.replace('Header line one', 'Header \u2014 one'));
    expect(run()).toMatchObject({
      exitCode: 0,
      all: 'comment-only: 1 TypeScript files token-identical',
    });
    writeFileSync(
      join(dir, 'a.ts'),
      BASE.replace('Header line one', 'Header \u00e2\u20ac\u201d one'),
    );
    expect(run()).toMatchObject({
      exitCode: 1,
      all: 'comment-only: mojibake at a.ts:2: `\u00e2\u20ac`',
    });
  });

  // The working tree carries a code change on top of the staged one, so only --cached passes.
  it('exits 0 under --cached on a staged comment-only change', () => {
    const dir = makeGitRepo(root, { 'a.ts': BASE });
    writeFileSync(join(dir, 'a.ts'), BASE.replace('Header line one', 'Header one'));
    mustRun('git', ['add', 'a.ts'], dir);
    writeFileSync(join(dir, 'a.ts'), BASE.replace("'a // not comment'", "'b // not comment'"));
    const r = runIn(process.execPath, ['--import', TSX_LOADER_URL, CLI, '--cached'], dir);
    expect(r).toMatchObject({
      exitCode: 0,
      all: 'comment-only: 1 TypeScript files token-identical',
    });
  });

  it('prints one JSON object for --json on a pass and on a code difference', () => {
    const dir = makeGitRepo(root, { 'a.ts': BASE });
    const base = headSha(dir);
    const head = commitChanges(
      dir,
      { write: { 'a.ts': BASE.replace('Header line one', 'Header one'), 'notes.md': 'n\n' } },
      'comments',
    );
    const run = (range: string) =>
      runIn(process.execPath, ['--import', TSX_LOADER_URL, CLI, '--json', range], dir);

    const pass = run(`${base}..${head}`);
    expect(pass.exitCode).toBe(0);
    expect(JSON.parse(pass.stdout)).toEqual({ compared: 1, notCompared: ['notes.md'] });

    const code = commitChanges(
      dir,
      { write: { 'a.ts': BASE.replace("'a // not comment'", "'b // not comment'") } },
      'code',
    );
    // From `base`, so the range still carries `head`'s notes.md alongside the code difference.
    const differs = run(`${base}..${code}`);
    expect(differs.exitCode).toBe(1);
    expect(JSON.parse(differs.stdout)).toEqual({ compared: 1, notCompared: ['notes.md'] });
    expect(differs.all.split('\n').filter((l) => l !== differs.stdout)).toEqual([
      "comment-only: code differs in a.ts: base line 10 `'a // not comment'`, head line 10 `'b // not comment'`",
    ]);
  });

  it('prints nothing to stdout for --json on a usage error, its stderr unchanged', () => {
    const dir = makeGitRepo(root, { 'a.ts': BASE });
    const r = runIn(process.execPath, ['--import', TSX_LOADER_URL, CLI, '--json', 'a...b'], dir);
    expect(r).toMatchObject({
      exitCode: 2,
      stdout: '',
      all: 'comment-only: usage: comment-only [--cached] [<base>] | <base>..<head>',
    });
  });
});
