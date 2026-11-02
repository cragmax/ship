/**
 * Build-time script: install Ship's agent files from their sources under `ship/agents/` into
 * `.claude/agents/`, where Claude Code reads them. The copies are committed and never hand-edited.
 * The install owns only the copies that carry {@link SHIP_HEADER}: another agent file there is
 * the repository's own, never written, removed, or checked.
 *
 * `npm run codegen` installs. `--check` (`npm run gate:codegen`) reports drift and exits 1.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dirname, '../../..');

/** The sources, repository-relative. */
const SOURCES = 'ship/agents';

/** Where Claude Code reads project agents, repository-relative. */
const INSTALLS = '.claude/agents';

/** The line marking an installed copy as Ship's. */
const SHIP_HEADER =
  "# Ship's agent file: change it upstream under ship/agents/, then run `npm run codegen`.";

/** What one install did, each file repository-relative. */
interface InstallReport {
  /** Each copy written, in source order. */
  readonly written: readonly string[];
  /** Each stale copy removed: one carrying {@link SHIP_HEADER} whose source is gone. */
  readonly removed: readonly string[];
}

interface AgentDrift {
  /** The copy, repository-relative. */
  readonly file: string;
  readonly reason: string;
}

/**
 * Overwrite every source's copy into `.claude/agents/`, then remove each stale copy.
 *
 * @param root - The repository root.
 * @throws {@link Error} when a source does not open with a frontmatter `---` line, naming it,
 *   before any copy is written.
 * @throws {@link Error} when `ship/agents/` or `.claude/agents/` is missing.
 */
export function installAgents(root: string): InstallReport {
  const copies = sourceNames(root).map((name) => ({ name, text: expectedCopy(root, name) }));
  const written = copies.map(({ name, text }) => {
    writeFileSync(join(root, INSTALLS, name), text, 'utf8');

    return `${INSTALLS}/${name}`;
  });
  const removed = staleNames(root).map((name) => {
    rmSync(join(root, INSTALLS, name));

    return `${INSTALLS}/${name}`;
  });

  return { written, removed };
}

/**
 * The drift check: each source's copy must equal a fresh install, line endings aside, and no
 * stale copy may remain. Writes nothing.
 *
 * @param root - The repository root.
 * @returns One entry per drifted copy, empty when none drifted.
 * @throws {@link Error} when a source does not open with a frontmatter `---` line, naming it.
 * @throws {@link Error} when `ship/agents/` or `.claude/agents/` is missing.
 */
export function checkAgents(root: string): AgentDrift[] {
  const drifted = sourceNames(root).flatMap((name): AgentDrift[] => {
    const file = `${INSTALLS}/${name}`;
    const path = join(root, file);
    const expected = expectedCopy(root, name);
    if (!existsSync(path)) return [{ file, reason: 'missing — never installed' }];

    return readLf(path) === expected ? [] : [{ file, reason: `differs from ${SOURCES}/${name}` }];
  });
  const stale = staleNames(root).map((name) => ({
    file: `${INSTALLS}/${name}`,
    reason: `stale — no source under ${SOURCES}/`,
  }));

  return [...drifted, ...stale];
}

function sourceNames(root: string): string[] {
  return markdownNames(join(root, SOURCES));
}

/** The `.md` file names under `dir`, sorted. */
function markdownNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The source with {@link SHIP_HEADER} as its frontmatter's first line: Claude Code drops an agent
 * file whose first line is not the frontmatter's opening `---`.
 *
 * @throws {@link Error} when the source does not open with a frontmatter `---` line.
 */
function expectedCopy(root: string, name: string): string {
  const source = readLf(join(root, SOURCES, name));

  if (!source.startsWith('---\n')) {
    throw new Error(`install-agents: ${SOURCES}/${name} does not open with a frontmatter ---`);
  }

  return `---\n${SHIP_HEADER}\n${source.slice('---\n'.length)}`;
}

/** Each installed copy carrying {@link SHIP_HEADER} that no source matches. */
function staleNames(root: string): string[] {
  const sources = new Set(sourceNames(root));

  return markdownNames(join(root, INSTALLS)).filter(
    (name) =>
      !sources.has(name) && readLf(join(root, INSTALLS, name)).split('\n')[1] === SHIP_HEADER,
  );
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
    throw new Error(`install-agents: unknown arguments ${argv.join(' ')}; the one flag is --check`);
  }

  if (argv.length === 0) {
    const { written, removed } = installAgents(ROOT_DIR);
    console.log(`[codegen] Installed ${String(written.length)} agent file(s).`);
    for (const file of removed) console.log(`[codegen] Removed stale ${file}.`);

    return;
  }

  const drift = checkAgents(ROOT_DIR);

  if (drift.length > 0) {
    for (const d of drift) console.error(`FAIL: ${d.file} — ${d.reason}`);
    console.error('\nEdit the source under ship/agents/, then run `npm run codegen`.');
    process.exit(1);
  }

  console.log('agents-check: OK');
}

// Only when invoked as a CLI: the unit tests import this module, and an import must never write.
if (import.meta.main) {
  main(process.argv.slice(2));
}
