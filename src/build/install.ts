#!/usr/bin/env node
/**
 * The `ship-install` bin: install Ship's part of a consumer's `.claude/` from this package's
 * sources, each {@link PARTS} row a source folder and the folder Claude Code reads it from. The
 * consumer commits the copies and never hand-edits them. The install owns only the copies that
 * carry their part's header: another file there is the consumer's own, never written, removed, or
 * checked.
 *
 * Run from the consumer's root. `--check` reports drift and exits 1.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The package root: this file is `dist/build/install.js` once built. */
const PACKAGE_DIR = resolve(import.meta.dirname, '../..');

/** One kind of installed file. */
interface Part {
  /** The sources' folder, relative to the package root. */
  readonly sources: string;
  /** Where Claude Code reads the copies, relative to the consumer's root. */
  readonly installs: string;
  /** The file names under a folder this part installs, each relative to it, sorted. */
  readonly names: (dir: string) => string[];
  /**
   * The copy of a source's text: the source plus the part's header, the line marking it as Ship's.
   *
   * @throws {@link Error} when the source has no place for the header.
   */
  readonly place: (source: string) => string;
  /** Whether a copy carries the part's header where {@link Part.place} puts it. */
  readonly carries: (copy: string) => boolean;
}

const AGENT_HEADER =
  "# Ship's agent file, installed from @cragmax/ship by ship-install: change it in cragmax/ship.";
const SKILL_HEADER =
  "# Ship's skill, installed from @cragmax/ship by ship-install: change it in cragmax/ship.";
const WORKFLOW_HEADER =
  "// Ship's workflow, installed from @cragmax/ship by ship-install: change it in cragmax/ship.";

/**
 * Every part Ship installs. The workflows' sources are the render `npm run build` writes into the
 * gitignored `workflows/`, which the package ships.
 */
const PARTS: readonly Part[] = [
  {
    sources: 'agents',
    installs: '.claude/agents',
    names: (dir) => namesEndingIn(dir, '.md'),
    ...inFrontmatter(AGENT_HEADER),
  },
  {
    sources: 'skills',
    installs: '.claude/skills',
    names: skillNames,
    ...inFrontmatter(SKILL_HEADER),
  },
  {
    sources: 'workflows',
    installs: '.claude/workflows',
    names: (dir) => namesEndingIn(dir, '.js'),
    // Last, so nothing precedes the leading `export const meta` the runtime reads (unprobed).
    place: (source) => `${source}${WORKFLOW_HEADER}\n`,
    carries: (copy) => copy.endsWith(`\n${WORKFLOW_HEADER}\n`),
  },
];

/** What one install did, each file relative to the consumer's root. */
interface InstallReport {
  /** Each copy written, part by part in {@link PARTS} order, each part's in name order. */
  readonly written: readonly string[];
  /** Each stale copy removed: one carrying its part's header whose source is gone. */
  readonly removed: readonly string[];
}

interface CopyDrift {
  /** The copy, relative to the consumer's root. */
  readonly file: string;
  readonly reason: string;
}

/**
 * Overwrite every source's copy into its part's folder under `.claude/`, then remove each stale
 * copy.
 *
 * @param source - The package root, holding the sources.
 * @param target - The consumer's root, holding `.claude/`.
 * @throws {@link Error} when a source has no place for its header (an agent file or a skill that
 *   does not open with a frontmatter `---` line), naming it, before any copy is written.
 * @throws {@link Error} when a part's source folder is missing, or its install folder is missing
 *   and the part has no source.
 * @throws {@link Error} when a skill an agent source preloads is neither under `.claude/skills/`
 *   nor installed from the package's `skills/`, one line per agent and skill, before any copy is
 *   written.
 */
export function install(source: string, target: string): InstallReport {
  requireConsumerSkills(source, target);
  const copies = PARTS.flatMap((part) =>
    part.names(join(source, part.sources)).map((name) => ({
      file: `${part.installs}/${name}`,
      text: expectedCopy(source, part, name),
    })),
  );
  const written = copies.map(({ file, text }) => {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), text, 'utf8');

    return file;
  });
  const removed = PARTS.flatMap((part) => staleFiles(source, target, part)).map((file) => {
    rmSync(join(target, file));

    return file;
  });

  return { written, removed };
}

/**
 * The drift check: each source's copy must equal a fresh install, line endings aside, and no
 * stale copy may remain. Writes nothing.
 *
 * @param source - The package root, holding the sources.
 * @param target - The consumer's root, holding `.claude/`.
 * @returns One entry per drifted copy, empty when none drifted.
 * @throws {@link Error} when a source has no place for its header, naming it.
 * @throws {@link Error} when a part's source or install folder is missing.
 * @throws {@link Error} when a skill an agent source preloads is missing, as {@link install} does.
 */
