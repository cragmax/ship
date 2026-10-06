/**
 * The `ship` workflow's launch arguments. `args` is whatever the launching
 * Workflow call passed, verbatim — and the main-loop model writes that call,
 * not the user (a string in the pilot: observed 2026-09-29, #1035). Two
 * shapes are accepted — the object (also as its JSON text) and the string,
 * its numbers space- or comma-separated, each with an optional leading `#`:
 *
 * ```
 * { epics | issues, exclude?, preflightOnly?, maxSlices?, attach? }
 * epics|issues N... [--exclude] [--preflight-only] [--max-slices K] [--attach ship/<slug>]
 * ```
 *
 * Bare numbers are refused — epic or issue would be a guess — and so is
 * any unknown key or flag: a typo must never launch a full run. A usage
 * error is returned as a refusal, never thrown.
 *
 * `--attach` (`attach`) names an attached run's target: an open PR's run
 * branch, of the `/resync` shape ({@link RUN_BRANCH_SHAPE}). It takes
 * `issues` only — `epics` with it is refused.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { ShipRefusal } from './preflight.js';
import { RUN_BRANCH_SHAPE } from './run-branch.js';
import { MAX_SLICES } from './stages.js';

/** What a run ships: whole epics, or an explicit issue list. */
export type Selection = 'epics' | 'issues';

/** The parsed launch arguments. */
export interface ShipArgs {
  /** Epics or issues. */
  readonly selection: Selection;
  /** The epic or issue numbers, in launch order, distinct. */
  readonly numbers: readonly number[];
  /** Drop failing issues and their dependents instead of refusing. */
  readonly exclude: boolean;
  /** Stop after pre-flight. */
  readonly preflightOnly: boolean;
  /** The most issues in flight at once, from start until settled; default `MAX_SLICES`. */
  readonly maxSlices: number;
  /** The open PR's run branch an attached run lands on; `null` for an unattached run. */
  readonly attach: string | null;
}

/** The parse's outcome: the arguments, or the usage refusal. */
export type ArgsOutcome =
  | { readonly args: ShipArgs; readonly refusal?: never }
  | { readonly refusal: ShipRefusal; readonly args?: never };

/** The keys the object shape accepts. */
const ARG_KEYS = ['epics', 'issues', 'exclude', 'preflightOnly', 'maxSlices', 'attach'];

/** A usage error while parsing; caught by {@link parseShipArgs}. */
class ArgsError extends Error {}

/**
 * Parse the launch arguments.
 *
 * @param raw - `args` as the runtime passed it.
 * @returns The arguments, or a `usage` refusal naming the problem.
 */
export function parseShipArgs(raw: unknown): ArgsOutcome {
  try {
    return { args: typeof raw === 'string' ? parseText(raw) : parseObject(raw) };
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    return {
      refusal: {
        kind: 'usage',
        message: `${err.message}; expected epics|issues N... [--exclude] [--preflight-only] [--max-slices K] [--attach ship/<slug>]`,
      },
    };
  }
}

/**
 * Parse the string shape, or the object shape's JSON text.
 *
 * @param text - The launch text.
 * @returns The arguments.
 * @throws {@link ArgsError}on a usage error.
 */
function parseText(text: string): ShipArgs {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return parseObject(parseJson(trimmed));
  const [first, ...rest] = trimmed.split(/\s+/);
  return validated({ selection: selectionWord(first), ...parseTokens(rest) });
}

/**
 * The string shape's first word.
 *
 * @param word - The word; `undefined` or empty for no arguments.
 * @returns The selection.
 * @throws {@link ArgsError}when it is neither `epics` nor `issues`.
 */
function selectionWord(word: string | undefined): Selection {
  if (word === 'epics' || word === 'issues') return word;
  throw new ArgsError(
    word === undefined || word === ''
      ? 'no arguments'
      : `'${word}' is not epics or issues (bare numbers are ambiguous)`,
  );
}

/**
 * The string shape's words after the selection: numbers and flags.
 *
 * @param tokens - The words.
 * @returns Everything but the selection.
 * @throws {@link ArgsError}on an unknown flag or a bad number.
 */
function parseTokens(tokens: readonly string[]): Omit<ShipArgs, 'selection'> {
  const numbers: number[] = [];
  const args: { -readonly [K in keyof Omit<ShipArgs, 'selection'>]: ShipArgs[K] } = {
    numbers,
    exclude: false,
    preflightOnly: false,
    maxSlices: MAX_SLICES,
    attach: null,
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    switch (token) {
      case '--exclude':
        args.exclude = true;
        break;
      case '--preflight-only':
        args.preflightOnly = true;
        break;
      case '--max-slices':
        args.maxSlices = positiveInteger(tokens[++i], '--max-slices');
        break;
      case '--attach':
        args.attach = attachTarget(tokens[++i], '--attach');
        break;
      default:
        numbers.push(...numberList(token));
    }
  }
  return args;
}

