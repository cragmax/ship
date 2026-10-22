/**
 * Fixture repos (per-test `mkdtemp` roots, never this repository's own
 * worktrees) carry the real `.gitignore`, so the clean-status assertions run
 * against the actual patterns. Link-dependent cases are win32-only: junction
 * and ignore behaviour has been observed there alone.
 *
 * @integrationTier standalone
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPoolRegistry } from '../../../server-pool/src/index.js';
import { toPosix } from '../../../tooling/lib/strings.js';
import { unlinkLink } from '../../src/cli/git/links.js';
import { provisionBatch } from '../../src/cli/commands/provision-batch.js';
import { provision } from '../../src/cli/commands/provision.js';
import { teardownWorktree } from '../../src/cli/commands/teardown.js';
import type {
  ProvisionBatchResult,
  ProvisionResult,
  TeardownResult,
  TsserverRestart,
} from '../../src/cli/envelope/types.js';
import {
  isJunction,
  isRegistered,
  listTree,
  makeFixtureRepo,
  prebuildNpmTemplate,
  runCli,
  seedBatch,
  type FixtureRepoOptions,
} from '../helpers/worktree-cli-fixture.js';
import {
  addWorktree,
  mustRun,
  porcelain,
  runIn,
} from '../../../tooling/test/helpers/worktree-fixture.js';
import { commitChanges, headSha } from '../../../tooling/test/helpers/worktree-fixture-git.js';

const WIN32 = process.platform === 'win32';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TIMEOUT = { timeout: 60_000 };

prebuildNpmTemplate();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ph-wt-'));
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir. rmSync does not follow junctions.
  }
});

interface Layout {
  readonly main: string;
  readonly batch: string;
  readonly slice: string;
}

/** A fixture main checkout plus a seeded batch worktree and one slice worktree. */
function batchAndSlice(options: FixtureRepoOptions = {}): Layout {
  const main = makeFixtureRepo(root, options);
  const batch = addWorktree(main, join(root, 'batch'), 'ship/batch');
  seedBatch(batch);
  const slice = addWorktree(main, join(root, 'slice'), 'slice-1');
  return { main, batch, slice };
}

/** The real `.gitignore` with its `pattern` line replaced, or dropped when `null`. */
function gitignoreReplacing(pattern: string, replacement: string | null): string {
  return readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (line.trim() !== pattern) return [line];
      return replacement === null ? [] : [replacement];
    })
    .join('\n');
}

const SCAFFOLD_PATTERN = 'vitest.worktree*.config.ts';

describe.skipIf(!WIN32)('provision + teardown round trip', () => {
  it(
    'provisions a slice against the batch and tears it down leaving the batch untouched',
    TIMEOUT,
    () => {
      const { main, batch, slice } = batchAndSlice();
      const batchModules = join(batch, 'node_modules');
      const before = listTree(batchModules);

      const prov = runCli<ProvisionResult>(['provision', slice, '--batch', batch]);
      expect(prov.json.status, JSON.stringify(prov.json)).toBe('ok');
      expect(prov.code).toBe(0);
      const sliceModules = join(slice, 'node_modules');
      expect(lstatSync(sliceModules).isSymbolicLink()).toBe(true);
      expect(realpathSync(sliceModules)).toBe(realpathSync(batchModules));
      expect(existsSync(join(slice, 'dist', 'index.js'))).toBe(true);
      expect(lstatSync(join(slice, 'dist')).isSymbolicLink()).toBe(false);
      const config = readFileSync(join(slice, 'vitest.worktree.config.ts'), 'utf8');
      expect(config).toContain("from './config/vitest.config'");
      expect(config).toContain("cacheDir: './.vitest-cache'");
      expect(prov.json.env).toEqual({ PH_PROJECT_DIR: toPosix(batch) });
      const junction = { path: toPosix(sliceModules), target: toPosix(batchModules) };
      expect(prov.json.batch).toBe(toPosix(batch));
      expect(prov.json.junctions).toEqual([junction]);
      expect(prov.json.dist).toBe(toPosix(join(slice, 'dist')));
      expect(prov.json.vitestConfigs).toEqual([toPosix(join(slice, 'vitest.worktree.config.ts'))]);
      expect(prov.json.rolledBack).toEqual([]);
      expect(runIn('npm', ['test'], slice).exitCode).toBe(0);

      const down = runCli<TeardownResult>(['teardown', slice]);
      expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
      expect(down.code).toBe(0);
      expect(down.json.unlinked).toEqual([junction]);
      expect(down.json.removed).toBe(true);
      expect(down.json.registered).toBe(false);
      expect(existsSync(slice)).toBe(false);
      expect(isRegistered(main, slice)).toBe(false);
      expect(listTree(batchModules)).toEqual(before);
    },
  );

  it(
    'never follows the junction: a nested junction inside the batch survives teardown',
    TIMEOUT,
    () => {
      const { batch, slice } = batchAndSlice();
      const nested = join(batch, 'node_modules', 'linked-pkg');
      const nestedTarget = realpathSync(nested);
      const nestedFiles = listTree(nestedTarget);
      const before = listTree(join(batch, 'node_modules'));

      expect(runCli(['provision', slice, '--batch', batch]).json.status).toBe('ok');
      expect(isJunction(join(slice, 'node_modules'))).toBe(true);
      const down = runCli<TeardownResult>(['teardown', slice]);
      expect(down.json.status, JSON.stringify(down.json)).toBe('ok');

      expect(isJunction(nested)).toBe(true);
      expect(listTree(nestedTarget)).toEqual(nestedFiles);
      expect(listTree(join(batch, 'node_modules'))).toEqual(before);
      expect(existsSync(slice)).toBe(false);
    },
  );

  // Bites on Windows only: a process there cannot remove a directory that is
  // its own cwd, while POSIX may remove it regardless.
  it('removes the worktree even when the CLI starts with its cwd inside it', TIMEOUT, () => {
    const { main, batch, slice } = batchAndSlice();
    expect(runCli(['provision', slice, '--batch', batch]).json.status).toBe('ok');

    const down = runCli<TeardownResult>(['teardown', slice], { cwd: join(slice, 'server-pool') });
    expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
    expect(existsSync(slice)).toBe(false);
    expect(isRegistered(main, slice)).toBe(false);
  });

  it('refuses to tear down the main worktree and leaves its links alone', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    seedBatch(main);
    const link = join(main, 'node_modules', 'linked-pkg');
    const before = listTree(main);

    const down = runCli<TeardownResult>(['teardown', main]);
    expect(down.code).toBe(1);
    expect(down.json.status).toBe('refused');
    expect(down.json.reason).toBe('main-worktree');
    expect(down.json.registered).toBe(true);
    expect(down.json.unlinked).toEqual([]);
    expect(isJunction(link)).toBe(true);
    expect(listTree(main)).toEqual(before);
  });
});

