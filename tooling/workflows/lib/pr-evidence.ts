/**
 * A pull request body's Evidence section: one bullet per landed issue, its
 * tracer test seen red then green, as its tdd reported it
 * ({@link TddEvidence}).
 *
 * **Guarded at render time.** Nothing upstream tells a complete tracer from a
 * half-filled one (the evidence's shape: `TddEvidenceSchema` in
 * `tooling/workflows/schemas/agent-outputs.ts`), so this render does: an
 * empty claim never reads as evidence.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { TddEvidence } from './agent-calls.js';

/**
 * One landed issue's Evidence bullet.
 *
 * @returns A `tracer` per {@link tracerBullet}. A `none` as the one line
 *   `- **#N** no red-green — <reason>`, the reason per {@link oneLine};
 *   `no reason given` when that is empty.
 */
export function evidenceBullet(issue: number, evidence: TddEvidence): string[] {
  const ref = `#${String(issue)}`;
  if (evidence.kind === 'none') {
    const reason = oneLine(evidence.reason);
    return [`- **${ref}** no red-green — ${reason === '' ? 'no reason given' : reason}`];
  }
  return tracerBullet(ref, evidence);
}

/**
 * A tracer's bullet; the one line `- **#N** evidence incomplete` instead when the test is blank,
 * or the red or the green is empty per {@link oneLine}.
 */
function tracerBullet(ref: string, evidence: TddEvidence): string[] {
  const red = oneLine(evidence.red);
  const green = oneLine(evidence.green);
  if (evidence.test.trim() === '' || red === '' || green === '') {
    return [`- **${ref}** evidence incomplete`];
  }
  return [
    `- **${ref}** ${codeSpan(evidence.test)}`,
    ...codeBlock(evidence.pseudocode),
    `  **Before:** ${red}`,
    `  **After:** ${green}`,
  ];
}

/** The pseudocode as a fenced block nested in the bullet; none for blank pseudocode. */
function codeBlock(pseudocode: string): string[] {
  if (pseudocode.trim() === '') return [];
  const fence = codeFence(pseudocode);
  return [
    `  ${fence}text`,
    ...pseudocode
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => `  ${line}`),
    `  ${fence}`,
  ];
}

/** The fence no backtick run in the pseudocode can close: one longer, at least three. */
function codeFence(pseudocode: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(pseudocode) + 1));
}

/**
 * A text as an inline code span no backtick in it can close.
 *
 * @param text - The text, verbatim.
 * @returns The text between single backticks when it holds none. Else
 *   between runs one longer than its longest backtick run, padded one space
 *   each side (CommonMark strips one; a backtick-edged text needs the pad).
 */
export function codeSpan(text: string): string {
  const longest = longestBacktickRun(text);
  if (longest === 0) return `\`${text}\``;
  const delimiter = '`'.repeat(longest + 1);
  return `${delimiter} ${text} ${delimiter}`;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/**
 * A text on one line.
 *
 * @returns Its LF- or CRLF-separated lines, each trimmed, the empty ones
 *   dropped, joined with one space.
 */
export function oneLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}
