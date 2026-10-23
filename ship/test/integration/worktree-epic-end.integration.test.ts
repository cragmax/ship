/**
 * Per-test `mkdtemp` roots holding a fake `gh`: `append-pr-body` appends a
 * section to a fake PR body, and `post-pr-comment` and `post-issue-comment`
 * post a comment to a fake PR or issue.
 *
 * @integrationTier standalone
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ExecModule from '../../src/cli/git/exec.js';
import { appendPrBody as appendPrBodyInProcess } from '../../src/cli/commands/append-pr-body.js';
import { runCaptured } from '../../src/cli/git/exec.js';
import type {
  AppendPrBodyResult,
  PostIssueCommentResult,
  PostPrCommentResult,
} from '../../src/cli/envelope/types-run.js';
import {
  prependPath,
  readFakeIssueCommented,
  readFakePrCommented,
  readFakePrEdited,
  setFakePrBodies,
  setFakePrComment,
  setFakePrEditExit,
  writeFakeGh,
  type FakePrComment,
} from '../../../tooling/test/helpers/worktree-fixture-git.js';
import {
  expectUsageFailure,
  makeTempRoot,
  removeTempDirs,
  runCli,
} from '../helpers/worktree-cli-fixture.js';

// A pass-through spy: every spawn still runs, and the in-process test reads
// the options each one got. The CLI-spawned tests run in their own process.
vi.mock('../../src/cli/git/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecModule>();
  return { ...actual, runCaptured: vi.fn(actual.runCaptured) };
});

const TIMEOUT = { timeout: 60_000 };

let root: string;
// `append-pr-body` leaves the body it wrote in the OS temp dir for its caller.
const logDirs = new Set<string>();

beforeEach(() => {
  root = makeTempRoot('ph-wt-end-');
});

afterEach(() => {
  removeTempDirs([root, ...logDirs]);
  logDirs.clear();
});

describe('append-pr-body', () => {
  // CRLF, non-ASCII, trailing spaces and a closing keyword: all must survive the round trip.
  const BODY = '## Summary\r\n\r\nAdds x — fixes #3.  \r\n';
  const SECTION = '## Attached run 1\n\n### Issues\n\n- fixes #8 — y\n';

  /** Run `append-pr-body` on PR 9 with a fake `gh` first on `PATH`; `root` is `gh`'s cwd. */
  function appendRun({
    bodies = { 9: BODY },
    editExit,
    section = SECTION,
  }: { bodies?: Record<number, string>; editExit?: number; section?: string | null } = {}): {
    r: ReturnType<typeof runCli<AppendPrBodyResult>>;
    bin: string;
  } {
    const bin = writeFakeGh(root, {});
    setFakePrBodies(bin, bodies);
    if (editExit !== undefined) setFakePrEditExit(bin, editExit);
    if (section !== null) writeFileSync(`${root}/pr-section.md`, section);
    const r = runCli<AppendPrBodyResult>(
      ['append-pr-body', root, '--pr', '9', '--section-file', `${root}/pr-section.md`],
      { env: prependPath(bin) },
    );
    if (typeof r.json.bodyFile === 'string') logDirs.add(dirname(r.json.bodyFile));
    return { r, bin };
  }

  it('appends the section to the PR’s body as gh read it, byte for byte', TIMEOUT, () => {
    const { r, bin } = appendRun();

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', pr: 9 });
    expect(r.json.bodyFile).toMatch(/ph-worktree-append-pr-body-[^/]+\/pr-body\.md$/);
    expect(readFakePrEdited(bin)).toEqual({
      argv: ['pr', 'edit', '9', '--body-file', r.json.bodyFile],
      body: `${BODY}\n${SECTION}`,
    });
    expect(readFileSync(r.json.bodyFile ?? '', 'utf8')).toBe(`${BODY}\n${SECTION}`);
  });

  it('fails pr-body and edits nothing when gh cannot read the body', TIMEOUT, () => {
    const { r, bin } = appendRun({ bodies: {} });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', pr: 9, bodyFile: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-body']);
    expect(r.json.errors[0]?.message).toContain('gh pr view 9 exited 3');
    expect(readFakePrEdited(bin)).toBeNull();
  });

  it('fails pr-edit, naming the body it wrote, when gh pr edit fails', TIMEOUT, () => {
    const { r } = appendRun({ editExit: 1 });

    expect(r.code).toBe(1);
    expect(r.json.status).toBe('failed');
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-edit']);
    expect(typeof r.json.bodyFile).toBe('string');
    expect(r.json.errors[0]?.message).toContain('gh pr edit 9 exited 1');
    expect(r.json.errors[0]?.message).toContain(r.json.bodyFile);
  });

  it.each([
    { name: 'missing', section: null },
    { name: 'blank', section: ' \n' },
  ])('fails section and calls no gh when the section file is $name', TIMEOUT, ({ section }) => {
    // No body configured: a body read would fail `pr-body`, so `section` alone proves none ran.
    const { r, bin } = appendRun({ bodies: {}, section });

    expect(r.code).toBe(1);
    expect(r.json.errors.map((e) => e.step)).toEqual(['section']);
    expect(r.json.bodyFile).toBeNull();
    expect(readFakePrEdited(bin)).toBeNull();
  });

  // 65,001 characters read; the new body adds one '\n', then the section.
  const LONG_BODY = `${'b'.repeat(65_000)}\n`;

  it('refuses a new body of 65,537 characters at body-too-long, editing nothing', TIMEOUT, () => {
    const { r, bin } = appendRun({ bodies: { 9: LONG_BODY }, section: `${'s'.repeat(534)}\n` });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', pr: 9 });
    expect(r.json.errors.map((e) => e.step)).toEqual(['body-too-long']);
    const bodyFile = r.json.bodyFile ?? '';
    expect(bodyFile).not.toBe('');
    expect(r.json.errors[0]?.message).toContain('65537');
    expect(r.json.errors[0]?.message).toContain('65536');
    expect(r.json.errors[0]?.message).toContain(bodyFile);
    const written = readFileSync(bodyFile, 'utf8');
    expect(written).toHaveLength(65_537);
    expect(written.startsWith(LONG_BODY)).toBe(true);
    expect(readFakePrEdited(bin)).toBeNull();
  });

  // '—' is 1 UTF-16 unit but 3 UTF-8 bytes: the limit counts the string's length, not bytes.
  it('edits a new body of exactly 65,536 characters, non-ASCII ones included', TIMEOUT, () => {
    const section = `${'—'.repeat(10)}${'s'.repeat(523)}\n`;
    const { r, bin } = appendRun({ bodies: { 9: LONG_BODY }, section });

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'ok', errors: [] });
    expect(readFakePrEdited(bin)?.argv).toEqual([
      'pr',
      'edit',
      '9',
      '--body-file',
      r.json.bodyFile,
    ]);
    expect(readFakePrEdited(bin)?.body).toHaveLength(65_536);
    expect(readFakePrEdited(bin)?.body?.endsWith(section)).toBe(true);
  });
});

