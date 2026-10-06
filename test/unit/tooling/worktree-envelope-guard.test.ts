import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ResultBaseSchema,
  TeardownResultSchema,
  guardEnvelope,
} from '../../../tooling/worktree/schemas.js';
import type { ResultBase } from '../../../tooling/worktree/types.js';

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
};

const REMOVED_PREFIX = /^envelope fails its schema: removed: /;

// One mock stands in for every command module, so any command's result is the test's to choose.
const { commandMock } = vi.hoisted(() => ({ commandMock: vi.fn() }));
vi.mock('../../../tooling/worktree/append-pr-body.js', () => ({ appendPrBody: commandMock }));
vi.mock('../../../tooling/worktree/bump.js', () => ({ bump: commandMock }));
vi.mock('../../../tooling/worktree/check-master.js', () => ({ checkMaster: commandMock }));
vi.mock('../../../tooling/worktree/cut.js', () => ({
  cutBatch: commandMock,
  cutSlice: commandMock,
}));
vi.mock('../../../tooling/worktree/cut-attach.js', () => ({ attachBatch: commandMock }));
vi.mock('../../../tooling/worktree/harvest.js', () => ({ harvest: commandMock }));
vi.mock('../../../tooling/worktree/land.js', () => ({ land: commandMock }));
vi.mock('../../../tooling/worktree/live-runs.js', () => ({ liveRuns: commandMock }));
vi.mock('../../../tooling/worktree/post-pr-comment.js', () => ({ postPrComment: commandMock }));
vi.mock('../../../tooling/worktree/preflight.js', () => ({ preflight: commandMock }));
vi.mock('../../../tooling/worktree/provision.js', () => ({ provision: commandMock }));
vi.mock('../../../tooling/worktree/provision-batch.js', () => ({ provisionBatch: commandMock }));
vi.mock('../../../tooling/worktree/publish.js', () => ({ publish: commandMock }));
vi.mock('../../../tooling/worktree/publish-push.js', () => ({ publishPushOnly: commandMock }));
vi.mock('../../../tooling/worktree/staged-set.js', () => ({ stagedGuard: commandMock }));
vi.mock('../../../tooling/worktree/sync-master.js', () => ({ syncMaster: commandMock }));
vi.mock('../../../tooling/worktree/teardown.js', () => ({ teardownWorktree: commandMock }));

const { runWorktreeCli } = await import('../../../tooling/worktree.js');

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
  // only the command's own schema — never the base one — can reject it.
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

  it('keeps an unknown command’s usage envelope and exit 2', async () => {
    const { result, exitCode } = await runWorktreeCli(['bogus']);

    expect(result).toEqual({
      command: 'bogus',
      status: 'failed',
      worktree: null,
      errors: [{ step: 'usage', message: "unknown command 'bogus'" }],
      at: expect.any(String),
    });
    expect(exitCode).toBe(2);
  });
});
