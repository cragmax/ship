/**
 * The crash retry of the hook-running git commands, land's commit and publish's push: a hook
 * failure is a crash when every job lefthook reports as failed ended on a signal, and a crash is
 * retried once.
 */

import { extname } from 'node:path';

import type { Captured } from './exec.js';
import type { HookAttempt } from '../envelope/types-run.js';
import { StepFailure } from '../envelope/types.js';

/** The lowest exit status a shell gives a job a signal killed: 128 plus the signal number. */
const SIGNAL_STATUS = 128;

/** Inputs of {@link runHooked}. */
interface HookedRun {
  /** The step a failure is reported as (`commit`, `push`). */
  readonly step: string;
  /** The command as a failure message names it. */
  readonly label: string;
  /** The first attempt's log. The retry's is {@link retryLog} of it. */
  readonly logFile: string;
  /** Receives each attempt as it ends: the envelope's `hookAttempts`. */
  readonly attempts: HookAttempt[];
  /** Run the command once, its whole output to `log`. */
  readonly spawn: (log: string) => Captured;
}

/**
 * Run a hook-running git command, and once more when its hooks crashed ({@link hookCrash}).
 *
 * @throws StepFailure for `step` naming the log, on a non-zero exit that is no crash, a spawn
 *   failure or a budget kill, none of them retried; naming the hook crash and both logs, when the
 *   retry crashed too; naming both logs, when the retry failed otherwise.
 */
export function runHooked(run: HookedRun): void {
  const first = attempt(run, run.logFile);
  if (first.r.exitCode === 0) return;

  if (first.crash === null) {
    throw new StepFailure(
      run.step,
      `${run.label} exited ${String(first.r.exitCode)}; output in ${run.logFile}`,
      first.r.tail,
    );
  }

  const retryFile = retryLog(run.logFile);
  const retry = attempt(run, retryFile);
  if (retry.r.exitCode === 0) return;
  const logs = `output in ${run.logFile} and ${retryFile}`;

  if (retry.crash === null) {
    throw new StepFailure(
      run.step,
      `${run.label} exited ${String(retry.r.exitCode)} on its retry after a hook crash; ${logs}`,
      retry.r.tail,
    );
  }

  throw new StepFailure(
    run.step,
    `${run.label}: the hook crashed twice (exit status ${String(first.crash)}, then ${String(retry.crash)}); ${logs}`,
    retry.r.tail,
  );
}

/**
 * The crash a failed hook run's output shows: the highest `exit status` lefthook printed, one per
 * failed job, when every one is {@link SIGNAL_STATUS} or above.
 *
 * @returns `null` when the output names no exit status, or any below {@link SIGNAL_STATUS}.
 */
export function hookCrash(output: string): number | null {
  const statuses = [...output.matchAll(/exit status (\d+)/gu)].map((m) => Number(m[1]));
  if (statuses.length === 0 || statuses.some((s) => s < SIGNAL_STATUS)) return null;

  return Math.max(...statuses);
}

/** The retry's log: the first attempt's path with `.retry` before its extension. */
export function retryLog(logFile: string): string {
  const ext = extname(logFile);

  return `${logFile.slice(0, logFile.length - ext.length)}.retry${ext}`;
}

/**
 * Run one attempt and record it on `run.attempts`. A budget kill or spawn failure (exit `-1`) is
 * never a crash: a killed run's hooks may still be running.
 */
function attempt(run: HookedRun, log: string): { r: Captured; crash: number | null } {
  const r = run.spawn(log);
  const crash = r.exitCode > 0 ? hookCrash(r.output) : null;
  run.attempts.push({ log, crash });

  return { r, crash };
}
