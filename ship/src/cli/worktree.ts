/**
 * Worktree lifecycle CLI (Ship ADR-0001) — checks, cuts, provisions, lands into and tears down an
 * unattended run's batch and slice worktrees, retires a merged run, and lists the live runs;
 * `COMMANDS` holds each command's flags and arity. A command prints one JSON object on one stdout
 * line and nothing else: its envelope, checked against its schema (`envelope/schemas*.ts`) before
 * printing ({@link runWorktreeCli}).
 *
 * Run it from a checkout other than the one it mutates: a mutating command refuses `self-hosted`
 * when the CLI lies inside its target — except `cut-batch` (it writes only `.git` and gitignored
 * run paths), `retire-run` (no worktree lies in the run root it removes) and `commit` (it touches
 * only its cwd's index and `HEAD`). Target paths and path flags resolve against the starting cwd.
 *
 * Exit codes: `0` ok, `1` failed, refused or conflict (read `status`), `2` usage
 * ({@link UsageError}: `worktree: <reason>` on stderr, the `usage` envelope on stdout) — the runner
 * rule shared with `ship/src/cli/run-gate.ts`, which leaves stdout empty on `2`.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { z } from 'zod';

import type { RunSelection } from '../core/run-slug.js';
import { toPosix } from '../../../tooling/lib/shared.js';
import { RUN_BRANCH_SHAPE } from '../core/run-branch.js';
import type { CutSliceInput } from './commands/cut.js';
import {
  CommitResultSchema,
  guardEnvelope,
  HarvestResultSchema,
  LiveRunsResultSchema,
  ProvisionBatchResultSchema,
  ProvisionResultSchema,
  ResultBaseSchema,
  RetireRunResultSchema,
  StagedGuardResultSchema,
  TeardownResultSchema,
} from './envelope/schemas.js';
import {
  AppendPrBodyResultSchema,
  BumpResultSchema,
  ChangedFilesResultSchema,
  CheckMasterResultSchema,
  CutBatchResultSchema,
  CutSliceResultSchema,
  LandResultSchema,
  PostIssueCommentResultSchema,
  PostPrCommentResultSchema,
  PreflightResultSchema,
  PublishResultSchema,
  SyncMasterResultSchema,
} from './envelope/schemas-run.js';
import type { KeepRequest } from './commands/teardown.js';
import { recordFailure, type ResultBase } from './envelope/types.js';

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
  /** The target is the starting cwd, and every positional is `rest`. */
  readonly cwdTarget?: true;
  /** The envelope schema `run`'s result must satisfy, in every mode of the command. */
  readonly schema: z.ZodType;
  /**
   * Run the command, importing its module only when called, so an invocation loads no other
   * command's module unless its own command's module imports it.
   */
  readonly run: (args: ParsedArgs) => Promise<ResultBase>;
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

