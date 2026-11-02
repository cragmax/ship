/** Pure string helpers. Importing nothing, they load no `execa`. */

/**
 * Convert a filesystem path to POSIX separators for stable display and
 * matching across platforms.
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Locale-independent string order (UTF-16 code-unit comparison), as a
 * comparator composable into tie-breaks. Used instead of `localeCompare`,
 * whose locale-dependent order would defeat reproducibility across platforms:
 * these are ASCII file paths and identifiers, not display text.
 *
 * @returns `-1`, `0`, or `1`.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;

  return 0;
}

/** Sort and deduplicate by code unit. */
export function sortedSet(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(compareStrings);
}
