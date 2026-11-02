/** The render-safety check for a source file the workflow render copies verbatim. */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { describe, it, expect } from 'vitest';

/** `source` with its block and line comments removed. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Declares the `<file name> render safety` suite: the file at `path` has no import or re-export
 * and never uses a token that reaches outside a pure function.
 *
 * @remarks The file is read as text, as the render step copies its source. Comments are stripped
 * first so its header TSDoc may name the forbidden tokens.
 */
export function describeRenderSafety(path: string): void {
  describe(`${basename(path)} render safety`, () => {
    const code = stripComments(readFileSync(path, 'utf8'));

    it('has no import statement or re-export', () => {
      const lines = code.split('\n').map((line) => line.trim());
      expect(lines.filter((line) => /^import\b/.test(line))).toEqual([]);
      expect(code).not.toMatch(/\bimport\s*\(/);
      expect(code).not.toMatch(/\bfrom\s*['"]/);
    });

    it.each([
      'eval(',
      'new Function',
      'Date.now',
      'new Date(',
      'Math.random',
      'process.',
      'Buffer',
      'require(',
      'setTimeout',
      'setImmediate',
      'globalThis',
      '__dirname',
    ])('never uses %s', (token) => {
      expect(code).not.toContain(token);
    });
  });
}