/** Read a required value flag, resolved as a path ({@link toTarget}). */
function pathFlag(args: ParsedArgs, flag: string): string {
  return toTarget(args.values.get(flag) ?? '');
}

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  provision: {
    schema: ProvisionResultSchema,
    valueFlags: ['--batch'],
    switchFlags: ['--server'],
    rest: NO_REST,
    run: async (args) => {
      const { provision } = await import('./commands/provision.js');
      return provision({
        slice: args.target,
        batch: pathFlag(args, '--batch'),
        server: args.switches.has('--server'),
      });
    },
  },
  'provision-batch': {
    schema: ProvisionBatchResultSchema,
    valueFlags: ['--report-dir'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { provisionBatch } = await import('./commands/provision-batch.js');
      return provisionBatch({ batch: args.target, reportDir: pathFlag(args, '--report-dir') });
    },
  },
  teardown: {
    schema: TeardownResultSchema,
    valueFlags: [],
    optionFlags: ['--keep-to', '--base', '--report'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { teardownWorktree } = await import('./commands/teardown.js');
      return teardownWorktree(args.target, {}, keepFlags(args));
    },
  },
  harvest: {
    schema: HarvestResultSchema,
    valueFlags: [],
    switchFlags: [],
    rest: { min: 1, max: 1 },
    run: async (args) => {
      const { harvest } = await import('./commands/harvest.js');
      return harvest({ batch: args.target, sha: args.rest[0] ?? '' });
    },
  },
  land: {
    schema: LandResultSchema,
    valueFlags: ['--base', '--message-file', '--log'],
    switchFlags: [],
    rest: { min: 1, max: 1 },
    run: async (args) => {
      const { land } = await import('./commands/land.js');
      return land({
        batch: args.target,
        sha: args.rest[0] ?? '',
        base: args.values.get('--base') ?? '',
        messageFile: pathFlag(args, '--message-file'),
        logFile: pathFlag(args, '--log'),
      });
    },
  },
  // At least one file: an empty expected set never precedes a real commit,
  // and accepting it would let an empty-list bug pass on an empty index.
  'staged-guard': {
    schema: StagedGuardResultSchema,
    valueFlags: [],
    switchFlags: [],
    rest: { min: 1, max: Infinity },
    run: async (args) => {
      const { stagedGuard } = await import('./git/staged-set.js');
      return stagedGuard({ worktree: args.target, files: args.rest });
    },
  },
  commit: {
    schema: CommitResultSchema,
    valueFlags: ['--message-file'],
    switchFlags: [],
    rest: { min: 1, max: Infinity },
    cwdTarget: true,
    run: async (args) => {
      const { commit } = await import('./commands/commit.js');
      return commit({
        worktree: args.target,
        messageFile: pathFlag(args, '--message-file'),
        files: args.rest,
      });
    },
  },
  'retire-run': {
    schema: RetireRunResultSchema,
    valueFlags: ['--branch'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { retireRun } = await import('./commands/retire-run.js');
      return retireRun({ main: args.target, branch: args.values.get('--branch') ?? '' });
    },
  },
  'live-runs': {
    schema: LiveRunsResultSchema,
    valueFlags: [],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { liveRuns } = await import('./commands/live-runs.js');
      return liveRuns({ main: args.target });
    },
  },
  preflight: {
    schema: PreflightResultSchema,
    valueFlags: [],
    optionFlags: ['--attach', '--slug'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { preflight } = await import('./commands/preflight.js');
      const attach = args.values.get('--attach');
      const slug = args.values.get('--slug');
      return preflight({
        main: args.target,
        ...(attach === undefined ? {} : { attach }),
        ...(slug === undefined ? {} : { slugs: slugList(slug) }),
      });
    },
  },
  'cut-batch': {
    schema: CutBatchResultSchema,
    valueFlags: [],
    optionFlags: ['--epic', '--issues', '--attach'],
    switchFlags: ['--attached-run'],
    rest: NO_REST,
    run: async (args) => {
      const selection = batchSelection(args);
      if ('attach' in selection) {
        const { attachBatch } = await import('./commands/cut-attach.js');
        return attachBatch({
          main: args.target,
          branch: selection.attach,
          attachedRun: selection.attachedRun,
        });
      }
      const { cutBatch } = await import('./commands/cut.js');
      return cutBatch({ main: args.target, selection });
    },
  },
  'cut-slice': {
    schema: CutSliceResultSchema,
    valueFlags: [],
    optionFlags: ['--issue', '--attempt', '--attached-run'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { cutSlice } = await import('./commands/cut.js');
      const run = args.values.get('--attached-run');
      return cutSlice({
        batch: args.target,
        slice: sliceFlag(args),
        ...(run === undefined ? {} : { attachedRun: positiveInt(run, '--attached-run') }),
      });
    },
  },
  'sync-master': {
    schema: SyncMasterResultSchema,
    valueFlags: [],
    switchFlags: ['--continue'],
    rest: NO_REST,
    run: async (args) => {
      const { syncMaster } = await import('./commands/sync-master.js');
      return syncMaster({ batch: args.target, continue: args.switches.has('--continue') });
    },
  },
  bump: {
    schema: BumpResultSchema,
    valueFlags: [],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { bump } = await import('./commands/bump.js');
      return bump({ batch: args.target });
    },
  },
  'check-master': {
    schema: CheckMasterResultSchema,
    valueFlags: ['--local', '--remote'],
    optionFlags: ['--synced'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { checkMaster } = await import('./commands/check-master.js');
      return checkMaster({
        main: args.target,
        local: args.values.get('--local') ?? '',
        remote: args.values.get('--remote') ?? '',
        synced: args.values.get('--synced') ?? null,
      });
    },
  },
  publish: {
    schema: PublishResultSchema,
    valueFlags: ['--log'],
    optionFlags: ['--title', '--body-file'],
    switchFlags: ['--push-only', '--draft'],
    rest: NO_REST,
    run: async (args) => {
      const logFile = pathFlag(args, '--log');
      if (publishMode(args) === 'push-only') {
        const pollMs = pollMsFromEnv();
        const { publishPushOnly } = await import('./commands/publish-push.js');
        return publishPushOnly({
          batch: args.target,
          logFile,
          ...(pollMs === undefined ? {} : { pollMs }),
        });
      }
      const { publish } = await import('./commands/publish.js');
      return publish({
        batch: args.target,
        title: args.values.get('--title') ?? '',
        bodyFile: pathFlag(args, '--body-file'),
        logFile,
        draft: args.switches.has('--draft'),
      });
    },
  },
  'append-pr-body': {
    schema: AppendPrBodyResultSchema,
    valueFlags: ['--pr', '--section-file'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { appendPrBody } = await import('./commands/append-pr-body.js');
      return appendPrBody({
        batch: args.target,
        pr: positiveInt(args.values.get('--pr') ?? '', '--pr'),
        sectionFile: pathFlag(args, '--section-file'),
      });
    },
  },
  'post-pr-comment': {
    schema: PostPrCommentResultSchema,
    valueFlags: ['--pr', '--comment-file'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { postPrComment } = await import('./commands/post-pr-comment.js');
      return postPrComment({
        batch: args.target,
        pr: positiveInt(args.values.get('--pr') ?? '', '--pr'),
        commentFile: pathFlag(args, '--comment-file'),
      });
    },
  },
  'changed-files': {
    schema: ChangedFilesResultSchema,
    valueFlags: ['--base'],
    switchFlags: [],
    rest: { min: 1, max: 1 },
    run: async (args) => {
      const { changedFiles } = await import('./commands/changed-files.js');
      return changedFiles({
        worktree: args.target,
        sha: args.rest[0] ?? '',
        base: args.values.get('--base') ?? '',
      });
    },
  },
  'post-issue-comment': {
    schema: PostIssueCommentResultSchema,
    valueFlags: ['--issue', '--comment-file'],
    switchFlags: [],
    rest: NO_REST,
    run: async (args) => {
      const { postIssueComment } = await import('./commands/post-issue-comment.js');
      return postIssueComment({
        cwd: args.target,
        issue: positiveInt(args.values.get('--issue') ?? '', '--issue'),
        commentFile: pathFlag(args, '--comment-file'),
      });
    },
  },
};

