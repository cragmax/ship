/**
 * Runs `ship/src/build/install-agents.ts` as `npm run codegen` and `gate:codegen` do, from a copy
 * at the same path under a temp root: the script finds the repository from its own location.
 *
 * @integrationTier standalone
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, it } from 'vitest';

const SCRIPT = 'ship/src/build/install-agents.ts';
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const TIMEOUT = { timeout: 60_000 };

const HEADER =
  "# Ship's agent file: change it upstream under ship/agents/, then run `npm run codegen`.";

let root: string;

const write = (path: string, text: string): void => {
  writeFileSync(join(root, path), text, 'utf8');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'install-agents-cli-'));

  for (const dir of ['ship/src/build', 'ship/agents', '.claude/agents']) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  copyFileSync(join(REPO_ROOT, SCRIPT), join(root, SCRIPT));
  // The script reads import.meta, which only an ES module has.
  write('package.json', '{ "type": "module" }\n');

  write('ship/agents/pr.md', '---\nname: pr\n---\n\nWrites the body.\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it(
  '--check exits 1 naming a hand-edited copy, and exits 0 once the install rewrites it',
  TIMEOUT,
  () => {
    expect(run().status).toBe(0);
    write('.claude/agents/pr.md', `---\n${HEADER}\nname: pr\n---\n\nHand edit.\n`);

    const drifted = run('--check');

    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain('.claude/agents/pr.md');

    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
  },
);

it('the install reports each stale copy it removes', TIMEOUT, () => {
  write('.claude/agents/gone.md', `---\n${HEADER}\nname: gone\n---\n\nOld.\n`);

  const installed = run();

  expect(installed.status).toBe(0);
  expect(installed.stdout).toContain('.claude/agents/gone.md');
  expect(existsSync(join(root, '.claude/agents/gone.md'))).toBe(false);
});

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, ['--import', TSX_LOADER_URL, SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 50_000,
  });

  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}
