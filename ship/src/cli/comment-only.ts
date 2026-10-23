/**
 * `npx tsx ship/src/cli/comment-only.ts [--json] [--cached] [<base>] | <base>..<head>` — prove a
 * change to TypeScript files is comment-only ({@link proveCommentOnly}); with no head it reads the
 * working tree, or the staged index under `--cached`.
 *
 * Exit 0: stdout lists each `not compared: <path>`, then the count of token-identical files.
 * Exit 1: one stderr line naming the first code difference, or else one line per mojibake
 * hit (`<path>:<line>`). Exit 2: a usage error or a git failure, its detail on the following
 * lines. With `--json` (first), stdout is instead one JSON object `{ compared, notCompared }` on
 * exit 0 and 1 alike, and empty on exit 2; stderr is unchanged. `main` sets `process.exitCode`,
 * never `process.exit()`, so output is flushed in full.
 */

import {
  type CommentOnlyReport,
  formatDifference,
  formatMojibake,
  parseRevisions,
  proveCommentOnly,
} from './comment-only.core.js';
import { describeError } from '../core/describe-error.js';
import { StepFailure } from './envelope/types.js';

function writeFailures(report: CommentOnlyReport): boolean {
  if (report.difference !== null) {
    process.stderr.write(`comment-only: ${formatDifference(report.difference)}\n`);

    return true;
  }

  for (const m of report.mojibake) process.stderr.write(`comment-only: ${formatMojibake(m)}\n`);

  return report.mojibake.length > 0;
}

function writeReport(report: CommentOnlyReport, json: boolean): boolean {
  const { compared, notCompared } = report;
  if (json) process.stdout.write(`${JSON.stringify({ compared, notCompared })}\n`);
  else for (const path of notCompared) process.stdout.write(`not compared: ${path}\n`);
  const failed = writeFailures(report);

  if (!failed && !json) {
    process.stdout.write(`comment-only: ${String(compared)} TypeScript files token-identical\n`);
  }

  return failed;
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args[0] === '--json';

  try {
    const report = proveCommentOnly(process.cwd(), parseRevisions(json ? args.slice(1) : args));
    if (writeReport(report, json)) process.exitCode = 1;
  } catch (error) {
    const detail = error instanceof StepFailure && error.detail ? `\n${error.detail}` : '';
    process.stderr.write(`comment-only: ${describeError(error)}${detail}\n`);
    process.exitCode = 2;
  }
}

main();
