import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ResultBaseSchema,
  TeardownResultSchema,
  guardEnvelope,
} from '../../../src/cli/envelope/schemas.js';
import type { ResultBase } from '../../../src/cli/envelope/types.js';

// `removed` is a string where the schema wants a boolean: the one bad key.
const BAD_TEARDOWN = {
  command: 'teardown',
  status: 'ok',
  worktree: 'C:/src/slice',
  errors: [],
  unlinked: [{ path: 'C:/src/slice/node_modules', target: 'C:/src/batch/node_modules' }],
  sources: [{ path: 'C:/src/batch/node_modules', before: 3, after: 3 }],
  removed: 'yes',
  registered: false,
  kept: null,
  tsserverRestart: { outcome: 'skipped', reason: 'not-removed', detail: null },
};

const REMOVED_PREFIX = /^envelope fails its schema: removed: /;

// One mock stands in for every command module, so any command's result is the test's to choose.
const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }));
vi.mock('../../../src/cli/commands/append-pr-body.js', () => ({ appendPrBody: commandMock }));
vi.mock('../../../src/cli/commands/bump.js', () => ({ bump: commandMock }));
vi.mock('../../../src/cli/commands/check-master.js', () => ({ checkMaster: commandMock }));
vi.mock('../../../src/cli/commands/cut.js', () => ({
  cutBatch: commandMock,
  cutSlice: commandMock,
}));
vi.mock('../../../src/cli/commands/cut-attach.js', () => ({ attachBatch: commandMock }));
vi.mock('../../../src/cli/commands/harvest.js', () => ({ harvest: commandMock }));
vi.mock('../../../src/cli/commands/land.js', () => ({ land: commandMock }));
vi.mock('../../../src/cli/commands/live-runs.js', () => ({ liveRuns: commandMock }));
vi.mock('../../../src/cli/commands/post-issue-comment.js', () => ({
  postIssueComment: commandMock,
}));
vi.mock('../../../src/cli/commands/post-pr-comment.js', () => ({ postPrComment: commandMock }));
vi.mock('../../../src/cli/commands/preflight.js', () => ({ preflight: commandMock }));
vi.mock('../../../src/cli/commands/provision.js', () => ({ provision: commandMock }));
vi.mock('../../../src/cli/commands/provision-batch.js', () => ({ provisionBatch: commandMock }));
vi.mock('../../../src/cli/commands/publish.js', () => ({ publish: commandMock }));
vi.mock('../../../src/cli/commands/publish-push.js', () => ({ publishPushOnly: commandMock }));
vi.mock('../../../src/cli/git/staged-set.js', () => ({ stagedGuard: commandMock }));
vi.mock('../../../src/cli/commands/sync-master.js', () => ({ syncMaster: commandMock }));
vi.mock('../../../src/cli/commands/teardown.js', () => ({ teardownWorktree: commandMock }));

const { runWorktreeCli } = await import('../../../src/cli/worktree.js');

beforeEach(() => {
  commandMock.mockReset();
});

describe('guardEnvelope', () => {
  it('returns the very envelope its schema accepts', () => {
    const good = { ...BAD_TEARDOWN, removed: true, at: '2026-09-29T10:00:00.000Z' };

    expect(guardEnvelope(good as ResultBase, TeardownResultSchema)).toBe(good);
  });

  it('replaces an envelope its schema rejects with a failed envelope naming the key', () => {
    const bad = { ...BAD_TEARDOWN, at: '2026-09-29T10:00:00.000Z' } as unknown as ResultBase;

    const out = guardEnvelope(bad, TeardownResultSchema);

    expect(out).not.toBe(bad);
    expect(out).toEqual({
      command: 'teardown',
      status: 'failed',
      worktree: 'C:/src/slice',
      errors: [{ step: 'envelope', message: expect.stringMatching(REMOVED_PREFIX) }],
      at: '2026-09-29T10:00:00.000Z',
    });
    expect(ResultBaseSchema.safeParse(out).success).toBe(true);
  });

  it('names a nested failing key by its path, an index in brackets', () => {
    const bad = {
      ...BAD_TEARDOWN,
      removed: true,
      sources: [{ path: 'C:/src/batch/node_modules', before: 'three', after: 3 }],
    } as unknown as ResultBase;

    const out = guardEnvelope(bad, TeardownResultSchema);

    expect(out.errors).toEqual([
      {
        step: 'envelope',
        message: expect.stringMatching(/^envelope fails its schema: sources\[0\]\.before: /),
      },
    ]);
  });
});

