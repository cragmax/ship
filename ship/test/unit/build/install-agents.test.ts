import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkAgents, installAgents } from '../../../src/build/install-agents.js';

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
  root = mkdtempSync(join(tmpdir(), 'install-agents-'));
  mkdirSync(at('ship/agents'), { recursive: true });
  mkdirSync(at('.claude/agents'), { recursive: true });
  write('ship/agents/tdd.md', TDD_SOURCE);
  write('ship/agents/pr.md', PR_SOURCE);
  write('.claude/agents/github.md', REPO_OWN);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installAgents', () => {
  it('writes each source into .claude/agents/ with the header as the frontmatter first line', () => {
    installAgents(root);

    expect(read('.claude/agents/tdd.md')).toBe(
      `---\n${HEADER}\nname: tdd\ndescription: >\n  Builds one issue.\n---\n\n# TDD\n\nBody.\n`,
    );
    expect(read('.claude/agents/pr.md')).toBe(
      `---\n${HEADER}\nname: pr\n---\n\nWrites the body.\n`,
    );
    expect(checkAgents(root)).toEqual([]);
  });

  it('reports each copy written in name order, and installs no file that is not .md', () => {
    write('ship/agents/notes.txt', 'Not an agent.\n');

    expect(installAgents(root).written).toEqual(['.claude/agents/pr.md', '.claude/agents/tdd.md']);
    expect(existsSync(at('.claude/agents/notes.txt'))).toBe(false);
  });

  it('refuses a source that does not open with a frontmatter line, naming it', () => {
    installAgents(root);
    write('ship/agents/pr.md', 'name: pr\n---\n\nNo opening line.\n');

    expect(() => installAgents(root)).toThrow('ship/agents/pr.md');
    expect(() => checkAgents(root)).toThrow('ship/agents/pr.md');
  });

  it('refuses a never-installed source without a frontmatter line, naming it, and writes no copy', () => {
    // Sorted after the valid sources, so a write-as-you-go install would have written them.
    write('ship/agents/zero.md', 'name: zero\n---\n\nNo opening line.\n');

    expect(() => checkAgents(root)).toThrow('ship/agents/zero.md');
    expect(() => installAgents(root)).toThrow('ship/agents/zero.md');
    expect(existsSync(at('.claude/agents/pr.md'))).toBe(false);
    expect(existsSync(at('.claude/agents/tdd.md'))).toBe(false);
  });

  it('overwrites a hand-edited copy wholesale', () => {
    installAgents(root);
    write('.claude/agents/tdd.md', `---\n${HEADER}\nname: tdd\n---\n\nHand edit.\n`);

    installAgents(root);

    expect(read('.claude/agents/tdd.md')).toBe(
      `---\n${HEADER}\nname: tdd\ndescription: >\n  Builds one issue.\n---\n\n# TDD\n\nBody.\n`,
    );
  });

  it('removes and reports a copy with the header and no source, and leaves a header-less file', () => {
    installAgents(root);
    write('.claude/agents/gone.md', `---\n${HEADER}\nname: gone\n---\n\nOld.\n`);
    write('.claude/agents/mentions.md', `---\nname: mentions\n---\n\n${HEADER}\n`);

    expect(installAgents(root).removed).toEqual(['.claude/agents/gone.md']);
    expect(existsSync(at('.claude/agents/gone.md'))).toBe(false);
    expect(read('.claude/agents/mentions.md')).toBe(`---\nname: mentions\n---\n\n${HEADER}\n`);
    expect(read('.claude/agents/github.md')).toBe(REPO_OWN);
  });
});

describe('checkAgents', () => {
  it('names a hand-edited copy without rewriting it, and an edit to its source plus an install clears it', () => {
    installAgents(root);
    write('.claude/agents/pr.md', `---\n${HEADER}\nname: pr\n---\n\nHand edit.\n`);

    expect(checkAgents(root)).toEqual([
      { file: '.claude/agents/pr.md', reason: 'differs from ship/agents/pr.md' },
    ]);
    expect(read('.claude/agents/pr.md')).toBe(`---\n${HEADER}\nname: pr\n---\n\nHand edit.\n`);

    write('ship/agents/pr.md', '---\nname: pr\n---\n\nHand edit.\n');
    installAgents(root);

    expect(checkAgents(root)).toEqual([]);
  });

  it('names a missing copy and a stale one, and passes over the repo own agent', () => {
    installAgents(root);
    rmSync(at('.claude/agents/tdd.md'));
    write('.claude/agents/gone.md', `---\n${HEADER}\nname: gone\n---\n\nOld.\n`);
    write('.claude/agents/github.md', `${REPO_OWN}Edited.\n`);

    expect(checkAgents(root)).toEqual([
      { file: '.claude/agents/tdd.md', reason: 'missing — never installed' },
      { file: '.claude/agents/gone.md', reason: 'stale — no source under ship/agents/' },
    ]);
    expect(existsSync(at('.claude/agents/gone.md'))).toBe(true);
  });

  it('passes a copy that differs from a fresh install only by CRLF line endings', () => {
    installAgents(root);
    write(
      '.claude/agents/pr.md',
      `---\r\n${HEADER}\r\nname: pr\r\n---\r\n\r\nWrites the body.\r\n`,
    );

    expect(checkAgents(root)).toEqual([]);
  });
});
