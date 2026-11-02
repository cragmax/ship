import { describe, expect, it } from 'vitest';

import { sortedSet } from '../../../src/core/strings.js';

describe('sortedSet', () => {
  it('drops repeats and sorts by code unit, upper case before lower', () => {
    expect(sortedSet(['b.ts', 'a.ts', 'B.ts', 'b.ts', 'a.ts'])).toEqual(['B.ts', 'a.ts', 'b.ts']);
  });
});
