import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAGES } from '../../../tooling/workflows/lib/stages.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const AGENTS_DIR = resolve(REPO_ROOT, '.claude/agents');

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

  // Hand-written: the agents that load a skill through the Skill tool (review N2).
  it.each(['ship-tdd', 'reviewer', 'ship-test-review'])(
    '%s lists Skill in its tools',
    (agentType) => {
      const fm = frontmatter(readFileSync(join(AGENTS_DIR, `${agentType}.md`), 'utf8'));
      const line = fm.split(/\r?\n/).find((l) => l.startsWith('tools:')) ?? '';
      const tools = line
        .slice('tools:'.length)
        .split(',')
        .map((t) => t.trim());

      expect(tools).toContain('Skill');
    },
  );

  it('covers every agent the workflow calls', () => {
    expect([...agentTypes].sort((a, b) => a.localeCompare(b))).toEqual([
      'critic',
      'overlap-estimator',
      'planner',
      'retro',
      'reviewer',
      'runner',
      'scout',
      'ship-plan-reviewer',
      'ship-tdd',
      'ship-test-review',
    ]);
  });

  it.each(readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')))(
    '%s names no personal workflow skill',
    (file) => {
      const text = readFileSync(join(AGENTS_DIR, file), 'utf8');

      expect(PERSONAL_SKILLS.filter((name) => text.includes(name))).toEqual([]);
    },
  );

  it.each(readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')))(
    '%s cites no skill under a home directory',
    (file) => {
      // Every home-directory spelling: `~`, `$HOME`, `${HOME}`, `"$HOME"`, `%USERPROFILE%`, `$env:USERPROFILE`, `Users/<name>`; either slash.
      expect(readFileSync(join(AGENTS_DIR, file), 'utf8')).not.toMatch(
        /(?:~|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE|\bUsers[\\/][^\\/\s]+)"?[\\/]\.claude[\\/]skills[\\/]/i,
      );
    },
  );

  it.each(readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')))(
    '%s cites only skill files that exist in the repo',
    (file) => {
      const cited = readFileSync(join(AGENTS_DIR, file), 'utf8').match(
        /\.claude\/skills\/[\w-]+\/[\w-]+\.\w+/g,
      );

      expect((cited ?? []).filter((path) => !existsSync(join(REPO_ROOT, path)))).toEqual([]);
    },
  );

  // Hand-written: each agent that runs a repo skill reads it by path (#1039).
  it.each([
    ['ship-tdd', '.claude/skills/tdd/SKILL.md'],
    ['ship-test-review', '.claude/skills/audit-tests/SKILL.md'],
    ['overlap-estimator', '.claude/skills/batch-issues/areas.md'],
  ])('%s reads %s by repo path, not through the Skill tool', (agentType, path) => {
    const text = readFileSync(join(AGENTS_DIR, `${agentType}.md`), 'utf8');

    expect(text).toContain(path);
    expect(text).not.toMatch(/\bload\b[^.]*\bwith the Skill tool\b/i);
  });
});