export function checkInstall(source: string, target: string): CopyDrift[] {
  requireConsumerSkills(source, target);

  return PARTS.flatMap((part) => {
    const drifted = part.names(join(source, part.sources)).flatMap((name): CopyDrift[] => {
      const file = `${part.installs}/${name}`;
      const path = join(target, file);
      const expected = expectedCopy(source, part, name);
      if (!existsSync(path)) return [{ file, reason: 'missing — never installed' }];

      return readLf(path) === expected
        ? []
        : [{ file, reason: `differs from ${part.sources}/${name}` }];
    });
    const stale = staleFiles(source, target, part).map((file) => ({
      file,
      reason: `stale — no source under ${part.sources}/`,
    }));

    return [...drifted, ...stale];
  });
}

/**
 * Throw, one line per agent source and skill, when a source's `skills:` front matter names a skill
 * with no `.claude/skills/<name>/SKILL.md` that the package's `skills/` does not install: Claude
 * Code skips a missing preloaded skill with only a debug-log warning.
 */
function requireConsumerSkills(source: string, target: string): void {
  const installed = new Set(skillNames(join(source, 'skills')).map((name) => dirname(name)));
  const missing = namesEndingIn(join(source, 'agents'), '.md').flatMap((agent) =>
    preloadedSkills(readLf(join(source, 'agents', agent)))
      .filter((skill) => !installed.has(skill))
      .filter((skill) => !existsSync(join(target, '.claude/skills', skill, 'SKILL.md')))
      .map(
        (skill) => `install: no .claude/skills/${skill}/SKILL.md, which agents/${agent} preloads`,
      ),
  );

  if (missing.length > 0) throw new Error(missing.join('\n'));
}

/** The names an agent file's front matter lists under `skills:` as a block sequence, in order. */
function preloadedSkills(agent: string): string[] {
  const lines = agent.split('\n');
  const close = lines.indexOf('---', 1);
  const frontmatter = lines[0] === '---' && close !== -1 ? lines.slice(1, close) : [];
  const start = frontmatter.indexOf('skills:');
  if (start === -1) return [];
  const item = /^[ \t]+- /u;
  const items = frontmatter.slice(start + 1);
  const end = items.findIndex((line) => !item.test(line));

  return items
    .slice(0, end === -1 ? items.length : end)
    .map((line) => line.replace(item, '').trim());
}

/** The names under `dir` ending in `extension`, sorted. */
function namesEndingIn(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .sort((a, b) => a.localeCompare(b));
}

/** `<skill>/SKILL.md` for each skill folder under `dir` that holds one, sorted. */
function skillNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
    .map((entry) => `${entry.name}/SKILL.md`)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * A part placing `header` as its frontmatter's first line: Claude Code drops an agent file whose
 * first line is not the frontmatter's opening `---`, and reads a YAML comment inside it.
 * {@link Part.place} throws when the source does not open with a frontmatter `---` line.
 */
function inFrontmatter(header: string): Pick<Part, 'place' | 'carries'> {
  return {
    place: (source) => {
      if (!source.startsWith('---\n')) throw new Error('does not open with a frontmatter ---');

      return `---\n${header}\n${source.slice('---\n'.length)}`;
    },
    carries: (copy) => copy.split('\n')[1] === header,
  };
}

/**
 * The copy a fresh install writes for one source.
 *
 * @throws {@link Error} when the source has no place for the header, naming the source.
 */
function expectedCopy(source: string, part: Part, name: string): string {
  const file = `${part.sources}/${name}`;

  try {
    return part.place(readLf(join(source, file)));
  } catch (error) {
    throw new Error(`install: ${file} ${(error as Error).message}`, { cause: error });
  }
}

/** Each installed copy carrying its part's header that no source matches, consumer-relative. */
function staleFiles(source: string, target: string, part: Part): string[] {
  const sources = new Set(part.names(join(source, part.sources)));
  const installs = join(target, part.installs);
  if (!existsSync(installs)) return [];

  return part
    .names(installs)
    .filter((name) => !sources.has(name) && part.carries(readLf(join(installs, name))))
    .map((name) => `${part.installs}/${name}`);
}

/** A file's text with CRLF line endings read as LF. */
function readLf(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/**
 * Install, or with `--check` report every drifted copy and exit 1.
 *
 * @throws {@link Error} on an argument other than `--check`.
 */
function main(argv: readonly string[]): void {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) {
    throw new Error(`install: unknown arguments ${argv.join(' ')}; the one flag is --check`);
  }

  if (argv.length === 0) {
    const { written, removed } = install(PACKAGE_DIR, process.cwd());
    console.log(`ship-install: installed ${String(written.length)} file(s).`);
    for (const file of removed) console.log(`ship-install: removed stale ${file}.`);

    return;
  }

  const drift = checkInstall(PACKAGE_DIR, process.cwd());

  if (drift.length > 0) {
    for (const d of drift) console.error(`FAIL: ${d.file} — ${d.reason}`);
    console.error('\nRun `npx ship-install`, or change the source in cragmax/ship.');
    process.exit(1);
  }

  console.log('install-check: OK');
}

// Only when invoked as a CLI: the unit tests import this module, and an import must never write.
if (import.meta.main && process.argv[2] === '--help') {
  console.log('usage: ship-install [--check], from the consumer root');
} else if (import.meta.main) {
  main(process.argv.slice(2));
}
