/**
 * CLI shell of the `commit-msg` hook: the message file named by argv and the repo state in, the
 * decision from the pure core `hooks/lib/commit-msg.ts`, refusals out. A merge commit,
 * clean or concluded, runs the hook with `MERGE_HEAD` set and skips both checks.
 *
 * Exit 0: the commit may proceed. Exit 1: refused, one stderr line per problem, or one
 * `commit-msg: ` line carrying the error when the message file cannot be read (fail closed).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { checkCommit } from './lib/commit-msg.js';

function main(): void {
  try {
    if (gitOut(['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== null) return;
    const problems = checkCommit({
      message: readFileSync(process.argv[2] ?? '', 'utf8'),
      branch: gitOut(['symbolic-ref', '--short', '-q', 'HEAD']),
      headVersion: versionAt('HEAD:'),
      stagedVersion: versionAt(':'),
    });

    for (const p of problems) process.stderr.write(`commit-msg: ${p}\n`);
    if (problems.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`commit-msg: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/** Git's stdout for `args`, trimmed, or `null` on a non-zero exit. */
function gitOut(args: readonly string[]): string | null {
  const r = spawnSync('git', args, { encoding: 'utf8' });

  return r.status === 0 ? r.stdout.trim() : null;
}

/** `package.json`'s `version` at `HEAD:` or in the index (`:`), or `null` if unreadable. */
function versionAt(prefix: string): string | null {
  const text = gitOut(['show', `${prefix}package.json`]);
  if (text === null) return null;

  try {
    const { version } = JSON.parse(text) as { version?: unknown };

    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

main();