describe('post-pr-comment', () => {
  // CRLF and non-ASCII: both must reach gh unchanged.
  const COMMENT = '<details><summary>Run report — attached run 2</summary>\r\n\r\n## Landed\r\n';

  /** Run `post-pr-comment` on PR 9 with a fake `gh` first on `PATH`; `root` is `gh`'s cwd. */
  function commentRun({
    comment = COMMENT,
    gh,
  }: { comment?: string | null; gh?: FakePrComment } = {}): {
    r: ReturnType<typeof runCli<PostPrCommentResult>>;
    bin: string;
    file: string;
  } {
    const bin = writeFakeGh(root, {});
    if (gh !== undefined) setFakePrComment(bin, gh);
    const file = `${root}/pr-report-comment.md`;
    if (comment !== null) writeFileSync(file, comment);
    const r = runCli<PostPrCommentResult>(
      ['post-pr-comment', root, '--pr', '9', '--comment-file', file],
      { env: prependPath(bin) },
    );
    return { r, bin, file };
  }

  it('posts the comment file to the PR and returns the comment’s URL', TIMEOUT, () => {
    const { r, bin, file } = commentRun();

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      pr: 9,
      url: 'https://github.com/fixture/repo/pull/9#issuecomment-1',
    });
    expect(readFakePrCommented(bin)).toEqual({
      argv: ['pr', 'comment', '9', '--body-file', file],
      body: COMMENT,
    });
  });

  it('fails pr-comment when gh pr comment exits non-zero', TIMEOUT, () => {
    const { r } = commentRun({ gh: { exit: 1 } });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['pr-comment']);
    expect(r.json.errors[0]?.message).toContain('gh pr comment 9 exited 1');
  });

  // A warning line before the URL, whitespace around it and trailing blank lines.
  it('returns the last non-empty line gh printed, trimmed, as the URL', TIMEOUT, () => {
    const stdout =
      'Warning: 1 uncommitted change\n  https://github.com/fixture/repo/pull/9#issuecomment-7 \r\n\r\n';
    const { r } = commentRun({ gh: { stdout } });

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      url: 'https://github.com/fixture/repo/pull/9#issuecomment-7',
    });
  });

  it.each([
    { name: 'nothing', gh: { printUrl: false } },
    { name: 'a last line that is no https URL', gh: { stdout: 'https://x/1\nComment posted\n' } },
  ])('fails comment-url when gh pr comment exits 0 printing $name', TIMEOUT, ({ gh }) => {
    const { r } = commentRun({ gh });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['comment-url']);
    expect(r.json.errors[0]?.message).toBe(
      'gh pr comment 9 printed no comment URL; the comment may have been posted',
    );
  });

  it.each([
    { name: 'missing', comment: null },
    { name: 'blank', comment: ' \n' },
  ])('fails comment and calls no gh when the comment file is $name', TIMEOUT, ({ comment }) => {
    const { r, bin } = commentRun({ comment });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['comment']);
    expect(readFakePrCommented(bin)).toBeNull();
  });

  it('refuses a comment of 65,537 characters at body-too-long, calling no gh', TIMEOUT, () => {
    const { r, bin } = commentRun({ comment: 'c'.repeat(65_537) });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['body-too-long']);
    expect(r.json.errors[0]?.message).toContain('65537');
    expect(r.json.errors[0]?.message).toContain('65536');
    expect(readFakePrCommented(bin)).toBeNull();
  });

  // '—' is 1 UTF-16 unit but 3 UTF-8 bytes: the limit counts the string's length, not bytes.
  it('posts a comment of exactly 65,536 characters, non-ASCII ones included', TIMEOUT, () => {
    const comment = `${'—'.repeat(10)}${'c'.repeat(65_526)}`;
    const { r, bin } = commentRun({ comment });

    expect(r.json.status).toBe('ok');
    expect(readFakePrCommented(bin)?.body).toBe(comment);
  });
});

