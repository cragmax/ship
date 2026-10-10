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

// Hand-written: the by-hand restore wordings the mutation helper retired (#1061).
const RETIRED_RESTORE =
  /Edit-back|reversing (?:the|your) exact (?:mutation|edit)|git checkout <the-exact-impl-file|git checkout -- <file you mutated>|restore via `git checkout`/i;

// A vitest run instruction without a worktree config, beside the right one.
const BARE_VITEST = /\bnpx vitest (?:run|related)\b(?! --config vitest\.worktree\.)/;

const frontmatter = (text: string): string =>
  /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] ?? '';

const agentTypes = [...new Set(Object.values(STAGES).map((row) => row.agentType))];

const agentText = (agentType: string): string =>
  readFileSync(join(AGENTS_DIR, `${agentType}.md`), 'utf8').replaceAll('\r\n', '\n');

const toolsOf = (agentType: string): string[] => {
  const line = frontmatter(agentText(agentType))
    .split('\n')
    .find((l) => l.startsWith('tools:'));
  return (line ?? '')
    .slice('tools:'.length)
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
};

// From the heading line up to the next `## ` heading; '' when the heading is absent.
const section = (text: string, heading: string): string => {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) return '';
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? text.length : end);
};

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
      expect(toolsOf(agentType)).toContain('Skill');
    },
  );

  // regression: #1054 — without Edit, the applier rewrote whole plans and corrupted unrelated text.
  it('planner lists Edit in its tools', () => {
    expect(toolsOf('planner')).toContain('Edit');
  });

  // Hand-written: the diff reviewer reads and writes its findings, never edits (#1099).
  it('diff-reviewer lists exactly Read, Glob, Grep, Bash, Write and LSP in its tools', () => {
    expect(toolsOf('diff-reviewer')).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Write', 'LSP']);
  });

  // Hand-written: the PR writer only reads; the workflow renders its answer (#1181).
  it('pr-writer lists exactly Read, Glob, Grep and Bash in its tools', () => {
    expect(toolsOf('pr-writer')).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
  });

  describe('the agents that write a file', () => {
    const writers = agentTypes.filter((agentType) => toolsOf(agentType).includes('Write'));

    it('are exactly the eight the workflow hands a file to write', () => {
      expect([...writers].sort((a, b) => a.localeCompare(b))).toEqual([
        'critic',
        'diff-reviewer',
        'planner',
        'reviewer',
        'runner',
        'ship-plan-reviewer',
        'ship-tdd',
        'ship-test-review',
      ]);
    });
  });

  // Hand-written: each agent that runs an interactive skill, and the skill's step phrases it overrides.
  it.each([
    [
      'reviewer',
      '.claude/skills/manifest-tsdoc/SKILL.md',
      ['refuse without paths', 'STOP for approval'],
    ],
    [
      'ship-test-review',
      '.claude/skills/audit-tests/SKILL.md',
      [
        'Refuse without paths',
        'user confirms the scope',
        'user picks which findings to fix',
        'STOP for commit',
        'Never commit during audit',
      ],
    ],
    ['ship-tdd', '.claude/skills/tdd/SKILL.md', ['surface it', 'Not for:']],
    [
      'diff-reviewer',
      '.claude/skills/diff-review/SKILL.md',
      ['ask for it', 'ask where the issue or plan is', 'Where you can start sub-agents'],
    ],
  ])('%s overrides the interactive steps of %s', (agentType, skill, phrases) => {
    const overrides = section(agentText(agentType), '## Headless overrides');
    const skillText = readFileSync(join(REPO_ROOT, skill), 'utf8');

    expect(overrides).toContain(skill);
    for (const phrase of phrases) {
      expect(overrides, `overrides quote "${phrase}"`).toContain(phrase);
      // A reworded skill leaves the override quoting a step that no longer exists.
      expect(skillText, `${skill} still says "${phrase}"`).toContain(phrase);
    }
  });

  it.each(['ship-tdd', 'ship-test-review'])(
    '%s names none of the retired by-hand restore wordings',
    (agentType) => {
      expect(agentText(agentType)).not.toMatch(RETIRED_RESTORE);
    },
  );

  // regression: #1077 — a bare `npx vitest run` in a slice writes into the shared, junctioned node_modules/.vite.
  it.each(['planner', 'ship-plan-reviewer', 'ship-tdd', 'reviewer', 'ship-test-review'])(
    '%s names no npx vitest run without the worktree config',
    (agentType) => {
      expect(agentText(agentType)).not.toMatch(BARE_VITEST);
    },
  );

  it('covers every agent the workflow calls', () => {
    expect([...agentTypes].sort((a, b) => a.localeCompare(b))).toEqual([
      'critic',
      'diff-reviewer',
      'overlap-estimator',
      'planner',
      'pr-writer',
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

  // Hand-written: the agents that run a repo skill, which they read by path (#1039).
  it.each([
    'ship-tdd',
    'ship-test-review',
    'overlap-estimator',
    'reviewer',
    'diff-reviewer',
    'pr-writer',
  ])('%s never loads a skill with the Skill tool', (agentType) => {
    expect(readFileSync(join(AGENTS_DIR, `${agentType}.md`), 'utf8')).not.toMatch(
      /\bload\b[^.]*\bwith the Skill tool\b/i,
    );
  });
});
