/**
 * An error formatter shared by the tooling and evals CLIs. Dependency-free, so
 * a module on the evals dry-run path (`evals/cli-support.ts`) uses it without
 * loading rcon-client.
 */

/**
 * Describe an error: its message, plus its errno `code` when it carries one.
 *
 * @param error - Anything thrown or reported.
 * @returns `message [CODE]`, `message`, or `String(error)` for a non-Error.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';
    return `${error.message}${code}`;
  }
  return String(error);
}
