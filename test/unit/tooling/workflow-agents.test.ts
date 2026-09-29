import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAGES } from '../../../tooling/workflows/lib/stages.js';

const AGENTS_DIR = resolve(import.meta.dirname, '../../../.claude/agents');

// The maintainer-personal workflow skills a repo agent must never name (ADR-0045).
const PERSONAL_SKILLS = [
  'plan-issue',
  'plan-issues',
  'ship-issue',
  'ship-issues',
  'hand-off',
  'orient-from-handoff',
];

const frontmatter = (text: string): string =>
  /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] ?? '';

const agentTypes = [...new Set(Object.values(STAGES).map((row) => row.agentType))];

describe('workflow agents', () => {
  it.each(agentTypes)('%s has an agent file named for it that pins no model', (agentType) => {
    const path = join(AGENTS_DIR, `${agentType}.md`);

    expect(existsSync(path)).toBe(true);
    const fm = frontmatter(readFileSync(path, 'utf8'));
    expect(/^name:\s*(\S+)\s*$/m.exec(fm)?.[1]).toBe(agentType);
    expect(fm).not.toMatch(/^model:/m);
  });

  it.each(readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')))(
    '%s names no personal workflow skill',
    (file) => {
      const text = readFileSync(join(AGENTS_DIR, file), 'utf8');

      expect(PERSONAL_SKILLS.filter((name) => text.includes(name))).toEqual([]);
    },
  );
});
