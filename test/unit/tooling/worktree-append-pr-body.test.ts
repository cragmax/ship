import { describe, expect, it } from 'vitest';

import { appendSection } from '../../../tooling/worktree/append-pr-body.js';

const S1 = '## Attached run 1\n\n### Issues\n\n- fixes #8 — x\n';
const S2 = '## Attached run 2\n\n### Issues\n\n- fixes #9 — z\n';
// Trailing spaces, a closing keyword and a fold: what a byte-for-byte prefix must keep.
const B1 =
  '## Summary\n\nAdds x — fixes #3.  \n\n<details><summary>Run report</summary>\n\n## Landed issues\n\n</details>\n';

describe('appendSection', () => {
  it.each([
    { name: 'a body ending in a newline', body: B1, expected: `${B1}\n${S1}` },
    {
      name: 'a body without its final newline',
      body: '## Summary\n\nx',
      expected: `## Summary\n\nx\n\n${S1}`,
    },
    {
      name: 'a CRLF body',
      body: '## Summary\r\n\r\nx\r\n',
      expected: `## Summary\r\n\r\nx\r\n\n${S1}`,
    },
    { name: 'an empty body', body: '', expected: S1 },
  ])('appends after $name, the body kept byte for byte', ({ body, expected }) => {
    expect(appendSection(body, S1)).toBe(expected);
  });

  it('appends a second attached run’s section after the first', () => {
    const twice = appendSection(appendSection(B1, S1), S2);

    expect(twice).toBe(`${B1}\n${S1}\n${S2}`);
    expect(twice.split('\n').filter((l) => l.startsWith('## Attached run '))).toEqual([
      '## Attached run 1',
      '## Attached run 2',
    ]);
  });
});