describe('provision-batch', () => {
  it(
    'installs, builds, creates the project-dir marker and writes the trimmed warm registry',
    TIMEOUT,
    () => {
      const main = makeFixtureRepo(root);
      const batch = addWorktree(main, join(main, '.claude', 'worktrees', 'ship-b'), 'ship/batch');
      const reportDir = join(main, 'reports', 'ship-b');

      const run = runCli<ProvisionBatchResult>([
        'provision-batch',
        batch,
        '--report-dir',
        reportDir,
      ]);
      expect(run.json.status, JSON.stringify(run.json)).toBe('ok');
      expect(run.code).toBe(0);
      expect(lstatSync(join(batch, 'node_modules', 'fake-dep')).isDirectory()).toBe(true);
      expect(lstatSync(join(batch, 'node_modules')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(batch, 'dist', 'index.js'))).toBe(true);
      expect(lstatSync(join(batch, 'paper-harness', 'helpers')).isDirectory()).toBe(true);
      expect(lstatSync(join(batch, 'paper-harness', 'tests')).isDirectory()).toBe(true);
      const registry = toPosix(join(reportDir, 'pool-registry.batch.json'));
      expect(run.json.registry).toBe(registry);
      const loaded = loadPoolRegistry(registry);
      expect(loaded.ok).toBe(true);
      expect(
        (loaded.ok ? loaded.value : []).map((e) => ({
          type: e.type,
          host: e.host,
          rconPort: e.rconPort,
        })),
      ).toEqual([
        { type: 'paper', host: 'localhost', rconPort: 25701 },
        { type: 'paper', host: 'localhost', rconPort: 25703 },
        { type: 'folia', host: 'localhost', rconPort: 25711 },
        { type: 'folia', host: 'localhost', rconPort: 25713 },
      ]);
      expect(run.json.warm).toEqual([
        { type: 'paper', host: 'localhost', rconPort: 25701 },
        { type: 'paper', host: 'localhost', rconPort: 25703 },
        { type: 'folia', host: 'localhost', rconPort: 25711 },
        { type: 'folia', host: 'localhost', rconPort: 25713 },
      ]);
      expect(run.json.nodeModules).toBe(toPosix(join(batch, 'node_modules')));
      expect(run.json.dist).toBe(toPosix(join(batch, 'dist')));
      expect(run.json.projectDirMarker).toBe(toPosix(join(batch, 'paper-harness')));
      expect(run.json.env).toEqual({ PH_PROJECT_DIR: toPosix(batch), PH_POOL_REGISTRY: registry });
      expect(porcelain(batch)).toBe('');
    },
  );

  interface BatchCase {
    readonly batch: string;
    readonly reportDir: string;
    readonly sentinel?: string;
  }

  it.each([
    {
      name: 'the batch is the main checkout',
      arrange: (main: string, _batch: string): BatchCase => {
        mkdirSync(join(main, 'node_modules'));
        const sentinel = join(main, 'node_modules', 'sentinel.txt');
        writeFileSync(sentinel, '');
        return { batch: main, reportDir: join(root, 'reports'), sentinel };
      },
      status: 'refused',
      reason: 'main-worktree',
    },
    {
      name: 'the report dir is inside a worktree',
      arrange: (_main: string, batch: string): BatchCase => ({
        batch,
        reportDir: join(batch, 'reports'),
      }),
      status: 'refused',
      reason: 'report-dir-inside-worktree',
    },
    {
      name: 'the registry lacks the folia warm member',
      arrange: (_main: string, batch: string): BatchCase => {
        const path = join(batch, 'server-pool', 'src', 'registry', 'pool-registry.json');
        const entries = JSON.parse(readFileSync(path, 'utf8')) as { type: string }[];
        writeFileSync(path, JSON.stringify(entries.filter((e) => e.type !== 'folia')));
        return { batch, reportDir: join(root, 'reports') };
      },
      status: 'failed',
      step: 'registry',
    },
  ])('guards: $name', TIMEOUT, ({ arrange, status, reason, step }) => {
    const main = makeFixtureRepo(root);
    const c = arrange(main, addWorktree(main, join(root, 'batch'), 'ship/batch'));

    const run = runCli<ProvisionBatchResult>([
      'provision-batch',
      c.batch,
      '--report-dir',
      c.reportDir,
    ]);
    expect(run.code).toBe(1);
    expect(run.json.status).toBe(status);
    if (reason !== undefined) expect(run.json.reason).toBe(reason);
    if (step !== undefined) expect(run.json.errors[0]?.step).toBe(step);
    expect(existsSync(join(c.reportDir, 'pool-registry.batch.json'))).toBe(false);
    if (c.sentinel !== undefined) expect(existsSync(c.sentinel)).toBe(true);
  });

  it('fails the post-check when the build output is not ignored', TIMEOUT, () => {
    const main = makeFixtureRepo(root, { gitignore: gitignoreReplacing('dist/', null) });
    const batch = addWorktree(main, join(root, 'batch'), 'ship/batch');

    const run = runCli<ProvisionBatchResult>([
      'provision-batch',
      batch,
      '--report-dir',
      join(root, 'reports'),
    ]);
    expect(run.code).toBe(1);
    expect(run.json.status).toBe('failed');
    expect(run.json.errors[0]?.step).toBe('post-check');
    expect(run.json.errors[0]?.message).toContain('dist/');
    expect(run.json.env).toBeNull();
  });

  it.skipIf(!WIN32)(
    'fails preconditions and never runs npm ci when the batch node_modules is a link',
    TIMEOUT,
    () => {
      const main = makeFixtureRepo(root);
      const batch = addWorktree(main, join(root, 'batch'), 'ship/batch');
      const target = join(root, 'other-modules');
      mkdirSync(target);
      writeFileSync(join(target, 'sentinel.txt'), 'keep\n');
      symlinkSync(target, join(batch, 'node_modules'), 'junction');
      const before = listTree(target);

      const run = runCli<ProvisionBatchResult>([
        'provision-batch',
        batch,
        '--report-dir',
        join(root, 'reports'),
      ]);
      expect(run.code).toBe(1);
      expect(run.json.status).toBe('failed');
      expect(run.json.errors[0]?.step).toBe('preconditions');
      expect(run.json.errors[0]?.message).toContain('node_modules is a link');
      expect(run.json.nodeModules).toBeNull();
      expect(realpathSync(join(batch, 'node_modules'))).toBe(realpathSync(target));
      expect(listTree(target)).toEqual(before);
    },
  );
});

