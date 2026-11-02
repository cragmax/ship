/**
 * Parser for an issue body's `## Blocked by` section: the hand-written half of an issue's
 * blockers. The native `blockedBy` links are the other half, unioned in by
 * `ship/src/cli/run-gate-gh.ts`.
 *
 * **Deliberately ignored.** Refs after a line's leading run (a trailing parenthetical), and every
 * line whose text does not start with a ref: prose such as `Soft dependency on #N`,
 * `NOT blocked by #N` or `Runs in parallel with #N`, which occurs in real bodies naming issues
 * that are not blockers. A blocker named mid-sentence is therefore missed on purpose. Native links
 * are unioned in regardless.
 *
 * **Over-reading is the safe direction.** A stray `#N` opening a line inside the section is read
 * as a blocker: that refuses the run loudly, where a missed blocker would let it start silently.
 */

const HEADING_PREFIX = /^ {0,3}#{1,6}(?=\s|$)/;
const DETAILS = /^\s*<details\b/i;
const LIST_MARKER = /^(?:[-*+]|\d+\.)[ \t]+/;
const REF = /`#(\d+)`|\*\*#(\d+)\*\*|#(\d+)\b/y;
const SEPARATOR = /\s*(?:,\s*and\b|,|&|and\b)\s*/y;

/**
 * Parse the blocker issue numbers out of an issue body's `## Blocked by` section(s): deduped,
 * ascending, or `[]` when the body has no section.
 *
 * CRLF is normalised first. A section opens at an ATX heading (any level) whose text is
 * `Blocked by`, case-insensitive, trailing whitespace tolerated, and closes at the next ATX
 * heading, a line starting `<details` (where triage appends the "Original report" tail) or EOF.
 * Within it, a blocker is the leading ref run of a line: after optional indentation and an
 * optional list marker (`-`, `*`, `+`, or `N.`), the text starts with `#N`. Further refs joined by
 * `,`, `&`, or `and` extend the run, each ref optionally wrapped in backticks or `**`. Several
 * sections are unioned.
 */
export function parseBlockedBySection(body: string): number[] {
  const blockers = new Set<number>();
  let inSection = false;

  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = HEADING_PREFIX.exec(line);

    if (heading !== null) {
      inSection = line.slice(heading[0].length).trim().toLowerCase() === 'blocked by';
    } else if (DETAILS.test(line)) {
      inSection = false;
    } else if (inSection) {
      for (const ref of leadingRefRun(line)) blockers.add(ref);
    }
  }

  return [...blockers].sort((a, b) => a - b);
}

/**
 * The issue numbers of one line's leading ref run, list marker optional, or `[]` when the line's
 * text does not start with a ref.
 */
function leadingRefRun(line: string): number[] {
  const trimmed = line.trimStart();
  const text = trimmed.slice(LIST_MARKER.exec(trimmed)?.[0].length ?? 0);
  const refs: number[] = [];
  let at = 0;

  for (;;) {
    REF.lastIndex = at;
    const ref = REF.exec(text);
    if (ref === null) return refs;
    refs.push(Number(ref[1] ?? ref[2] ?? ref[3]));
    SEPARATOR.lastIndex = REF.lastIndex;
    if (SEPARATOR.exec(text) === null) return refs;
    at = SEPARATOR.lastIndex;
  }
}
