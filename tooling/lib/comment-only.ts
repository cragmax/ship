import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

import { git, gitPaths } from '../worktree/git.js';

/** One code token; comments and JSDoc are never tokens. */
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

/** One changed file, by root-relative path; a side is `null` when the file is absent there. */
export interface FileChange {
  readonly basePath: string | null;
  readonly headPath: string | null;
}

/** The revisions to compare; a `null` head is the working tree. */
export interface Revisions {
  readonly base: string;
  readonly head: string | null;
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
}

const USAGE = 'usage: comment-only [<base> | <base>..<head>]';

/** CRLF reads as LF, as a template literal reads it, so a CRLF checkout matches its LF blob. */
function codeTokens(fileName: string, source: string): CodeToken[] {
  const lf = source.replaceAll('\r\n', '\n');
  const sf = ts.createSourceFile(fileName, lf, ts.ScriptTarget.Latest, false);
  const tokens: CodeToken[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      tokens.push({ kind: node.kind, text: node.getText(sf), line });
      return;
    }
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return tokens;
}

/**
 * Compare two versions of a file token by token, on kind and text only.
 *
 * @param fileName - Name the parser is given for both sides.
 * @param base - The base side's text; `''` when the file is added.
 * @param head - The head side's text; `''` when the file is deleted.
 * @returns The first differing pair, or `null` when the code is identical.
 */
export function firstDifference(
  fileName: string,
  base: string,
  head: string,
): TokenDifference | null {
  const b = codeTokens(fileName, base);
  const h = codeTokens(fileName, head);
  for (const [i, bt] of b.entries()) {
    const ht = h[i];
    if (ht === undefined) break;
    if (bt.kind !== ht.kind || bt.text !== ht.text) return { base: bt, head: ht };
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
 * Read the command's arguments: none (base `HEAD` against the working tree),
 * `<base>` against the working tree, or `<base>..<head>`.
 *
 * @throws {@link Error} with the usage line when there is more than one argument, the
 *   argument holds `...`, or a `..` form lacks a revision on either side.
 */
export function parseRevisions(args: readonly string[]): Revisions {
  if (args.length > 1 || args[0]?.includes('...') === true) throw new Error(USAGE);
  const [arg = 'HEAD'] = args;
  if (!arg.includes('..')) return { base: arg, head: null };
  const parts = arg.split('..');
  const [base = '', head = ''] = parts;
  if (parts.length !== 2 || base === '' || head === '') throw new Error(USAGE);
  return { base, head };
}

const isCompared = (c: FileChange): boolean =>
  [c.basePath, c.headPath].some((p) => p !== null && /\.m?ts$/u.test(p));

/**
 * Prove every changed TypeScript file between two revisions — or a revision
 * and the working tree, untracked files included — differs in comments only.
 *
 * @remarks
 * A file counts as TypeScript when either path ends `.ts` or `.mts`. Files are
 * compared in git's order and comparison stops at the first difference. In
 * working-tree mode a tracked file moved without `git mv` is a deletion plus
 * an added file, so it fails when it holds code.
 *
 * @param cwd - Any directory inside the repository.
 * @throws {@link StepFailure} when a git command fails, an unknown revision included.
 */
export function proveCommentOnly(cwd: string, revisions: Revisions): CommentOnlyReport {
  const top = git(cwd, ['rev-parse', '--show-toplevel'], 'toplevel');
  const changes = changedFiles(top, revisions);
  const notCompared = changes.filter((c) => !isCompared(c)).map(displayPath);
  let compared = 0;
  for (const change of changes.filter(isCompared)) {
    compared++;
    const d = firstDifference(
      displayPath(change),
      readSide(top, revisions.base, change.basePath),
      readSide(top, revisions.head, change.headPath),
    );
    if (d !== null) return { compared, notCompared, difference: { change, ...d } };
  }
  return { compared, notCompared, difference: null };
}

function changedFiles(top: string, { base, head }: Revisions): FileChange[] {
  const revs = head === null ? [base] : [base, head];
  const changes = parseNameStatus(
    gitPaths(top, ['diff', '--name-status', '-M', ...revs, '--'], 'diff'),
  );
  if (head !== null) return changes;
  const untracked = gitPaths(top, ['ls-files', '--others', '--exclude-standard'], 'untracked');
  return [...changes, ...untracked.map((path) => ({ basePath: null, headPath: path }))];
}

function readSide(top: string, rev: string | null, path: string | null): string {
  if (path === null) return '';
  if (rev === null) return readFileSync(join(top, path), 'utf8');
  return git(top, ['show', `${rev}:${path}`], 'show');
}

const renderToken = (t: CodeToken): string => {
  const text = t.kind === ts.SyntaxKind.EndOfFileToken ? '<end of file>' : `\`${t.text}\``;
  return `line ${String(t.line)} ${text}`;
};

/**
 * Render a difference as one line naming the file and both tokens.
 *
 * @returns The line, labelling a rename `<base path> -> <head path>`.
 */
export function formatDifference(d: FileDifference): string {
  const { basePath, headPath } = d.change;
  const label =
    basePath !== null && headPath !== null && basePath !== headPath
      ? `${basePath} -> ${headPath}`
      : displayPath(d.change);
  return `code differs in ${label}: base ${renderToken(d.base)}, head ${renderToken(d.head)}`;
}
