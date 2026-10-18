/**
 * The worktree CLI's test helpers: its envelope-typed runner, and the npm-template fixture repos
 * it provisions and tears down — the real `.gitignore` (so clean-status checks run against the
 * actual patterns), the real pool registry, a `file:` tarball dependency that `npm ci` installs
 * offline, and fake `build` / `test` scripts. The plain process and template-copy helpers they
 * build on are root's `test/helpers/worktree-fixture.ts` (ADR-0048 decision 3).
 */

import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execaSync } from 'execa';
import { beforeAll, onTestFinished } from 'vitest';

import {
  copyTemplateRepo,
  fixtureEnv,
  mustRun,
  realGitignore,
  runIn,
  templatesRoot,
} from '../../../test/helpers/worktree-fixture.js';
import { compareStrings, toPosix } from '../../../tooling/shared.js';
import type { SyncMasterResult } from '../../../tooling/worktree/types-run.js';
import type { ResultBase } from '../../../tooling/worktree/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_PATH = join(REPO_ROOT, 'tooling', 'worktree.ts');
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const FAKE_DEP_TARBALL = 'fake-dep-1.0.0.tgz';

const FIXTURE_PACKAGE = {
  name: 'wt-fixture',
  version: '1.0.0',
  private: true,
  scripts: { build: 'node build.js', test: 'node check.js' },
  dependencies: { 'fake-dep': `file:vendor/${FAKE_DEP_TARBALL}` },
};

const BUILD_SCRIPT = [
  "const fs = require('fs');",
  "if (fs.existsSync('FAIL_BUILD')) {",
  "  console.error('fixture build failed: FAIL_BUILD marker present');",
  '  process.exit(1);',
  '}',
  "fs.rmSync('dist', { recursive: true, force: true });",
  "fs.mkdirSync('dist');",
  "fs.writeFileSync('dist/index.js', 'module.exports = 1;\\n');",
  "console.log('fixture build ok');",
  '',
].join('\n');

const CHECK_SCRIPT = "require('fake-dep');\nconsole.log('fake-dep resolved');\n";

/** What {@link runCli} returns for one CLI invocation. */
export interface CliRun<T extends ResultBase> {
  /** The single JSON object the CLI printed. */
  readonly json: T;
  /** The CLI's exit code. */
  readonly code: number;
  /** The CLI's stderr (the usage message on exit 2). */
  readonly stderr: string;
}

let npmTemplateDir: string | undefined;

/**
 * The calling test file's npm template directory, built on first use: a packed `fake-dep`
 * tarball plus a fixture `package.json` and its lockfile, all created offline.
 *
 * @throws When `npm pack` or `npm install` fails, carrying its output.
 */
function npmTemplate(): string {
  if (npmTemplateDir !== undefined) return npmTemplateDir;
  const root = join(templatesRoot(), 'npm');
  const template = join(root, 'template');
  const depSrc = join(root, 'fake-dep-src');
  mkdirSync(join(template, 'vendor'), { recursive: true });
  mkdirSync(depSrc, { recursive: true });
  writeFileSync(
    join(depSrc, 'package.json'),
    JSON.stringify({ name: 'fake-dep', version: '1.0.0', main: 'index.js' }),
  );
  writeFileSync(join(depSrc, 'index.js'), "module.exports = 'fake-dep';\n");
  mustRun('npm', ['pack', '--pack-destination', join(template, 'vendor')], depSrc);
  writeFileSync(join(template, 'package.json'), `${JSON.stringify(FIXTURE_PACKAGE, null, 2)}\n`);
  mustRun(
    'npm',
    ['install', '--package-lock-only', '--offline', '--no-audit', '--no-fund'],
    template,
  );
  npmTemplateDir = template;
  return template;
}

/**
 * Build the calling test file's {@link npmTemplate} in a `beforeAll` with its own budget, so the
 * `npm pack` and lockfile install stay out of the first test's timeout. Call it at the top level
 * of a file that uses {@link makeFixtureRepo}.
 */
export function prebuildNpmTemplate(): void {
  beforeAll(() => {
    npmTemplate();
  }, 120_000);
}

/** Options for {@link makeFixtureRepo}. */
export interface FixtureRepoOptions {
  /** `.gitignore` content; defaults to the real repository's file. */
  readonly gitignore?: string;
}

function writeRepoFiles(main: string, template: string, gitignore: string): void {
  cpSync(template, main, { recursive: true });
  writeFileSync(join(main, 'build.js'), BUILD_SCRIPT);
  writeFileSync(join(main, 'check.js'), CHECK_SCRIPT);
  writeFileSync(join(main, 'vitest.config.ts'), 'export default {};\n');
  writeFileSync(join(main, 'vitest.integration.config.ts'), 'export default {};\n');
  writeFileSync(join(main, '.gitignore'), gitignore);
  const registryDir = join(main, 'server-pool', 'src', 'registry');
  mkdirSync(registryDir, { recursive: true });
  copyFileSync(
    join(REPO_ROOT, 'server-pool', 'src', 'registry', 'pool-registry.json'),
    join(registryDir, 'pool-registry.json'),
  );
}

/**
 * Create and commit a fixture main checkout at `<root>/main` from the {@link npmTemplate}, and
 * return its path: a copy of the test file's template repo for that `.gitignore`
 * ({@link copyTemplateRepo}). Identity, signing and line endings are set in the fixture's own
 * local config only.
 */
export function makeFixtureRepo(root: string, options: FixtureRepoOptions = {}): string {
  const main = join(root, 'main');
  const gitignore = options.gitignore ?? realGitignore();
  copyTemplateRepo(JSON.stringify(['fixture', gitignore]), main, (dir) => {
    writeRepoFiles(dir, npmTemplate(), gitignore);
  });
  return main;
}

