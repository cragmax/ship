/**
 * Pure core of the `commit-msg` hook: a commit's first line follows `<type>(<scope>): <subject>`,
 * and on `master` its version bump matches its type, since a push to `master` publishes that
 * version. A branch commit skips the bump check: the branch bumps once, on `master`.
 */

/** The commit types. `fix` bumps the patch and `feat` the minor, every other type nothing. */
const COMMIT_TYPES = ['fix', 'feat', 'refactor', 'test', 'docs', 'chore'] as const;

/** The commit scopes. */
const COMMIT_SCOPES = ['workflow', 'cli', 'agents', 'build', 'tests', 'docs'] as const;

/** What the hook knows about the commit being made. */
export interface CommitFacts {
  /** The message file's text. */
  readonly message: string;
  /** The checked-out branch's short name, `null` when `HEAD` is detached. */
  readonly branch: string | null;
  /** `package.json`'s version at `HEAD`, `null` when there is no `HEAD` or no readable version. */
  readonly headVersion: string | null;
  /** The staged `package.json`'s version, `null` when it has none readable. */
  readonly stagedVersion: string | null;
}

const FIRST_LINE = new RegExp(
  `^(${COMMIT_TYPES.join('|')})\\((${COMMIT_SCOPES.join('|')})\\): \\S`,
  'u',
);

/**
 * Check a commit against the commit rules.
 *
 * @returns One line per problem, empty when the commit may proceed.
 */
export function checkCommit(facts: CommitFacts): string[] {
  const line = firstLine(facts.message);
  const match = FIRST_LINE.exec(line);

  if (match === null) {
    return [
      `first line '${line}' is not '<type>(<scope>): <subject>'; ` +
        `types: ${COMMIT_TYPES.join(', ')}; scopes: ${COMMIT_SCOPES.join(', ')}`,
    ];
  }

  if (facts.branch !== 'master' || facts.headVersion === null) return [];
  const type = match[1] ?? '';
  const want = expectedVersion(type, facts.headVersion);
  if (want === null || facts.stagedVersion === want) return [];

  return [
    `a ${type} commit on master stages version ${want} over HEAD's ${facts.headVersion}, ` +
      `not ${facts.stagedVersion ?? 'none'}: ${bumpHint(type)}`,
  ];
}

/** The fix for a wrong bump, naming the npm command when one bump would fix it. */
function bumpHint(type: string): string {
  if (type === 'fix' || type === 'feat') {
    const level = type === 'fix' ? 'patch' : 'minor';

    return `run \`npm version ${level} --no-git-tag-version\`, then stage package.json and package-lock.json`;
  }

  return `a ${type} commit does not bump: stage package.json at HEAD's version`;
}

/**
 * The version a commit of `type` must stage over `head`.
 *
 * @returns `head` bumped by one patch (`fix`) or one minor with patch 0 (`feat`), else `head`,
 *   or `null` when `head` is not `x.y.z`.
 */
function expectedVersion(type: string, head: string): string | null {
  const v = parseVersion(head);
  if (v === null) return null;
  const [major, minor, patch] = v;
  if (type === 'fix') return `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  if (type === 'feat') return `${String(major)}.${String(minor + 1)}.0`;

  return head;
}

/** `x.y.z` as three numbers, `null` for any other shape. */
function parseVersion(version: string): readonly [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);

  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The first line git keeps: the first that is neither blank nor a `#` comment. */
function firstLine(message: string): string {
  return message.split('\n').find((line) => line.trim() !== '' && !line.startsWith('#')) ?? '';
}
