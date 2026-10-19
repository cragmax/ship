/**
 * The two pull request body sections the PR writer's answer fills: the
 * Summary ({@link summaryLines}) and the Merge Danger
 * ({@link mergeDangerLines}). A writer that returned nothing gets a fallback
 * line in each, so the body still says what is missing.
 *
 * Render-safe (`ship/src/build/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

import type { PrWriterOutput } from '../calls/agent-calls.js';

/**
 * The Summary section's lines.
 *
 * @param writer - The PR writer's answer; `null` when it returned none.
 * @returns For `null`, the one line
 *   `Summary unavailable — the PR writer returned nothing`; else the
 *   summary's lines per {@link textLines}, none for a blank summary.
 */
export function summaryLines(writer: PrWriterOutput | null): string[] {
  if (writer === null) return ['Summary unavailable — the PR writer returned nothing'];
  return textLines(writer.summary);
}

/**
 * The Merge Danger section's lines.
 *
 * @param writer - The PR writer's answer; `null` when it returned none.
 * @returns For `null`, the one line
 *   `Unavailable — the PR writer returned nothing`. Else `**Door:** <door>`
 *   and a blank line; the door note's lines and a blank line, when it has
 *   any; `**Blast Radius:** <blastRadius>`, trimmed; then a blank line and
 *   the ramifications' lines, when they have any. The note's and the
 *   ramifications' lines per {@link textLines}.
 */
export function mergeDangerLines(writer: PrWriterOutput | null): string[] {
  if (writer === null) return ['Unavailable — the PR writer returned nothing'];
  const note = textLines(writer.doorNote);
  const ramifications = textLines(writer.ramifications);
  return [
    `**Door:** ${writer.door}`,
    '',
    ...(note.length === 0 ? [] : [...note, '']),
    `**Blast Radius:** ${writer.blastRadius.trim()}`,
    ...(ramifications.length === 0 ? [] : ['', ...ramifications]),
  ];
}

/**
 * A text's LF- or CRLF-separated lines, outer blank lines and trailing whitespace dropped;
 * inner lines verbatim, indentation and blank lines kept. None for a blank text.
 */
function textLines(text: string): string[] {
  const trimmed = text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  return trimmed === '' ? [] : trimmed.split(/\r?\n/);
}
