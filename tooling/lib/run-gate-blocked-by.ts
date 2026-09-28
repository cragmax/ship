/**
 * Parser for an issue body's `## Blocked by` section — the hand-written half
 * of an issue's blockers. The native `blockedBy` links are the other half,
 * unioned in by `tooling/lib/run-gate-gh.ts`.
 *
 * **Grammar.** CRLF is normalised first. A section opens at an ATX heading
 * (any level) whose text is `Blocked by`, case-insensitive, trailing
 * whitespace tolerated. It closes at the next ATX heading of any level, at a
 * line starting `<details` (where triage appends the "Original report" tail),
 * or at EOF. Within a section, a blocker is the **leading
 * ref run** of a line: after optional indentation and an optional list marker
 * (`-`, `*`, `+` or `N.`), the text must start with `#N`; further `#N` refs
 * joined by `,`, `&` or `and` extend the run. Each ref may be wrapped in
 * backticks or `**`. Several sections are unioned.
 *
 * **Deliberately ignored.** Refs after the leading run (a trailing
 * parenthetical), and every line whose text does not start with a ref — prose
 * such as `None — can start immediately. (#708 … is Related)`,
 * `Soft dependency on #N`, `NOT blocked by #N` or `Runs in parallel with #N`,
 * all of which occur in real bodies naming issues that are not blockers. A
 * blocker named mid-sentence is therefore missed on purpose; native links are
 * unioned in regardless.
 *
 * **Over-reading is the safe direction.** A stray `#N` opening a line inside
 * the section is read as a blocker: that refuses the run loudly, where a
 * missed blocker would let it start silently.
 */

const HEADING_PREFIX = /^ {0,3}#{1,6}(?=\s|$)/;
const DETAILS = /^\s*<details\b/i;
const LIST_MARKER = /^(?:[-*+]|\d+\.)[ \t]+/;
const REF = /`#(\d+)`|\*\*#(\d+)\*\*|#(\d+)\b/y;
const SEPARATOR = /\s*(?:,\s*and\b|,|&|and\b)\s*/y;

/**
 * Parse the blocker issue numbers out of an issue body's `## Blocked by`
 * section(s), per the grammar in the file header.
 *
 * @param body - The issue body markdown (LF or CRLF).
 * @returns The blocker numbers, deduped, ascending; `[]` when the body has no
 *   section.
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
 * The leading ref run of one line, list marker optional.
 *
 * @param line - One body line.
 * @returns The run's issue numbers; `[]` when the line's text does not start
 *   with a ref.
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
