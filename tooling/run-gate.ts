/**
 * Decides whether an unattended run may start and derives its dependency edges (#1031): a shell
 * over the pure core `tooling/lib/run-gate.ts` and its `gh` boundary `tooling/lib/run-gate-gh.ts`.
 * Usage: the `USAGE` line. Numbers may be space- or comma-separated, each with an optional leading
 * `#` — quote a `#N` token. `check N` is the mid-run re-check: OPEN and labelled, never blockers.
 *
 * **Output contract.** stdout carries only the JSON (`GateVerdict` for `epics` / `issues`,
 * `IssueCheck` for `check`), pretty-printed, one trailing newline; diagnostics go to stderr. Exit
 * `0` ok / ready, `1` refused / not ready (read the JSON), `2` a usage, `gh` or schema error
 * (stdout empty, read stderr). Never `process.exit()`: `main` sets `process.exitCode` and
 * returns, so the stdout JSON a caller parses is flushed in full.
 */

import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

import { describeError } from './lib/describe-error.js';
import { gatherAndEvaluate, gatherCheck, type GhJson } from './lib/run-gate-gh.js';
import type { GateMode, GateVerdict, IssueCheck, LaunchSpec } from './lib/run-gate.js';

/** Parsed argv: gate a launch spec, or check one issue. */
export type RunGateArgs =
  | { readonly kind: 'gate'; readonly spec: LaunchSpec; readonly mode: GateMode }
  | { readonly kind: 'check'; readonly issue: number };

const USAGE = 'usage: npx tsx tooling/run-gate.ts epics|issues N... [--exclude] | check N';

/** One parsed issue number and the argv token it came from. */
interface Operand {
  readonly value: number;
  readonly token: string;
}

/**
 * Parse `argv` (everything after `run-gate.ts`).
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns The parsed arguments.
 * @throws On a missing or unknown subcommand, an unknown flag, no numbers, a
 *   token that is not a positive integer, a duplicate number, `--exclude`
 *   with `check`, or `check` with other than one number — each message
 *   naming the offending token.
 */
export function parseRunGateArgs(argv: readonly string[]): RunGateArgs {
  const [command, ...tokens] = argv;
  if (command === undefined) throw usageError('missing subcommand (epics, issues or check)');
  if (command !== 'epics' && command !== 'issues' && command !== 'check') {
    throw usageError(`unknown subcommand '${command}'`);
  }
  const { operands, exclude } = parseOperands(tokens);
  if (operands.length === 0) throw usageError(`no issue numbers after '${command}'`);
  if (command === 'check') return checkArgs(operands, exclude);
  const numbers = operands.map((o) => o.value);
  return {
    kind: 'gate',
    spec:
      command === 'epics' ? { kind: 'epics', epics: numbers } : { kind: 'issues', issues: numbers },
    mode: exclude === undefined ? 'refuse' : 'exclude',
  };
}

/**
 * The process exit code for a verdict or check.
 *
 * @param result - The printed result.
 * @returns `0` for ok / ready, `1` for refused / not ready.
 */
export function exitCodeFor(result: GateVerdict | IssueCheck): number {
  if ('verdict' in result) return result.verdict === 'ok' ? 0 : 1;
  return result.ready ? 0 : 1;
}

/**
 * Split the post-subcommand tokens into numbers and the `--exclude` flag.
 *
 * @throws On an unknown flag, a non-positive-integer piece, or a duplicate.
 */
function parseOperands(tokens: readonly string[]): {
  operands: Operand[];
  exclude: string | undefined;
} {
  const operands: Operand[] = [];
  let exclude: string | undefined;
  for (const token of tokens) {
    if (token.startsWith('--')) exclude = parseFlag(token);
    else for (const value of parseNumberToken(token)) addOperand(operands, { value, token });
  }
  return { operands, exclude };
}

/**
 * Accept the one known flag.
 *
 * @throws When it is not `--exclude`.
 */
function parseFlag(token: string): string {
  if (token !== '--exclude') throw usageError(`unknown flag '${token}'`);
  return token;
}

/**
 * Split one token on commas into issue numbers; empty pieces (`1027,`) are
 * skipped so a comma-then-space list splits cleanly across tokens.
 *
 * @throws When a piece is not a positive integer.
 */
function parseNumberToken(token: string): number[] {
  return token
    .split(',')
    .filter((p) => p !== '')
    .map((piece) => parseIssueNumber(piece, token));
}

/**
 * Append an operand, refusing a repeat.
 *
 * @throws When its number is already present.
 */
function addOperand(operands: Operand[], operand: Operand): void {
  if (operands.some((o) => o.value === operand.value)) {
    throw usageError(`duplicate issue number ${String(operand.value)} in '${operand.token}'`);
  }
  operands.push(operand);
}

/**
 * Parse one number piece (`N` or `#N`).
 *
 * @throws When the piece is not a positive integer.
 */
function parseIssueNumber(piece: string, token: string): number {
  const digits = /^#?(\d+)$/.exec(piece.trim())?.[1];
  const value = digits === undefined ? Number.NaN : Number(digits);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw usageError(`not a positive issue number: '${token}'`);
  }
  return value;
}

/**
 * Build `check` arguments.
 *
 * @throws When `--exclude` is given or there is more than one number.
 */
function checkArgs(operands: readonly Operand[], exclude: string | undefined): RunGateArgs {
  if (exclude !== undefined) throw usageError(`'${exclude}' does not apply to check`);
  const [first, extra] = operands;
  if (extra !== undefined)
    throw usageError(`check takes exactly one issue; extra '${extra.token}'`);
  if (first === undefined) throw usageError('check takes exactly one issue');
  return { kind: 'check', issue: first.value };
}

/** A usage error carrying the usage line. */
function usageError(reason: string): Error {
  return new Error(`run-gate: ${reason}\n${USAGE}`);
}

/**
 * The real {@link GhJson} port: run `gh` and parse its stdout as JSON.
 *
 * @throws When gh fails or times out (60s) — the message carries gh's
 *   stderr, else execa's short message — or prints non-JSON.
 */
async function ghJson(args: readonly string[]): Promise<unknown> {
  const result = await execa('gh', args, { timeout: 60_000, reject: false });
  const command = `gh ${args.join(' ')}`;
  if (result.failed) {
    const detail = result.stderr === '' ? (result.shortMessage ?? 'no output') : result.stderr;
    throw new Error(`run-gate: ${command} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`run-gate: ${command} printed non-JSON output`);
  }
}

/**
 * CLI shell: parse, gather, print, set the exit code (output contract in the
 * file header). Every error lands in the one catch, before stdout is written.
 *
 * @param argv - `process.argv.slice(2)`.
 * @param gh - The `gh` port.
 */
export async function main(argv: readonly string[], gh: GhJson): Promise<void> {
  try {
    const args = parseRunGateArgs(argv);
    const result =
      args.kind === 'check'
        ? await gatherCheck(args.issue, gh)
        : await gatherAndEvaluate(args.spec, args.mode, gh);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 2;
  }
}

// Entry-point guard: run `main()` only when executed as a script, not when
// the unit test imports the argv parser.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2), ghJson);
}
