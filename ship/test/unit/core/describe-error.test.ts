import { describe, it, expect } from 'vitest';

import { describeError } from '../../../src/core/describe-error.js';

describe('describeError', () => {
  it('gives an errno error its message and code', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25575'), {
      code: 'ECONNREFUSED',
    });

    expect(describeError(refused)).toBe('connect ECONNREFUSED 127.0.0.1:25575 [ECONNREFUSED]');
  });

  it('gives a plain error its message alone', () => {
    expect(describeError(new Error('Authentication failed'))).toBe('Authentication failed');
  });

  it('stringifies anything else', () => {
    expect(describeError('timeout')).toBe('timeout');
    expect(describeError(42)).toBe('42');
  });
});
