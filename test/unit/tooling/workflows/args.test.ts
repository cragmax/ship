import { describe, expect, it } from 'vitest';

import { parseShipArgs } from '../../../../tooling/workflows/lib/args.js';
import { DEFAULT_PR_REVIEW_LEVEL, MAX_SLICES } from '../../../../tooling/workflows/lib/stages.js';
import { SHIP_META } from '../../../../tooling/workflows/ship.meta.js';
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
        prReview: DEFAULT_PR_REVIEW_LEVEL,
      },
    ],
    [
      'the string form, every flag, mixed separators and #',
      '  issues #1045,1046 1047 --exclude --preflight-only --max-slices 2 --pr-review max ',
      {
        selection: 'issues',
        numbers: [1045, 1046, 1047],
        exclude: true,
        preflightOnly: true,
        maxSlices: 2,
        prReview: 'max',
      },
    ],
    [
      'the object form, every key',
      { issues: [1045, 7], exclude: true, preflightOnly: true, maxSlices: 3, prReview: 'off' },
      {
        selection: 'issues',
        numbers: [1045, 7],
        exclude: true,
        preflightOnly: true,
        maxSlices: 3,
        prReview: 'off',
      },
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
        prReview: DEFAULT_PR_REVIEW_LEVEL,
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
        prReview: DEFAULT_PR_REVIEW_LEVEL,
      },
    ],
    [
      'the string form, --pr-review xhigh',
      'epics 1 --pr-review xhigh',
      {
        selection: 'epics',
        numbers: [1],
        exclude: false,
        preflightOnly: false,
        maxSlices: MAX_SLICES,
        prReview: 'xhigh',
      },
    ],
    [
      'the object form, prReview max',
      { epics: [1], prReview: 'max' },
      {
        selection: 'epics',
        numbers: [1],
        exclude: false,
        preflightOnly: false,
        maxSlices: MAX_SLICES,
        prReview: 'max',
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
    ['--pr-review low', 'issues 1 --pr-review low', /--pr-review: 'low' is not off, xhigh or max/],
    [
      '--pr-review medium',
      'issues 1 --pr-review medium',
      /--pr-review: 'medium' is not off, xhigh or max/,
    ],
    [
      '--pr-review high',
      'issues 1 --pr-review high',
      /--pr-review: 'high' is not off, xhigh or max/,
    ],
    [
      '--pr-review ultra',
      'issues 1 --pr-review ultra',
      /--pr-review: 'ultra' is not off, xhigh or max/,
    ],
    [
      '--pr-review in capitals',
      'issues 1 --pr-review XHIGH',
      /--pr-review: 'XHIGH' is not off, xhigh or max/,
    ],
    [
      'a missing --pr-review value',
      'issues 1 --pr-review',
      /--pr-review: 'undefined' is not off, xhigh or max/,
    ],
    [
      'a bad prReview',
      { issues: [1], prReview: 'ultra' },
      /prReview: 'ultra' is not off, xhigh or max/,
    ],
    [
      'a boolean prReview',
      { issues: [1], prReview: true },
      /prReview: 'true' is not off, xhigh or max/,
    ],
  ])('refuses %s', (_name, raw, message) => {
    const outcome = parseShipArgs(raw);

    expect(outcome.args).toBeUndefined();
    expect(outcome.refusal?.kind).toBe('usage');
    expect(outcome.refusal?.message).toMatch(message);
  });

  it('ends every usage refusal with the accepted shape', () => {
    expect(
      parseShipArgs('1045').refusal?.message.endsWith(
        '; expected epics|issues N... [--exclude] [--preflight-only] [--max-slices K] [--pr-review off|xhigh|max]',
      ),
    ).toBe(true);
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

describe('the launch help', () => {
  it('names the --pr-review argument, its default and its object key', () => {
    expect(SHIP_META.whenToUse).toContain('`--pr-review off|xhigh|max`');
    expect(SHIP_META.whenToUse).toContain('default xhigh');
    expect(SHIP_META.whenToUse).toContain('prReview?');
  });
});
