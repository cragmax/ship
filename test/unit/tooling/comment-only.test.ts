import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  firstDifference,
  formatDifference,
  parseNameStatus,
  parseRevisions,
  proveCommentOnly,
} from '../../../tooling/lib/comment-only.js';
import { commitChanges, headSha, makeGitRepo } from '../../helpers/worktree-fixture-git.js';
import { mustRun } from '../../helpers/worktree-fixture.js';

const BASE = [
  '/**',
  ' * Header line one',
  ' * line two',
  ' */',
  "import { x } from './y.js';",
  '/** Doc for f.',
  ' *  more doc */',
  'export function f(a: number): string {',
  '  // inline note',
  "  const s = 'a // not comment';",
  '  const t = `${a} // mid ${a} tail // end`;',
  '  const r = /a\\/\\/b/u;',
  '  /* block',
  '     comment */',
  '  return s + t + String(r) + x;',
  '}',
  '',
].join('\n');

const COMMENT_ONLY = [
  "import { x } from './y.js';",
  '/** Doc for f. more doc */',
  'export function f(a: number): string {',
  "  const s = 'a // not comment';",
  '  const t = `${a} // mid ${a} tail // end`;',
  '  const r = /a\\/\\/b/u;',
  '  /* block comment */',
  '  return s + t + String(r) + x;',
  '}',
  '',
].join('\n');

const ONE_TOKEN = COMMENT_ONLY.replace('String(r) + x', 'String(r) - x');

describe('firstDifference', () => {
  it('names the first differing code token on each side with its line', () => {
    const d = firstDifference('a.ts', BASE, ONE_TOKEN);
    expect(d).toMatchObject({
      base: { kind: ts.SyntaxKind.PlusToken, text: '+', line: 15 },
      head: { kind: ts.SyntaxKind.MinusToken, text: '-', line: 8 },
    });
  });

  it('passes a diff that only deletes, collapses, removes and re-wraps comments', () => {
    expect(firstDifference('a.ts', BASE, COMMENT_ONLY)).toBeNull();
  });

  // Tags and links parse into identifier nodes inside the JSDoc tree; plain JSDoc text does not.
  it('passes a diff that rewrites JSDoc tags and links', () => {
    const base = '/** See {@link g}.\n * @param a - n */\nexport function f(a: number) {}\n';
    const head = '/** Doc. */\nexport function f(a: number) {}\n';
    expect(firstDifference('a.ts', base, head)).toBeNull();
  });

  it.each([
    ['string', "'a // not comment'", "'a  not comment'", "'a  not comment'"],
    ['template middle', '// mid ', 'mid ', '} mid ${'],
    ['regex', '/a\\/\\/b/u', '/ab/u', '/ab/u'],
  ])('treats // inside a %s literal as code', (_kind, from, to, headText) => {
    const d = firstDifference('a.ts', BASE, COMMENT_ONLY.replace(from, to));
    expect(d?.head.text).toBe(headText);
  });

  // core.autocrlf=true checks a blob's LF out as CRLF; a multi-line template must still match.
  it('reads a CRLF side as its LF blob', () => {
    const lf = 'const q = `a\nb`;\n';
    expect(firstDifference('a.ts', lf, lf.replaceAll('\n', '\r\n'))).toBeNull();
  });

  it('compares an added file against an empty base', () => {
    expect(firstDifference('n.ts', '', 'export const x = 1;\n')).toMatchObject({
      base: { kind: ts.SyntaxKind.EndOfFileToken, text: '', line: 1 },
      head: { text: 'export', line: 1 },
    });
  });

  it('passes an added file holding only comments', () => {
    expect(firstDifference('n.ts', '', '// only\n/** doc */\n/* b */\n')).toBeNull();
  });

  it('fails a deleted file that held code', () => {
    const d = firstDifference('n.ts', 'export const x = 1;\n', '');
    expect(d?.head.kind).toBe(ts.SyntaxKind.EndOfFileToken);
  });
});

describe('parseNameStatus', () => {
  it('reads two paths for a rename or copy and one for every other status', () => {
    expect(
      parseNameStatus([
        'M',
        'a.ts',
        'R090',
        'b.ts',
        'lib/b.ts',
        'A',
        'n.ts',
        'D',
        'c.ts',
        'C075',
        'd.ts',
        'e.ts',
        'T',
        'f.ts',
      ]),
    ).toEqual([
      { basePath: 'a.ts', headPath: 'a.ts' },
      { basePath: 'b.ts', headPath: 'lib/b.ts' },
      { basePath: null, headPath: 'n.ts' },
      { basePath: 'c.ts', headPath: null },
      { basePath: 'd.ts', headPath: 'e.ts' },
      { basePath: 'f.ts', headPath: 'f.ts' },
    ]);
  });
});

describe('parseRevisions', () => {
  it.each([
    [[], { base: 'HEAD', head: null }],
    [['v1.2'], { base: 'v1.2', head: null }],
    [['v1.2..abc'], { base: 'v1.2', head: 'abc' }],
  ])('reads %j', (args, expected) => {
    expect(parseRevisions(args)).toEqual(expected);
  });

  it.each([[['a...b']], [['a..']], [['..b']], [['a', 'b']]])('refuses %j', (args) => {
    expect(() => parseRevisions(args)).toThrow(
      new Error('usage: comment-only [<base> | <base>..<head>]'),
    );
  });
});

