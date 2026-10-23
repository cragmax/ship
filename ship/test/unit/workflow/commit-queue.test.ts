import { describe, expect, it } from 'vitest';

import {
  createCommitQueue,
  landingEvent,
  settleEvents,
  teardownEvent,
  teardownResidue,
} from '../../../src/workflow/commit-queue.js';
import type { LandOutput, TeardownOutput } from '../../../src/workflow/calls/tool-calls.js';

const AT = { issue: 7, epic: 1025 };

const land = (fields: Partial<LandOutput>): LandOutput => ({
  exitCode: 1,
  envelopePath: 'e.json',
  errors: [],
  commit: null,
  files: [],
  lines: null,
  conflicts: [],
  rolledBack: false,
  batchClean: true,
  ...fields,
});

const failedAt = (step: string, fields: Partial<LandOutput> = {}): LandOutput =>
  land({ status: 'failed', errors: [{ step, message: `${step} broke` }], ...fields });

const refused = (
  reason: NonNullable<LandOutput['reason']>,
  fields: Partial<LandOutput> = {},
): LandOutput =>
  land({
    status: 'refused',
    reason,
    errors: [{ step: 'preconditions', message: 'no' }],
    ...fields,
  });

const withoutBatchClean = ({ batchClean: _, ...out }: LandOutput): LandOutput => out;

const COMMITTED = { kind: 'committed', issue: 7 } as const;
const CONFLICT = { kind: 'harvest-conflict', issue: 7 } as const;
const BLOCKED = { kind: 'blocked', issue: 7, reason: expect.any(String) };
const HALT = { kind: 'epic-halt', epic: 1025, reason: expect.any(String) };

const teardown = (fields: Partial<TeardownOutput>): TeardownOutput => ({
  exitCode: 0,
  envelopePath: 't.json',
  status: 'ok',
  errors: [],
  removed: true,
  registered: false,
  kept: null,
  ...fields,
});

const TD_OK = teardown({});
const TD_SHRANK = teardown({
  exitCode: 1,
  status: 'refused',
  reason: 'source-shrank',
  removed: false,
  registered: true,
  kept: null,
  errors: [{ step: 'gate', message: 'node_modules lost 40 entries' }],
});

describe('landingEvent', () => {
  it.each([
    ['ok with its commit', land({ exitCode: 0, status: 'ok', commit: 'c1' }), COMMITTED],
    ['a conflict, the batch clean', land({ status: 'conflict', rolledBack: true }), CONFLICT],
    ['refused slice-not-single-commit', refused('slice-not-single-commit'), BLOCKED],
    ['a failed commit, rolled back clean', failedAt('commit', { rolledBack: true }), BLOCKED],
    ['a failed build, rolled back clean', failedAt('build', { rolledBack: true }), BLOCKED],
    ['refused batch-dirty', refused('batch-dirty', { batchClean: false }), HALT],
    ['refused main-worktree', refused('main-worktree'), HALT],
    ['refused unregistered-worktree', refused('unregistered-worktree'), HALT],
    ['refused self-hosted', refused('self-hosted'), HALT],
    ['refused staged-mismatch', refused('staged-mismatch', { rolledBack: true }), HALT],
    ['refused not-run-batch', refused('not-run-batch'), HALT],
    ['a failed cherry-pick', failedAt('cherry-pick', { rolledBack: true }), HALT],
    ['a failed rollback', failedAt('rollback'), HALT],
    ['a failed internal step', failedAt('internal'), HALT],
    ['a failed commit not rolled back', failedAt('commit'), HALT],
    [
      'a failed commit, batch unverified',
      failedAt('commit', { rolledBack: true, batchClean: false }),
      HALT,
    ],
    ['a conflict, batch unverified', land({ status: 'conflict', batchClean: false }), HALT],
    [
      'refused slice-not-single-commit, batch unverified',
      refused('slice-not-single-commit', { batchClean: false }),
      HALT,
    ],
    ['ok without its commit', land({ exitCode: 0, status: 'ok' }), HALT],
    ['no batchClean at all', withoutBatchClean(land({ status: 'conflict' })), HALT],
  ])('maps %s', (_name, out, event) => {
    expect(landingEvent(out, AT)).toEqual(event);
  });

  it('halts, naming the runner, when the runner returned nothing', () => {
    expect(landingEvent(null, AT)).toEqual({
      kind: 'epic-halt',
      epic: 1025,
      reason: 'the runner returned nothing for land',
    });
  });

  it('carries the envelope’s status, reason and first error in the reason', () => {
    expect(landingEvent(refused('batch-dirty', { batchClean: false }), AT)).toEqual({
      kind: 'epic-halt',
      epic: 1025,
      reason: 'land refused (batch-dirty): no',
    });
  });
});

