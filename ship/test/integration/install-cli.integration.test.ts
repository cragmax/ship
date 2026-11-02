/**
 * Runs `ship/src/build/install.ts` as `npm run codegen` and `gate:codegen` do, from a copy at the
 * same path under a temp root: the script finds the repository from its own location.
 *
 * @integrationTier standalone
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, it } from 'vitest';

const SCRIPT = 'ship/src/build/install.ts';
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const TIMEOUT = { timeout: 60_000 };

const AGENT_HEADER =
  "# Ship's agent file: change it upstream under ship/agents/, then run `npm run codegen`.";
const WORKFLOW_HEADER =
  "// Ship's workflow: change it upstream under ship/src/workflow/, then run `npm run codegen`.";

const RENDER = "export const meta = { name: 'ship' };\n\nreturn await runShip();\n";

let root: string;

const write = (path: string, text: string): void => {
  writeFileSync(join(root, path), text, 'utf8');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'install-cli-'));

  for (const dir of [
    'ship/src/build',
    'ship/agents',
    'ship/skills/unattended-agent',
    'ship/workflows',
    '.claude/agents',
    '.claude/skills',
    '.claude/workflows',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }

  copyFileSync(join(REPO_ROOT, SCRIPT), join(root, SCRIPT));
  // The script reads import.meta, which only an ES module has.
  write('package.json', '{ "type": "module" }\n');

  write('ship/agents/pr.md', '---\nname: pr\n---\n\nWrites the body.\n');
  write('ship/skills/unattended-agent/SKILL.md', '---\nname: unattended-agent\n---\n\nRules.\n');
  write('ship/workflows/ship.js', RENDER);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it(
  'the install restores a deleted workflow copy, and --check names a hand-edited one until the install rewrites it',
  TIMEOUT,
  () => {
    expect(run().status).toBe(0);
    rmSync(join(root, '.claude/workflows/ship.js'));

    expect(run().status).toBe(0);
    expect(readFileSync(join(root, '.claude/workflows/ship.js'), 'utf8')).toBe(
      `${RENDER}${WORKFLOW_HEADER}\n`,
    );

    write('.claude/workflows/ship.js', `${RENDER}// Hand edit.\n${WORKFLOW_HEADER}\n`);
    const drifted = run('--check');

    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain(
      'FAIL: .claude/workflows/ship.js — differs from ship/workflows/ship.js',
    );

    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
  },
);

it(
  '--check exits 1 naming a hand-edited agent copy, and exits 0 once the install rewrites it',
  TIMEOUT,
  () => {
    expect(run().status).toBe(0);
    write('.claude/agents/pr.md', `---\n${AGENT_HEADER}\nname: pr\n---\n\nHand edit.\n`);

    const drifted = run('--check');

    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain('.claude/agents/pr.md');

    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
  },
);

it(
  'the install exits non-zero naming a skill an agent source preloads that .claude/skills/ lacks, and installs once it is there',
  TIMEOUT,
  () => {
    write(
      'ship/agents/spec-review.md',
      '---\nname: spec-review\nskills:\n  - spec-review\n  - unattended-agent\n  - probe\n---\n\nReviews.\n',
    );
    mkdirSync(join(root, '.claude/skills/spec-review'));
    write('.claude/skills/spec-review/SKILL.md', '---\nname: spec-review\n---\n');

    const refused = run();

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(
      'install: no .claude/skills/probe/SKILL.md, which ship/agents/spec-review.md preloads',
    );
    expect(existsSync(join(root, '.claude/agents/spec-review.md'))).toBe(false);

    mkdirSync(join(root, '.claude/skills/probe'));
    write('.claude/skills/probe/SKILL.md', '---\nname: probe\n---\n');

    expect(run().status).toBe(0);
    expect(existsSync(join(root, '.claude/agents/spec-review.md'))).toBe(true);
  },
);

it('the install reports each stale copy it removes', TIMEOUT, () => {
  write('.claude/agents/gone.md', `---\n${AGENT_HEADER}\nname: gone\n---\n\nOld.\n`);

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