describe('usage errors', () => {
  it.each([
    { name: 'an unknown subcommand', args: ['frobnicate', 'x'] },
    { name: 'provision without --batch', args: ['provision', 'x'] },
    { name: 'teardown --keep-to without --base', args: ['teardown', 'x', '--keep-to', 'k'] },
    { name: 'teardown --base without --keep-to', args: ['teardown', 'x', '--base', 'b'] },
    { name: 'teardown --report without --keep-to', args: ['teardown', 'x', '--report', 'r'] },
  ])('exits 2 with a usage envelope for $name', TIMEOUT, ({ args }) => {
    const run = runCli(args, { cwd: root });
    expect(run.code).toBe(2);
    expect(run.json.status).toBe('failed');
    expect(run.json.errors[0]?.step).toBe('usage');
    const message = run.json.errors[0]?.message ?? '';
    expect(message).not.toBe('');
    expect(run.stderr).toContain(`worktree: ${message}`);
  });
});

describe.skipIf(!WIN32)('teardown gate (in-process, unlink seam)', () => {
  /** A provisioned slice, ready for an in-process teardown. */
  function provisioned(): Layout {
    const layout = batchAndSlice();
    expect(runCli(['provision', layout.slice, '--batch', layout.batch]).json.status).toBe('ok');
    return layout;
  }

  it('refuses when the link source shrank, leaving the worktree in place', TIMEOUT, () => {
    const { main, batch, slice } = provisioned();
    const unlink = (path: string): void => {
      unlinkLink(path);
      rmSync(join(batch, 'node_modules', 'fake-dep', 'lib', 'f0.js'));
    };

    const down = teardownWorktree(toPosix(slice), { unlink });
    expect(down.status).toBe('refused');
    expect(down.reason).toBe('source-shrank');
    const source = down.sources.find((s) => s.path === toPosix(join(batch, 'node_modules')));
    expect(source?.before).toBeTypeOf('number');
    expect(source?.after).toBe((source?.before ?? 0) - 1);
    expect(down.removed).toBe(false);
    expect(existsSync(slice)).toBe(true);
    expect(isRegistered(main, slice)).toBe(true);
  });

  it('refuses when a link survives the unlink step, before git sees the worktree', TIMEOUT, () => {
    const { main, batch, slice } = provisioned();

    const down = teardownWorktree(toPosix(slice), { unlink: () => undefined });
    expect(down.status).toBe('refused');
    expect(down.reason).toBe('links-remain');
    expect(realpathSync(join(slice, 'node_modules'))).toBe(
      realpathSync(join(batch, 'node_modules')),
    );
    expect(isRegistered(main, slice)).toBe(true);
    expect(down.registered).toBe(true);
  });

  it('ignores churn in a volatile top-level cache of the source', TIMEOUT, () => {
    const { main, batch, slice } = provisioned();
    const unlink = (path: string): void => {
      unlinkLink(path);
      rmSync(join(batch, 'node_modules', '.vite-temp', 'x.js'));
    };

    const down = teardownWorktree(toPosix(slice), { unlink });
    expect(down.status, JSON.stringify(down)).toBe('ok');
    expect(down.removed).toBe(true);
    expect(isRegistered(main, slice)).toBe(false);
  });

  it('refuses a CLI hosted inside the worktree it would remove', TIMEOUT, () => {
    const { main, batch, slice } = provisioned();

    const down = teardownWorktree(toPosix(slice), {
      selfPath: toPosix(join(slice, 'ship', 'src', 'cli', 'worktree.ts')),
    });
    expect(down.status).toBe('refused');
    expect(down.reason).toBe('self-hosted');
    expect(down.registered).toBe(true);
    expect(down.unlinked).toEqual([]);
    expect(realpathSync(join(slice, 'node_modules'))).toBe(
      realpathSync(join(batch, 'node_modules')),
    );
    expect(isRegistered(main, slice)).toBe(true);
  });
});

