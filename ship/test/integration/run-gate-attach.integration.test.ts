/**
 * A throwaway repo per test (`mkdtemp`), its `origin/*` refs written with `update-ref`; the run
 * gate's landed set is resolved through the CLI's real git port, `gh` faked.
 *
 * @integrationTier standalone
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gitIn } from '../../src/cli/run-gate.js';
import { gatherAndEvaluate, landedIssues, type GhJson } from '../../src/cli/run-gate-gh.js';
import { commitChanges, makeGitRepo } from '../../../tooling/test/helpers/worktree-fixture-git.js';
import { mustRun } from '../../../tooling/test/helpers/worktree-fixture.js';
import { makeTempRoot, removeTempDirs } from '../helpers/worktree-cli-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const TARGET = 'ship/epic-9';

let root: string;
let repo: string;

beforeEach(() => {
  root = makeTempRoot('ph-run-gate-attach-');
  repo = makeGitRepo(root, {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDirs([root]);
});

describe('gatherAndEvaluate in an attached run', () => {
  it(
    'an OPEN out-of-set blocker landed fixes #N on the attach branch satisfies the gate',
    TIMEOUT,
    async () => {
      publishMaster();
      mustRun('git', ['checkout', '-q', '-b', TARGET], repo);
      commitChanges(repo, {}, 'fix(build): land the blocker\n\nfixes #90');
      publishTarget();

      const verdict = await gatherAndEvaluate(
        { kind: 'issues', issues: [3] },
        'refuse',
        BLOCKED_BY_90,
        {
          branch: TARGET,
          git: gitIn(repo),
        },
      );

      expect(verdict).toEqual({
        verdict: 'ok',
        mode: 'refuse',
        runSet: [{ epic: null, issues: [3] }],
        edges: [],
        failures: [],
        excluded: [],
      });
    },
  );
});

describe('landedIssues', () => {
  it(
    'holds a fixes #N commit on the target, never a see #N one, one on origin/master, a merge or a merged side commit',
    TIMEOUT,
    async () => {
      commitChanges(repo, {}, 'fix(build): already on master\n\nfixes #13');
      publishMaster();
      mustRun('git', ['checkout', '-q', '-b', TARGET], repo);
      commitChanges(repo, {}, 'fix(build): land eleven\n\nfixes #11');
      commitChanges(repo, {}, 'fix(build): part of twelve\n\nsee #12');
      mustRun('git', ['checkout', '-q', '-b', 'side'], repo);
      commitChanges(repo, {}, 'fix(build): side commit\n\nfixes #15');
      mustRun('git', ['checkout', '-q', TARGET], repo);
      mustRun('git', ['merge', '-q', '--no-ff', 'side', '-m', 'merge side\n\nfixes #14'], repo);
      publishTarget();

      expect(await landedIssues(TARGET, gitIn(repo))).toEqual(new Set([11]));
    },
  );

  it(
    'reads its own repository when GIT_DIR points at another, as a git hook exports',
    TIMEOUT,
    async () => {
      const foreign = makeTempRoot('ph-run-gate-foreign-');

      try {
        mustRun('git', ['init', '-q', '-b', 'master'], foreign);
        publishMaster();
        mustRun('git', ['checkout', '-q', '-b', TARGET], repo);
        commitChanges(repo, {}, 'fix(build): land eleven\n\nfixes #11');
        publishTarget();
        vi.stubEnv('GIT_DIR', join(foreign, '.git'));

        expect(await landedIssues(TARGET, gitIn(repo))).toEqual(new Set([11]));
      } finally {
        removeTempDirs([foreign]);
      }
    },
  );

  it('rejects, carrying git’s stderr, when the target branch is unknown', TIMEOUT, async () => {
    publishMaster();

    await expect(landedIssues(TARGET, gitIn(repo))).rejects.toThrow(
      /^run-gate: git log .* failed: fatal: .*unknown revision/,
    );
  });
});

/** Issue 3, OPEN and ready, blocked by issue 90, which is OPEN. */
const BLOCKED_BY_90: GhJson = (args) => {
  const issue = Number(args[2]);
  if (issue === 90) return Promise.resolve({ number: 90, state: 'OPEN' });

  return Promise.resolve({
    number: 3,
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
    body: '## Blocked by\n\n- #90\n',
    blockedBy: { nodes: [], totalCount: 0 },
  });
};

/** Point `origin/master` at `HEAD`. */
function publishMaster(): void {
  mustRun('git', ['update-ref', 'refs/remotes/origin/master', 'HEAD'], repo);
}

/** Point `origin/<TARGET>` at `HEAD`. */
function publishTarget(): void {
  mustRun('git', ['update-ref', `refs/remotes/origin/${TARGET}`, 'HEAD'], repo);
}
