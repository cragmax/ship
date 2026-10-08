/**
 * `npx tsx tooling/comment-only.ts [--cached] [<base>] | <base>..<head>` — prove a change to
 * TypeScript files is comment-only ({@link proveCommentOnly}); with no head it reads the
 * working tree, or the staged index under `--cached`.
 *
 * Exit 0: stdout lists each `not compared: <path>`, then the count of token-identical files.
 * Exit 1: one stderr line naming the first code difference. Exit 2: a usage error or a git
 * failure, its detail on the following lines. `main` sets `process.exitCode`, never
 * `process.exit()`, so output is flushed in full.
 */

import { formatDifference, parseRevisions, proveCommentOnly } from './lib/comment-only.js';
import { describeError } from './lib/describe-error.js';
import { StepFailure } from './worktree/types.js';

function main(): void {
  try {
    const report = proveCommentOnly(process.cwd(), parseRevisions(process.argv.slice(2)));
    for (const path of report.notCompared) process.stdout.write(`not compared: ${path}\n`);
    if (report.difference !== null) {
      process.stderr.write(`comment-only: ${formatDifference(report.difference)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `comment-only: ${String(report.compared)} TypeScript files token-identical\n`,
    );
  } catch (error) {
    const detail = error instanceof StepFailure && error.detail ? `\n${error.detail}` : '';
    process.stderr.write(`comment-only: ${describeError(error)}${detail}\n`);
    process.exitCode = 2;
  }
}

main();
