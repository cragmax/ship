/**
 * Worktree lifecycle CLI — provisions and tears down the batch and slice
 * worktrees of an unattended run (ADR-0045). Each command prints exactly one
 * JSON object on one stdout line — the envelope in `worktree/types.ts` — and
 * nothing else.
 *
 * Usage (square brackets = optional):
 *
 * ```
 * npx tsx <main-checkout>/tooling/worktree.ts provision SLICE --batch BATCH [--server]
 * npx tsx <main-checkout>/tooling/worktree.ts provision-batch BATCH --report-dir DIR
 * npx tsx <main-checkout>/tooling/worktree.ts teardown WORKTREE
 * ```
 *
 * Always run it from a checkout other than the one it mutates — normally
 * the main checkout: every command refuses (`self-hosted`, see
 * `assertNotSelfHosted` in `worktree/git.ts`) when the CLI lies inside its
 * target. Target paths come only from argv, resolved against the starting
 * cwd.
 *
 * Exit codes: `0` ok, `1` failed or refused (the envelope's `status` tells
 * which), `2` usage error ({@link UsageError}). No npm script wraps this
 * CLI: `npm run` prints a banner on stdout, which would break the
 * one-object contract.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { toPosix } from './shared.js';
import { provision } from './worktree/provision.js';
import { provisionBatch } from './worktree/provision-batch.js';
import { teardownWorktree } from './worktree/teardown.js';
import { recordFailure, type ResultBase } from './worktree/types.js';

/** A command line that cannot be dispatched — exit 2. */
class UsageError extends Error {}

/** A subcommand's parsed argv. */
interface ParsedArgs {
  /** The resolved positional path. */
  readonly target: string;
  /** Value flags (`--batch X`) by name. */
  readonly values: ReadonlyMap<string, string>;
  /** Boolean flags present (`--server`). */
  readonly switches: ReadonlySet<string>;
}

/** One entry of the dispatch table. */
interface CommandSpec {
  /** Flags taking a value; every one is required. */
  readonly valueFlags: readonly string[];
  /** Flags taking no value. */
  readonly switchFlags: readonly string[];
  /** Run the command. */
  readonly run: (args: ParsedArgs) => ResultBase;
}

/**
 * Resolve a CLI path against the starting cwd into envelope form.
 *
 * @param path - Path as given on the command line.
 * @returns Absolute forward-slash path.
 */
function toTarget(path: string): string {
  return toPosix(resolve(path));
}

/**
 * Read a required value flag.
 *
 * @param args - Parsed argv.
 * @param flag - Flag name.
 * @returns The flag's value, resolved as a path.
 */
function pathFlag(args: ParsedArgs, flag: string): string {
  return toTarget(args.values.get(flag) ?? '');
}

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  provision: {
    valueFlags: ['--batch'],
    switchFlags: ['--server'],
    run: (args) =>
      provision({
        slice: args.target,
        batch: pathFlag(args, '--batch'),
        server: args.switches.has('--server'),
      }),
  },
  'provision-batch': {
    valueFlags: ['--report-dir'],
    switchFlags: [],
    run: (args) =>
      provisionBatch({ batch: args.target, reportDir: pathFlag(args, '--report-dir') }),
  },
  teardown: {
    valueFlags: [],
    switchFlags: [],
    run: (args) => teardownWorktree(args.target),
  },
};

/**
 * Parse one subcommand's arguments against its spec.
 *
 * @param argv - Arguments after the subcommand name.
 * @param spec - The subcommand's flags.
 * @returns The parsed arguments.
 * @throws UsageError on an unknown flag, a flag missing its value, a missing
 *   required flag, or a missing or extra positional.
 */
function parseArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (spec.switchFlags.includes(arg)) switches.add(arg);
    else if (spec.valueFlags.includes(arg)) values.set(arg, requireValue(argv[++i], arg));
    else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length !== 1) {
    throw new UsageError(`expected one positional path, got ${String(positionals.length)}`);
  }
  const missing = spec.valueFlags.find((flag) => !values.has(flag));
  if (missing !== undefined) throw new UsageError(`missing required flag ${missing}`);
  return { target: toTarget(positionals[0] ?? ''), values, switches };
}

/**
 * Check a value flag was followed by a value.
 *
 * @param value - The next argv entry.
 * @param flag - The flag it belongs to.
 * @returns The value.
 * @throws UsageError when the value is absent or is itself a flag.
 */
function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`flag ${flag} needs a value`);
  }
  return value;
}

/**
 * Run one CLI invocation.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns The envelope and the process exit code.
 */
export function runWorktreeCli(argv: readonly string[]): { result: ResultBase; exitCode: number } {
  const [name = '', ...rest] = argv;
  const base: ResultBase = { command: name, status: 'failed', worktree: null, errors: [] };
  try {
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(`unknown command '${name}'`);
    const spec = COMMANDS[name] as CommandSpec;
    const result = spec.run(parseArgs(rest, spec));
    return { result, exitCode: result.status === 'ok' ? 0 : 1 };
  } catch (err) {
    if (err instanceof UsageError) {
      base.errors.push({ step: 'usage', message: err.message });
      return { result: base, exitCode: 2 };
    }
    recordFailure(base, err);
    return { result: base, exitCode: 1 };
  }
}

// Entry-point guard: run only when executed as a script, not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { result, exitCode } = runWorktreeCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
