import { describe, expect, it } from 'vitest';

import {
  bumpVersion,
  readVersionLine,
  setVersionLine,
  targetVersion,
  versionDelta,
} from '../../../tooling/worktree/package-version.js';
import { StepFailure } from '../../../tooling/worktree/types.js';

/** The step a throwing call's `StepFailure` names; `null` when it does not throw one. */
function failedStep(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    return err instanceof StepFailure ? err.step : null;
  }
  return null;
}

describe('versionDelta', () => {
  it.each([
    ['1.2.3', 'none'],
    ['1.2.4', 'patch'],
    ['1.3.0', 'minor'],
    ['2.0.0', 'major'],
  ])('reads 1.2.3 -> %s as %s', (to, delta) => {
    expect(versionDelta('1.2.3', to)).toBe(delta);
  });
});

describe('bumpVersion', () => {
  it('resets the lower components', () => {
    expect(bumpVersion('1.2.9', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.9.9', 'major')).toBe('2.0.0');
  });

  it.each(['1.2.3-rc.1', 'x'])('throws StepFailure version for %s', (version) => {
    expect(failedStep(() => bumpVersion(version, 'patch'))).toBe('version');
  });
});

describe('targetVersion', () => {
  it.each([
    [{ base: '1.2.3', ours: '1.2.4', theirs: '1.3.0' }, '1.3.1'],
    [{ base: '1.2.3', ours: '1.2.4', theirs: '1.2.4' }, '1.2.5'],
    [{ base: '1.2.3', ours: '1.2.3', theirs: '1.2.4' }, '1.2.4'],
    [{ base: '1.2.3', ours: '1.3.0', theirs: '1.2.3' }, '1.3.0'],
  ])('gives %o the version %s', (versions, result) => {
    expect(targetVersion(versions)).toBe(result);
  });
});

describe('setVersionLine and readVersionLine', () => {
  it('rewrites the top-level line with its trailing comma', () => {
    const text = '{\n  "name": "p",\n  "version": "1.0.0",\n  "private": true\n}\n';

    expect(setVersionLine(text, '2.0.0')).toBe(
      '{\n  "name": "p",\n  "version": "2.0.0",\n  "private": true\n}\n',
    );
  });

  it('rewrites a last line without a comma, keeping CRLF', () => {
    const text = '{\r\n  "name": "p",\r\n  "version": "1.0.0"\r\n}\r\n';

    expect(setVersionLine(text, '1.0.1')).toBe(
      '{\r\n  "name": "p",\r\n  "version": "1.0.1"\r\n}\r\n',
    );
  });

  it('leaves a nested version line untouched', () => {
    const text =
      '{\n  "version": "1.0.0",\n  "packages": {\n    "": {\n      "version": "1.0.0"\n    }\n  }\n}\n';

    expect(setVersionLine(text, '3.0.0')).toBe(
      '{\n  "version": "3.0.0",\n  "packages": {\n    "": {\n      "version": "1.0.0"\n    }\n  }\n}\n',
    );
  });

  it.each([
    ['no top-level line', '{\n  "name": "p"\n}\n'],
    ['two top-level lines', '{\n  "version": "1.0.0",\n  "version": "1.0.1"\n}\n'],
  ])('throws StepFailure version for %s', (_name, text) => {
    expect(failedStep(() => setVersionLine(text, '1.0.0'))).toBe('version');
  });

  it('reads the top-level version, and null without one', () => {
    const nested = '{\n  "a": {\n      "version": "9.9.9"\n  },\n  "version": "1.2.3"\n}\n';

    expect(readVersionLine(nested)).toBe('1.2.3');
    expect(readVersionLine('{\n  "name": "p"\n}\n')).toBeNull();
  });
});