describe("teardown's tsserver restart (in-process, restart seam)", () => {
  const RESTARTED: TsserverRestart = { outcome: 'restarted', session: 4242, killed: [4343, 4344] };
  const NOT_REMOVED: TsserverRestart = { outcome: 'skipped', reason: 'not-removed', detail: null };

  it('restarts once after removing a worktree and records the restart', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const wt = addWorktree(main, join(root, 'wt'), 'wt');
    const restartTsserver = vi.fn(() => RESTARTED);

    const down = teardownWorktree(toPosix(wt), { restartTsserver });

    expect(down.removed, JSON.stringify(down)).toBe(true);
    expect(restartTsserver).toHaveBeenCalledOnce();
    expect(down.tsserverRestart).toEqual(RESTARTED);
  });

  // The link's source is the worktree's own git admin dir, which `git worktree remove` deletes:
  // the gate passes, and only the post-remove recount sees the source gone.
  it.skipIf(!WIN32)('restarts after a removal whose post-remove recount fails', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const wt = addWorktree(main, join(root, 'wt'), 'wt');
    const admin = mustRun('git', ['rev-parse', '--absolute-git-dir'], wt).trim();
    symlinkSync(admin, join(wt, 'admin-link'), 'junction');
    const restartTsserver = vi.fn(() => RESTARTED);

    const down = teardownWorktree(toPosix(wt), { restartTsserver });

    expect(down.status, JSON.stringify(down)).toBe('failed');
    expect(down.errors[0]?.step).toBe('post-remove-recount');
    expect(down.removed).toBe(true);
    expect(restartTsserver).toHaveBeenCalledOnce();
    expect(down.tsserverRestart).toEqual(RESTARTED);
  });

  it('restarts nothing for an absent path', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const restartTsserver = vi.fn(() => RESTARTED);
    const cwd = process.cwd();
    let down: TeardownResult;
    try {
      process.chdir(main);
      down = teardownWorktree(toPosix(join(root, 'gone')), { restartTsserver });
    } finally {
      process.chdir(cwd);
    }

    expect(down.status, JSON.stringify(down)).toBe('ok');
    expect(restartTsserver).not.toHaveBeenCalled();
    expect(down.tsserverRestart).toEqual(NOT_REMOVED);
  });

  it('restarts nothing when teardown refuses', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const restartTsserver = vi.fn(() => RESTARTED);

    const down = teardownWorktree(toPosix(main), { restartTsserver });

    expect(down.reason).toBe('main-worktree');
    expect(restartTsserver).not.toHaveBeenCalled();
    expect(down.tsserverRestart).toEqual(NOT_REMOVED);
  });

  it('restarts nothing when teardown fails', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const wt = addWorktree(main, join(root, 'wt'), 'wt');
    const restartTsserver = vi.fn(() => RESTARTED);
    const keep = { dir: toPosix(join(root, 'kept')), base: 'no-such-commit' };

    const down = teardownWorktree(toPosix(wt), { restartTsserver }, keep);

    expect(down.status).toBe('failed');
    expect(existsSync(wt)).toBe(true);
    expect(restartTsserver).not.toHaveBeenCalled();
    expect(down.tsserverRestart).toEqual(NOT_REMOVED);
  });

  // The suite's own removals must never kill the tsserver of the session running it.
  it('skips the restart in a CLI subprocess of the test suite', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const wt = addWorktree(main, join(root, 'wt'), 'wt');

    const down = runCli<TeardownResult>(['teardown', wt]);

    expect(down.json.removed, JSON.stringify(down.json)).toBe(true);
    expect(down.json.tsserverRestart).toEqual({
      outcome: 'skipped',
      reason: 'disabled',
      detail: null,
    });
  });
});

