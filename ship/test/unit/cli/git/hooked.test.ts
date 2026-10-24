import { describe, expect, it } from 'vitest';

import type { HookAttempt } from '../../../../src/cli/envelope/types-run.js';
import { StepFailure } from '../../../../src/cli/envelope/types.js';
import type { Captured } from '../../../../src/cli/git/exec.js';
import { hookCrash, retryLog, runHooked } from '../../../../src/cli/git/hooked.js';

describe('hookCrash', () => {
  it.each([
    { name: 'one job on exit status 139', output: 'test\nexit status 139┃  lint ❯', crash: 139 },
    { name: 'a job on exactly 128', output: 'exit status 128\n', crash: 128 },
    {
      name: 'two crashed jobs, the highest',
      output: 'exit status 134\nexit status 139',
      crash: 139,
    },
    { name: 'a job on 127', output: 'exit status 127\n', crash: null },
    {
      name: 'a crash beside a gate failure',
      output: 'exit status 139\nexit status 1',
      crash: null,
    },
    { name: 'no exit status at all', output: 'pre-commit: refused\n', crash: null },
  ])('reads $name as $crash', ({ output, crash }) => {
    expect(hookCrash(output)).toBe(crash);
  });
});

describe('runHooked', () => {
  /** Run `runHooked` over scripted attempts: the logs spawned, the attempts and the throw. */
  function runScripted(results: readonly Captured[]): {
    spawned: string[];
    attempts: HookAttempt[];
    thrown: unknown;
  } {
    const spawned: string[] = [];
    const attempts: HookAttempt[] = [];
    let thrown: unknown = null;

    try {
      runHooked({
        step: 'commit',
        label: 'git commit',
        logFile: '/r/c.log',
        attempts,
        spawn: (log) => {
          spawned.push(log);

          return results[spawned.length - 1] ?? captured(0, '');
        },
      });
    } catch (err) {
      thrown = err;
    }

    return { spawned, attempts, thrown };
  }

  it('fails a retry that failed a gate after a crash, naming both logs', () => {
    const { attempts, thrown } = runScripted([
      captured(1, 'exit status 139'),
      captured(1, 'exit status 1'),
    ]);

    expect(attempts).toEqual([
      { log: '/r/c.log', crash: 139 },
      { log: '/r/c.retry.log', crash: null },
    ]);
    expect(thrown).toBeInstanceOf(StepFailure);
    expect((thrown as StepFailure).step).toBe('commit');
    expect((thrown as StepFailure).message).toBe(
      'git commit exited 1 on its retry after a hook crash; output in /r/c.log and /r/c.retry.log',
    );
  });

  it('names each attempt its own exit status when the retry crashed too', () => {
    const { thrown } = runScripted([
      captured(1, 'exit status 134'),
      captured(1, 'exit status 139'),
    ]);

    expect((thrown as StepFailure).message).toBe(
      'git commit: the hook crashed twice (exit status 134, then 139); output in /r/c.log and /r/c.retry.log',
    );
  });

  it('never retries a budget kill, whatever its output shows', () => {
    const { spawned, attempts, thrown } = runScripted([captured(-1, 'exit status 139')]);

    expect(spawned).toEqual(['/r/c.log']);
    expect(attempts).toEqual([{ log: '/r/c.log', crash: null }]);
    expect((thrown as StepFailure).message).toBe('git commit exited -1; output in /r/c.log');
  });
});

/** A {@link Captured} with `output` as both the whole output and the tail. */
function captured(exitCode: number, output: string): Captured {
  return { exitCode, stdout: '', output, tail: output };
}

describe('retryLog', () => {
  it.each([
    { log: 'C:/r/land-715-1.log', retry: 'C:/r/land-715-1.retry.log' },
    { log: '/r/a.b/push', retry: '/r/a.b/push.retry' },
  ])('names $log retry $retry', ({ log, retry }) => {
    expect(retryLog(log)).toBe(retry);
  });
});
