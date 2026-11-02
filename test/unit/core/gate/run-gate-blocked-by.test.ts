import { describe, it, expect } from 'vitest';

import { parseBlockedBySection } from '../../../../src/core/gate/run-gate-blocked-by.js';

describe('parseBlockedBySection — list-item forms', () => {
  it.each([
    ['- #1031 (declares the run set)', [1031]],
    ['- `#968` (Slice B — the lease wrapper)', [968]],
    ['- **#942** (PRD A — pool registry)', [942]],
    ['- #1026, #1027', [1026, 1027]],
    ['- #1026 & #1027', [1026, 1027]],
    ['- #1026 and #1027', [1026, 1027]],
    ['* #12', [12]],
    ['+ #13', [13]],
    ['1. #5', [5]],
    ['   - #44 (indented)', [44]],
  ])('%s', (line, expected) => {
    expect(parseBlockedBySection(section(line))).toEqual(expected);
  });
});

function section(...lines: string[]): string {
  return ['## Parent', '', '- #1025', '', '## Blocked by', '', ...lines, ''].join('\n');
}

// regression: real issue bodies declare blockers with no list marker.
describe('parseBlockedBySection — marker-less lines', () => {
  it.each([
    ['#617 — depends on Slice 1 establishing `test/unit/tooling/manifest.test.ts`.', [617]],
    ['#519.', [519]],
  ])('%s', (line, expected) => {
    expect(parseBlockedBySection(section(line))).toEqual(expected);
  });
});

describe('parseBlockedBySection — ignored lines', () => {
  it.each([
    'None — can start immediately.',
    'None - can start immediately. (#708, importable run-integration, is Related…)',
    'Soft dependency on #901',
    'NOT blocked by #902',
    'Runs in parallel with #903',
    '- Enhanced by #904 (reset-on-acquire)',
  ])('%s', (line) => {
    expect(parseBlockedBySection(section(line))).toEqual([]);
  });

  it('keeps only the leading ref run, not refs in a trailing parenthetical', () => {
    expect(
      parseBlockedBySection(section('- #1030 (both edit CLAUDE.md; #1027 is after #1028)')),
    ).toEqual([1030]);
  });
});

describe('parseBlockedBySection — section bounds', () => {
  it('stops at the next heading', () => {
    const body = ['## Blocked by', '', '- #10', '', '## Parent', '', '- #1025', ''].join('\n');
    expect(parseBlockedBySection(body)).toEqual([10]);
  });

  it('stops at a <details> block', () => {
    const body = [
      '## Blocked by',
      '',
      '- #10',
      '',
      '<details><summary>Original report</summary>',
      '',
      '- #77',
      '',
      '</details>',
    ].join('\n');

    expect(parseBlockedBySection(body)).toEqual([10]);
  });

  it('returns [] when there is no section', () => {
    expect(parseBlockedBySection('## What to build\n\n- #10 is related\n')).toEqual([]);
  });

  it('parses a CRLF body', () => {
    expect(parseBlockedBySection('## Blocked by\r\n\r\n- #10\r\n- #11\r\n')).toEqual([10, 11]);
  });

  it('matches the heading case-insensitively with trailing whitespace', () => {
    expect(parseBlockedBySection('### Blocked By   \n\n- #10\n')).toEqual([10]);
  });

  it('unions two sections', () => {
    const body = ['## Blocked by', '- #20', '## Notes', '- #30', '## Blocked by', '- #10'].join(
      '\n',
    );

    expect(parseBlockedBySection(body)).toEqual([10, 20]);
  });
});

describe('parseBlockedBySection — result shape', () => {
  it('collapses duplicates and sorts ascending', () => {
    expect(parseBlockedBySection(section('- #30, #10', '- #10', '- #20, #30'))).toEqual([
      10, 20, 30,
    ]);
  });
});