describe('self-hosted guard on the provision commands (in-process)', () => {
  it('provision-batch refuses a CLI hosted inside the batch and installs nothing', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const batch = toPosix(addWorktree(main, join(root, 'batch'), 'ship/batch'));
    const reportDir = toPosix(join(root, 'reports'));

    const run = provisionBatch({ batch, reportDir, selfPath: `${batch}/ship/src/cli/worktree.ts` });
    expect(run.status).toBe('refused');
    expect(run.reason).toBe('self-hosted');
    expect(existsSync(join(batch, 'node_modules'))).toBe(false);
    expect(existsSync(reportDir)).toBe(false);
  });

  it('provision refuses a CLI hosted inside the slice and creates nothing', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const batch = toPosix(addWorktree(main, join(root, 'batch'), 'ship/batch'));
    const slice = toPosix(addWorktree(main, join(root, 'slice'), 'slice-1'));
    const before = listTree(slice);

    const run = provision({
      slice,
      batch,
      server: false,
      selfPath: `${slice}/ship/src/cli/worktree.ts`,
    });
    expect(run.status).toBe('refused');
    expect(run.reason).toBe('self-hosted');
    expect(listTree(slice)).toEqual(before);
  });
});

describe('inherited git environment', () => {
  it(
    'tears down the named worktree despite a foreign GIT_DIR, as a git hook exports',
    TIMEOUT,
    () => {
      const main = makeFixtureRepo(root);
      const slice = addWorktree(main, join(root, 'slice'), 'slice-1');
      const foreignMain = makeFixtureRepo(join(root, 'foreign'));
      const foreignWt = addWorktree(foreignMain, join(root, 'foreign-wt'), 'other');
      const foreignGitDir = runIn(
        'git',
        ['rev-parse', '--absolute-git-dir'],
        foreignWt,
      ).stdout.trim();
      const saved = process.env['GIT_DIR'];
      process.env['GIT_DIR'] = foreignGitDir;
      let down: TeardownResult;
      try {
        down = teardownWorktree(toPosix(slice));
      } finally {
        if (saved === undefined) delete process.env['GIT_DIR'];
        else process.env['GIT_DIR'] = saved;
      }

      expect(down.status, JSON.stringify(down)).toBe('ok');
      expect(down.removed).toBe(true);
      expect(down.registered).toBe(false);
      expect(existsSync(slice)).toBe(false);
      expect(isRegistered(main, slice)).toBe(false);
      expect(isRegistered(foreignMain, foreignWt)).toBe(true);
    },
  );
});

