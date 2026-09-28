/**
 * Worktree lifecycle CLI — provisions, harvests into and tears down the
 * batch and slice worktrees of an unattended run, and lists the live runs
 * (ADR-0045). Each command prints exactly one JSON object on one stdout
 * line — the envelope in `worktree/types.ts` — and nothing else.
 *
 * Usage (square brackets = optional, `...` = one or more):
 *
 * ```
 * npx tsx <main-checkout>/tooling/worktree.ts provision SLICE --batch BATCH [--server]
 * npx tsx <main-checkout>/tooling/worktree.ts provision-batch BATCH --report-dir DIR
 * npx tsx <main-checkout>/tooling/worktree.ts teardown WORKTREE
 * npx tsx <main-checkout>/tooling/worktree.ts harvest BATCH SLICE-SHA
 * npx tsx <main-checkout>/tooling/worktree.ts staged-guard WORKTREE FILE...
 * npx tsx <main-checkout>/tooling/worktree.ts live-runs MAIN
 * ```
 *
 * The commit queue runs `harvest`, then `staged-guard` over the harvest's
 * `files`, then commits.
 *
 * Always run it from a checkout other than the one it mutates — normally
 * the main checkout: every command that mutates a worktree (provision,
 * provision-batch, teardown, harvest) refuses (`self-hosted`, see
 * `assertNotSelfHosted` in `worktree/git.ts`) when the CLI lies inside its
 * target. Target paths come only from argv, resolved against the starting
 * cwd; the arguments after the target (a sha, repo-relative paths) are kept
 * verbatim.
 *
 * Exit codes: `0` ok, `1` failed, refused or conflict (the envelope's
 * `status` tells which), `2` usage error ({@link UsageError}). The runner
 * rule shared with `tooling/run-gate.ts`: on `0` / `1` parse stdout; `2` is
 * a tool or usage error whose human message is on stderr
 * (`worktree: <reason>`). Here the `usage` envelope is on stdout too, where
 * `run-gate.ts` leaves stdout empty. No npm script wraps this CLI: `npm run`
 * prints a banner on stdout, which would break the one-object contract.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { toPosix } from './shared.js';
import { harvest } from './worktree/harvest.js';
import { liveRuns } from './worktree/live-runs.js';
import { provision } from './worktree/provision.js';
import { provisionBatch } from './worktree/provision-batch.js';
import { stagedGuard } from './worktree/staged-set.js';
import { teardownWorktree } from './worktree/teardown.js';
import { recordFailure, type ResultBase } from './worktree/types.js';

/** A command line that cannot be dispatched — exit 2. */
class UsageError extends Error {}

/** A subcommand's parsed argv. */
interface ParsedArgs {
  /** The resolved positional path. */
  readonly target: string;
  /** The positionals after the target, verbatim. */
  readonly rest: readonly string[];
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
  /** How many positionals may follow the target (`max` may be `Infinity`). */
  readonly rest: { readonly min: number; readonly max: number };
  /** Run the command. */
  readonly run: (args: ParsedArgs) => ResultBase;
}

/** Arity of a command taking only its target. */
const NO_REST = { min: 0, max: 0 } as const;

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
    rest: NO_REST,
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
    rest: NO_REST,
    run: (args) =>
      provisionBatch({ batch: args.target, reportDir: pathFlag(args, '--report-dir') }),
  },
  teardown: {
    valueFlags: [],
    switchFlags: [],
    rest: NO_REST,
    run: (args) => teardownWorktree(args.target),
  },
  harvest: {
    valueFlags: [],
    switchFlags: [],
    rest: { min: 1, max: 1 },
    run: (args) => harvest({ batch: args.target, sha: args.rest[0] ?? '' }),
  },
  // At least one file: an empty expected set never precedes a real commit,
  // and accepting it would let an empty-list bug pass on an empty index.
  'staged-guard': {
    valueFlags: [],
    switchFlags: [],
    rest: { min: 1, max: Infinity },
    run: (args) => stagedGuard({ worktree: args.target, files: args.rest }),
  },
  'live-runs': {
    valueFlags: [],
    switchFlags: [],
    rest: NO_REST,
    run: (args) => liveRuns({ main: args.target }),
  },
};

/**
 * Parse one subcommand's arguments against its spec.
 *
 * @param argv - Arguments after the subcommand name.
 * @param spec - The subcommand's flags and positional arity.
 * @returns The parsed arguments.
 * @throws UsageError on an unknown flag, a flag missing its value, a missing
 *   required flag, or a positional count outside the spec's range.
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
  assertArity(positionals.length, spec.rest);
  const missing = spec.valueFlags.find((flag) => !values.has(flag));
  if (missing !== undefined) throw new UsageError(`missing required flag ${missing}`);
  const [target = '', ...rest] = positionals;
  return { target: toTarget(target), rest, values, switches };
}

/**
 * Check the positional count: one target path plus `rest.min`..`rest.max`
 * further arguments.
 *
 * @param count - Positionals given.
 * @param rest - The spec's arity after the target.
 * @throws UsageError naming the expectation and the count.
 */
function assertArity(count: number, rest: CommandSpec['rest']): void {
  if (count >= 1 + rest.min && count <= 1 + rest.max) return;
  let expected = 'one positional path';
  if (rest.max === Infinity) expected += ` plus at least ${String(rest.min)} more`;
  else if (rest.max === rest.min && rest.max > 0) expected += ` plus ${String(rest.max)} more`;
  else if (rest.max > 0) expected += ` plus ${String(rest.min)}..${String(rest.max)} more`;
  throw new UsageError(`expected ${expected}, got ${String(count)} positionals`);
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
  if (exitCode === 2) process.stderr.write(`worktree: ${result.errors[0]?.message ?? 'usage'}\n`);
  process.exitCode = exitCode;
}
