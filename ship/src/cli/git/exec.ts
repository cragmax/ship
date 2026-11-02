/**
 * Child-process runner for the worktree CLI. Output is always captured, never inherited: the
 * CLI's stdout carries exactly one JSON object, and a failure's tail travels in `errors[].detail`.
 * The spawn budgets below are the only timeouts of a run's tool steps (the workflow sets none).
 * Every spawn that can outlast local git plumbing names its constant here.
 *
 * A budget kill is `execaSync`'s `timeout`. On win32 it reaches only the direct child: npm chains,
 * MSYS fork children and git's launcher and hook survive. Async execa kills no
 * further, and never settles while a survivor holds the output pipe (unprobed). POSIX is unprobed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execaSync } from 'execa';

import { toPosix } from '../../../../tooling/lib/strings.js';

import { StepFailure } from '../envelope/types.js';

/** How many trailing output lines a failure carries. */
const TAIL_LINES = 40;

/** Budget for one `npm ci` / `npm run build`. */
export const NPM_TIMEOUT_MS = 600_000;

/**
 * Budget for one `git commit` whose pre-commit hook runs the commit gate
 * (lefthook's parallel jobs, a whole-program `tsc` among them).
 */
export const COMMIT_TIMEOUT_MS = 900_000;

/** Budget for one `git fetch` from `origin`. */
export const FETCH_TIMEOUT_MS = 120_000;

/** Budget for one `gh` call. */
export const GH_TIMEOUT_MS = 120_000;

/** Budget for one `git push` through the pre-push hook, whose server tier may run. */
export const PUSH_TIMEOUT_MS = 2_700_000;

/** Budget for any child without an explicit one. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** What {@link runCaptured} observed. */
export interface Captured {
  /** Exit code. `-1` when the child never produced one (spawn failure, timeout kill). */
  readonly exitCode: number;
  /** The child's stdout alone (for parsing). */
  readonly stdout: string;
  /** The whole output {@link outputOf} composes, as the log file gets it. */
  readonly output: string;
  /**
   * Last {@link TAIL_LINES} lines of the output {@link outputOf} composes,
   * then any line {@link writeLog} returns.
   */
  readonly tail: string;
}

/** Options for {@link runCaptured}. */
export interface CaptureOptions {
  /** Working directory of the child. */
  readonly cwd: string;
  /** Kill the child after this many ms. */
  readonly timeoutMs?: number;
  /** Variables laid over the child's environment (after the `GIT_*` strip). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Also write the whole output {@link outputOf} composes here (created or
   * overwritten) after the child exits, even when it failed, timed out, or
   * never started.
   */
  readonly logFile?: string;
}

/**
 * Run a child with captured output, never throwing on a child failure.
 * Accepted residual: a Windows budget kill's survivors are reported, not reaped
 * ({@link outputOf}, {@link orphanWarning}).
 *
 * @remarks
 * The child gets {@link gitFreeEnv} with `options.env` laid over it. An overlay must not set a
 * `GIT_*` variable.
 *
 * @param args - Argument vector, passed without a shell.
 */
export function runCaptured(
  file: string,
  args: readonly string[],
  options: CaptureOptions,
): Captured {
  const env = { ...gitFreeEnv(), ...options.env };
  const r = execaSync(file, args, {
    cwd: options.cwd,
    env,
    extendEnv: false,
    all: true,
    reject: false,
    stdin: 'ignore',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const output = outputOf(r.all, r.timedOut, r.shortMessage ?? '', options.cwd);
  const logged = options.logFile === undefined ? '' : writeLog(options.logFile, output);

  return {
    exitCode: r.exitCode ?? -1,
    stdout: r.stdout,
    output,
    tail: lastLines(output + logged),
  };
}

/**
 * This process's environment minus every `GIT_*` variable. Ship names each repository by explicit
 * path (`git -C`), so an inherited repository-location variable (a git hook exports `GIT_DIR`) is
 * always wrong. A prefix rule rather than a list, so no name that
 * `git rev-parse --local-env-vars` prints can be missed. No child here needs any other `GIT_*`
 * setting.
 */
export function gitFreeEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * Create a fresh directory for a command's own log and message files, in
 * the OS temp dir, outside every worktree, so nothing written there can be
 * staged. For the commands whose argv names no log file. The CLI never
 * removes it: the envelope names its files for the caller to read.
 *
 * @param command - The subcommand, used as the directory's name prefix.
 * @returns The new directory, absolute with forward slashes.
 */
export function freshLogDir(command: string): string {
  return toPosix(mkdtempSync(join(tmpdir(), `ph-worktree-${command}-`)));
}

/**
 * Run a child as a named step.
 *
 * @returns What the child produced, when it exited 0.
 * @throws StepFailure for `step` carrying the output tail, on any non-zero
 *   exit, spawn failure or timeout.
 */
export function runStep(
  step: string,
  file: string,
  args: readonly string[],
  options: CaptureOptions,
): Captured {
  const r = runCaptured(file, args, options);

  if (r.exitCode !== 0) {
    throw new StepFailure(
      step,
      `${file} ${args.join(' ')} exited ${String(r.exitCode)} in ${options.cwd}`,
      r.tail,
    );
  }

  return r;
}

/**
 * Write the whole output to the log file. `''` when written, else a line naming the failure.
 *
 * @silences A failed write: the child's outcome stands (a commit that landed must not read as
 *   failed), and the returned line reaches the caller in the tail.
 */
function writeLog(file: string, output: string): string {
  try {
    writeFileSync(file, output);

    return '';
  } catch (err) {
    return `\nlog not written to ${file}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * What the child printed, then execa's message after a budget kill (else a killed child reads as
 * a bare exit `-1`), or that message alone when it printed nothing. On win32 a budget kill then
 * appends {@link orphanWarning}'s line.
 */
function outputOf(all: string, timedOut: boolean, failure: string, cwd: string): string {
  const warning = timedOut && process.platform === 'win32' ? `\n${orphanWarning(cwd)}` : '';
  if (all.trim() === '') return failure + warning;

  return (timedOut ? `${all}\n${failure}` : all) + warning;
}

/**
 * The Windows budget-kill line (the file header has the why), naming `cwd` as given: for a
 * `git -C` spawn the CLI's own cwd. No remediation command: survivors cannot be found by `cwd`.
 */
function orphanWarning(cwd: string): string {
  return `warning: the budget kill reached only the direct child, started in ${cwd}; its descendants, and the program itself when that child was a launcher, may still be running`;
}

/**
 * Keep the last {@link TAIL_LINES} lines of `text`.
 *
 * @returns The trailing lines, joined with `\n`.
 */
function lastLines(text: string): string {
  return text.split(/\r?\n/u).slice(-TAIL_LINES).join('\n');
}
