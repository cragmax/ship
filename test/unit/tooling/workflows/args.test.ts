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
        attach: null,
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
        attach: null,
      },
    ],
    [
      'the object form, every key',
      { issues: [1045, 7], exclude: true, preflightOnly: true, maxSlices: 3 },
      {
        selection: 'issues',
        numbers: [1045, 7],
        exclude: true,
        preflightOnly: true,
        maxSlices: 3,
        attach: null,
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
        attach: null,
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
        attach: null,
      },
    ],
    [
      'the string form with --attach',
      'issues 1190 1191 --attach ship/epic-1182',
      {
        selection: 'issues',
        numbers: [1190, 1191],
        exclude: false,
        preflightOnly: false,
        maxSlices: MAX_SLICES,
        attach: 'ship/epic-1182',
      },
    ],
    [
      'the object form with attach',
      { issues: [1190], attach: 'ship/1183-1184' },
      {
        selection: 'issues',
        numbers: [1190],
        exclude: false,
        preflightOnly: false,
        maxSlices: MAX_SLICES,
        attach: 'ship/1183-1184',
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
    [
      '--attach with epics',
      'epics 1182 --attach ship/epic-1182',
      /--attach takes issues, not epics/,
    ],
    [
      'attach with epics in the object form',
      { epics: [1182], attach: 'ship/epic-1182' },
      /--attach takes issues, not epics/,
    ],
    [
      'a non-ship/ --attach branch',
      'issues 7 --attach feature/x',
      /--attach: 'feature\/x' is not a ship\/ run branch/,
    ],
    [
      'a missing --attach value',
      'issues 7 --attach',
      /--attach: 'undefined' is not a ship\/ run branch/,
    ],
    [
      'an uppercase --attach branch',
      'issues 7 --attach ship/Epic-9',
      /--attach: 'ship\/Epic-9' is not a ship\/ run branch/,
    ],
    ['a non-string attach', { issues: [7], attach: 9 }, /attach: '9' is not a ship\/ run branch/],
  ])('refuses %s', (_name, raw, message) => {
    const outcome = parseShipArgs(raw);

    expect(outcome.args).toBeUndefined();
    expect(outcome.refusal?.kind).toBe('usage');
    expect(outcome.refusal?.message).toMatch(message);
  });

  it('ends a usage refusal with the expected forms, --attach among them', () => {
    expect(parseShipArgs('issues').refusal?.message).toBe(
      'no issues numbers; expected epics|issues N... [--exclude] [--preflight-only] [--max-slices K] [--attach ship/<slug>]',
    );
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