describe('teardown with other worktrees nearby', () => {
  it('refuses while another registered worktree lies inside the target', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const outer = addWorktree(main, join(root, 'outer'), 'outer');
    const nested = addWorktree(main, join(outer, 'nested', 'inner'), 'inner');
    writeFileSync(join(nested, 'uncommitted.txt'), 'work in progress\n');
    const before = listTree(outer);

    const down = runCli<TeardownResult>(['teardown', outer]);
    expect(down.code).toBe(1);
    expect(down.json.status).toBe('refused');
    expect(down.json.reason).toBe('nested-worktree');
    expect(down.json.errors[0]?.message).toContain(toPosix(nested));
    expect(down.json.registered).toBe(true);
    expect(down.json.unlinked).toEqual([]);
    expect(listTree(outer)).toEqual(before);
    expect(readFileSync(join(nested, 'uncommitted.txt'), 'utf8')).toBe('work in progress\n');
    expect(isRegistered(main, outer)).toBe(true);
    expect(isRegistered(main, nested)).toBe(true);
  });

  it('tears down a worktree beside a sibling whose name extends its own', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const wt = addWorktree(main, join(root, 'wt'), 'wt');
    const sibling = addWorktree(main, join(root, 'wt2'), 'wt2');

    const down = runCli<TeardownResult>(['teardown', wt]);
    expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
    expect(down.code).toBe(0);
    expect(down.json.registered).toBe(false);
    expect(existsSync(wt)).toBe(false);
    expect(isRegistered(main, wt)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(isRegistered(main, sibling)).toBe(true);
  });

  it('keeps a torn-down batch branch and the run record in the main checkout', TIMEOUT, () => {
    const main = makeFixtureRepo(root);
    const batch = addWorktree(main, join(main, '.claude', 'worktrees', 'ship-run'), 'ship/run');
    const record = join(main, 'reports', 'ship-run', 'run.md');
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, 'the run record\n');

    const down = runCli<TeardownResult>(['teardown', batch]);
    expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
    expect(isRegistered(main, batch)).toBe(false);
    expect(existsSync(batch)).toBe(false);
    const branch = runIn('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/ship/run'], main);
    expect(branch.exitCode).toBe(0);
    expect(readFileSync(record, 'utf8')).toBe('the run record\n');
  });
});

describe('teardown keeping an unlanded attempt’s work', () => {
  /** `café` in Latin-1: text to git, invalid as UTF-8. */
  const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  const HOSTILE_DIFF_CONFIG = [
    ['diff.noprefix', 'true'],
    ['color.diff', 'always'],
  ] as const;

  /** A slice off `main` with its base, and a tdd report outside it, in a run root. */
  function sliceWithReport(): { main: string; slice: string; base: string; report: string } {
    const main = makeFixtureRepo(root);
    const base = headSha(main);
    const slice = addWorktree(main, join(root, 'slice'), 'slice-7-1');
    const report = join(root, 'reports', 'ship-7', 'tdd-7-1.md');
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, '# tdd 7-1\nBLOCKED at the probe\n');
    return { main, slice, base, report };
  }

  /** Run `teardown` on `slice`, keeping its work in `kept` against `base`, with `report`. */
  function teardownKeeping(slice: string, kept: string, base: string, report: string) {
    const args = ['teardown', slice, '--keep-to', kept, '--base', base, '--report', report];
    return runCli<TeardownResult>(args);
  }

  it(
    'writes a patch of the committed and uncommitted work that applies to the slice base, and copies the report, before removing the slice',
    TIMEOUT,
    () => {
      const { main, slice, base, report } = sliceWithReport();
      commitChanges(
        slice,
        { write: { 'committed.txt': 'committed on the slice branch\n' } },
        'slice work',
      );
      writeFileSync(
        join(slice, 'config', 'vitest.config.ts'),
        'export default { edited: true };\n',
      );
      writeFileSync(join(slice, 'untracked.txt'), 'never staged\n');
      writeFileSync(join(slice, 'latin1.txt'), LATIN1);
      // regression: the user's diff config and a UTF-8 decode each broke git apply on the patch
      for (const [key, value] of HOSTILE_DIFF_CONFIG) mustRun('git', ['config', key, value], main);
      const kept = toPosix(join(root, 'kept', 'ship-7-7-1'));

      const down = teardownKeeping(slice, kept, base, report);

      expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
      expect(down.json.removed).toBe(true);
      expect(existsSync(slice)).toBe(false);
      expect(down.json.kept).toEqual({
        patch: `${kept}/slice.patch`,
        report: `${kept}/tdd-7-1.md`,
      });
      expect(readFileSync(`${kept}/tdd-7-1.md`, 'utf8')).toBe('# tdd 7-1\nBLOCKED at the probe\n');
      mustRun('git', ['apply', `${kept}/slice.patch`], main);
      expect(readFileSync(join(main, 'committed.txt'), 'utf8')).toBe(
        'committed on the slice branch\n',
      );
      expect(readFileSync(join(main, 'config', 'vitest.config.ts'), 'utf8')).toBe(
        'export default { edited: true };\n',
      );
      expect(readFileSync(join(main, 'untracked.txt'), 'utf8')).toBe('never staged\n');
      expect(readFileSync(join(main, 'latin1.txt'))).toEqual(LATIN1);
    },
  );

  it(
    'writes no patch for a slice with no diff from its base, still copying the report',
    TIMEOUT,
    () => {
      const { slice, base, report } = sliceWithReport();
      const kept = toPosix(join(root, 'kept', 'ship-7-7-1'));

      const down = teardownKeeping(slice, kept, base, report);

      expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
      expect(down.json.kept).toEqual({ patch: null, report: `${kept}/tdd-7-1.md` });
      expect(existsSync(`${kept}/slice.patch`)).toBe(false);
      expect(existsSync(slice)).toBe(false);
    },
  );

  it('keeps the patch and no report when the tdd wrote none', TIMEOUT, () => {
    const { slice, base, report } = sliceWithReport();
    writeFileSync(join(slice, 'untracked.txt'), 'never staged\n');
    const unwritten = join(dirname(report), 'tdd-7-2.md');
    const kept = toPosix(join(root, 'kept', 'ship-7-7-2'));

    const down = teardownKeeping(slice, kept, base, unwritten);

    expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
    expect(down.json.kept).toEqual({ patch: `${kept}/slice.patch`, report: null });
    expect(existsSync(`${kept}/tdd-7-2.md`)).toBe(false);
    expect(existsSync(slice)).toBe(false);
  });

  it('creates no kept dir when there is neither a diff nor a report', TIMEOUT, () => {
    const { slice, base, report } = sliceWithReport();
    const kept = toPosix(join(root, 'kept', 'ship-7-7-3'));

    const down = teardownKeeping(slice, kept, base, join(dirname(report), 'tdd-7-3.md'));

    expect(down.json.status, JSON.stringify(down.json)).toBe('ok');
    expect(down.json.kept).toEqual({ patch: null, report: null });
    expect(existsSync(kept)).toBe(false);
  });

  // regression: a keep that failed silently let teardown delete the work it was asked to keep
  it('fails at keep and leaves the slice in place when the base is no commit', TIMEOUT, () => {
    const { main, slice, report } = sliceWithReport();
    writeFileSync(join(slice, 'untracked.txt'), 'never staged\n');
    const kept = toPosix(join(root, 'kept', 'ship-7-7-1'));

    const down = teardownKeeping(slice, kept, 'no-such-commit', report);

    expect(down.json.status, JSON.stringify(down.json)).toBe('failed');
    expect(down.json.errors[0]?.step).toBe('keep');
    expect(down.json.removed).toBe(false);
    expect(down.json.kept).toBeNull();
    expect(readFileSync(join(slice, 'untracked.txt'), 'utf8')).toBe('never staged\n');
    expect(isRegistered(main, slice)).toBe(true);
  });
});