describe('post-issue-comment', () => {
  // CRLF and non-ASCII: both must reach gh unchanged.
  const COMMENT =
    '> *Posted by an unattended `/ship` run.*\r\n\r\n**Not landed: blocked.** over — budget\r\n';

  /** Run `post-issue-comment` on issue 7 with a fake `gh` first on `PATH`; `root` is `gh`'s cwd. */
  function issueCommentRun({
    comment = COMMENT,
    gh,
  }: { comment?: string | null; gh?: FakePrComment } = {}): {
    r: ReturnType<typeof runCli<PostIssueCommentResult>>;
    bin: string;
    file: string;
  } {
    const bin = writeFakeGh(root, {});
    if (gh !== undefined) setFakePrComment(bin, gh);
    const file = `${root}/issue-comment-7.md`;
    if (comment !== null) writeFileSync(file, comment);
    const r = runCli<PostIssueCommentResult>(
      ['post-issue-comment', root, '--issue', '7', '--comment-file', file],
      { env: prependPath(bin) },
    );
    return { r, bin, file };
  }

  it('posts the comment file to the issue and returns the comment’s URL', TIMEOUT, () => {
    const { r, bin, file } = issueCommentRun();

    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      status: 'ok',
      issue: 7,
      url: 'https://github.com/fixture/repo/issues/7#issuecomment-1',
      worktree: root,
    });
    expect(readFakeIssueCommented(bin)).toEqual({
      argv: ['issue', 'comment', '7', '--body-file', file],
      body: COMMENT,
    });
    expect(readFakePrCommented(bin)).toBeNull();
  });

  it(
    'fails issue-comment with gh’s exit code when gh issue comment exits non-zero',
    TIMEOUT,
    () => {
      const { r } = issueCommentRun({ gh: { exit: 1 } });

      expect(r.code).toBe(1);
      expect(r.json).toMatchObject({ status: 'failed', issue: 7, url: null });
      expect(r.json.errors.map((e) => e.step)).toEqual(['issue-comment']);
      expect(r.json.errors[0]?.message).toContain('gh issue comment 7 exited 1');
    },
  );

  it('fails comment and calls no gh when the comment file is missing', TIMEOUT, () => {
    const { r, bin } = issueCommentRun({ comment: null });

    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'failed', url: null });
    expect(r.json.errors.map((e) => e.step)).toEqual(['comment']);
    expect(readFakeIssueCommented(bin)).toBeNull();
  });
});