describe('proveCommentOnly', () => {
  const B_TS = 'export const b = 2;\n// bee\nexport const bb = 3;\n';
  const B_TRIMMED = 'export const b = 2;\nexport const bb = 3;\n';
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'comment-only-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const makeRepo = (): string => makeGitRepo(root, { 'a.ts': BASE, 'b.ts': B_TS, 'n.md': 'x\n' });

  it('passes a comment-only working tree with a git mv, listing the non-TypeScript file', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.ts'), COMMENT_ONLY);
    mustRun('git', ['mv', 'b.ts', 'lib-b.ts'], dir);
    writeFileSync(join(dir, 'lib-b.ts'), B_TRIMMED);
    writeFileSync(join(dir, 'n.md'), 'y\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: null })).toEqual({
      compared: 2,
      notCompared: ['n.md'],
      difference: null,
    });
  });

  it('names the changed file and tokens of a code change in a revision range', () => {
    const dir = makeRepo();
    const first = headSha(dir);
    const second = commitChanges(
      dir,
      {
        rename: [['b.ts', 'lib-b.ts']],
        write: { 'a.ts': ONE_TOKEN, 'lib-b.ts': B_TRIMMED, 'n.md': 'y\n' },
      },
      'trim',
    );
    expect(proveCommentOnly(dir, { base: first, head: second })).toMatchObject({
      compared: 1,
      notCompared: ['n.md'],
      difference: {
        change: { basePath: 'a.ts', headPath: 'a.ts' },
        base: { text: '+' },
        head: { text: '-' },
      },
    });
  });

  it('compares a renamed file old path against new in a revision range', () => {
    const dir = makeRepo();
    const first = headSha(dir);
    const second = commitChanges(
      dir,
      { rename: [['b.ts', 'lib-b.ts']], write: { 'lib-b.ts': B_TRIMMED } },
      'trim',
    );
    expect(proveCommentOnly(dir, { base: first, head: second })).toEqual({
      compared: 1,
      notCompared: [],
      difference: null,
    });
  });

  it('compares an untracked TypeScript file as added', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'new.ts'), 'export const x = 1;\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: null }).difference).toMatchObject({
      change: { basePath: null, headPath: 'new.ts' },
      head: { text: 'export' },
    });
  });

  it('compares a deleted TypeScript file against an empty head', () => {
    const dir = makeRepo();
    rmSync(join(dir, 'b.ts'));
    expect(proveCommentOnly(dir, { base: 'HEAD', head: null })).toEqual({
      compared: 1,
      notCompared: [],
      difference: {
        change: { basePath: 'b.ts', headPath: null },
        base: { kind: ts.SyntaxKind.ExportKeyword, text: 'export', line: 1 },
        head: { kind: ts.SyntaxKind.EndOfFileToken, text: '', line: 1 },
      },
    });
  });

  it('skips an untracked TypeScript file git ignores', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'tmp'));
    writeFileSync(join(dir, 'tmp', 'scratch.ts'), 'export const x = 1;\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: null })).toEqual({
      compared: 0,
      notCompared: [],
      difference: null,
    });
  });

  it('lists a deleted non-TypeScript file under its base path', () => {
    const dir = makeRepo();
    rmSync(join(dir, 'n.md'));
    expect(proveCommentOnly(dir, { base: 'HEAD', head: null }).notCompared).toEqual(['n.md']);
  });

  it('passes untracked .ts and .mts files holding only comments', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'notes.ts'), '// only\n');
    writeFileSync(join(dir, 'notes.mts'), '// only\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: null })).toEqual({
      compared: 2,
      notCompared: [],
      difference: null,
    });
  });
});

describe('formatDifference', () => {
  const plus = { kind: ts.SyntaxKind.PlusToken, text: '+', line: 15 };
  const minus = { kind: ts.SyntaxKind.MinusToken, text: '-', line: 8 };

  it('names the file and both tokens with their lines', () => {
    expect(
      formatDifference({ change: { basePath: 'a.ts', headPath: 'a.ts' }, base: plus, head: minus }),
    ).toBe('code differs in a.ts: base line 15 `+`, head line 8 `-`');
  });

  it('labels a rename with both paths', () => {
    expect(
      formatDifference({
        change: { basePath: 'b.ts', headPath: 'lib/b.ts' },
        base: plus,
        head: minus,
      }),
    ).toBe('code differs in b.ts -> lib/b.ts: base line 15 `+`, head line 8 `-`');
  });

  it('renders the end-of-file token of an absent side', () => {
    expect(
      formatDifference({
        change: { basePath: null, headPath: 'n.ts' },
        base: { kind: ts.SyntaxKind.EndOfFileToken, text: '', line: 1 },
        head: { kind: ts.SyntaxKind.ExportKeyword, text: 'export', line: 1 },
      }),
    ).toBe('code differs in n.ts: base line 1 <end of file>, head line 1 `export`');
  });
});