describe('teardownEvent and teardownResidue', () => {
  it.each([
    ['ok', TD_OK, null, null],
    [
      'refused source-shrank',
      TD_SHRANK,
      HALT,
      'teardown refused (source-shrank): node_modules lost 40 entries',
    ],
    [
      'refused links-remain',
      teardown({
        status: 'refused',
        reason: 'links-remain',
        errors: [{ step: 'unlink', message: 'dist' }],
      }),
      null,
      'teardown refused (links-remain): dist',
    ],
    [
      'failed remnants',
      teardown({ status: 'failed', errors: [{ step: 'remnants', message: 'still there' }] }),
      null,
      'teardown failed: still there',
    ],
    ['no output', null, null, 'the runner returned nothing for teardown'],
  ])('maps %s', (_name, out, event, residue) => {
    expect(teardownEvent(out, 1025)).toEqual(event);
    expect(teardownResidue(out)).toEqual(residue);
  });
});

describe('settleEvents', () => {
  const halting = {
    kind: 'epic-halt',
    epic: 1025,
    reason: 'land refused (batch-dirty): no',
  } as const;
  const SHRANK = {
    kind: 'epic-halt',
    epic: 1025,
    reason: 'teardown refused (source-shrank): node_modules lost 40 entries',
  } as const;
  const blockedBy = (reason: string) => ({ kind: 'blocked', issue: 7, reason });

  it.each([
    ['a landing with a clean teardown', COMMITTED, null, 'running', [COMMITTED], 'running'],
    [
      'a halting landing',
      halting,
      halting,
      'halting',
      [halting, blockedBy(halting.reason)],
      'halted',
    ],
    [
      'a landing whose teardown shrank a source (landed-then-halted)',
      COMMITTED,
      SHRANK,
      'halting',
      [SHRANK, blockedBy(SHRANK.reason)],
      'halted',
    ],
    [
      'a halt in an entry already halted',
      halting,
      halting,
      'halted',
      [blockedBy(halting.reason)],
      'halted',
    ],
    [
      'a shrunk source in an entry already halted',
      { kind: 'agent-died', issue: 7 },
      SHRANK,
      'halted',
      [blockedBy(SHRANK.reason)],
      'halted',
    ],
    [
      'a landing in an entry already halted',
      COMMITTED,
      null,
      'halted',
      [blockedBy('landed after its epic halted')],
      'halted',
    ],
    [
      'a landing in an entry halting but not yet halted',
      COMMITTED,
      null,
      'halting',
      [COMMITTED],
      'halting',
    ],
    [
      'a chain-level block with no slice',
      { kind: 'blocked', issue: 7, reason: 'tdd BLOCKED' },
      null,
      'running',
      [blockedBy('tdd BLOCKED')],
      'running',
    ],
    [
      'a dead agent',
      { kind: 'agent-died', issue: 7 },
      null,
      'running',
      [{ kind: 'agent-died', issue: 7 }],
      'running',
    ],
    [
      'a not-ready re-check with no slice',
      { kind: 'label-removed', issue: 7 },
      null,
      'running',
      [{ kind: 'label-removed', issue: 7 }],
      'running',
    ],
  ] as const)('settles %s', (_name, primary, halt, entry, events, after) => {
    expect(settleEvents(primary, halt, { ...AT, entry })).toEqual({ events, entry: after });
  });
});

describe('createCommitQueue', () => {
  it('starts a task only once the one before it has settled, even when it rejected', async () => {
    const queue = createCommitQueue();
    const log: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = queue.enqueue(async () => {
      log.push('first start');
      await gate;
      log.push('first end');

      throw new Error('first failed');
    });
    const second = queue.enqueue(() => {
      log.push('second start');

      return Promise.resolve('second');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['first start']);

    release();

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second');
    expect(log).toEqual(['first start', 'first end', 'second start']);
  });
});