describe('usage errors', () => {
  // The epic end has no server-tier step: its push's pre-push hook runs it (Tooling ADR-0002).
  it('exits 2 naming server-tier an unknown command', TIMEOUT, () => {
    const run = runCli(['server-tier', 'b', '--engine', 'paper', '--registry', 'r', '--log', 'l'], {
      cwd: root,
    });
    expect(run.code).toBe(2);
    expect(run.json.errors[0]).toEqual({
      step: 'usage',
      message: "unknown command 'server-tier'",
    });
  });

  it.each([
    { name: 'publish without --title', args: ['publish', 'b', '--body-file', 'f', '--log', 'l'] },
    {
      name: 'publish --push-only with --title',
      args: ['publish', 'b', '--push-only', '--title', 't', '--log', 'l'],
    },
    {
      name: 'publish --push-only with --body-file',
      args: ['publish', 'b', '--push-only', '--body-file', 'f', '--log', 'l'],
    },
    { name: 'publish --push-only without --log', args: ['publish', 'b', '--push-only'] },
    {
      name: 'publish --push-only with --draft',
      args: ['publish', 'b', '--push-only', '--draft', '--log', 'l'],
    },
    {
      name: 'append-pr-body without --section-file',
      args: ['append-pr-body', 'b', '--pr', '9'],
    },
    {
      name: 'append-pr-body with pr 0',
      args: ['append-pr-body', 'b', '--pr', '0', '--section-file', 'f'],
    },
    {
      name: 'post-pr-comment without --comment-file',
      args: ['post-pr-comment', 'b', '--pr', '9'],
    },
    {
      name: 'post-pr-comment with pr 0',
      args: ['post-pr-comment', 'b', '--pr', '0', '--comment-file', 'f'],
    },
  ])('exits 2 with a usage envelope for $name', TIMEOUT, ({ args }) => {
    expectUsageFailure(runCli(args, { cwd: root }));
  });
});

describe('append-pr-body (in-process)', () => {
  // The fake gh only prints well-formed body JSON, so the read is stubbed here.
  it(
    'fails pr-body without echoing gh’s output, editing nothing, when gh prints no body JSON',
    TIMEOUT,
    () => {
      writeFileSync(`${root}/pr-section.md`, '## Attached run 1\n');
      vi.mocked(runCaptured).mockClear();
      vi.mocked(runCaptured).mockReturnValueOnce({
        exitCode: 0,
        stdout: 'gh-printed <html>',
        tail: '',
      });

      const r = appendPrBodyInProcess({ batch: root, pr: 9, sectionFile: `${root}/pr-section.md` });

      expect(r).toMatchObject({ status: 'failed', pr: 9, bodyFile: null });
      expect(r.errors).toEqual([
        { step: 'pr-body', message: 'gh pr view 9 printed no readable body JSON' },
      ]);
      expect(vi.mocked(runCaptured)).toHaveBeenCalledTimes(1);
    },
  );
});
