/**
 * Which `src/cli/` command modules one CLI invocation loads, read from a resolve hook the
 * spawned CLI registers through `NODE_OPTIONS`. Each command runs against a missing target, so it
 * fails at its first step and touches nothing.
 *
 * @integrationTier standalone
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toPosix } from '../../src/core/strings.js';
import { prependPath, writeFakeGh } from '../helpers/worktree-fixture-git.js';
import { runCli } from '../helpers/worktree-cli-fixture.js';

const TIMEOUT = { timeout: 60_000 };

/** The modules the CLI's dispatch table runs its commands from. */
const COMMAND_MODULES = [
  'append-pr-body',
  'bump',
  'changed-files',
  'check-master',
  'cut',
  'cut-attach',
  'harvest',
  'land',
  'live-runs',
  'post-issue-comment',
  'post-pr-comment',
  'preflight',
  'provision',
  'provision-batch',
  'publish',
  'publish-push',
  'retire-run',
  'staged-set',
  'sync-master',
  'teardown',
];

// The hook thread shares the process's env.
const HOOKS = [
  "import { appendFileSync } from 'node:fs';",
  'export async function resolve(specifier, context, next) {',
  '  const result = await next(specifier, context);',
  '  appendFileSync(process.env.PH_LOAD_LOG, `${result.url}\\n`);',
  '  return result;',
  '}',
  '',
].join('\n');

let root: string;
let env: Record<string, string>;
let runs = 0;

beforeAll(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-load-')));
  writeFileSync(join(root, 'hooks.mjs'), HOOKS);
  const hooksUrl = pathToFileURL(join(root, 'hooks.mjs')).href;
  writeFileSync(
    join(root, 'register.mjs'),
    `import { register } from 'node:module';\nregister(${JSON.stringify(hooksUrl)});\n`,
  );
  // A fake `gh` first on PATH, so no command can reach the real one.
  env = {
    ...prependPath(writeFakeGh(root, {})),
    NODE_OPTIONS: `--import ${pathToFileURL(join(root, 'register.mjs')).href}`,
  };
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory (unprobed).
    // The leak is a bounded temp dir.
  }
});

describe('worktree CLI module loading', () => {
  it('loads no command module for a usage error', TIMEOUT, () => {
    const { code, modules } = loadedCommandModules(['no-such-command']);
    expect(code).toBe(2);
    expect(modules).toEqual([]);
  });

  // The expected set is the command module's own import graph. `m` is a missing path, and
  // `commit` targets the cwd, the non-repo temp dir `runCli` starts in.
  it.each<[string, (m: string) => string[], string[]]>([
    ['live-runs', (m) => ['live-runs', m], ['live-runs']],
    ['teardown', (m) => ['teardown', m], ['teardown']],
    ['provision', (m) => ['provision', m, '--batch', m], ['provision']],
    ['provision-batch', (m) => ['provision-batch', m, '--report-dir', m], ['provision-batch']],
    ['check-master', (m) => ['check-master', m, '--local', 'a', '--remote', 'b'], ['check-master']],
    ['staged-guard', (m) => ['staged-guard', m, 'f.txt'], ['staged-set']],
    [
      'append-pr-body',
      (m) => ['append-pr-body', m, '--pr', '1', '--section-file', `${m}/s.md`],
      ['append-pr-body'],
    ],
    [
      'post-pr-comment',
      (m) => ['post-pr-comment', m, '--pr', '1', '--comment-file', `${m}/c.md`],
      ['post-pr-comment'],
    ],
    [
      'post-issue-comment',
      (m) => ['post-issue-comment', m, '--issue', '1', '--comment-file', `${m}/c.md`],
      ['post-issue-comment'],
    ],
    ['harvest', (m) => ['harvest', m, 'abc'], ['harvest', 'staged-set']],
    [
      'land',
      (m) => ['land', m, 'abc', '--base', 'b', '--message-file', `${m}/m.txt`, '--log', `${m}/l`],
      ['cut', 'harvest', 'land', 'staged-set'],
    ],
    ['changed-files', (m) => ['changed-files', m, 'abc', '--base', 'b'], ['changed-files']],
    [
      'retire-run',
      (m) => ['retire-run', m, '--branch', 'ship/x'],
      ['cut-attach', 'live-runs', 'retire-run'],
    ],
    [
      'preflight',
      (m) => ['preflight', m],
      [
        'cut',
        'cut-attach',
        'harvest',
        'land',
        'live-runs',
        'preflight',
        'staged-set',
        'sync-master',
      ],
    ],
    ['cut-batch --epic', (m) => ['cut-batch', m, '--epic', '1'], ['cut', 'harvest', 'staged-set']],
    [
      'cut-batch --attach',
      (m) => ['cut-batch', m, '--attach', 'ship/x'],
      ['cut-attach', 'live-runs'],
    ],
    [
      'cut-slice',
      (m) => ['cut-slice', m, '--issue', '1', '--attempt', '1'],
      ['cut', 'harvest', 'staged-set'],
    ],
    [
      'sync-master',
      (m) => ['sync-master', m],
      ['cut', 'harvest', 'land', 'staged-set', 'sync-master'],
    ],
    ['bump', (m) => ['bump', m], ['bump', 'cut', 'harvest', 'staged-set']],
    [
      'publish',
      (m) => ['publish', m, '--title', 't', '--body-file', `${m}/b.md`, '--log', `${m}/l`],
      ['cut', 'harvest', 'live-runs', 'publish', 'staged-set'],
    ],
    [
      'publish --push-only',
      (m) => ['publish', m, '--push-only', '--log', `${m}/l`],
      ['cut', 'harvest', 'live-runs', 'publish', 'publish-push', 'staged-set'],
    ],
  ])('%s loads only its own module and what that imports', TIMEOUT, (_name, argv, expected) => {
    const { code, modules } = loadedCommandModules(argv(`${root}/missing`));
    expect(code).toBe(1);
    expect(modules).toEqual(expected);
  });
});

/** Run the CLI with `args` and return the command modules it loaded, in list order. */
function loadedCommandModules(args: readonly string[]): { code: number; modules: string[] } {
  const log = join(root, `load-${String(++runs)}.log`);
  const { code } = runCli(args, { env: { ...env, PH_LOAD_LOG: log } });
  const loaded = new Set(
    readFileSync(log, 'utf8')
      .split('\n')
      .map((url) => /\/src\/cli\/(?:commands|git)\/([a-z-]+)\.ts$/u.exec(url)?.[1])
      .filter((name) => name !== undefined),
  );

  return { code, modules: COMMAND_MODULES.filter((m) => loaded.has(m)) };
}
