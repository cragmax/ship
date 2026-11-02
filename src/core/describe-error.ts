/** An error formatter shared by Ship's CLIs. */

/**
 * Describe an error: its message, plus its errno `code` when it carries one.
 *
 * @returns `message [CODE]`, `message`, or `String(error)` for a non-Error.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';

    return `${error.message}${code}`;
  }

  return String(error);
}