/**
 * Parse one subcommand's arguments against its spec; a `--` ends the flags.
 *
 * @throws UsageError on an unknown flag, a flag missing its value, a missing
 *   required flag, or a positional count outside the spec's range.
 */
function parseArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const { flags, positionals, trailing } = splitAtDashes(argv, spec);
  for (let i = 0; i < flags.length; i++) {
    const arg = flags[i] ?? '';
    if (spec.switchFlags.includes(arg)) switches.add(arg);
    else if (spec.valueFlags.includes(arg) || spec.optionFlags?.includes(arg) === true) {
      values.set(arg, requireValue(flags[++i], arg));
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    else positionals.push(arg);
  }
  positionals.push(...trailing);
  assertArity(positionals.length, spec.rest);
  const missing = spec.valueFlags.find((flag) => !values.has(flag));
  if (missing !== undefined) throw new UsageError(`missing required flag ${missing}`);
  const [target = '', ...rest] = positionals;
  return { target: toTarget(target), rest, values, switches };
}

/**
 * Split argv at its first `--` into the arguments before it and the positionals after it; the
 * positional list starts with the cwd target for a {@link CommandSpec.cwdTarget} command.
 */
function splitAtDashes(
  argv: readonly string[],
  spec: CommandSpec,
): { flags: readonly string[]; positionals: string[]; trailing: readonly string[] } {
  const end = argv.includes('--') ? argv.indexOf('--') : argv.length;
  return {
    flags: argv.slice(0, end),
    positionals: spec.cwdTarget === true ? ['.'] : [],
    trailing: argv.slice(end + 1),
  };
}

