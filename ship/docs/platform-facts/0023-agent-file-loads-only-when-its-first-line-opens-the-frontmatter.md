---
status: current
platform: [claude-code 2.1.316, windows 11]
last-verified: 2026-11-02
relied-on-by: [ship/src/build/install.ts]
---

# Ship PF-23: A project agent file loads only when its first line opens the frontmatter, and a YAML comment inside the frontmatter is accepted

A `.claude/agents/<name>.md` file whose first line is anything but the frontmatter's opening `---` is not loaded as an agent: `claude -p --agent <name>` answers that the agent is not found, and the available-agents list omits it. The same file with the extra line moved inside the frontmatter, as a YAML comment right after the opening `---`, loads and runs its instructions. A project skill's `SKILL.md` with the same YAML comment there loads too, its frontmatter parsed.

## Implication

The install puts Ship's header line in an agent file or a skill on the frontmatter's first line, after the opening `---`, never above it.

## Scope

Tested with an HTML comment (`<!-- … -->`) as the leading line. Other leading content (a blank line, a byte-order mark) was not tried. The probe ran through `claude -p --agent`, not a workflow `agent()` call.

## Established

Nested `claude -p` sessions in a scratch git repository, 2026-11-02. A control agent with plain frontmatter replied with its instructed token. An agent whose first line was `<!-- Installed by Ship. Change it upstream. -->` above the frontmatter failed with `--agent 'probe-hdr' not found. Available agents: claude, Explore, general-purpose, Plan, probe-ctl, statusline-setup`. With that line rewritten as a `# …` YAML comment on the frontmatter's second line, the agent loaded and replied `PROBE-HDR-OK`. `ship/test/unit/build/install.test.ts` pins the header's position in each installed copy.

A second probe, 2026-11-02, on claude-code 2.1.316: a `.claude/skills/probe-hdr/SKILL.md` with `# Ship's skill: …` on its frontmatter's second line answered `/probe-hdr` with its token `PROBE-SKILL-HDR-7K2Q`, as a header-less control skill did, and the skill listing quoted its `description` field verbatim, not the raw frontmatter.
