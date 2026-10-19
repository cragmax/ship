import { existsSync, writeFileSync } from 'node:fs';

import { ESLINT_SUPPRESSIONS } from '../../core/generated-files.js';
import { sortedSet } from '../../../../tooling/shared.js';

import { NPM_TIMEOUT_MS, runStep } from '../git/exec.js';
import { git } from '../git/git.js';

/** ESLint's suppressions file: file → rule → suppressed count. */
type Suppressions = Record<string, Record<string, { count: number }>>;

/**
 * Write and stage the merged suppressions file over a cherry-pick conflict.
 *
 * @param batch - The batch worktree, mid-pick, with `eslint-suppressions.json`
 *   its only unmerged path.
 * @throws StepFailure `suppressions` when git or ESLint fails — ESLint fails
 *   on an unsuppressed lint error in a file whose entries the sides disagree on.
 */
export function regenerateSuppressions(batch: string): void {
  const stage = (n: number): Suppressions =>
    JSON.parse(
      git(batch, ['show', `:${String(n)}:${ESLINT_SUPPRESSIONS}`], 'suppressions'),
    ) as Suppressions;
  const ours = stage(2);
  const theirs = stage(3);
  const keys = sortedSet([...Object.keys(ours), ...Object.keys(theirs)]).filter((key) =>
    existsSync(`${batch}/${key}`),
  );
  const merged: Suppressions = {};
  for (const key of keys) {
    const rules = sortedSet([...Object.keys(ours[key] ?? {}), ...Object.keys(theirs[key] ?? {})]);
    merged[key] = Object.fromEntries(
      rules.map((rule) => [
        rule,
        // `--prune-suppressions` only lowers a count, never raises one: start
        // from the larger side's, and the prune below fits it to the merged tree.
        { count: Math.max(ours[key]?.[rule]?.count ?? 0, theirs[key]?.[rule]?.count ?? 0) },
      ]),
    );
  }
  const changed = keys.filter((key) => JSON.stringify(ours[key]) !== JSON.stringify(theirs[key]));
  writeFileSync(`${batch}/${ESLINT_SUPPRESSIONS}`, JSON.stringify(merged, null, 2));
  if (changed.length > 0) {
    runStep('suppressions', 'npx', ['eslint', '--prune-suppressions', ...changed], {
      cwd: batch,
      timeoutMs: NPM_TIMEOUT_MS,
    });
  }
  git(batch, ['add', '--', ESLINT_SUPPRESSIONS], 'suppressions');
}
