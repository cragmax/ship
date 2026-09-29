import { describe, expect, it } from 'vitest';

import { parseShipArgs } from '../../../../tooling/workflows/lib/args.js';
import { MAX_SLICES } from '../../../../tooling/workflows/lib/stages.js';
import { runShip } from '../../../../tooling/workflows/ship.js';

import { fakeHooks } from './_fake-hooks.js';

describe('parseShipArgs — accepted forms', () => {
  it.each([
    [
      'the string form, defaults',
      'epics 1025',
      {
        selection: 'epics',
        numbers: [1025],
        exclude: false,
        preflightOnly: false,
        maxSlices: MAX_SLICES,
      },
    ],
    [
      'the string form, every flag, mixed separators and #',
      '  issues #1045,1046 1047 --exclude --preflight-only --max-slices 2 ',
      {
        selection: 'issues',
        numbers: [1045, 1046, 1047],
        exclude: true,
        preflightOnly: true,
        maxSlices: 2,
      },
    ],
    [
      'the object form, every key',
      { issues: [1045, 7], exclude: true, preflightOnly: true, maxSlices: 3 },
      { selection: 'issues', numbers: [1045, 7], exclude: true, preflightOnly: true, maxSlices: 3 },
    ],
    [
      'the object form, defaults',
      { epics: [1025] },
      {
        selection: 'epics',
        numbers: [1025],
        exclude: false,
        preflightOnly: false,
        maxSlices: MAX_SLICES,
      },
    ],
    [
      'the object form as JSON text',
      '{"epics":[1025,1030],"preflightOnly":true}',
      {
        selection: 'epics',
        numbers: [1025, 1030],
        exclude: false,
        preflightOnly: true,
        maxSlices: MAX_SLICES,
      },
    ],
  ])('parses %s', (_name, raw, args) => {
    expect(parseShipArgs(raw)).toEqual({ args });
  });
});

describe('parseShipArgs — usage refusals', () => {
  it.each([
    ['bare numbers', '1045 1046', /'1045' is not epics or issues \(bare numbers are ambiguous\)/],
    ['an empty string', '   ', /^no arguments/],
    ['undefined', undefined, /^no arguments/],
    ['null', null, /^no arguments/],
    ['an array', ['issues', '1'], /^not an object/],
    ['an unknown flag', 'issues 1 --force', /unknown flag '--force'/],
    ['a zero', 'issues 0', /'0' is not a positive integer/],
    ['a word', 'epics abc', /'abc' is not a positive integer/],
    ['a missing --max-slices value', 'issues 1 --max-slices', /--max-slices: 'undefined'/],
    ['a zero --max-slices', 'issues 1 --max-slices 0', /--max-slices: '0'/],
    ['a repeated number', 'issues 5 6 5', /#5 is given twice/],
    ['no numbers', 'issues --exclude', /no issues numbers/],
    ['both epics and issues', { epics: [1], issues: [2] }, /exactly one of epics and issues/],
    ['neither epics nor issues', { exclude: true }, /exactly one of epics and issues/],
    ['an unknown key', { issues: [1], preflight_only: true }, /unknown key 'preflight_only'/],
    ['a non-boolean flag', { issues: [1], exclude: 'yes' }, /exclude is not a boolean/],
    ['a non-list selection', { issues: 1045 }, /issues is not a list/],
    ['a fractional number', { issues: [1.5] }, /issues: '1.5' is not a positive integer/],
    ['a bad maxSlices', { epics: [1], maxSlices: -1 }, /maxSlices: '-1'/],
    ['invalid JSON text', '{nope', /not valid JSON/],
  ])('refuses %s', (_name, raw, message) => {
    const outcome = parseShipArgs(raw);

    expect(outcome.args).toBeUndefined();
    expect(outcome.refusal?.kind).toBe('usage');
    expect(outcome.refusal?.message).toMatch(message);
  });

  it('ends the run with the usage refusal before any agent call', async () => {
    const run = fakeHooks();

    const report = await runShip(run.hooks, '1045');

    expect(report).toEqual({
      status: 'refused',
      refusals: [{ kind: 'usage', message: expect.stringMatching(/bare numbers/) }],
      dropped: [],
      epics: [],
    });
    expect(run.calls).toEqual([]);
  });
});