describe.skipIf(!WIN32)('provision', () => {
  it(
    'leaves the slice status clean, and a --server re-provision reuses the junction',
    TIMEOUT,
    () => {
      const { batch, slice } = batchAndSlice();

      const first = runCli<ProvisionResult>(['provision', slice, '--batch', batch]);
      expect(first.json.status, JSON.stringify(first.json)).toBe('ok');
      expect(porcelain(slice)).toBe('');
      expect(existsSync(join(slice, 'vitest.worktree.integration.config.ts'))).toBe(false);

      const again = runCli<ProvisionResult>(['provision', slice, '--batch', batch, '--server']);
      expect(again.json.status, JSON.stringify(again.json)).toBe('ok');
      expect(again.json.junctions).toEqual([
        {
          path: toPosix(join(slice, 'node_modules')),
          target: toPosix(join(batch, 'node_modules')),
        },
      ]);
      expect(realpathSync(join(slice, 'node_modules'))).toBe(
        realpathSync(join(batch, 'node_modules')),
      );
      const twin = readFileSync(join(slice, 'vitest.worktree.integration.config.ts'), 'utf8');
      expect(twin).toContain("from './config/vitest.integration.config'");
      expect(twin).toContain("cacheDir: './.vitest-cache-integration'");
      expect(porcelain(slice)).toBe('');
    },
  );

  it('fails the post-check and rolls back when a scaffold file is not ignored', TIMEOUT, () => {
    const { batch, slice } = batchAndSlice({
      gitignore: gitignoreReplacing(SCAFFOLD_PATTERN, null),
    });

    const prov = runCli<ProvisionResult>(['provision', slice, '--batch', batch]);
    expect(prov.code).toBe(1);
    expect(prov.json.status).toBe('failed');
    expect(prov.json.errors[0]?.step).toBe('post-check');
    expect(prov.json.errors[0]?.message).toContain('vitest.worktree.config.ts');
    expect(prov.json.rolledBack).toEqual([
      toPosix(join(slice, 'vitest.worktree.config.ts')),
      toPosix(join(slice, 'dist')),
      toPosix(join(slice, 'node_modules')),
    ]);
    expect(prov.json.junctions).toEqual([]);
    expect(prov.json.dist).toBeNull();
    expect(prov.json.vitestConfigs).toEqual([]);
    expect(existsSync(join(slice, 'node_modules'))).toBe(false);
    expect(existsSync(join(slice, 'vitest.worktree.config.ts'))).toBe(false);
    expect(existsSync(join(slice, 'dist'))).toBe(false);
  });

  it('fails the junction step when node_modules already links elsewhere', TIMEOUT, () => {
    const { batch, slice } = batchAndSlice();
    const elsewhere = join(root, 'elsewhere-modules');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(slice, 'node_modules'), 'junction');

    const prov = runCli<ProvisionResult>(['provision', slice, '--batch', batch]);
    expect(prov.code).toBe(1);
    expect(prov.json.status).toBe('failed');
    expect(prov.json.errors[0]?.step).toBe('junction');
    expect(prov.json.rolledBack).toEqual([]);
    expect(realpathSync(join(slice, 'node_modules'))).toBe(realpathSync(elsewhere));
  });

  it('fails loudly on a build failure and rolls back everything it created', TIMEOUT, () => {
    const { batch, slice } = batchAndSlice();
    writeFileSync(join(slice, 'FAIL_BUILD'), '');
    const before = listTree(join(batch, 'node_modules'));

    const prov = runCli<ProvisionResult>(['provision', slice, '--batch', batch]);
    expect(prov.code).toBe(1);
    expect(prov.json.status).toBe('failed');
    expect(prov.json.errors[0]?.step).toBe('build');
    expect(prov.json.errors[0]?.detail).toContain(
      'fixture build failed: FAIL_BUILD marker present',
    );
    expect(prov.json.rolledBack).toEqual([toPosix(join(slice, 'node_modules'))]);
    expect(existsSync(join(slice, 'node_modules'))).toBe(false);
    expect(existsSync(join(slice, 'dist'))).toBe(false);
    expect(existsSync(join(slice, 'vitest.worktree.config.ts'))).toBe(false);
    expect(listTree(join(batch, 'node_modules'))).toEqual(before);
  });

  it('keeps an earlier provision intact when a re-provision fails', TIMEOUT, () => {
    const { batch, slice } = batchAndSlice();
    expect(runCli(['provision', slice, '--batch', batch]).json.status).toBe('ok');
    writeFileSync(join(slice, 'FAIL_BUILD'), '');

    const again = runCli<ProvisionResult>(['provision', slice, '--batch', batch, '--server']);
    expect(again.json.status).toBe('failed');
    expect(again.json.errors[0]?.step).toBe('build');
    expect(again.json.rolledBack).toEqual([]);
    expect(realpathSync(join(slice, 'node_modules'))).toBe(
      realpathSync(join(batch, 'node_modules')),
    );
    expect(existsSync(join(slice, 'vitest.worktree.config.ts'))).toBe(true);
    expect(existsSync(join(slice, 'vitest.worktree.integration.config.ts'))).toBe(false);
  });

  it('rolls back only the twin when a --server re-provision fails its post-check', TIMEOUT, () => {
    // Only the unit config is ignored: the first provision passes, the
    // re-provision rewrites it, then fails on the twin it created.
    const { batch, slice } = batchAndSlice({
      gitignore: gitignoreReplacing(SCAFFOLD_PATTERN, 'vitest.worktree.config.ts'),
    });
    expect(runCli(['provision', slice, '--batch', batch]).json.status).toBe('ok');

    const again = runCli<ProvisionResult>(['provision', slice, '--batch', batch, '--server']);
    expect(again.json.status).toBe('failed');
    expect(again.json.errors[0]?.step).toBe('post-check');
    expect(again.json.rolledBack).toEqual([
      toPosix(join(slice, 'vitest.worktree.integration.config.ts')),
    ]);
    expect(realpathSync(join(slice, 'node_modules'))).toBe(
      realpathSync(join(batch, 'node_modules')),
    );
    expect(existsSync(join(slice, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(slice, 'vitest.worktree.config.ts'))).toBe(true);
    expect(existsSync(join(slice, 'vitest.worktree.integration.config.ts'))).toBe(false);
  });

  it.each([
    {
      name: 'the batch has no node_modules',
      arrange: (f: Layout) => {
        rmSync(join(f.batch, 'node_modules'), { recursive: true, force: true });
        return f;
      },
    },
    {
      name: '--batch is the main checkout',
      arrange: (f: Layout) => {
        seedBatch(f.main);
        return { ...f, batch: f.main };
      },
    },
    {
      name: 'the slice is a plain directory, not a worktree',
      arrange: (f: Layout) => {
        const plain = join(root, 'plain');
        mkdirSync(plain);
        return { ...f, slice: plain };
      },
    },
  ])('fails preconditions and creates nothing when $name', TIMEOUT, ({ arrange }) => {
    const { batch, slice } = arrange(batchAndSlice());
    const before = listTree(slice);

    const prov = runCli<ProvisionResult>(['provision', slice, '--batch', batch]);
    expect(prov.code).toBe(1);
    expect(prov.json.status).toBe('failed');
    expect(prov.json.errors[0]?.step).toBe('preconditions');
    expect(listTree(slice)).toEqual(before);
  });
});
