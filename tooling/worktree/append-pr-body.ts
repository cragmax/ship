/**
 * `append-pr-body <batch> --pr N --section-file F` — append an attached
 * run's section to its open PR's body (ADR-0045 decision 12). `gh` sets a
 * body only whole (`gh pr edit --body-file`; it has no text-append flag), so
 * the command reads the body and sets it back with the section after it.
 *
 * Order: read the section file, read the PR's body
 * (`gh pr view --json body`), write the new body to a body file, refuse it
 * when it is over {@link GH_BODY_LIMIT}, then `gh pr edit`; the first failed
 * step ends the command `failed` ({@link appendPrBody}).
 *
 * The body as `gh` read it is the new body's prefix byte for byte
 * ({@link appendSection}), so a body neutralised when it was written is
 * never touched again. It mutates no worktree — the batch is only `gh`'s working directory — so it has no
 * linked-worktree or self-hosted guard. The body file lives in a fresh OS
 * temp directory (`freshLogDir`) the command never removes: it is the
 * caller's to read.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import { describeError } from '../lib/describe-error.js';

import { freshLogDir, GH_BODY_LIMIT, GH_TIMEOUT_MS, runCaptured } from './exec.js';
import type { AppendPrBodyResult } from './types-run.js';
import { recordFailure, StepFailure } from './types.js';

/** `gh pr view --json body` output; unknown keys are tolerated. */
const PrBodySchema = z.object({ body: z.string() });

/** Inputs of {@link appendPrBody}; paths absolute with forward slashes. */
export interface AppendPrBodyInput {
  /** The batch worktree: only `gh`'s working directory. */
  readonly batch: string;
  /** The open PR. */
  readonly pr: number;
  /** The section to append. */
  readonly sectionFile: string;
}

/**
 * Append the section to the PR's body.
 *
 * @param input - The batch, the PR and the section file.
 * @returns The envelope: `ok` with `bodyFile`; or `failed` with the step —
 *   `section` or `pr-body` (`bodyFile` null, no edit made, the PR
 *   untouched), `internal` when the body file cannot be written (no edit
 *   made), `body-too-long` when the new body is over {@link GH_BODY_LIMIT}
 *   characters — exactly the limit is allowed (`bodyFile` set and named in
 *   the error, no edit made, the PR untouched) — or `pr-edit` (`bodyFile`
 *   set and named in the error, so the caller can set the body by hand).
 */
export function appendPrBody(input: AppendPrBodyInput): AppendPrBodyResult {
  const { batch, pr } = input;
  const result: AppendPrBodyResult = {
    command: 'append-pr-body',
    status: 'ok',
    worktree: batch,
    errors: [],
    pr,
    bodyFile: null,
  };
  try {
    const section = readSection(input.sectionFile);
    const body = readPrBody(batch, pr);
    const file = `${freshLogDir('append-pr-body')}/pr-body.md`;
    const newBody = appendSection(body, section);
    writeFileSync(file, newBody);
    result.bodyFile = file;
    if (newBody.length > GH_BODY_LIMIT) {
      throw new StepFailure(
        'body-too-long',
        `new body is ${String(newBody.length)} characters, over GitHub's ${String(GH_BODY_LIMIT)}-character limit; the body is in ${file}`,
      );
    }
    editPrBody(batch, pr, file);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * A PR body with a section appended, the body kept byte for byte as the
 * prefix — never trimmed, never neutralised.
 *
 * @param body - The PR's body as `gh` read it.
 * @param section - The section.
 * @returns `section` alone for an empty body; otherwise the body, one blank
 *   line (a body ending in `\n`, a CRLF body included, gains one `\n`; any
 *   other gains two), then the section.
 */
export function appendSection(body: string, section: string): string {
  if (body === '') return section;
  return `${body}${body.endsWith('\n') ? '\n' : '\n\n'}${section}`;
}

/**
 * Read the section file.
 *
 * @param file - The section file.
 * @returns Its text.
 * @throws StepFailure `section` when it cannot be read or is blank.
 */
function readSection(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new StepFailure('section', `section file ${file} unreadable: ${describeError(err)}`);
  }
  if (text.trim() === '') throw new StepFailure('section', `section file ${file} is empty`);
  return text;
}

/**
 * One `gh pr view <pr> --json body`.
 *
 * @param batch - `gh`'s working directory.
 * @param pr - The PR.
 * @returns Its body, as `gh` printed it.
 * @throws StepFailure `pr-body` when `gh` fails or prints no readable body
 *   JSON; the message never carries `gh`'s stdout, which can be large.
 */
function readPrBody(batch: string, pr: number): string {
  const r = runCaptured('gh', ['pr', 'view', String(pr), '--json', 'body'], {
    cwd: batch,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw new StepFailure(
      'pr-body',
      `gh pr view ${String(pr)} exited ${String(r.exitCode)}`,
      r.tail,
    );
  }
  const body = parseBody(r.stdout);
  if (body === null) {
    throw new StepFailure('pr-body', `gh pr view ${String(pr)} printed no readable body JSON`);
  }
  return body;
}

/**
 * Parse `gh pr view --json body` output.
 *
 * @param stdout - `gh`'s stdout.
 * @returns The body, or `null` unless it is JSON matching {@link PrBodySchema}.
 */
function parseBody(stdout: string): string | null {
  try {
    const parsed = PrBodySchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.body : null;
  } catch {
    return null;
  }
}

/**
 * One `gh pr edit <pr> --body-file <file>`.
 *
 * @param batch - `gh`'s working directory.
 * @param pr - The PR.
 * @param file - The whole new body.
 * @throws StepFailure `pr-edit` on a non-zero exit, naming the body file.
 */
function editPrBody(batch: string, pr: number, file: string): void {
  const r = runCaptured('gh', ['pr', 'edit', String(pr), '--body-file', file], {
    cwd: batch,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw new StepFailure(
      'pr-edit',
      `gh pr edit ${String(pr)} exited ${String(r.exitCode)}; the body is in ${file}`,
      r.tail,
    );
  }
}
