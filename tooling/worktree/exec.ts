/**
 * Child-process runner for the worktree CLI. Output is always captured,
 * never inherited: the CLI's stdout carries exactly one JSON object, so a
 * child writing to it would corrupt the envelope. On failure the captured
 * tail travels in the envelope's `errors[].detail` instead.
 */

import { execaSync } from 'execa';

import { StepFailure } from './types.js';

/** How many trailing output lines a failure carries. */
const TAIL_LINES = 40;

/** Budget for one `npm ci` / `npm run build`. */
export const NPM_TIMEOUT_MS = 600_000;

/** Budget for any child without an explicit one. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** What {@link runCaptured} observed. */
export interface Captured {
  /** Exit code; `-1` when the child never produced one (spawn failure, timeout kill). */
  readonly exitCode: number;
  /** The child's stdout alone (for parsing). */
  readonly stdout: string;
  /**
   * Last {@link TAIL_LINES} lines of interleaved stdout + stderr; execa's
   * failure message (spawn error, timeout) when the child printed nothing.
   */
  readonly tail: string;
}

/** Options for {@link runCaptured}. */
export interface CaptureOptions {
  /** Working directory of the child. */
  readonly cwd: string;
  /** Kill the child after this many ms. */
  readonly timeoutMs?: number;
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
 * The child gets this process's environment minus every `GIT_*` variable.
 * The CLI names each repository by explicit path (`git -C`), so an inherited
 * repository-location variable is always wrong: a git hook exports
 * `GIT_DIR`, and under it `git -C <worktree>` resolves the hook's
 * repository instead — its worktree list, its main checkout, its
 * `worktree remove`. A prefix rule rather than a list, so no name that
 * `git rev-parse --local-env-vars` prints can be missed; no child here
 * needs any other `GIT_*` setting.
 *
 * @param file - Executable name or path.
 * @param args - Argument vector, passed without a shell.
 * @param options - Working directory and optional timeout.
 * @returns Exit code, stdout, and the output tail.
 */
export function runCaptured(
  file: string,
  args: readonly string[],
  options: CaptureOptions,
): Captured {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const r = execaSync(file, args, {
    cwd: options.cwd,
    env,
    extendEnv: false,
    all: true,
    reject: false,
    stdin: 'ignore',
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const output = r.all.trim() === '' ? (r.shortMessage ?? '') : r.all;
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout, tail: lastLines(output) };
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