describe('runWorktreeCli — the envelope guard', () => {
  it('reports a command whose envelope fails its schema as failed at step envelope, exit 1', async () => {
    commandMock.mockReturnValue({ ...BAD_TEARDOWN });

    const { result, exitCode } = await runWorktreeCli(['teardown', 'C:/src/slice']);

    expect(result).toEqual({
      command: 'teardown',
      status: 'failed',
      worktree: 'C:/src/slice',
      errors: [{ step: 'envelope', message: expect.stringMatching(REMOVED_PREFIX) }],
      at: expect.any(String),
    });
    expect(exitCode).toBe(1);
  });

  // A base-only `ok` envelope lacks every command's own required fields, so
  // only the command's own schema, never the base one, can reject it.
  it.each(
    [
      ['provision', 'C:/s', '--batch', 'C:/b'],
      ['provision-batch', 'C:/b', '--report-dir', 'C:/r'],
      ['teardown', 'C:/s'],
      ['harvest', 'C:/b', 'abc123'],
      ['land', 'C:/b', 'abc123', '--base', 'def456', '--message-file', 'C:/m', '--log', 'C:/l'],
      ['staged-guard', 'C:/w', 'a.ts'],
      ['live-runs', 'C:/main'],
      ['preflight', 'C:/main'],
      ['cut-batch', 'C:/main', '--epic', '7'],
      ['cut-batch', 'C:/main', '--attach', 'ship/epic-7'],
      ['cut-slice', 'C:/b', '--issue', '7', '--attempt', '1'],
      ['sync-master', 'C:/b'],
      ['bump', 'C:/b'],
      ['check-master', 'C:/main', '--local', 'aaa', '--remote', 'bbb', '--synced', 'ccc'],
      ['publish', 'C:/b', '--log', 'C:/l', '--title', 't', '--body-file', 'C:/body.md'],
      ['publish', 'C:/b', '--log', 'C:/l', '--push-only'],
      ['append-pr-body', 'C:/b', '--pr', '9', '--section-file', 'C:/s.md'],
      ['post-pr-comment', 'C:/b', '--pr', '9', '--comment-file', 'C:/c.md'],
      ['post-issue-comment', 'C:/main', '--issue', '7', '--comment-file', 'C:/c.md'],
    ].map((argv) => ({ argv, line: argv.join(' ') })),
  )('guards $line with its command’s own schema', async ({ argv }) => {
    const [command = ''] = argv;
    commandMock.mockReturnValue({ command, status: 'ok', worktree: 'C:/b', errors: [] });

    const { result, exitCode } = await runWorktreeCli(argv);

    expect(commandMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.errors[0]?.step).toBe('envelope');
    expect(exitCode).toBe(1);
  });

  it.each([['bogus'], ['commit', '--message-file', 'C:/m', '--', 'a.ts']])(
    'keeps an unknown command’s usage envelope and exit 2: %s',
    async (...argv) => {
      const [command = ''] = argv;
      const { result, exitCode } = await runWorktreeCli(argv);

      expect(commandMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        command,
        status: 'failed',
        worktree: null,
        errors: [{ step: 'usage', message: `unknown command '${command}'` }],
        at: expect.any(String),
      });
      expect(exitCode).toBe(2);
    },
  );
});

describe('runWorktreeCli — arguments', () => {
  it('passes an argument after -- as a positional, never as a flag', async () => {
    commandMock.mockReturnValue({ command: 'staged-guard', status: 'ok', worktree: 'C:/w' });

    await runWorktreeCli(['staged-guard', 'C:/w', 'a.ts', '--', '--odd.ts']);

    expect(commandMock).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['a.ts', '--odd.ts'] }),
    );
  });
});
