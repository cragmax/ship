/**
 * Runs `gate:codegen`'s two steps, `src/build/check-codegen.ts` then
 * `src/build/install.ts --check`, from a copy of `src/` under a temp root: each script
 * finds the repository from its own location.
 *
 * @integrationTier standalone
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { FIXTURE_PRETTIER_CONFIG } from '../helpers/fixtures.js';
import { linkNodeModules } from '../helpers/worktree-fixture.js';

const CHECK = 'src/build/check-codegen.ts';
const INSTALL = 'src/build/install.ts';
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-codegen-cli-'));
  cpSync(join(REPO_ROOT, 'src'), join(root, 'src'), { recursive: true });

  for (const dir of ['agents', 'skills', '.claude/agents', '.claude/skills', '.claude/workflows']) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  // The scripts read import.meta, which only an ES module has.
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n', 'utf8');
  // The render and the schema module are formatted under the repository's prettier config.
  copyFileSync(FIXTURE_PRETTIER_CONFIG, join(root, '.prettierrc.json'));
  linkNodeModules(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it(
  'fails naming the workflow whose source under src changed since the last codegen run',
  { timeout: 120_000 },
  () => {
    expect(run(CHECK).status).toBe(0);
    expect(existsSync(join(root, 'workflows/ship.js'))).toBe(true);
    expect(run(INSTALL).status).toBe(0);
    expect(run(INSTALL, '--check').status).toBe(0);

    // A declaration, since the render drops a trailing comment.
    appendFileSync(join(root, 'src/workflow/ship.ts'), '\nfunction uninstalledEdit(): void {}\n');

    expect(run(CHECK).status).toBe(0);
    const drifted = run(INSTALL, '--check');

    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain(
      'FAIL: .claude/workflows/ship.js — differs from workflows/ship.js',
    );
    expect(drifted.stderr).not.toContain('resync.js');
  },
);

it('fails naming a hand-edited schema module', { timeout: 60_000 }, () => {
  appendFileSync(join(root, 'src/workflow/schemas.generated.ts'), '\n// Hand edit.\n');

  const drifted = run(CHECK);

  expect(drifted.status).toBe(1);
  expect(drifted.stderr).toContain('FAIL: src/workflow/schemas.generated.ts');
});

function run(script: string, ...args: string[]): { status: number | null; stderr: string } {
  const child = spawnSync(process.execPath, ['--import', TSX_LOADER_URL, script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 50_000,
  });

  return { status: child.status, stderr: child.stderr };
}