/**
 * Check the positional count: one target path plus `rest.min`..`rest.max`
 * further arguments.
 *
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
 * Read `teardown`'s keep flags: `--keep-to` and `--base` go together; `--report` needs them.
 *
 * @returns The request, its paths resolved ({@link toTarget}); `null` with none of the flags.
 * @throws UsageError for any other combination.
 */
function keepFlags(args: ParsedArgs): KeepRequest | null {
  const dir = args.values.get('--keep-to');
  const base = args.values.get('--base');
  const report = args.values.get('--report');
  if (dir === undefined && base === undefined && report === undefined) return null;
  if (dir === undefined || base === undefined) {
    throw new UsageError('teardown --keep-to and --base go together; --report needs both');
  }
  return {
    dir: toTarget(dir),
    base,
    ...(report === undefined ? {} : { report: toTarget(report) }),
  };
}

/**
 * Read a positive-integer value (an issue, epic or attempt number).
 *
 * @throws UsageError unless `text` is a positive integer in decimal.
 */
function positiveInt(text: string, flag: string): number {
  if (!/^[1-9]\d*$/u.test(text)) {
    throw new UsageError(`flag ${flag} needs a positive integer, got '${text}'`);
  }
  return Number(text);
}

/**
 * Read `preflight`'s `--slug`: run slugs, comma-separated, each in `runSlug`'s domain.
 *
 * @throws UsageError for an empty or malformed slug.
 */
function slugList(text: string): string[] {
  const slugs = text.split(',');
  if (slugs.some((slug) => !RUN_BRANCH_SHAPE.test(`ship/${slug}`))) {
    throw new UsageError(`flag --slug needs run slugs separated by commas, got '${text}'`);
  }
  return slugs;
}

/**
 * Read `cut-batch`'s selection: exactly one of `--epic E`, `--issues N,…` and
 * `--attach ship/<slug>` (a branch name, kept as given), the last optionally with `--attached-run`.
 *
 * @throws UsageError for other than one, a bad number, or `--attached-run` without `--attach`.
 */
function batchSelection(
  args: ParsedArgs,
): RunSelection | { readonly attach: string; readonly attachedRun: boolean } {
  const given = ['--epic', '--issues', '--attach'].filter((flag) => args.values.has(flag));
  if (given.length !== 1) {
    throw new UsageError('cut-batch takes exactly one of --epic, --issues and --attach');
  }
  const epic = args.values.get('--epic');
  const issues = args.values.get('--issues');
  const attach = args.values.get('--attach');
  const attachedRun = args.switches.has('--attached-run');
  if (attach !== undefined) return { attach, attachedRun };
  if (attachedRun) throw new UsageError('cut-batch --attached-run goes with --attach');
  if (epic !== undefined) return { epic: positiveInt(epic, '--epic') };
  return { issues: (issues ?? '').split(',').map((n) => positiveInt(n, '--issues')) };
}

