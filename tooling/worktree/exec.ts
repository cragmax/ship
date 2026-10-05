/**
 * Child-process runner for the worktree CLI. Output is always captured,
 * never inherited: the CLI's stdout carries exactly one JSON object, so a
 * child writing to it would corrupt the envelope. On failure the captured
 * tail travels in the envelope's `errors[].detail` instead.
 *
 * The spawn budgets below are the only timeouts of an unattended run's
 * tool steps: the CLI owns them, and the workflow that calls it sets none
 * of its own. Every spawn that can outlast local git plumbing — a network
 * call, an install, a build, a hooked commit — names its constant here; the
 * local `git` plumbing (`git.ts`) runs under the default.
 *
 * A budget kill is `execaSync`'s `timeout`. On Windows (#1048; Windows 11,
 * Node 24, Git for Windows 2.55) it reaches only the direct child, and its
 * descendants survive it except in a node → node chain:
 *
 * - an npm chain (`npm run` → cmd → npm-cli → cmd → node) outlives it;
 * - a program an MSYS process execs (`sleep`, or Git Bash's sh-script `npm`,
 *   which runs as its own sh process) runs as a new Windows process whose
 *   parent is the exited fork, outside the Windows process tree:
 *   `taskkill /T` reaches neither it nor anything below it, native
 *   descendants included;
 * - the direct child can be a launcher. From a Windows-native PATH, `git` is
 *   Git's `cmd/git.exe`, and killing it leaves the real `git.exe` and its
 *   hook running; from Git Bash's PATH the real `git.exe` is the child — it
 *   dies, and its hook tree survives.
 *
 * Async execa gains nothing: `child.kill()` and its own `timeout` also kill
 * only the direct child, and its promise never settles while a survivor
 * holds the output pipe; the sync spawn returns at the budget. So a Windows
 * budget kill is reported, not repaired: {@link outputOf} appends
 * {@link orphanWarning}'s line. POSIX is unexamined: whether a hook's
 * children survive a SIGTERM to `git` there has not been probed.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execaSync } from 'execa';

import { toPosix } from '../shared.js';

import { StepFailure } from './types.js';

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

/** Budget for one `git push` whose pre-push hook runs the full gate. */
export const PUSH_TIMEOUT_MS = 2_700_000;

/** Budget for any child without an explicit one. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** What {@link runCaptured} observed. */
export interface Captured {
  /** Exit code; `-1` when the child never produced one (spawn failure, timeout kill). */
  readonly exitCode: number;
  /** The child's stdout alone (for parsing). */
  readonly stdout: string;
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
   * overwritten) after the child exits — even when it failed, timed out or
   * never started.
   */
  readonly logFile?: string;
}

/**
 * Keep the last {@link TAIL_LINES} lines of `text`.
 *
 * @param text - Captured output.
 * @returns The trailing lines, joined with `\n`.
 */
function lastLines(text: string): string {
  return text.split(/\r?\n/u).slice(-TAIL_LINES).join('\n');
}

/**
 * Run a child with captured output, never throwing on a child failure.
 * `.cmd` shims (`npm` on Windows) resolve through execa.
 *
 * @remarks
 * The child gets this process's environment minus every `GIT_*` variable,
 * with `options.env` laid over it; an overlay must not set a `GIT_*`
 * variable. The CLI names each repository by explicit path (`git -C`), so
 * an inherited repository-location variable is always wrong: a git hook exports
 * `GIT_DIR`, and under it `git -C <worktree>` resolves the hook's
 * repository instead — its worktree list, its main checkout, its
 * `worktree remove`. A prefix rule rather than a list, so no name that
 * `git rev-parse --local-env-vars` prints can be missed; no child here
 * needs any other `GIT_*` setting.
 *
 * @param file - Executable name or path.
 * @param args - Argument vector, passed without a shell.
 * @param options - Working directory, optional timeout, env overlay and log file.
 * @returns Exit code, stdout, and the output tail.
 */
export function runCaptured(
  file: string,
  args: readonly string[],
  options: CaptureOptions,
): Captured {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    ...options.env,
  };
  const r = execaSync(file, args, {
    cwd: options.cwd,
    env,
    extendEnv: false,
    all: true,
    reject: false,
    stdin: 'ignore',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  let output = outputOf(r.all, r.timedOut, r.shortMessage ?? '', options.cwd);
  if (options.logFile !== undefined) output += writeLog(options.logFile, output);
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout, tail: lastLines(output) };
}

/**
 * Compose a child's output: what it printed, then execa's message after a
 * budget kill — a killed child that printed anything would otherwise read
 * as a bare exit `-1` — or that message alone when it printed nothing. On
 * win32 a budget kill then appends {@link orphanWarning}'s line; POSIX gets
 * none.
 *
 * @param all - Interleaved stdout + stderr.
 * @param timedOut - Whether the budget killed the child.
 * @param failure - Execa's failure message; empty when the child succeeded.
 * @param cwd - The child's working directory, named by the warning.
 * @returns The composed output.
 */
function outputOf(all: string, timedOut: boolean, failure: string, cwd: string): string {
  const warning = timedOut && process.platform === 'win32' ? `\n${orphanWarning(cwd)}` : '';
  if (all.trim() === '') return failure + warning;
  return (timedOut ? `${all}\n${failure}` : all) + warning;
}

/**
 * The report of a Windows budget kill that reached only the direct child
 * (the file header has the why). It carries no remediation command: the
 * survivors cannot be found by `cwd`.
 *
 * @param cwd - The killed child's working directory, named as given — for a
 *   `git -C` spawn that is the CLI's own cwd, not the repository.
 * @returns The one warning line.
 */
function orphanWarning(cwd: string): string {
  return `warning: the budget kill reached only the direct child, started in ${cwd}; its descendants, and the program itself when that child was a launcher, may still be running`;
}

/**
 * Write the whole output to the log file.
 *
 * @param file - The log file.
 * @param output - The composed output.
 * @returns `''` when written; otherwise a line naming the failure.
 * @silences A failed write (a missing directory, a file held open): the
 *   child's outcome stands — a commit that landed must not read as failed —
 *   and the returned line reaches the caller in the tail.
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
 * Create a fresh directory for a command's own log and message files, in
 * the OS temp dir — outside every worktree, so nothing written there can be
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
 * @param step - Step name reported on failure.
 * @param file - Executable name or path.
 * @param args - Argument vector.
 * @param options - Working directory and optional timeout.
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
