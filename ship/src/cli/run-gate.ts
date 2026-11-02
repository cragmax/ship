/**
 * Decides whether an unattended run may start and derives its dependency edges: a shell over
 * the pure core `ship/src/core/gate/run-gate.ts` and its `gh` boundary
 * `ship/src/cli/run-gate-gh.ts`.
 * Usage: the `USAGE` line. Numbers may be space- or comma-separated, each with an optional leading
 * `#`. Quote a `#N` token. `check N` is the mid-run re-check: OPEN and labelled, never blockers.
 *
 * **Output contract.** stdout carries only the JSON (`GateVerdict` for `epics` / `issues`,
 * `IssueCheck` for `check`), pretty-printed, one trailing newline. Diagnostics go to stderr. Exit
 * `0` ok / ready, `1` refused / not ready (read the JSON), `2` a usage, `gh`, git or schema error
 * (stdout empty, read stderr). Never `process.exit()`: `main` sets `process.exitCode` and
 * returns, so the stdout JSON a caller parses is flushed in full.
 */

import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

import { describeError } from '../core/describe-error.js';
import { gitFreeEnv } from './git/exec.js';
import { gatherAndEvaluate, gatherCheck, type GhJson, type GitText } from './run-gate-gh.js';
import type { GateMode, GateVerdict, IssueCheck, LaunchSpec } from '../core/gate/run-gate.js';

/** Parsed argv: gate a launch spec, or check one issue. */
type RunGateArgs =
  | {
      readonly kind: 'gate';
      readonly spec: LaunchSpec;
      readonly mode: GateMode;
      /** An attached run's target, `ship/<slug>` (Ship ADR-0001 decision 16). Absent otherwise. */
      readonly attach?: string;
    }
  | { readonly kind: 'check'; readonly issue: number };

const USAGE =
  'usage: npx tsx ship/src/cli/run-gate.ts epics|issues N... [--exclude] [--attach ship/<slug>] | check N';

/** The flags after the subcommand: each the token it came from, or the attach target. */
interface Flags {
  readonly exclude: string | undefined;
  readonly attach: string | undefined;
}

/** One parsed issue number and the argv token it came from. */
interface Operand {
  readonly value: number;
  readonly token: string;
}

/**
 * Parse `argv` (everything after `run-gate.ts`).
 *
 * @throws On a missing or unknown subcommand, an unknown flag, no numbers, a
 *   token that is not a positive integer, a duplicate number, `--attach`
 *   without a `ship/<slug>` value, `--exclude` or `--attach` with `check`,
 *   or `check` with other than one number, each message naming the
 *   offending token.
 */
export function parseRunGateArgs(argv: readonly string[]): RunGateArgs {
  const [command, ...tokens] = argv;
  if (command === undefined) throw usageError('missing subcommand (epics, issues or check)');

  if (command !== 'epics' && command !== 'issues' && command !== 'check') {
    throw usageError(`unknown subcommand '${command}'`);
  }

  const { operands, flags } = parseOperands(tokens);
  if (operands.length === 0) throw usageError(`no issue numbers after '${command}'`);
  if (command === 'check') return checkArgs(operands, flags);
  const numbers = operands.map((o) => o.value);

  return {
    kind: 'gate',
    spec:
      command === 'epics' ? { kind: 'epics', epics: numbers } : { kind: 'issues', issues: numbers },
    mode: flags.exclude === undefined ? 'refuse' : 'exclude',
    ...(flags.attach === undefined ? {} : { attach: flags.attach }),
  };
}

/**
 * The process exit code for a verdict or check.
 *
 * @returns `0` for ok / ready, `1` for refused / not ready.
 */
export function exitCodeFor(result: GateVerdict | IssueCheck): number {
  if ('verdict' in result) return result.verdict === 'ok' ? 0 : 1;

  return result.ready ? 0 : 1;
}

/**
 * CLI shell: parse, gather, print, set the exit code (output contract in the
 * file header). Every error lands in the one catch, before stdout is written.
 *
 * @param argv - `process.argv.slice(2)`.
 * @param git - The git port an attached run's landed set is read through.
 */
