import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import { git, gitPaths } from './git/git.js';

/** One code token. Comments and JSDoc are never tokens. */
export interface CodeToken {
  /** As the parser re-scanned it in context (a template middle, a regex). */
  readonly kind: ts.SyntaxKind;
  /** `''` for the end-of-file token. */
  readonly text: string;
  /** 1-based. */
  readonly line: number;
}

/** The first pair of code tokens that differ between two versions of a file. */
export interface TokenDifference {
  readonly base: CodeToken;
  readonly head: CodeToken;
}

/** One changed file, by root-relative path. A side is `null` when the file is absent there. */
export interface FileChange {
  readonly basePath: string | null;
  readonly headPath: string | null;
}

/** The side compared against the base: a revision, the staged index or the working tree. */
type Head =
  | { readonly kind: 'revision'; readonly rev: string }
  | { readonly kind: 'index' }
  | { readonly kind: 'worktree' };

/** The base revision and the side compared against it. */
interface Revisions {
  readonly base: string;
  readonly head: Head;
}

/** A token difference located in one changed file. */
export interface FileDifference extends TokenDifference {
  readonly change: FileChange;
}

/** The outcome of {@link proveCommentOnly}. */
export interface CommentOnlyReport {
  /** TypeScript files compared, the differing one included. */
  readonly compared: number;
  /** Every changed non-TypeScript file, by head path (base path when deleted). */
  readonly notCompared: readonly string[];
  readonly difference: FileDifference | null;
  /** Every head line, across the files compared, holding a mojibake sequence its base lacks. */
  readonly mojibake: readonly Mojibake[];
}

/** A head line holding a mojibake sequence its base lacks. */
export interface MojibakeLine {
  /** 1-based head line. */
  readonly line: number;
  /** The first such sequence on the line, as matched. */
  readonly sequence: string;
}

/** A {@link MojibakeLine} located in one changed file, by head path. */
export interface Mojibake extends MojibakeLine {
  readonly path: string;
}

/** Windows-1252's images of the UTF-8 continuation bytes. Any one after U+00E2 is mojibake. */
const CONTINUATION = new TextDecoder('windows-1252').decode(
  Uint8Array.from({ length: 64 }, (_, i) => 0x80 + i),
);

const MOJIBAKE = new RegExp(`\u00e2[${CONTINUATION}]|\u00c3|\u00c2[\\p{P}\\p{S}]`, 'gu');

/**
 * Find the head lines holding a mojibake sequence (UTF-8 read as Windows-1252,
 * so an em dash or an arrow comes back as two or three Latin-1 characters)
 * that the base lacks.
 *
 * @param base - The base side's text. A sequence it holds anywhere is never flagged.
 * @param head - The head side's text, split into lines on LF.
 * @returns One entry per head line, its first sequence the base lacks, in line order.
 */
export function findMojibake(base: string, head: string): MojibakeLine[] {
  const hits: MojibakeLine[] = [];

  for (const [i, text] of head.split('\n').entries()) {
    for (const match of text.matchAll(MOJIBAKE)) {
      if (base.includes(match[0])) continue;
      hits.push({ line: i + 1, sequence: match[0] });
      break;
    }
  }

  return hits;
}

const USAGE = 'usage: comment-only [--cached] [<base>] | <base>..<head>';

/** A code token with its place in the syntax tree: each ancestor's kind and child index. */
interface PlacedToken {
  readonly token: CodeToken;
  readonly path: string;
}

const isJSDoc = (node: ts.Node): boolean =>
  node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

/**
 * Compare two versions of a file token by token, on kind, text and place in
 * the syntax tree, so a line break a comment edit adds or removes, which
 * changes where a statement ends (`return` then a newline), is a difference.
 *
 * @param fileName - Name the parser is given for both sides.
 * @param base - The base side's text, `''` when the file is added.
 * @param head - The head side's text, `''` when the file is deleted.
 * @returns The first differing pair, or `null` when the code is identical.
 */
export function firstDifference(
  fileName: string,
  base: string,
  head: string,
): TokenDifference | null {
  const b = codeTokens(fileName, base);
  const h = codeTokens(fileName, head);

  for (const [i, { token: bt, path }] of b.entries()) {
    const placed = h[i];
    if (placed === undefined) break;
    const ht = placed.token;

    if (bt.kind !== ht.kind || bt.text !== ht.text || path !== placed.path) {
      return { base: bt, head: ht };
    }
  }

  return null;
}

/**
 * Read `git diff -z --name-status` fields into changes.
 *
 * @param fields - The output split on NUL: a status, then two paths for a
 *   rename or copy (`R*`, `C*`) and one path for every other status.
 * @returns One change per entry, in git's order.
 */
export function parseNameStatus(fields: readonly string[]): FileChange[] {
  const changes: FileChange[] = [];
  let i = 0;

  while (i < fields.length) {
    const [status = '', first = '', second = ''] = fields.slice(i, i + 3);
    const paired = /^[RC]/u.test(status);
    changes.push(paired ? { basePath: first, headPath: second } : oneSided(status, first));
    i += paired ? 3 : 2;
  }

  return changes;
}

const displayPath = (c: FileChange): string => c.headPath ?? c.basePath ?? '';

const oneSided = (status: string, path: string): FileChange => ({
  basePath: status === 'A' ? null : path,
  headPath: status === 'D' ? null : path,
});

/**
 * Read the command's arguments: an optional `<base>` (default `HEAD`) against
 * the working tree, or against the staged index after `--cached`; or `<base>..<head>`.
 *
 * @throws {@link Error} with the usage line when more than one revision argument is
 *   given, the argument holds `...`, a `..` form lacks a revision on either side, or
 *   `--cached` precedes a `..` form.
 */