/** Whether `path` is listed by `git worktree list` in the fixture repo `main`. */
export function isRegistered(main: string, path: string): boolean {
  const wanted = toPosix(path).toLowerCase();
  return mustRun('git', ['worktree', 'list', '--porcelain'], main)
    .split('\n')
    .some((line) => line.trim().toLowerCase() === `worktree ${wanted}`);
}

/**
 * Seed a batch worktree the way a provisioned one looks: a real
 * `node_modules` holding `fake-dep` (~20 files), a `.bin` shim, a volatile
 * `.vite-temp` cache, a nested junction `linked-pkg` pointing at a sibling
 * directory, and a real `paper-harness/` workspace. Returns the nested junction's target directory.
 */
export function seedBatch(batch: string): string {
  const nodeModules = join(batch, 'node_modules');
  const dep = join(nodeModules, 'fake-dep');
  mkdirSync(join(dep, 'lib'), { recursive: true });
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'fake-dep', main: 'index.js' }));
  writeFileSync(join(dep, 'index.js'), "module.exports = 'fake-dep';\n");
  for (let i = 0; i < 18; i++)
    writeFileSync(join(dep, 'lib', `f${String(i)}.js`), `// ${String(i)}\n`);
  mkdirSync(join(nodeModules, '.bin'), { recursive: true });
  writeFileSync(join(nodeModules, '.bin', 'tool.cmd'), '@echo off\r\n');
  mkdirSync(join(nodeModules, '.vite-temp'), { recursive: true });
  writeFileSync(join(nodeModules, '.vite-temp', 'x.js'), '// cache\n');
  const linkedSrc = `${batch}-linked-pkg`;
  mkdirSync(linkedSrc, { recursive: true });
  writeFileSync(join(linkedSrc, 'index.js'), "module.exports = 'linked';\n");
  writeFileSync(join(linkedSrc, 'package.json'), JSON.stringify({ name: 'linked-pkg' }));
  symlinkSync(linkedSrc, join(nodeModules, 'linked-pkg'), 'junction');
  mkdirSync(join(batch, 'paper-harness', 'helpers'), { recursive: true });
  mkdirSync(join(batch, 'paper-harness', 'tests'), { recursive: true });
  return linkedSrc;
}

function collectTree(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = toPosix(relative(base, path));
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      out.push(`${rel} -> ${toPosix(readlinkSync(path))}`);
    } else if (stat.isDirectory()) {
      out.push(`${rel}/`);
      collectTree(path, base, out);
    } else {
      out.push(rel);
    }
  }
}

/**
 * Sorted relative listing of `dir` — one entry per file, directory (`name/`) and link
 * (`name -> target`) — that does not descend into links. Independent of the CLI's own walker.
 */
export function listTree(dir: string): string[] {
  const out: string[] = [];
  collectTree(dir, dir, out);
  return out.sort(compareStrings);
}

/**
 * Parse the CLI's stdout as one JSON envelope line (`command` / `status` / `errors`).
 *
 * @throws When stdout is not exactly one envelope line, quoting stdout and stderr.
 */
function parseEnvelope(stdout: string, stderr: string): ResultBase {
  const lines = stdout.split('\n');
  let json: Partial<ResultBase> | undefined;
  try {
    json = lines.length === 1 ? (JSON.parse(lines[0] ?? '') as Partial<ResultBase>) : undefined;
  } catch {
    json = undefined;
  }
  if (
    typeof json?.command !== 'string' ||
    typeof json.status !== 'string' ||
    !Array.isArray(json.errors)
  ) {
    throw new Error(`stdout is not one result-envelope line:\n${stdout}\nstderr:\n${stderr}`);
  }
  return json as ResultBase;
}

/**
 * Spawn the worktree CLI from this repository's `tooling/` under the tsx
 * loader (by absolute URL, so any `cwd` works). The default cwd is the OS
 * temp dir, so a relative or defaulted path can never resolve into a real
 * checkout. `options.env` is laid over the fixture env: a key must match the existing spelling to
 * replace it — see `prependPath` in `test/helpers/worktree-fixture-git.ts`.
 */
export function runCli<T extends ResultBase = ResultBase>(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): CliRun<T> {
  const r = execaSync(process.execPath, ['--import', TSX_LOADER_URL, CLI_PATH, ...args], {
    cwd: options.cwd ?? tmpdir(),
    env: { ...fixtureEnv(), ...options.env },
    extendEnv: false,
    reject: false,
    stdin: 'ignore',
  });
  const json = parseEnvelope(r.stdout, r.stderr) as T;
  return { json, code: r.exitCode ?? -1, stderr: r.stderr };
}

/**
 * Run `sync-master` on `batch`; the log dirs it leaves in the OS temp dir for its caller are
 * removed when the calling test finishes.
 */
export function runSyncMaster(batch: string, ...flags: string[]): CliRun<SyncMasterResult> {
  const r = runCli<SyncMasterResult>(['sync-master', batch, ...flags]);
  onTestFinished(() => {
    try {
      for (const log of r.json.logs) rmSync(dirname(log), { recursive: true, force: true });
    } catch {
      // Windows occasionally holds a lock on a just-used directory; the leak
      // is a bounded temp dir.
    }
  });
  return r;
}

/**
 * Whether `path` is a Windows junction (not a symlink), answered from PowerShell's `LinkType`,
 * since `lstat` reports both kinds alike.
 */
export function isJunction(path: string): boolean {
  const r = runIn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Item -LiteralPath '${path}' -Force).LinkType`,
    ],
    REPO_ROOT,
  );
  return r.exitCode === 0 && r.all.trim() === 'Junction';
}
