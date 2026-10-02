import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMMENT_MAX_CHARS } from '../../../tooling/lib/pr-review-comment.js';
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
  it('diff-reviewer lists exactly Read, Glob, Grep, Bash and Write in its tools', () => {
    expect(toolsOf('diff-reviewer')).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Write']);
  });

  // Hand-written: the curator reads, and writes only its comment file (#1111).
  it('curator lists exactly Read, Glob, Grep and Write in its tools', () => {
    expect(toolsOf('curator')).toEqual(['Read', 'Glob', 'Grep', 'Write']);
  });

  // Hand-written: the comment's two before-merge headings and its four finding labels (#1111).
  it('curator spells its two headings under ## Groups and its four labels under ## Labels', () => {
    const text = agentText('curator');
    const groups = section(text, '## Groups');
    const labels = section(text, '## Labels');

    expect(
      ['`Fix before merge`', '`Check before merge (unverified)`'].filter(
        (t) => !groups.includes(t),
      ),
    ).toEqual([]);
    expect(
      ['`verified`', '`unverified`', '`by design`', '`personal rule`'].filter(
        (t) => !labels.includes(t),
      ),
    ).toEqual([]);
  });

  // Hand-written: the curator's never rules, and the citation `pr-comment --findings-file` counts (#1111).
  it('curator states its never rules and the citation tooling counts under ## Discipline', () => {
    const discipline = section(agentText('curator'), '## Discipline');

    expect(
      [
        '**Never drop a finding.**',
        '**Never verify a finding.**',
        '**Never post.**',
        '**Never file an issue.**',
        '`<file>:<line>`',
      ].filter((t) => !discipline.includes(t)),
    ).toEqual([]);
  });

  // The constant is the oracle: its value is still unconfirmed against GitHub (#1110), so the agent file must follow it.
  it('curator states the comment limit pr-comment enforces under ## Discipline', () => {
    expect(section(agentText('curator'), '## Discipline')).toContain(
      `at most ${String(COMMENT_MAX_CHARS)} characters`,
    );
  });

  describe('the agents that write a file', () => {
    const writers = agentTypes.filter((agentType) => toolsOf(agentType).includes('Write'));

    it('are exactly the nine the workflow hands a file to write', () => {
      expect([...writers].sort((a, b) => a.localeCompare(b))).toEqual([
        'critic',
        'curator',
        'diff-reviewer',
        'planner',
        'reviewer',
        'runner',
        'ship-plan-reviewer',
        'ship-tdd',
        'ship-test-review',
      ]);
    });

    it.each(writers)('%s answers through StructuredOutput, per its ## Output', (agentType) => {
      expect(section(agentText(agentType), '## Output')).toContain('StructuredOutput');
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
    '%s mutates through the mutation helper and sweeps with check',
    (agentType) => {
      const text = agentText(agentType);

      expect(text).toContain('.claude/skills/audit-tests/mutate.ts');
      expect(text).toMatch(/mutate\.ts check/);
      expect(text).not.toMatch(RETIRED_RESTORE);
    },
  );

  // regression: #1077 — a bare `npx vitest run` in a slice writes into the shared, junctioned node_modules/.vite.
  it.each(['planner', 'ship-plan-reviewer', 'ship-tdd', 'reviewer', 'ship-test-review'])(
    '%s runs unit tests under the worktree vitest config',
    (agentType) => {
      const text = agentText(agentType);

      expect(text).toContain('npx vitest run --config vitest.worktree.config.ts <files>');
      expect(text).not.toMatch(BARE_VITEST);
    },
  );

  // Hand-written: the Probes-entry tokens the planner writes and the plan reviewer and the tdd read (#1071).
  const PLAN_PROBE_TOKENS = ['plan-time', 'tdd-time', 'pending — tdd', 'plan allowance spent'];

  // Its entry-format bullet, not the whole file: step 4 and apply mode repeat the tokens, so a drifted definition hid behind them.
  it('planner defines the plan-probe tokens in its Probes-entry format', () => {
    const entry =
      section(agentText('planner'), '## Plan-time probes')
        .split('\n')
        .find((l) => l.startsWith('- **The entry.**')) ?? '';

    expect(PLAN_PROBE_TOKENS.filter((token) => !entry.includes(token))).toEqual([]);
  });

  it.each<[string, string[]]>([
    ['ship-plan-reviewer', PLAN_PROBE_TOKENS],
    ['ship-tdd', ['plan-time', 'pending — tdd']],
  ])('%s spells the plan-probe tokens the planner writes', (agentType, tokens) => {
    const text = agentText(agentType);

    expect(tokens.filter((token) => !text.includes(token))).toEqual([]);
  });

  // Hand-written: the finding-line tokens the diff-review skill writes and the agents acting on its findings read (#1098, #1099).
  const FINDING_TOKENS = ['F<n>', 'hard', 'judgement'];

  // Its finding-line format, not the whole skill: its severity bullets repeat `hard` and `judgement`, so a renamed format would hide behind them.
  it('diff-review defines the finding tokens in its report’s finding line', () => {
    const skill = readFileSync(join(REPO_ROOT, '.claude/skills/diff-review/SKILL.md'), 'utf8');
    const format =
      section(skill.replaceAll('\r\n', '\n'), '## 4. Report')
        .split('\n')
        .find((l) => l.startsWith('`F<n> ')) ?? '';

    expect(FINDING_TOKENS.filter((token) => !format.includes(token))).toEqual([]);
  });

  it.each<[string, string, string[]]>([
    ['reviewer', '## Review mode', FINDING_TOKENS],
    ['diff-reviewer', '## Discipline', ['hard']],
  ])(
    '%s spells the finding tokens the diff-review skill writes, under its %s',
    (agentType, heading, tokens) => {
      const text = section(agentText(agentType), heading);

      expect(tokens.filter((token) => !text.includes(`\`${token}\``))).toEqual([]);
    },
  );

  // Hand-written: the probe timing and the greppable duration token a cap review reads (#1086).
  const DURATION_TOKENS = ['date +%s', 'duration: <dur>', '`42s`', '`11m 04s`'];

  it.each(['planner', 'ship-tdd'])(
    '%s times each probe and writes its duration token',
    (agentType) => {
      const text = agentText(agentType);

      expect(DURATION_TOKENS.filter((token) => !text.includes(token))).toEqual([]);
    },
  );

  // Its return section, not the whole file: the planner's step 4 also names `seconds`, so a dropped return field hid behind it.
  it.each<[string, string]>([
    ['planner', '## Return'],
    ['ship-tdd', '## Report and return'],
  ])('%s returns each probe record’s seconds under its %s', (agentType, heading) => {
    expect(section(agentText(agentType), heading)).toContain('`seconds`');
  });

  it('covers every agent the workflow calls', () => {
    expect([...agentTypes].sort((a, b) => a.localeCompare(b))).toEqual([
      'critic',
      'curator',
      'diff-reviewer',
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
    ['reviewer', '.claude/skills/manifest-tsdoc/SKILL.md'],
    ['diff-reviewer', '.claude/skills/diff-review/SKILL.md'],
  ])('%s reads %s by repo path, not through the Skill tool', (agentType, path) => {
    const text = readFileSync(join(AGENTS_DIR, `${agentType}.md`), 'utf8');

    expect(text).toContain(path);
    expect(text).not.toMatch(/\bload\b[^.]*\bwith the Skill tool\b/i);
  });
});
