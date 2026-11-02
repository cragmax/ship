import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkInstall, install } from '../../../src/build/install.js';

const HEADER =
  "# Ship's agent file: change it upstream under ship/agents/, then run `npm run codegen`.";

const TDD_SOURCE = '---\nname: tdd\ndescription: >\n  Builds one issue.\n---\n\n# TDD\n\nBody.\n';
const PR_SOURCE = '---\nname: pr\n---\n\nWrites the body.\n';
const REPO_OWN = '---\nname: github\n---\n\nThe repo own agent.\n';

let root: string;

const at = (path: string): string => join(root, path);
const write = (path: string, text: string): void => writeFileSync(at(path), text, 'utf8');
const read = (path: string): string => readFileSync(at(path), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'install-'));

  for (const dir of ['ship/agents', 'ship/skills', 'ship/workflows', '.claude/agents']) {
    mkdirSync(at(dir), { recursive: true });
  }

  mkdirSync(at('.claude/skills/tdd'), { recursive: true });
  mkdirSync(at('.claude/workflows'), { recursive: true });
  write('ship/agents/tdd.md', TDD_SOURCE);
  write('ship/agents/pr.md', PR_SOURCE);
  write('.claude/agents/github.md', REPO_OWN);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('install', () => {
  it('writes each source into .claude/agents/ with the header as the frontmatter first line', () => {
    install(root);

    expect(read('.claude/agents/tdd.md')).toBe(
      `---\n${HEADER}\nname: tdd\ndescription: >\n  Builds one issue.\n---\n\n# TDD\n\nBody.\n`,
    );
    expect(read('.claude/agents/pr.md')).toBe(
      `---\n${HEADER}\nname: pr\n---\n\nWrites the body.\n`,
    );
    expect(checkInstall(root)).toEqual([]);
  });

  it('reports each copy written in name order, and installs no file that is not .md', () => {
    write('ship/agents/notes.txt', 'Not an agent.\n');

    expect(install(root).written).toEqual(['.claude/agents/pr.md', '.claude/agents/tdd.md']);
    expect(existsSync(at('.claude/agents/notes.txt'))).toBe(false);
  });

  it('refuses a source that does not open with a frontmatter line, naming it', () => {
    install(root);
    write('ship/agents/pr.md', 'name: pr\n---\n\nNo opening line.\n');

    expect(() => install(root)).toThrow('ship/agents/pr.md');
    expect(() => checkInstall(root)).toThrow('ship/agents/pr.md');
  });

  it('refuses a never-installed source without a frontmatter line, naming it, and writes no copy', () => {
    // Sorted after the valid sources, so a write-as-you-go install would have written them.
    write('ship/agents/zero.md', 'name: zero\n---\n\nNo opening line.\n');

    expect(() => checkInstall(root)).toThrow('ship/agents/zero.md');
    expect(() => install(root)).toThrow('ship/agents/zero.md');
    expect(existsSync(at('.claude/agents/pr.md'))).toBe(false);
    expect(existsSync(at('.claude/agents/tdd.md'))).toBe(false);
  });

  it('overwrites a hand-edited copy wholesale', () => {
    install(root);
    write('.claude/agents/tdd.md', `---\n${HEADER}\nname: tdd\n---\n\nHand edit.\n`);

    install(root);

    expect(read('.claude/agents/tdd.md')).toBe(
      `---\n${HEADER}\nname: tdd\ndescription: >\n  Builds one issue.\n---\n\n# TDD\n\nBody.\n`,
    );
  });

  it('removes and reports a copy with the header and no source, and leaves a header-less file', () => {
    install(root);
    write('.claude/agents/gone.md', `---\n${HEADER}\nname: gone\n---\n\nOld.\n`);
    write('.claude/agents/mentions.md', `---\nname: mentions\n---\n\n${HEADER}\n`);

    expect(install(root).removed).toEqual(['.claude/agents/gone.md']);
    expect(existsSync(at('.claude/agents/gone.md'))).toBe(false);
    expect(read('.claude/agents/mentions.md')).toBe(`---\nname: mentions\n---\n\n${HEADER}\n`);
    expect(read('.claude/agents/github.md')).toBe(REPO_OWN);
  });
});

