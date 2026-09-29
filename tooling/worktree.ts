/**
 * Worktree lifecycle CLI — checks, cuts, provisions, lands into and tears
 * down the batch and slice worktrees of an unattended run, and lists the
 * live runs (ADR-0045). Each command prints exactly one JSON object on one
 * stdout line — the envelope in `worktree/types.ts` or
 * `worktree/types-run.ts` — and nothing else.
 *
 * Usage (square brackets = optional, `...` = one or more, `a | b` = exactly one):
 *
 * ```
 * npx tsx <main-checkout>/tooling/worktree.ts preflight MAIN
 * npx tsx <main-checkout>/tooling/worktree.ts cut-batch MAIN (--epic E | --issues N,...)
 * npx tsx <main-checkout>/tooling/worktree.ts cut-slice BATCH (--issue N --attempt K | --critic)
 * npx tsx <main-checkout>/tooling/worktree.ts provision SLICE --batch BATCH [--server]
 * npx tsx <main-checkout>/tooling/worktree.ts provision-batch BATCH --report-dir DIR
 * npx tsx <main-checkout>/tooling/worktree.ts teardown WORKTREE
 * npx tsx <main-checkout>/tooling/worktree.ts land BATCH SLICE-SHA --base CUT-SHA --message-file F --log L
 * npx tsx <main-checkout>/tooling/worktree.ts harvest BATCH SLICE-SHA
 * npx tsx <main-checkout>/tooling/worktree.ts staged-guard WORKTREE FILE...
 * npx tsx <main-checkout>/tooling/worktree.ts live-runs MAIN
 * npx tsx <main-checkout>/tooling/worktree.ts server-tier BATCH --engine paper|folia --registry R --log L
 * npx tsx <main-checkout>/tooling/worktree.ts sync-master BATCH [--continue]
 * npx tsx <main-checkout>/tooling/worktree.ts bump BATCH
 * npx tsx <main-checkout>/tooling/worktree.ts publish BATCH --title T --body-file F --log L
 * ```
 *
 * The commit queue runs `land` once per slice: it harvests, checks the
 * staged set as `staged-guard` does, builds when needed, then commits. The
 * epic end runs the last four, in that order.
 *
 * Always run it from a checkout other than the one it mutates — normally
 * the main checkout: every command that mutates a worktree (cut-slice,
 * provision, provision-batch, teardown, harvest, land, server-tier,
 * sync-master, bump, publish) refuses
 * (`self-hosted`, see `assertNotSelfHosted` in `worktree/git.ts`) when the
 * CLI lies inside its target. The one exception is `cut-batch`, whose
 * target is the main checkout the CLI runs from: it writes only `.git` and
 * a sibling directory, never that checkout's working tree
 * (`worktree/cut.ts`). Target paths and the path flags (`--batch`,
 * `--report-dir`, `--message-file`, `--log`, `--body-file`, `--registry`)
 * come only from argv, resolved against the starting cwd; every other
 * argument — a sha, repo-relative paths, a number, a title — is kept as given.
 *
 * Every envelope carries `at`, the instant the command finished
 * ({@link runWorktreeCli}).
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
import { bump } from './worktree/bump.js';
import { cutBatch, cutSlice, type CutSliceInput } from './worktree/cut.js';
import { harvest } from './worktree/harvest.js';
import { land } from './worktree/land.js';
import { liveRuns } from './worktree/live-runs.js';
import { preflight } from './worktree/preflight.js';
import { provision } from './worktree/provision.js';
import { provisionBatch } from './worktree/provision-batch.js';
import { publish } from './worktree/publish.js';
import { serverTier } from './worktree/server-tier.js';
import type { RunSelection } from './worktree/run-layout.js';
import { stagedGuard } from './worktree/staged-set.js';
import { syncMaster } from './worktree/sync-master.js';
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
  /** Flags taking a value that may be absent; `run` checks their combination. */
  readonly optionFlags?: readonly string[];
  /** Flags taking no value. */
  readonly switchFlags: readonly string[];
  /** How many positionals may follow the target (`max` may be `Infinity`). */
  readonly rest: { readonly min: number; readonly max: number };
  /** Run the command. */
  readonly run: (args: ParsedArgs) => ResultBase | Promise<ResultBase>;
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
  land: {
    valueFlags: ['--base', '--message-file', '--log'],
    switchFlags: [],
    rest: { min: 1, max: 1 },
    run: (args) =>
      land({
        batch: args.target,
        sha: args.rest[0] ?? '',
        base: args.values.get('--base') ?? '',
        messageFile: pathFlag(args, '--message-file'),
        logFile: pathFlag(args, '--log'),
      }),
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
  preflight: {
    valueFlags: [],
    switchFlags: [],
    rest: NO_REST,
    run: (args) => preflight({ main: args.target }),
  },
  'cut-batch': {
    valueFlags: [],
    optionFlags: ['--epic', '--issues'],
    switchFlags: [],
    rest: NO_REST,
    run: (args) => cutBatch({ main: args.target, selection: selectionFlag(args) }),
  },
  'cut-slice': {
    valueFlags: [],
    optionFlags: ['--issue', '--attempt'],
    switchFlags: ['--critic'],
    rest: NO_REST,
    run: (args) => cutSlice({ batch: args.target, slice: sliceFlag(args) }),
  },
  'sync-master': {
    valueFlags: [],
    switchFlags: ['--continue'],
    rest: NO_REST,
    run: (args) => syncMaster({ batch: args.target, continue: args.switches.has('--continue') }),
  },
  bump: {
    valueFlags: [],
    switchFlags: [],
    rest: NO_REST,
    run: (args) => bump({ batch: args.target }),
  },
  publish: {
    valueFlags: ['--title', '--body-file', '--log'],
    switchFlags: [],
    rest: NO_REST,
    run: (args) =>
      publish({
        batch: args.target,
        title: args.values.get('--title') ?? '',
        bodyFile: pathFlag(args, '--body-file'),
        logFile: pathFlag(args, '--log'),
      }),
  },
  'server-tier': {
    valueFlags: ['--engine', '--registry', '--log'],
    switchFlags: [],
    rest: NO_REST,
    run: (args) =>
      serverTier({
        batch: args.target,
        engine: engineFlag(args.values.get('--engine') ?? ''),
        registry: pathFlag(args, '--registry'),
        logFile: pathFlag(args, '--log'),
      }),
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
    else if (spec.valueFlags.includes(arg) || spec.optionFlags?.includes(arg) === true) {
      values.set(arg, requireValue(argv[++i], arg));
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
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
 * Read a positive-integer value (an issue, epic or attempt number).
 *
 * @param text - The value as given.
 * @param flag - The flag it belongs to.
 * @returns The number.
 * @throws UsageError unless `text` is a positive integer in decimal.
 */
function positiveInt(text: string, flag: string): number {
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new UsageError(`flag ${flag} needs a positive integer, got '${text}'`);
  }
  return Number(text);
}

/**
 * Read `server-tier`'s engine.
 *
 * @param text - The `--engine` value as given.
 * @returns The engine.
 * @throws UsageError unless it is `paper` or `folia`.
 */
function engineFlag(text: string): 'paper' | 'folia' {
  if (text === 'paper' || text === 'folia') return text;
  throw new UsageError(`flag --engine needs paper or folia, got '${text}'`);
}

/**
 * Read `cut-batch`'s run selection: exactly one of `--epic E` and
 * `--issues N,…`.
 *
 * @param args - Parsed argv.
 * @returns The selection.
 * @throws UsageError when both or neither is given, or a number is bad.
 */
function selectionFlag(args: ParsedArgs): RunSelection {
  const epic = args.values.get('--epic');
  const issues = args.values.get('--issues');
  if ((epic === undefined) === (issues === undefined)) {
    throw new UsageError('cut-batch takes exactly one of --epic and --issues');
  }
  if (epic !== undefined) return { epic: positiveInt(epic, '--epic') };
  return { issues: (issues ?? '').split(',').map((n) => positiveInt(n, '--issues')) };
}

/**
 * Read `cut-slice`'s slice: exactly one of `--critic` and
 * `--issue N --attempt K`.
 *
 * @param args - Parsed argv.
 * @returns The critic slice, or the issue attempt.
 * @throws UsageError when both or neither is given, when one of `--issue`
 *   and `--attempt` comes without the other, or a number is bad.
 */
function sliceFlag(args: ParsedArgs): CutSliceInput['slice'] {
  const issue = args.values.get('--issue');
  const attempt = args.values.get('--attempt');
  const critic = args.switches.has('--critic');
  if (critic === (issue !== undefined || attempt !== undefined)) {
    throw new UsageError('cut-slice takes exactly one of --critic and --issue N --attempt K');
  }
  if (critic) return { critic: true };
  if (issue === undefined || attempt === undefined) {
    throw new UsageError('cut-slice --issue and --attempt go together');
  }
  return { issue: positiveInt(issue, '--issue'), attempt: positiveInt(attempt, '--attempt') };
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
 * @returns Resolves to the envelope, stamped with its `at` instant on every
 *   path (ok, refused, failed, usage), and the process exit code; never rejects.
 */
export async function runWorktreeCli(
  argv: readonly string[],
): Promise<{ result: ResultBase; exitCode: number }> {
  const run = await dispatch(argv);
  run.result.at = new Date().toISOString();
  return run;
}

/**
 * Dispatch one invocation to its command.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns Resolves to the unstamped envelope and the exit code; never rejects.
 */
async function dispatch(
  argv: readonly string[],
): Promise<{ result: ResultBase; exitCode: number }> {
  const [name = '', ...rest] = argv;
  const base: ResultBase = { command: name, status: 'failed', worktree: null, errors: [] };
  try {
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(`unknown command '${name}'`);
    const spec = COMMANDS[name] as CommandSpec;
    const result = await spec.run(parseArgs(rest, spec));
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
  const { result, exitCode } = await runWorktreeCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (exitCode === 2) process.stderr.write(`worktree: ${result.errors[0]?.message ?? 'usage'}\n`);
  process.exitCode = exitCode;
}