export async function main(
  argv: readonly string[],
  gh: GhJson,
  git: GitText = gitIn(process.cwd()),
): Promise<void> {
  try {
    const args = parseRunGateArgs(argv);
    const attach =
      args.kind === 'gate' && args.attach !== undefined ? { branch: args.attach, git } : undefined;
    const result =
      args.kind === 'check'
        ? await gatherCheck(args.issue, gh)
        : await gatherAndEvaluate(args.spec, args.mode, gh, attach);

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCodeFor(result);
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 2;
  }
}

/**
 * The real {@link GitText} port: run `git` in `cwd` under {@link gitFreeEnv}, and resolve its
 * stdout.
 *
 * @throws When git fails or times out (60s). The message carries git's stderr, else execa's
 *   short message.
 */
export function gitIn(cwd: string): GitText {
  return (args) => captured('git', args, { cwd, env: gitFreeEnv() });
}

/**
 * The real {@link GhJson} port: run `gh` and parse its stdout as JSON.
 *
 * @throws When gh fails or times out (60s), the message carrying gh's
 *   stderr, else execa's short message, or prints non-JSON.
 */
async function ghJson(args: readonly string[]): Promise<unknown> {
  const stdout = await captured('gh', args);

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`run-gate: gh ${args.join(' ')} printed non-JSON output`);
  }
}

/**
 * Run `<file> <args…>` and resolve its stdout. A given `env` replaces this process's environment
 * rather than extending it.
 *
 * @throws When it fails or times out (60s), carrying its stderr, else execa's short message.
 */
async function captured(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const result = await execa(file, args, {
    timeout: 60_000,
    reject: false,
    ...options,
    extendEnv: options.env === undefined,
  });

  if (result.failed) {
    const detail = result.stderr === '' ? (result.shortMessage ?? 'no output') : result.stderr;

    throw new Error(`run-gate: ${file} ${args.join(' ')} failed: ${detail}`);
  }

  return result.stdout;
}

/** A usage error carrying the usage line. */
function usageError(reason: string): Error {
  return new Error(`run-gate: ${reason}\n${USAGE}`);
}

/**
 * Build `check` arguments.
 *
 * @throws When `--exclude` or `--attach` is given or there is more than one number.
 */
function checkArgs(operands: readonly Operand[], flags: Flags): RunGateArgs {
  if (flags.exclude !== undefined) throw usageError(`'${flags.exclude}' does not apply to check`);
  if (flags.attach !== undefined) throw usageError(`'--attach' does not apply to check`);
  const [first, extra] = operands;
  if (extra !== undefined)
    throw usageError(`check takes exactly one issue; extra '${extra.token}'`);
  if (first === undefined) throw usageError('check takes exactly one issue');

  return { kind: 'check', issue: first.value };
}

/**
 * Split the post-subcommand tokens into numbers and the flags.
 *
 * @throws On an unknown flag, `--attach` without a `ship/<slug>` value, a non-positive-integer
 *   piece, or a duplicate.
 */
function parseOperands(tokens: readonly string[]): { operands: Operand[]; flags: Flags } {
  const operands: Operand[] = [];
  let exclude: string | undefined;
  let attach: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (token === '--attach') attach = parseAttach(tokens[++i]);
    else if (token.startsWith('--')) exclude = parseFlag(token);
    else for (const value of parseNumberToken(token)) addOperand(operands, { value, token });
  }

  return { operands, flags: { exclude, attach } };
}

/**
 * The value after `--attach`.
 *
 * @throws When it is missing or not `ship/<slug>`.
 */
function parseAttach(value: string | undefined): string {
  if (value === undefined) throw usageError(`'--attach' needs a ship/<slug> value`);
  if (!/^ship\/[^/\s]+$/.test(value))
    throw usageError(`'--attach' takes ship/<slug>, not '${value}'`);

  return value;
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
 * Split one token on commas into issue numbers. Empty pieces (`1027,`) are
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
 * Accept the one known value-less flag.
 *
 * @throws When it is not `--exclude`.
 */
function parseFlag(token: string): string {
  if (token !== '--exclude') throw usageError(`unknown flag '${token}'`);

  return token;
}

// Entry-point guard: run `main()` only when executed as a script, not when
// the unit test imports the argv parser.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2), ghJson);
}