describe('checkInstall', () => {
  it('names a hand-edited copy without rewriting it, and an edit to its source plus an install clears it', () => {
    install(root);
    write('.claude/agents/pr.md', `---\n${HEADER}\nname: pr\n---\n\nHand edit.\n`);

    expect(checkInstall(root)).toEqual([
      { file: '.claude/agents/pr.md', reason: 'differs from ship/agents/pr.md' },
    ]);
    expect(read('.claude/agents/pr.md')).toBe(`---\n${HEADER}\nname: pr\n---\n\nHand edit.\n`);

    write('ship/agents/pr.md', '---\nname: pr\n---\n\nHand edit.\n');
    install(root);

    expect(checkInstall(root)).toEqual([]);
  });

  it('names a missing copy and a stale one, and passes over the repo own agent', () => {
    install(root);
    rmSync(at('.claude/agents/tdd.md'));
    write('.claude/agents/gone.md', `---\n${HEADER}\nname: gone\n---\n\nOld.\n`);
    write('.claude/agents/github.md', `${REPO_OWN}Edited.\n`);

    expect(checkInstall(root)).toEqual([
      { file: '.claude/agents/tdd.md', reason: 'missing — never installed' },
      { file: '.claude/agents/gone.md', reason: 'stale — no source under ship/agents/' },
    ]);
    expect(existsSync(at('.claude/agents/gone.md'))).toBe(true);
  });

  it('passes a copy that differs from a fresh install only by CRLF line endings', () => {
    install(root);
    write(
      '.claude/agents/pr.md',
      `---\r\n${HEADER}\r\nname: pr\r\n---\r\n\r\nWrites the body.\r\n`,
    );

    expect(checkInstall(root)).toEqual([]);
  });
});

describe('install of the skills and the rendered workflows', () => {
  const SKILL_HEADER =
    "# Ship's skill: change it upstream under ship/skills/, then run `npm run codegen`.";
  const WORKFLOW_HEADER =
    "// Ship's workflow: change it upstream under ship/src/workflow/, then run `npm run codegen`.";
  const SKILL = '---\nname: unattended-agent\nuser-invocable: false\n---\n\n# Rules\n';
  const REPO_SKILL = '---\nname: tdd\n---\n\nThe repo own skill.\n';
  const RENDER = "export const meta = { name: 'ship' };\n\nreturn await runShip();\n";

  beforeEach(() => {
    mkdirSync(at('ship/skills/unattended-agent'));
    write('ship/skills/unattended-agent/SKILL.md', SKILL);
    write('.claude/skills/tdd/SKILL.md', REPO_SKILL);
    write('ship/workflows/ship.js', RENDER);
  });

  it('writes the skill with the header as its frontmatter first line, and the render with the header last', () => {
    expect(install(root).written).toEqual([
      '.claude/agents/pr.md',
      '.claude/agents/tdd.md',
      '.claude/skills/unattended-agent/SKILL.md',
      '.claude/workflows/ship.js',
    ]);
    expect(read('.claude/skills/unattended-agent/SKILL.md')).toBe(
      `---\n${SKILL_HEADER}\nname: unattended-agent\nuser-invocable: false\n---\n\n# Rules\n`,
    );
    expect(read('.claude/workflows/ship.js')).toBe(`${RENDER}${WORKFLOW_HEADER}\n`);
    expect(read('.claude/skills/tdd/SKILL.md')).toBe(REPO_SKILL);
    expect(checkInstall(root)).toEqual([]);
  });

  it('refuses a skill that does not open with a frontmatter line, naming it', () => {
    write('ship/skills/unattended-agent/SKILL.md', 'name: unattended-agent\n---\n');

    expect(() => install(root)).toThrow(
      'install: ship/skills/unattended-agent/SKILL.md does not open with a frontmatter ---',
    );
  });

  it('names a hand-edited skill copy', () => {
    install(root);
    write('.claude/skills/unattended-agent/SKILL.md', `---\n${SKILL_HEADER}\nname: x\n---\n`);

    expect(checkInstall(root)).toEqual([
      {
        file: '.claude/skills/unattended-agent/SKILL.md',
        reason: 'differs from ship/skills/unattended-agent/SKILL.md',
      },
    ]);
  });

  it('removes a skill and a workflow copy carrying the header with no source, and leaves the rest', () => {
    mkdirSync(at('.claude/skills/gone'));
    write('.claude/skills/gone/SKILL.md', `---\n${SKILL_HEADER}\nname: gone\n---\n`);
    mkdirSync(at('.claude/skills/mentions'));
    const mentions = `---\nname: mentions\n---\n\n${SKILL_HEADER}\n`;
    write('.claude/skills/mentions/SKILL.md', mentions);
    write('.claude/workflows/old.js', `${RENDER}${WORKFLOW_HEADER}\n`);
    const own = `${WORKFLOW_HEADER}\n${RENDER}`;
    write('.claude/workflows/own.js', own);

    expect(install(root).removed).toEqual([
      '.claude/skills/gone/SKILL.md',
      '.claude/workflows/old.js',
    ]);
    expect(read('.claude/workflows/own.js')).toBe(own);
    expect(read('.claude/skills/mentions/SKILL.md')).toBe(mentions);
    expect(read('.claude/skills/tdd/SKILL.md')).toBe(REPO_SKILL);
  });
});