export function parseRevisions(args: readonly string[]): Revisions {
  const cached = args[0] === '--cached';
  const revs = cached ? args.slice(1) : args;
  if (revs.length > 1 || revs[0]?.includes('...') === true) throw new Error(USAGE);
  const [arg = 'HEAD'] = revs;
  if (!arg.includes('..')) return { base: arg, head: { kind: cached ? 'index' : 'worktree' } };
  const parts = arg.split('..');
  const [base = '', head = ''] = parts;
  if (cached || parts.length !== 2 || base === '' || head === '') throw new Error(USAGE);

  return { base, head: { kind: 'revision', rev: head } };
}

const isCompared = (c: FileChange): boolean =>
  [c.basePath, c.headPath].some((p) => p !== null && /\.m?ts$/u.test(p));

/**
 * Prove every changed TypeScript file between two revisions (or a revision
 * and the staged index, or the working tree with untracked files included)
 * differs in comments only.
 *
 * @remarks
 * A file counts as TypeScript when either path ends `.ts` or `.mts`. Files are
 * compared in git's order and comparison stops at the first difference. In
 * working-tree mode a tracked file moved without `git mv` is a deletion plus
 * an added file, so it fails when it holds code. Every compared file's head
 * lines are also scanned for a mojibake sequence its base lacks
 * ({@link findMojibake}), collected in `mojibake` up to the first token difference.
 *
 * @param cwd - Any directory inside the repository.
 * @throws {@link StepFailure} when a git command fails, an unknown revision included.
 */
export function proveCommentOnly(cwd: string, revisions: Revisions): CommentOnlyReport {
  const top = git(cwd, ['rev-parse', '--show-toplevel'], 'toplevel');
  const changes = changedFiles(top, revisions);
  const notCompared = changes.filter((c) => !isCompared(c)).map(displayPath);
  let compared = 0;
  const mojibake: Mojibake[] = [];

  for (const change of changes.filter(isCompared)) {
    compared++;
    const base = readSide(top, { kind: 'revision', rev: revisions.base }, change.basePath);
    const head = readSide(top, revisions.head, change.headPath);
    const { headPath } = change;

    if (headPath !== null) {
      mojibake.push(...findMojibake(base, head).map((hit) => ({ path: headPath, ...hit })));
    }

    const d = firstDifference(displayPath(change), base, head);
    if (d !== null) return { compared, notCompared, difference: { change, ...d }, mojibake };
  }

  return { compared, notCompared, difference: null, mojibake };
}

// --end-of-options: a revision starting `-` is never read as an option.
const diffRevs = (base: string, head: Head): string[] => {
  if (head.kind === 'revision') return ['--end-of-options', base, head.rev];

  return head.kind === 'index'
    ? ['--cached', '--end-of-options', base]
    : ['--end-of-options', base];
};

const renderToken = (t: CodeToken): string => {
  const text = t.kind === ts.SyntaxKind.EndOfFileToken ? '<end of file>' : `\`${t.text}\``;

  return `line ${String(t.line)} ${text}`;
};

/**
 * Render a difference as one line naming the file and both tokens.
 *
 * @returns The line, labelling a rename `<base path> -> <head path>`, and
 *   ending `(parsed differently)` when the two tokens read the same.
 */
export function formatDifference(d: FileDifference): string {
  const { basePath, headPath } = d.change;
  const label =
    basePath !== null && headPath !== null && basePath !== headPath
      ? `${basePath} -> ${headPath}`
      : displayPath(d.change);
  const same = d.base.kind === d.head.kind && d.base.text === d.head.text;
  const tokens = `base ${renderToken(d.base)}, head ${renderToken(d.head)}`;

  return `code differs in ${label}: ${tokens}${same ? ' (parsed differently)' : ''}`;
}

/**
 * Render a mojibake hit as one line naming its file, line and sequence.
 *
 * @returns The line, `mojibake at <path>:<line>: ` then the sequence in backticks.
 */
export function formatMojibake(m: Mojibake): string {
  return `mojibake at ${m.path}:${String(m.line)}: \`${m.sequence}\``;
}

function readSide(top: string, side: Head, path: string | null): string {
  if (path === null) return '';
  if (side.kind === 'worktree') return readFileSync(join(top, path), 'utf8');
  const spec = side.kind === 'index' ? `:${path}` : `${side.rev}:${path}`;

  return git(top, ['show', '--end-of-options', spec], 'show');
}

function changedFiles(top: string, { base, head }: Revisions): FileChange[] {
  const changes = parseNameStatus(
    gitPaths(top, ['diff', '--name-status', '-M', ...diffRevs(base, head), '--'], 'diff'),
  );

  if (head.kind !== 'worktree') return changes;
  const untracked = gitPaths(top, ['ls-files', '--others', '--exclude-standard'], 'untracked');

  return [...changes, ...untracked.map((path) => ({ basePath: null, headPath: path }))];
}

/** CRLF reads as LF, as a template literal reads it, so a CRLF checkout matches its LF blob. */
function codeTokens(fileName: string, source: string): PlacedToken[] {
  const lf = source.replaceAll('\r\n', '\n');
  const sf = ts.createSourceFile(fileName, lf, ts.ScriptTarget.Latest, false);
  const tokens: PlacedToken[] = [];

  const visit = (node: ts.Node, path: string): void => {
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      tokens.push({ token: { kind: node.kind, text: node.getText(sf), line }, path });

      return;
    }

    const children = node.getChildren(sf).filter((child) => !isJSDoc(child));

    for (const [i, child] of children.entries()) {
      visit(child, `${path}/${String(node.kind)}:${String(i)}`);
    }
  };

  visit(sf, '');

  return tokens;
}
