/**
 * `fakeHooks` answers for driving `runResync` — the TS source in
 * `resync.test.ts`, the committed render in `resync-rendered.test.ts`: the
 * run branch's batch reused, the push `ok`, and a merge that stops on a doc
 * index for the resolver.
 */

import { BATCH, fakeHooks, REPORT_DIR, type FakeRun } from './_fake-hooks.js';

/** Fields every `ok` worktree-CLI output carries. */
export const OK = { exitCode: 0, envelopePath: 'e.json', status: 'ok', errors: [] };

/** The run branch the resync fakes attach. */
export const BRANCH = 'ship/epic-9';

/**
 * An `ok` attach of {@link BRANCH}'s batch.
 *
 * @param created - Whether the batch was checked out anew.
 * @returns The `cut-batch --attach` answer.
 */
export const attachOk = (created: boolean) => ({
  ...OK,
  worktree: 'C:/src/main',
  branch: BRANCH,
  base: 'tip1',
  batch: BATCH,
  reportDir: REPORT_DIR,
  attach: { created, fastForwarded: false, pr: 9 },
});

/**
 * An `ok` push-only publish.
 *
 * @param pushed - Whether it pushed.
 * @returns The `publish --push-only` answer.
 */
export const publishOk = (pushed: boolean) => ({
  ...OK,
  pushed,
  pr: { number: 9, url: 'https://x/pull/9' },
  mergeable: 'MERGEABLE',
});

/** The resync answers over `fakeHooks`' ship defaults: the batch reused, the push `ok`. */
const RESYNC_OK: Readonly<Record<string, unknown>> = {
  'runner:cut-batch': attachOk(false),
  'runner:publish': publishOk(true),
};

/** The doc index the conflict fakes stop on. */
export const ADR_INDEX = 'docs/adr/readme.md';

/** A `sync-master` start stopped on a doc index, the resolver, and the `--continue`. */
export const DOC_INDEX_CONFLICT = {
  'runner:sync-master:resync': {
    exitCode: 1,
    envelopePath: 'e.json',
    status: 'conflict',
    outcome: 'needs-resolution',
    commit: null,
    conflicts: [{ path: ADR_INDEX, kind: 'doc-index', landedBy: ['docs: theirs'] }],
    version: null,
    pending: [ADR_INDEX],
    errors: [],
  },
  resolver: { verdict: 'resolved', summary: 'kept both rows' },
  'runner:sync-master:resync-continue': {
    ...OK,
    outcome: 'merged',
    commit: 'merge1',
    conflicts: [],
    pending: [],
  },
};

/**
 * Fake hooks answering the resync defaults, then `responses`.
 *
 * @param responses - Per-label overrides.
 * @returns The fake run.
 */
export function resyncHooks(responses: Readonly<Record<string, unknown>> = {}): FakeRun {
  return fakeHooks({ ...RESYNC_OK, ...responses });
}