/**
 * Parse the object shape.
 *
 * @param raw - The object.
 * @returns The arguments.
 * @throws {@link ArgsError}on a usage error.
 */
function parseObject(raw: unknown): ShipArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ArgsError(raw === undefined || raw === null ? 'no arguments' : 'not an object');
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const unknownKey = Object.keys(record).find((key) => !ARG_KEYS.includes(key));
  if (unknownKey !== undefined) throw new ArgsError(`unknown key '${unknownKey}'`);
  const hasEpics = Object.hasOwn(record, 'epics');
  if (hasEpics === Object.hasOwn(record, 'issues')) {
    throw new ArgsError('give exactly one of epics and issues');
  }
  const selection: Selection = hasEpics ? 'epics' : 'issues';
  const list = record[selection];
  if (!Array.isArray(list)) throw new ArgsError(`${selection} is not a list`);
  return validated({
    selection,
    numbers: list.map((n: unknown) => positiveInteger(n, selection)),
    exclude: flag(record, 'exclude'),
    preflightOnly: flag(record, 'preflightOnly'),
    maxSlices: optionalKey(record, 'maxSlices', positiveInteger, MAX_SLICES),
    attach: optionalKey<string | null>(record, 'attach', attachTarget, null),
  });
}

/**
 * An optional key, read when present.
 *
 * @param record - The object.
 * @param key - The key, also the name `read` reports.
 * @param read - Reads a present value; throws on a bad one.
 * @param absent - The value when the key is absent.
 * @returns `read`'s value, or `absent`.
 */
function optionalKey<T>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  read: (value: unknown, what: string) => T,
  absent: T,
): T {
  const value = record[key];
  return value === undefined ? absent : read(value, key);
}

/**
 * Parse JSON text.
 *
 * @param text - The text.
 * @returns The value.
 * @throws {@link ArgsError}when it is not JSON.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ArgsError('not valid JSON');
  }
}

/**
 * One token's numbers: comma-separated, each with an optional leading `#`.
 *
 * @param token - The token.
 * @returns The numbers.
 * @throws {@link ArgsError}on a `--` flag (every known flag is handled before), or
 *   on a piece that is not a positive integer.
 */
function numberList(token: string): number[] {
  if (token.startsWith('--')) throw new ArgsError(`unknown flag '${token}'`);
  return token
    .split(',')
    .filter((piece) => piece !== '')
    .map((piece) => positiveInteger(piece.replace(/^#/, ''), piece));
}

/**
 * A positive integer, from a number or its decimal text.
 *
 * @param value - The value.
 * @param what - What it is, for the message.
 * @returns The integer.
 * @throws {@link ArgsError}when it is not one.
 */
function positiveInteger(value: unknown, what: string): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new ArgsError(`${what}: '${String(value)}' is not a positive integer`);
  }
  return n;
}

/**
 * An attached run's target branch.
 *
 * @param value - The value given.
 * @param what - The flag or key, for the message.
 * @returns The branch.
 * @throws {@link ArgsError}when it is not a `ship/` run branch.
 */
function attachTarget(value: unknown, what: string): string {
  if (typeof value !== 'string' || !RUN_BRANCH_SHAPE.test(value)) {
    throw new ArgsError(`${what}: '${String(value)}' is not a ship/ run branch`);
  }
  return value;
}

/**
 * An optional boolean key.
 *
 * @param record - The object.
 * @param key - The key.
 * @returns Its value; `false` when absent.
 * @throws {@link ArgsError}when present and not a boolean.
 */
function flag(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new ArgsError(`${key} is not a boolean`);
  return value;
}

/**
 * Check the run-wide rules: at least one number, none twice, and an
 * attached run ships issues, never epics.
 *
 * @param args - The parsed arguments.
 * @returns `args`.
 * @throws {@link ArgsError}when a rule fails.
 */
function validated(args: ShipArgs): ShipArgs {
  if (args.numbers.length === 0) throw new ArgsError(`no ${args.selection} numbers`);
  const twice = args.numbers.find((n, i) => args.numbers.indexOf(n) !== i);
  if (twice !== undefined) throw new ArgsError(`#${String(twice)} is given twice`);
  if (args.attach !== null && args.selection === 'epics') {
    throw new ArgsError('--attach takes issues, not epics');
  }
  return args;
}
