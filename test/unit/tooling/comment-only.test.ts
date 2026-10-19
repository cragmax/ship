import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findMojibake,
  firstDifference,
  formatDifference,
  formatMojibake,
  parseNameStatus,
  parseRevisions,
  proveCommentOnly,
} from '../../../tooling/lib/comment-only.js';
import { StepFailure } from '../../../ship/src/cli/envelope/types.js';
import { commitChanges, headSha, makeGitRepo } from '../../helpers/worktree-fixture-git.js';
import { mustRun } from '../../helpers/worktree-fixture.js';

// A test spawning git runs near 5s under the gate's parallel load.
vi.setConfig({ testTimeout: 20_000 });

const BASE = readFileSync(new URL('../../fixtures/comment-only/base.txt', import.meta.url), 'utf8');

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

const WORKTREE = { kind: 'worktree' } as const;
const INDEX = { kind: 'index' } as const;

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

  // regression: same tokens, but the newline inside the comment ends the return (ASI).
  it.each([
    ['a comment edit', 'return /* why\n */ value;', 'return /* why */ value;'],
    ['a code edit', 'return\n  value;', 'return value;'],
  ])('fails %s that moves a line break past a return', (_edit, base, head) => {
    const wrap = (body: string): string => `export function f(value: number) {\n  ${body}\n}\n`;
    expect(firstDifference('a.ts', wrap(base), wrap(head))).toMatchObject({
      base: { text: 'value', line: 3 },
      head: { text: 'value', line: 2 },
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

describe('findMojibake', () => {
  it.each([
    ['\u00e2\u20ac\u201d', '\u00e2\u20ac'],
    ['\u00e2\u2020\u2019', '\u00e2\u2020'],
    ['\u00e2\u201d\u20ac', '\u00e2\u201d'],
    ['\u00e2\u2030\u00a5', '\u00e2\u2030'],
    ['\u00e2\u0153\u201c', '\u00e2\u0153'],
    // U+2FF0: its second byte, 0xBF, is the last UTF-8 continuation byte.
    ['\u00e2\u00bf\u00b0', '\u00e2\u00bf'],
    ['\u00c2\u00a7', '\u00c2\u00a7'],
    ['\u00c2\u00b0', '\u00c2\u00b0'],
    ['\u00c3\u00a9', '\u00c3'],
  ])('flags %s', (moji, sequence) => {
    expect(findMojibake('', '// x ' + moji + '\n')).toEqual([{ line: 1, sequence }]);
  });

  it.each(['\u2014', '\u2192', '\u2500', '\u00a7', '\u2019', '\u00e9', '\u00e2t', '\u00c2A'])(
    'passes a clean %s',
    (ch) => {
      expect(findMojibake('', '// a ' + ch + ' b\n')).toEqual([]);
    },
  );

  it('passes a mojibake sequence the base already holds', () => {
    expect(
      findMojibake(
        '// see \u00c2\u00a7 1\nexport const x = 1;\n',
        '// see \u00c2\u00a7 2\nexport const x = 1;\n',
      ),
    ).toEqual([]);
  });

  it('reports one entry per line, its first new sequence', () => {
    expect(
      findMojibake(
        '// \u00c2\u00a7\n',
        '// a\r\n// \u00c2\u00a7 \u00e2\u20ac\u201d \u00c3\u00a9\r\n',
      ),
    ).toEqual([{ line: 2, sequence: '\u00e2\u20ac' }]);
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
    [[], { base: 'HEAD', head: WORKTREE }],
    [['v1.2'], { base: 'v1.2', head: WORKTREE }],
    [['--cached'], { base: 'HEAD', head: INDEX }],
    [['--cached', 'v1.2'], { base: 'v1.2', head: INDEX }],
    [['v1.2..abc'], { base: 'v1.2', head: { kind: 'revision', rev: 'abc' } }],
  ])('reads %j', (args, expected) => {
    expect(parseRevisions(args)).toEqual(expected);
  });

  it.each([
    [['a...b']],
    [['a..']],
    [['..b']],
    [['a', 'b']],
    [['--cached', 'a..b']],
    [['--cached', 'a', 'b']],
  ])('refuses %j', (args) => {
    expect(() => parseRevisions(args)).toThrow(
      new Error('usage: comment-only [--cached] [<base>] | <base>..<head>'),
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
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE })).toEqual({
      compared: 2,
      notCompared: ['n.md'],
      difference: null,
      mojibake: [],
    });
  });

  it('reports a mojibake sequence a comment edit adds, by file and line', () => {
    const dir = makeRepo();
    writeFileSync(
      join(dir, 'a.ts'),
      BASE.replace('Header line one', 'Header \u00e2\u20ac\u201d one'),
    );
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE })).toEqual({
      compared: 1,
      notCompared: [],
      difference: null,
      mojibake: [{ path: 'a.ts', line: 2, sequence: '\u00e2\u20ac' }],
    });
  });

  // The working tree undoes the staged code change, so only --cached sees what would commit.
  it('reads the staged index, not the working tree, under --cached', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.ts'), ONE_TOKEN);
    mustRun('git', ['add', 'a.ts'], dir);
    writeFileSync(join(dir, 'a.ts'), COMMENT_ONLY);
    writeFileSync(join(dir, 'untracked.ts'), 'export const u = 1;\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: INDEX })).toMatchObject({
      compared: 1,
      notCompared: [],
      difference: { change: { basePath: 'a.ts', headPath: 'a.ts' }, head: { text: '-' } },
    });
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE }).difference).toMatchObject({
      change: { headPath: 'untracked.ts' },
    });
  });

  // regression: unguarded, git read --output=… as an option and wrote the diff to a file.
  it('reads a base starting with - as a revision, failing on it', () => {
    const dir = makeRepo();
    expect(() => proveCommentOnly(dir, { base: '--output=out', head: WORKTREE })).toThrow(
      StepFailure,
    );
    expect(existsSync(join(dir, 'out'))).toBe(false);
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
    expect(
      proveCommentOnly(dir, { base: first, head: { kind: 'revision', rev: second } }),
    ).toMatchObject({
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
    expect(proveCommentOnly(dir, { base: first, head: { kind: 'revision', rev: second } })).toEqual(
      {
        compared: 1,
        notCompared: [],
        difference: null,
        mojibake: [],
      },
    );
  });

  it('reports mojibake in a renamed file under its head path in a revision range', () => {
    const dir = makeRepo();
    const first = headSha(dir);
    const second = commitChanges(
      dir,
      {
        rename: [['b.ts', 'lib-b.ts']],
        write: { 'lib-b.ts': B_TS.replace('// bee', '// bee \u00e2\u2020\u2019') },
      },
      'garble',
    );
    expect(proveCommentOnly(dir, { base: first, head: { kind: 'revision', rev: second } })).toEqual(
      {
        compared: 1,
        notCompared: [],
        difference: null,
        mojibake: [{ path: 'lib-b.ts', line: 2, sequence: '\u00e2\u2020' }],
      },
    );
  });

  // git lists a.ts before b.ts, so a.ts's hit is collected before b.ts's code difference.
  it('carries the mojibake found before the first code difference', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.ts'), BASE.replace('Header line one', 'Header \u00c3\u00a9 one'));
    writeFileSync(join(dir, 'b.ts'), B_TS.replace('= 2', '= 4'));
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE })).toMatchObject({
      compared: 2,
      difference: { change: { headPath: 'b.ts' } },
      mojibake: [{ path: 'a.ts', line: 2, sequence: '\u00c3' }],
    });
  });

  it('compares an untracked TypeScript file as added', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'new.ts'), 'export const x = 1;\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE }).difference).toMatchObject({
      change: { basePath: null, headPath: 'new.ts' },
      head: { text: 'export' },
    });
  });

  it('compares a deleted TypeScript file against an empty head', () => {
    const dir = makeRepo();
    rmSync(join(dir, 'b.ts'));
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE })).toEqual({
      compared: 1,
      notCompared: [],
      difference: {
        change: { basePath: 'b.ts', headPath: null },
        base: { kind: ts.SyntaxKind.ExportKeyword, text: 'export', line: 1 },
        head: { kind: ts.SyntaxKind.EndOfFileToken, text: '', line: 1 },
      },
      mojibake: [],
    });
  });

  it('skips an untracked TypeScript file git ignores', () => {
    const dir = makeRepo();
    mkdirSync(join(dir, 'tmp'));
    writeFileSync(join(dir, 'tmp', 'scratch.ts'), 'export const x = 1;\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE })).toEqual({
      compared: 0,
      notCompared: [],
      difference: null,
      mojibake: [],
    });
  });

  it('lists a deleted non-TypeScript file under its base path', () => {
    const dir = makeRepo();
    rmSync(join(dir, 'n.md'));
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE }).notCompared).toEqual(['n.md']);
  });

  it('passes untracked .ts and .mts files holding only comments', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'notes.ts'), '// only\n');
    writeFileSync(join(dir, 'notes.mts'), '// only\n');
    expect(proveCommentOnly(dir, { base: 'HEAD', head: WORKTREE })).toEqual({
      compared: 2,
      notCompared: [],
      difference: null,
      mojibake: [],
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

  it('marks two tokens that read the same as parsed differently', () => {
    const value = { kind: ts.SyntaxKind.Identifier, text: 'value', line: 3 };
    expect(
      formatDifference({
        change: { basePath: 'a.ts', headPath: 'a.ts' },
        base: value,
        head: { ...value, line: 2 },
      }),
    ).toBe('code differs in a.ts: base line 3 `value`, head line 2 `value` (parsed differently)');
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

describe('formatMojibake', () => {
  it('names the file, line and sequence', () => {
    expect(formatMojibake({ path: 'src/a.ts', line: 3, sequence: '\u00e2\u20ac' })).toBe(
      'mojibake at src/a.ts:3: `\u00e2\u20ac`',
    );
  });
});