/**
 * Read `cut-slice`'s slice: `--issue N --attempt K`.
 *
 * @throws UsageError when either is missing or a number is bad.
 */
function sliceFlag(args: ParsedArgs): CutSliceInput['slice'] {
  const issue = args.values.get('--issue');
  const attempt = args.values.get('--attempt');
  if (issue === undefined || attempt === undefined) {
    throw new UsageError('cut-slice takes --issue N --attempt K');
  }
  return { issue: positiveInt(issue, '--issue'), attempt: positiveInt(attempt, '--attempt') };
}

/**
 * Read `publish`'s mode: `push-only` for `--push-only` alone, `create` for `--title` and
 * `--body-file` together.
 *
 * @throws UsageError when `--push-only` comes with either or `--draft`, or either is missing.
 */
function publishMode(args: ParsedArgs): 'push-only' | 'create' {
  const given = [
    ...['--title', '--body-file'].filter((flag) => args.values.has(flag)),
    ...(args.switches.has('--draft') ? ['--draft'] : []),
  ];
  if (args.switches.has('--push-only')) {
    if (given.length > 0) throw new UsageError(`publish --push-only takes no ${given.join(', ')}`);
    return 'push-only';
  }
  const missing = ['--title', '--body-file'].find((flag) => !args.values.has(flag));
  if (missing !== undefined) throw new UsageError(`missing required flag ${missing}`);
  return 'create';
}

/**
 * The wait between `publish --push-only`'s mergeable reads from `PH_WORKTREE_POLL_MS`, a test-only
 * seam: its value when a positive decimal integer, else `undefined` (the command's default).
 */
function pollMsFromEnv(): number | undefined {
  const text = process.env['PH_WORKTREE_POLL_MS'] ?? '';
  return /^[1-9]\d*$/u.test(text) ? Number(text) : undefined;
}

/**
 * Check a value flag was followed by a value.
 *
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
 *   path (ok, refused, failed, usage), and the process exit code; never
 *   rejects. The stamped envelope is checked against its schema
 *   ({@link guardEnvelope}): one that fails it is replaced by a `failed`
 *   envelope at step `envelope`, exit code `1`; an unchecked envelope is
 *   never returned.
 */
export async function runWorktreeCli(
  argv: readonly string[],
): Promise<{ result: ResultBase; exitCode: number }> {
  const { result, exitCode, schema } = await dispatch(argv);
  result.at = new Date().toISOString();
  const guarded = guardEnvelope(result, schema);
  return { result: guarded, exitCode: guarded === result ? exitCode : 1 };
}

/**
 * Dispatch one invocation to its command; never rejects. Resolves the unstamped envelope, the exit
 * code and the schema the envelope must satisfy — the command's for its own result,
 * `ResultBaseSchema` for a usage error or a throw.
 */
async function dispatch(
  argv: readonly string[],
): Promise<{ result: ResultBase; exitCode: number; schema: z.ZodType }> {
  const [name = '', ...rest] = argv;
  const base: ResultBase = { command: name, status: 'failed', worktree: null, errors: [] };
  try {
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(`unknown command '${name}'`);
    const spec = COMMANDS[name] as CommandSpec;
    const result = await spec.run(parseArgs(rest, spec));
    return { result, exitCode: result.status === 'ok' ? 0 : 1, schema: spec.schema };
  } catch (err) {
    if (err instanceof UsageError) {
      base.errors.push({ step: 'usage', message: err.message });
      return { result: base, exitCode: 2, schema: ResultBaseSchema };
    }
    recordFailure(base, err);
    return { result: base, exitCode: 1, schema: ResultBaseSchema };
  }
}

// Entry-point guard: run only when executed as a script, not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { result, exitCode } = await runWorktreeCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (exitCode === 2) process.stderr.write(`worktree: ${result.errors[0]?.message ?? 'usage'}\n`);
  process.exitCode = exitCode;
}
