/**
 * The `resync` workflow's launch arguments: the open run branch, as
 * `args` passed it verbatim — a one-word string, the object `{ branch }`,
 * or that object's JSON text. Anything else is refused, never guessed: an
 * extra word or key must never launch a merge and push.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import { RUN_BRANCH_SHAPE } from './run-branch.js';

/** The parse's outcome: the branch, or why the arguments are refused. */
export type ResyncArgsOutcome =
  | { readonly branch: string; readonly refusal?: never }
  | { readonly refusal: string; readonly branch?: never };

/** What a usage refusal ends with. */
const RESYNC_USAGE = 'expected the open run branch ship/<slug>, or { branch }';

/**
 * Parse the launch arguments.
 *
 * @param raw - `args` as the runtime passed it.
 * @returns The branch, or a refusal naming the problem.
 */
export function parseResyncArgs(raw: unknown): ResyncArgsOutcome {
  const branch = resyncBranchOf(raw);
  if (typeof branch !== 'string') return { refusal: `${branch.problem}; ${RESYNC_USAGE}` };
  if (!RUN_BRANCH_SHAPE.test(branch)) {
    return { refusal: `'${branch}' is not a ship/ run branch; ${RESYNC_USAGE}` };
  }
  return { branch };
}

/**
 * The branch the arguments name, before its shape is checked.
 *
 * @param raw - `args` as the runtime passed it.
 * @returns The branch text, or the problem.
 */
function resyncBranchOf(raw: unknown): string | { readonly problem: string } {
  return typeof raw === 'string' ? resyncBranchOfText(raw.trim()) : resyncBranchOfObject(raw);
}

/**
 * The string shape's branch: one word, or the object shape's JSON text.
 *
 * @param text - The launch text, trimmed.
 * @returns The branch, or the problem.
 */
function resyncBranchOfText(text: string): string | { readonly problem: string } {
  if (text.startsWith('{')) {
    const parsed = resyncJson(text);
    return parsed === null ? { problem: 'not valid JSON' } : resyncBranchOfObject(parsed.value);
  }
  const words = text.split(/\s+/).filter((word) => word !== '');
  if (words.length === 1) return words[0] ?? '';
  return { problem: words.length === 0 ? 'no arguments' : 'more than one word' };
}

/**
 * The object shape's branch.
 *
 * @param raw - The parsed object, or anything else.
 * @returns The branch, or the problem.
 */
function resyncBranchOfObject(raw: unknown): string | { readonly problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: raw === undefined || raw === null ? 'no arguments' : 'not an object' };
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const extra = Object.keys(record).find((key) => key !== 'branch');
  if (extra !== undefined) return { problem: `unknown key '${extra}'` };
  const branch = record['branch'];
  return typeof branch === 'string' ? branch : { problem: 'branch is not a string' };
}

/** Parse JSON text: the value, boxed; `null` when it is not JSON. */
function resyncJson(text: string): { readonly value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}
