/**
 * Plain fixture repos (per-test `mkdtemp` roots), each with a bare `origin`;
 * the check runs in-process except for one CLI spawn.
 *
 * @integrationTier standalone
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toPosix } from '../../tooling/shared.js';
import { checkMaster } from '../../tooling/worktree/check-master.js';
import type { CheckMasterResult } from '../../tooling/worktree/types-run.js';
import {
  advanceOrigin,
  commitChanges,
  headSha,
  makeBareOrigin,
  makeGitRepo,
} from '../helpers/worktree-fixture-git.js';
import { addWorktree, mustRun, runCli } from '../helpers/worktree-fixture.js';

const TIMEOUT = { timeout: 60_000 };
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GHOST = '0123456789abcdef0123456789abcdef01234567';

let root: string;
let main: string;
let bare: string;
let first: string;

beforeEach(() => {
  root = toPosix(mkdtempSync(join(tmpdir(), 'ph-wt-master-')));
  main = makeGitRepo(root, { 'base.txt': 'base\n' });
  bare = makeBareOrigin(root, main);
  first = headSha(main);
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a lock on a just-used directory; the leak
    // is a bounded temp dir.
  }
});

describe('check-master', () => {
  it('refuses a local master rewound since the launch, naming both shas, exit 1', TIMEOUT, () => {
    const second = commitChanges(main, { write: { 'local.txt': 'local\n' } }, 'maintainer commit');
    mustRun('git', ['update-ref', 'refs/heads/master', first], main);
    // Three distinct shas, so a flag read into the wrong field shows.
    const synced = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });

    const r = runCli<CheckMasterResult>([
      'check-master',
      main,
      '--local',
      second,
      '--remote',
      first,
      '--synced',
      synced,
    ]);

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      status: 'refused',
      reason: 'master-not-forward',
      local: { launch: second, synced: null, current: first, move: 'rewound' },
      remote: { launch: first, synced, current: synced, move: 'equal' },
      errors: [
        {
          step: 'check',
          message: `master is not forward of its launch: local rewound (launch ${second}, now ${first})`,
        },
      ],
      at: expect.stringMatching(ISO_INSTANT),
    });
  });

  it('refuses to run without --synced, exit 2', TIMEOUT, () => {
    const r = runCli<CheckMasterResult>([
      'check-master',
      main,
      '--local',
      first,
      '--remote',
      first,
    ]);

    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({
      command: 'check-master',
      status: 'failed',
      worktree: null,
      errors: [{ step: 'usage', message: 'missing required flag --synced' }],
    });
  });

  it('passes both refs level with their launch as equal', TIMEOUT, () => {
    expect(checkMaster({ main, local: first, remote: first, synced: first })).toEqual({
      command: 'check-master',
      status: 'ok',
      worktree: main,
      errors: [],
      local: { launch: first, synced: null, current: first, move: 'equal' },
      remote: { launch: first, synced: first, current: first, move: 'equal' },
    });
  });

  it('passes a maintainer commit on local master as forward', TIMEOUT, () => {
    const next = commitChanges(main, { write: { 'local.txt': 'l\n' } }, 'maintainer commit');

    const r = checkMaster({ main, local: first, remote: first, synced: first });

    expect(r.status).toBe('ok');
    expect(r.local).toEqual({ launch: first, synced: null, current: next, move: 'forward' });
  });

  it('fetches a remote master it has not seen, then passes it as forward', TIMEOUT, () => {
    const pushed = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });

    const r = checkMaster({ main, local: first, remote: first, synced: first });

    expect(r.status).toBe('ok');
    expect(r.remote).toEqual({ launch: first, synced: first, current: pushed, move: 'forward' });
  });

  it(
    "refuses origin's master rewound since the launch, even level with the synced sha",
    TIMEOUT,
    () => {
      const pushed = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });
      mustRun('git', ['fetch', '-q', 'origin'], main);
      mustRun('git', ['update-ref', 'refs/heads/master', first], bare);

      const r = checkMaster({ main, local: first, remote: pushed, synced: first });

      expect(r).toMatchObject({ status: 'refused', reason: 'master-not-forward' });
      expect(r.remote).toEqual({ launch: pushed, synced: first, current: first, move: 'rewound' });
      expect(r.errors[0]?.message).toBe(
        `master is not forward of its launch: origin rewound (launch ${pushed}, synced ${first}, now ${first})`,
      );
    },
  );

  it('refuses origin rewound to its launch sha behind the synced sha', TIMEOUT, () => {
    const synced = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });
    mustRun('git', ['fetch', '-q', 'origin'], main);
    mustRun('git', ['update-ref', 'refs/heads/master', first], bare);

    const r = checkMaster({ main, local: first, remote: first, synced });

    expect(r).toMatchObject({ status: 'refused', reason: 'master-not-forward' });
    expect(r.remote).toEqual({ launch: first, synced, current: first, move: 'rewound' });
    expect(r.errors[0]?.message).toBe(
      `master is not forward of its launch: origin rewound (launch ${first}, synced ${synced}, now ${first})`,
    );
  });

  it(
    'refuses origin force-moved to a descendant of its launch lacking the synced sha',
    TIMEOUT,
    () => {
      const synced = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });
      mustRun('git', ['fetch', '-q', 'origin'], main);
      mustRun('git', ['update-ref', 'refs/heads/master', first], bare);
      const other = advanceOrigin(root, bare, { write: { 'other.txt': 'o\n' } });

      const r = checkMaster({ main, local: first, remote: first, synced });

      expect(r).toMatchObject({ status: 'refused', reason: 'master-not-forward' });
      expect(r.remote).toEqual({ launch: first, synced, current: other, move: 'rewound' });
    },
  );

  it('passes origin at the synced sha as equal', TIMEOUT, () => {
    const synced = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });

    const r = checkMaster({ main, local: first, remote: first, synced });

    expect(r.status).toBe('ok');
    expect(r.remote).toEqual({ launch: first, synced, current: synced, move: 'equal' });
  });

  it('passes origin forward of the synced sha as forward', TIMEOUT, () => {
    const synced = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });
    const later = advanceOrigin(root, bare, { write: { 'later.txt': 'l\n' } });

    const r = checkMaster({ main, local: first, remote: first, synced });

    expect(r.status).toBe('ok');
    expect(r.remote).toEqual({ launch: first, synced, current: later, move: 'forward' });
  });

  it('fetches a synced sha it has not seen before judging it', TIMEOUT, () => {
    const synced = advanceOrigin(root, bare, { write: { 'remote.txt': 'r\n' } });
    // Kept on another origin branch: origin's master back at the launch needs
    // no fetch, so only the synced comparison's own fetch can find it.
    mustRun('git', ['update-ref', 'refs/heads/kept', synced], bare);
    mustRun('git', ['update-ref', 'refs/heads/master', first], bare);

    const r = checkMaster({ main, local: first, remote: first, synced });

    expect(r).toMatchObject({ status: 'refused', reason: 'master-not-forward' });
    expect(r.remote).toEqual({ launch: first, synced, current: first, move: 'rewound' });
  });

  it('refuses a synced sha missing even after a fetch as undecidable', TIMEOUT, () => {
    const r = checkMaster({ main, local: first, remote: first, synced: GHOST });

    expect(r.status).toBe('refused');
    expect(r.remote).toEqual({ launch: first, synced: GHOST, current: first, move: 'undecidable' });
    expect(r.errors[0]?.message).toBe(
      `master is not forward of its launch: origin undecidable (launch ${first}, synced ${GHOST}, now ${first})`,
    );
  });

  it.each([
    {
      which: 'local',
      named: 'local',
      other: 'remote',
      synced: false,
      remove: () => {
        mustRun('git', ['checkout', '-q', '--detach'], main);
        mustRun('git', ['update-ref', '-d', 'refs/heads/master'], main);
      },
    },
    {
      which: 'origin',
      named: 'remote',
      other: 'local',
      synced: true,
      remove: () => mustRun('git', ['update-ref', '-d', 'refs/heads/master'], bare),
    },
  ] as const)(
    'refuses a deleted $which master',
    TIMEOUT,
    ({ which, named, other, synced, remove }) => {
      remove();

      const r = checkMaster({ main, local: first, remote: first, synced: first });
      const shown = synced ? `, synced ${first}` : '';

      expect(r).toMatchObject({ status: 'refused', reason: 'master-not-forward' });
      expect(r[named]).toEqual({
        launch: first,
        synced: synced ? first : null,
        current: null,
        move: 'deleted',
      });
      expect(r[other]?.move).toBe('equal');
      expect(r.errors[0]?.message).toBe(
        `master is not forward of its launch: ${which} deleted (launch ${first}${shown}, now deleted)`,
      );
    },
  );

  it('refuses both refs at once, naming each in one message', TIMEOUT, () => {
    const second = commitChanges(main, { write: { 'local.txt': 'local\n' } }, 'maintainer commit');
    mustRun('git', ['update-ref', 'refs/heads/master', first], main);
    mustRun('git', ['update-ref', '-d', 'refs/heads/master'], bare);

    const r = checkMaster({ main, local: second, remote: first, synced: first });

    expect(r).toMatchObject({ status: 'refused', reason: 'master-not-forward' });
    expect(r.local).toEqual({ launch: second, synced: null, current: first, move: 'rewound' });
    expect(r.remote).toEqual({ launch: first, synced: first, current: null, move: 'deleted' });
    expect(r.errors[0]?.message).toBe(
      `master is not forward of its launch: local rewound (launch ${second}, now ${first}); origin deleted (launch ${first}, synced ${first}, now deleted)`,
    );
  });

  it('refuses a launch sha missing even after a fetch as undecidable', TIMEOUT, () => {
    const r = checkMaster({ main, local: first, remote: GHOST, synced: first });

    expect(r.status).toBe('refused');
    expect(r.remote).toEqual({ launch: GHOST, synced: first, current: first, move: 'undecidable' });
    expect(r.errors[0]?.message).toBe(
      `master is not forward of its launch: origin undecidable (launch ${GHOST}, synced ${first}, now ${first})`,
    );
  });

  it('fails at step ls-remote when origin cannot be reached, never passing', TIMEOUT, () => {
    mustRun('git', ['remote', 'set-url', 'origin', `${root}/missing.git`], main);

    const r = checkMaster({ main, local: first, remote: first, synced: first });

    expect(r.status).toBe('failed');
    expect(r.local).toEqual({ launch: first, synced: null, current: first, move: 'equal' });
    expect(r.remote).toBeNull();
    expect(r.errors[0]?.step).toBe('ls-remote');
    expect(r.errors[0]?.message).toMatch(/^git ls-remote origin refs\/heads\/master exited /);
  });

  it.each([
    {
      target: 'a linked worktree',
      path: () => addWorktree(main, `${root}/linked`, 'other'),
      outcome: { status: 'refused', reason: 'not-main-worktree' },
    },
    {
      target: 'a missing directory',
      path: () => `${root}/missing`,
      outcome: { status: 'failed', errors: [{ step: 'preconditions' }] },
    },
  ])('stops on $target before reading either ref', TIMEOUT, ({ path, outcome }) => {
    const r = checkMaster({ main: path(), local: first, remote: first, synced: first });

    expect(r).toMatchObject({ ...outcome, local: null, remote: null });
  });
});
