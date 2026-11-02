/**
 * Plain fixture helpers for tests that drive child processes in throwaway git repos under a
 * caller-owned temp root (plain-repo, commit and fake-`gh` builders in the sibling
 * `worktree-fixture-git.ts`; the worktree CLI's runner and npm-template repos in
 * `worktree-cli-fixture.ts`). Each template repo is built once per test file and
 * removed after its last test. Every child process runs with the `GIT_*` env stripped: an
 * inherited repository-location variable would point a fixture command at another repository.
 */

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execaSync } from 'execa';
import { afterAll } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Output of one fixture child process. */
interface ChildRun {
  /** Exit code (`-1` when the process never produced one). */
  readonly exitCode: number;
  /** Interleaved stdout + stderr. */
  readonly all: string;
  /** Stdout alone. */
  readonly stdout: string;
}

/** This process's env with every `GIT_*` variable stripped. */
export function fixtureEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * Run a child process in `cwd` with the fixture env, never throwing. `file` may be a `.cmd` shim
 * such as `npm`.
 */
export function runIn(file: string, args: readonly string[], cwd: string): ChildRun {
  const r = execaSync(file, args, {
    cwd,
    env: fixtureEnv(),
    extendEnv: false,
    reject: false,
    all: true,
    stdin: 'ignore',
  });

  return { exitCode: r.exitCode ?? -1, all: r.all, stdout: r.stdout };
}

/**
 * Run a child process that must succeed, and return its stdout.
 *
 * @throws When the child exits non-zero, carrying its output.
 */
export function mustRun(file: string, args: readonly string[], cwd: string): string {
  const r = runIn(file, args, cwd);

  if (r.exitCode !== 0) {
    throw new Error(
      `${file} ${args.join(' ')} failed in ${cwd} (exit ${String(r.exitCode)}):\n${r.all}`,
    );
  }

  return r.stdout;
}

/** `git status --porcelain` of a checkout, trimmed (`''` when clean). */
export function porcelain(dir: string): string {
  return mustRun('git', ['status', '--porcelain'], dir).trim();
}

/** A committed template repo of one test file, and its bare origin once one is asked for. */
interface RepoTemplate {
  readonly dir: string;
  /** Its `master` commit. */
  readonly sha: string;
  bare?: string;
}

const templates = new Map<string, RepoTemplate>();
/** The template each copy came from, by the copy's resolved path. */
const copies = new Map<string, RepoTemplate>();
let templateRoot: string | undefined;
let gitignoreText: string | undefined;

afterAll(() => {
  if (templateRoot !== undefined) rmSync(templateRoot, { recursive: true, force: true });
});

/** The calling test file's template root, made on first use and removed after its last test. */
export function templatesRoot(): string {
  templateRoot ??= mkdtempSync(join(tmpdir(), 'ph-repo-templates-'));

  return templateRoot;
}

/**
 * Copy into `dest` the calling test file's template repo for `key`, first building it, when the
 * file has none yet, from the files `write` puts in an empty directory, committed on `master`.
 * Equal keys must mean equal files: every copy of a key shares one commit sha.
 *
 * @throws When a git command fails, carrying its output, or a directory cannot be made or copied.
 */
export function copyTemplateRepo(key: string, dest: string, write: (dir: string) => void): void {
  let template = templates.get(key);

  if (template === undefined) {
    // A fresh name per build: a build that threw leaves its directory behind for the retry.
    const dir = mkdtempSync(join(templatesRoot(), 'repo-'));
    write(dir);
    initAndCommit(dir);
    template = { dir, sha: mustRun('git', ['rev-parse', 'HEAD'], dir).trim() };
    templates.set(key, template);
  }

  cpSync(template.dir, dest, { recursive: true });
  copies.set(resolve(dest), template);
}

/**
 * Give `repo` a copy of its template's bare origin at `bare`, as `origin`, with `origin/master`
 * level with `master`. Applies only to a {@link copyTemplateRepo} copy whose `master` has not
 * moved. Returns whether it applied, leaving `repo` untouched when not.
 *
 * @throws When a git command fails, carrying its output, or the bare cannot be copied.
 */
export function copyTemplateOrigin(repo: string, bare: string): boolean {
  const template = copies.get(resolve(repo));

  if (
    template === undefined ||
    mustRun('git', ['rev-parse', 'master'], repo).trim() !== template.sha
  ) {
    return false;
  }

  if (template.bare === undefined) {
    const templateBare = `${template.dir}.git`;
    mustRun('git', ['init', '-q', '--bare', '-b', 'master', templateBare], template.dir);
    mustRun('git', ['push', '-q', templateBare, 'master'], template.dir);
    template.bare = templateBare;
  }

  cpSync(template.bare, bare, { recursive: true });
  // A clone records its origin as an absolute path: the copy's points at its own copied bare.
  mustRun('git', ['remote', 'add', 'origin', bare], repo);
  mustRun('git', ['update-ref', 'refs/remotes/origin/master', template.sha], repo);

  return true;
}

/** The real repository's `.gitignore` content. */
export function realGitignore(): string {
  gitignoreText ??= readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');

  return gitignoreText;
}

/** Set a fixture repo's identity, signing and line endings in its own local config only. */
export function configureFixtureRepo(dir: string): void {
  for (const [key, value] of [
    ['user.name', 'fixture'],
    ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ] as const) {
    mustRun('git', ['config', key, value], dir);
  }
}

/**
 * Register a new linked worktree of the fixture repo at `path` on a fresh `branch`, started at
 * `start` (default `main`'s `HEAD`), and return `path` for chaining.
 */
export function addWorktree(main: string, path: string, branch: string, start?: string): string {
  mustRun(
    'git',
    ['worktree', 'add', '-q', '-b', branch, path, ...(start === undefined ? [] : [start])],
    main,
  );

  return path;
}

/**
 * Junction this checkout's `node_modules` into the fixture checkout `dir`.
 *
 * @returns The link, for the caller's cleanup to unlink.
 */
export function linkNodeModules(dir: string): string {
  const link = join(dir, 'node_modules');
  symlinkSync(realpathSync(join(REPO_ROOT, 'node_modules')), link, 'junction');

  return link;
}

/**
 * Turn a directory of written files into a repo on `master` with one commit
 * of everything in it. Identity, signing and line endings are set in the
 * repo's own local config only.
 */
function initAndCommit(dir: string): void {
  mustRun('git', ['init', '-q', '-b', 'master'], dir);
  configureFixtureRepo(dir);
  mustRun('git', ['add', '-A'], dir);
  mustRun('git', ['commit', '-q', '-m', 'fixture'], dir);
}
