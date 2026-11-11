/**
 * Plain-repo builders for the worktree CLI's `harvest`, `staged-guard`,
 * `live-runs`, `land`, `cut-*`, `preflight`, `sync-master` and
 * `publish` tests: small git repos with no npm template, commits built from a
 * change list, a bare `origin`, an independent staged-set reader, and a fake
 * `gh` the spawned CLI finds first on its `PATH`.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { compareStrings, toPosix } from '../../src/core/strings.js';

import { fixtureGitignore } from './fixtures.js';
import {
  addWorktree,
  configureFixtureRepo,
  copyTemplateOrigin,
  copyTemplateRepo,
  mustRun,
  porcelain,
  runIn,
} from './worktree-fixture.js';

/** Options for {@link makeGitRepo}. */
interface GitRepoOptions {
  /** Directory name under the root. Defaults to `main`. */
  readonly name?: string;
  /** `.gitignore` content. Defaults to {@link fixtureGitignore}. */
  readonly gitignore?: string;
}

/** What {@link commitChanges} does before committing. */
export interface Changes {
  /** Renames, applied first with `git mv`. */
  readonly rename?: readonly (readonly [from: string, to: string])[];
  /** Files to write (created or overwritten) and stage. */
  readonly write?: Readonly<Record<string, string>>;
  /** Tracked files to delete with `git rm`. */
  readonly remove?: readonly string[];
}

/** One fake-`gh` answer for a branch. */
export interface FakeGhResponse {
  /** Exit code. Non-zero prints an error and no JSON. Defaults to `0`. */
  readonly exit?: number;
  /** The branch's PRs, in any state (`OPEN`, `MERGED`, `CLOSED`), each with its head when given. */
  readonly prs?: readonly {
    readonly number: number;
    readonly state: string;
    readonly headRefOid?: string;
  }[];
}

/**
 * Create a repo at `<root>/<name>` on `master` whose one commit holds `files` plus a `.gitignore`,
 * and return its path with forward slashes, the form the tooling's envelopes carry. The repo is a
 * copy of the test file's template for those files ({@link copyTemplateRepo}): calls with equal
 * files share one commit sha.
 */
export function makeGitRepo(
  root: string,
  files: Readonly<Record<string, string>>,
  options: GitRepoOptions = {},
): string {
  const dir = join(root, options.name ?? 'main');
  const all = { '.gitignore': options.gitignore ?? fixtureGitignore(), ...files };
  copyTemplateRepo(JSON.stringify(['git', all]), dir, (template) => {
    writeFiles(template, all);
  });

  return toPosix(dir);
}

/**
 * Apply `changes` in a checkout, commit them, and return the new commit's full sha. No changes at
 * all make an empty (`--allow-empty`) commit. On win32 a checkout that tracks `foo.txt` cannot add
 * `Foo.txt` this way: the write lands on `foo.txt`. So a
 * case-collision slice must be cut from a commit before the other side gains the path.
 */
export function commitChanges(dir: string, changes: Changes, message: string): string {
  const { rename = [], write = {}, remove = [] } = changes;
  for (const [from, to] of rename) mustRun('git', ['mv', from, to], dir);
  writeFiles(dir, write);
  const written = Object.keys(write);
  if (written.length > 0) mustRun('git', ['add', '--', ...written], dir);
  if (remove.length > 0) mustRun('git', ['rm', '-q', '--', ...remove], dir);
  const empty = rename.length + written.length + remove.length === 0;
  mustRun('git', ['commit', '-q', ...(empty ? ['--allow-empty'] : []), '-m', message], dir);

  return headSha(dir);
}

/** The parents of a commit, in order. */
export function parents(dir: string, ref = 'HEAD'): string[] {
  return mustRun('git', ['rev-list', '--parents', '-n', '1', ref], dir).trim().split(' ').slice(1);
}

/** The short branch a worktree has checked out. */
export function branchOf(dir: string): string {
  return mustRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
}

/** HEAD, porcelain, branches, and worktree list of a fixture main: "nothing mutated". */
export function repoState(dir: string): Record<string, string> {
  return {
    head: headSha(dir),
    porcelain: porcelain(dir),
    branches: mustRun('git', ['branch', '--list', '--format=%(refname)'], dir),
    worktrees: mustRun('git', ['worktree', 'list', '--porcelain'], dir),
  };
}

/** HEAD, porcelain, staged set, and merge state of a checkout: what "nothing mutated" compares. */
export function snapshot(dir: string): Record<string, unknown> {
  return {
    head: headSha(dir),
    porcelain: porcelain(dir),
    staged: stagedNames(dir),
    merging: runIn('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], dir).exitCode === 0,
  };
}

/** Resolve a commit-ish in a checkout to its full sha. */
export function headSha(dir: string, ref = 'HEAD'): string {
  return mustRun('git', ['rev-parse', '--verify', `${ref}^{commit}`], dir).trim();
}

/** Split the output of git `args`, `-z` included, into paths sorted by code unit. */
export function gitPathList(dir: string, args: readonly string[]): string[] {
  return mustRun('git', args, dir)
    .split('\0')
    .filter((p) => p !== '')
    .sort(compareStrings);
}

/**
 * The staged paths of a checkout, sorted by code unit, a rename as both endpoints, read directly
 * from git, independent of the CLI's own reader.
 */
export function stagedNames(dir: string): string[] {
  return gitPathList(dir, ['diff', '--cached', '--name-only', '--no-renames', '-z']);
}

/** The untracked, non-ignored paths of a checkout, sorted by code unit. */
export function untrackedNames(dir: string): string[] {
  return gitPathList(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
}

/**
 * Give a fixture repo a bare `origin` at `<root>/<name>.git` holding its `master`, with
 * `origin/master` level with `master`. Returns the bare repo's path.
 */
export function makeBareOrigin(root: string, repo: string, name = 'origin'): string {
  const bare = join(root, `${name}.git`);
  if (copyTemplateOrigin(repo, bare)) return bare;
  mustRun('git', ['init', '-q', '--bare', '-b', 'master', bare], root);
  mustRun('git', ['remote', 'add', 'origin', bare], repo);
  mustRun('git', ['push', '-q', 'origin', 'master'], repo);
  mustRun('git', ['fetch', '-q', 'origin'], repo);

  return bare;
}

/** A fixture repo with a bare origin and a batch worktree. */
export interface FixtureRun {
  readonly main: string;
  readonly bare: string;
  readonly batch: string;
}

/** Give fixture repo `main` under `root` a bare origin and a batch `<root>/batch` on `branch`. */
export function withOriginAndBatch(root: string, main: string, branch = 'ship/r'): FixtureRun {
  const bare = makeBareOrigin(root, main);

  return { main, bare, batch: addWorktree(main, `${root}/batch`, branch) };
}

/** Point the fixture repo's hooks at `<root>/hooks`, holding one `name` hook running `script`. */
export function installHook(root: string, main: string, name: string, script: string): void {
  const hooks = `${root}/hooks`;
  mkdirSync(hooks, { recursive: true });
  writeFileSync(`${hooks}/${name}`, script);
  chmodSync(`${hooks}/${name}`, 0o755);
  mustRun('git', ['config', 'core.hooksPath', hooks], main);
}

/**
 * A hook script that fails its first `failing` runs, each printing one lefthook-style
 * `exit status <s>` line per entry of `statuses` and `run <n> failed`, then a 50-line summary, then
 * passes, printing `run <n> passed`. Every run appends a line to `counter`, so {@link hookRuns}
 * counts them.
 */
export function failingHookScript(
  counter: string,
  failing: number,
  statuses: readonly number[],
): string {
  return [
    '#!/bin/sh',
    `echo run >> "${counter}"`,
    `n=$(wc -l < "${counter}" | tr -d ' ')`,
    `if [ "$n" -le ${String(failing)} ]; then`,
    '  echo "run $n failed"',
    ...statuses.map((s) => `  echo "exit status ${String(s)}"`),
    // As lefthook's summary does (unprobed), push the statuses out of the 40-line tail: the crash
    // is read from the whole output.
    '  i=0; while [ "$i" -lt 50 ]; do echo "  summary line $i"; i=$((i + 1)); done',
    '  exit 1',
    'fi',
    'echo "run $n passed"',
    '',
  ].join('\n');
}

/** How many times a {@link failingHookScript} hook ran: the lines of its counter file. */
export function hookRuns(counter: string): number {
  return existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').length - 1 : 0;
}

/** Commit `changes` on an existing branch of `main` through a throwaway worktree. */
export function commitOn(main: string, branch: string, changes: Changes, message: string): string {
  return inThrowawayWorktree(main, branch, (dir) => commitChanges(dir, changes, message));
}

/** Check an existing branch of `main` out at `path`. */
export function addWorktreeAt(main: string, path: string, branch: string): void {
  mustRun('git', ['worktree', 'add', '-q', path, branch], main);
}

/**
 * Advance `bare`'s master, then merge it into `branch` of `main` with `--no-ff`, unpushed: a
 * resync's merge. The merge runs in `checkout` when given (a worktree already on `branch`), else in
 * a throwaway worktree.
 */
export function mergeOn(main: string, bare: string, branch: string, checkout?: string): string {
  advanceOrigin(dirname(main), bare, { write: { 'm.txt': 'm\n' } }, 'm');
  mustRun('git', ['fetch', '-q', 'origin'], main);

  const merge = (dir: string): string => {
    mustRun('git', ['merge', '--no-ff', '-q', '-m', 'Merge origin/master', 'origin/master'], dir);

    return headSha(dir);
  };

  return checkout === undefined ? inThrowawayWorktree(main, branch, merge) : merge(checkout);
}

/**
 * Push one commit of `changes` to the {@link makeBareOrigin} repo's `branch`, which must exist on
 * origin, from a scratch clone, so the fixture repo's copy of `branch` falls behind origin's at its
 * next fetch. Returns the pushed commit's full sha.
 */
export function advanceOrigin(
  root: string,
  bare: string,
  changes: Changes,
  message = 'pushed elsewhere',
  branch = 'master',
): string {
  const clone = mkdtempSync(join(root, 'clone-'));
  mustRun('git', ['clone', '-q', '-b', branch, bare, clone], root);
  configureFixtureRepo(clone);
  const sha = commitChanges(clone, changes, message);
  mustRun('git', ['push', '-q', 'origin', branch], clone);

  return sha;
}

/**
 * Push a `--no-ff` merge to the bare repo's `master`, as GitHub lands a PR:
 * a side branch holding one commit per entry of `commits`, in order, merged with
 * `message` as the merge commit's subject. Returns the pushed merge commit's full sha.
 */
export function advanceOriginByMerge(
  root: string,
  bare: string,
  commits: readonly Changes[],
  message: string,
): string {
  const clone = mkdtempSync(join(root, 'clone-'));
  mustRun('git', ['clone', '-q', bare, clone], root);
  configureFixtureRepo(clone);
  mustRun('git', ['checkout', '-q', '-b', 'side'], clone);
  commits.forEach((changes, i) => commitChanges(clone, changes, `side ${String(i + 1)}`));
  mustRun('git', ['checkout', '-q', 'master'], clone);
  mustRun('git', ['merge', '-q', '--no-ff', '-m', message, 'side'], clone);
  mustRun('git', ['push', '-q', 'origin', 'master'], clone);

  return headSha(clone);
}

const FAKE_GH_SCRIPT = String.raw`'use strict';
const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const argv = process.argv.slice(2);
if (argv[0] === 'auth' && argv[1] === 'status' && argv.length === 2) {
  const auth = JSON.parse(readFileSync(join(__dirname, 'auth.json'), 'utf8'));
  if (auth.exit !== 0) {
    process.stderr.write('gh-fake: configured auth failure\n');
    process.exit(auth.exit);
  }
  process.stdout.write('gh-fake: logged in\n');
  process.exit(0);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
if (argv[0] === 'pr' && argv[1] === 'create') {
  const create = JSON.parse(readFileSync(join(__dirname, 'create.json'), 'utf8'));
  const bodyFile = flag('--body-file');
  const body = bodyFile === undefined ? null : readFileSync(bodyFile, 'utf8');
  writeFileSync(join(__dirname, 'created.json'), JSON.stringify({ argv, body }));
  if (create.exit !== 0) {
    process.stderr.write('gh-fake: configured pr create failure\n');
    process.exit(create.exit);
  }
  process.stdout.write('https://github.com/fixture/repo/pull/' + create.number + '\n');
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'view' && flag('--json') === 'body') {
  const n = argv[2];
  const bodiesPath = join(__dirname, 'bodies.json');
  const body = (existsSync(bodiesPath) ? JSON.parse(readFileSync(bodiesPath, 'utf8')) : {})[n];
  if (typeof body !== 'string') {
    process.stderr.write('gh-fake: no body configured for ' + n + '\n');
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({ body }) + '\n');
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'edit') {
  const editPath = join(__dirname, 'edit.json');
  const edit = existsSync(editPath) ? JSON.parse(readFileSync(editPath, 'utf8')) : { exit: 0 };
  const bodyFile = flag('--body-file');
  const body = bodyFile === undefined ? null : readFileSync(bodyFile, 'utf8');
  writeFileSync(join(__dirname, 'edited.json'), JSON.stringify({ argv, body }));
  if (edit.exit !== 0) {
    process.stderr.write('gh-fake: configured pr edit failure\n');
    process.exit(edit.exit);
  }
  process.stdout.write('https://github.com/fixture/repo/pull/' + argv[2] + '\n');
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'comment') {
  const commentPath = join(__dirname, 'comment.json');
  const comment = {
    exit: 0,
    printUrl: true,
    ...(existsSync(commentPath) ? JSON.parse(readFileSync(commentPath, 'utf8')) : {}),
  };
  const bodyFile = flag('--body-file');
  const body = bodyFile === undefined ? null : readFileSync(bodyFile, 'utf8');
  writeFileSync(join(__dirname, 'commented.json'), JSON.stringify({ argv, body }));
  if (comment.exit !== 0) {
    process.stderr.write('gh-fake: configured pr comment failure\n');
    process.exit(comment.exit);
  }
  if (typeof comment.stdout === 'string') {
    process.stdout.write(comment.stdout);
  } else if (comment.printUrl) {
    process.stdout.write('https://github.com/fixture/repo/pull/' + argv[2] + '#issuecomment-1\n');
  }
  process.exit(0);
}
if (argv[0] === 'issue' && argv[1] === 'comment') {
  const commentPath = join(__dirname, 'comment.json');
  const comment = {
    exit: 0,
    printUrl: true,
    ...(existsSync(commentPath) ? JSON.parse(readFileSync(commentPath, 'utf8')) : {}),
  };
  const bodyFile = flag('--body-file');
  const body = bodyFile === undefined ? null : readFileSync(bodyFile, 'utf8');
  writeFileSync(join(__dirname, 'issue-commented.json'), JSON.stringify({ argv, body }));
  if (comment.exit !== 0) {
    process.stderr.write('gh-fake: configured issue comment failure\n');
    process.exit(comment.exit);
  }
  if (typeof comment.stdout === 'string') {
    process.stdout.write(comment.stdout);
  } else if (comment.printUrl) {
    process.stdout.write('https://github.com/fixture/repo/issues/' + argv[2] + '#issuecomment-1\n');
  }
  process.exit(0);
}
if (argv[0] === 'pr' && argv[1] === 'view' && flag('--json') === 'mergeable,url') {
  const n = argv[2];
  const viewsPath = join(__dirname, 'views.json');
  const list = (existsSync(viewsPath) ? JSON.parse(readFileSync(viewsPath, 'utf8')) : {})[n];
  if (!Array.isArray(list)) {
    process.stderr.write('gh-fake: no view configured for ' + n + '\n');
    process.exit(3);
  }
  const countPath = join(__dirname, 'views-count.json');
  const counts = existsSync(countPath) ? JSON.parse(readFileSync(countPath, 'utf8')) : {};
  const k = counts[n] || 0;
  counts[n] = k + 1;
  writeFileSync(countPath, JSON.stringify(counts));
  const mergeable = list[Math.min(k, list.length - 1)];
  process.stdout.write(JSON.stringify({ mergeable, url: 'https://github.com/fixture/repo/pull/' + n }) + '\n');
  process.exit(0);
}
const head = flag('--head');
if (argv[0] !== 'pr' || argv[1] !== 'list' || head === undefined || flag('--json') !== 'number,state,headRefOid') {
  process.stderr.write('gh-fake: unexpected argv ' + JSON.stringify(argv) + '\n');
  process.exit(3);
}
const responses = JSON.parse(readFileSync(join(__dirname, 'responses.json'), 'utf8'));
const response = responses[head] || {};
if ((response.exit || 0) !== 0) {
  process.stderr.write('gh-fake: configured failure for ' + head + '\n');
  process.exit(response.exit);
}
const prs = response.prs || [];
const shown = flag('--state') === 'all' ? prs : prs.filter((pr) => pr.state === 'OPEN');
process.stdout.write(JSON.stringify(shown) + '\n');
`;

/** How the fake `gh pr create` answers. */
export interface FakePrCreate {
  /** Exit code. Non-zero prints an error and no URL. Defaults to `0`. */
  readonly exit?: number;
  /** The number in the printed PR URL. */
  readonly number: number;
}

/** What the fake `gh pr create` was called with. */
interface FakePrCreated {
  /** Its argv, after `gh`. */
  readonly argv: string[];
  /** The `--body-file` content when it ran, `null` without the flag. */
  readonly body: string | null;
}

/**
 * Write a fake `gh` into `<dir>/bin` and return that bin directory, to put first on the CLI's
 * `PATH`. It answers only `auth status` (exits `authExit`); `pr create` as `create` says
 * ({@link readFakePrCreated}); `pr view <n> --json body` ({@link setFakePrBodies});
 * `pr edit` ({@link setFakePrEditExit}, {@link readFakePrEdited}); `pr comment` and
 * `issue comment` ({@link setFakePrComment}, {@link readFakePrCommented},
 * {@link readFakeIssueCommented}); `pr view <n> --json mergeable,url` ({@link setFakePrViews},
 * {@link readFakePrViewCount}); and `pr list --head <branch> … --json number,state,headRefOid`,
 * which prints the PRs `responses` lists for the branch, none for an unlisted branch, and lists
 * open PRs only unless `--state all`. Anything else exits 3.
 */
export function writeFakeGh(
  dir: string,
  responses: Readonly<Record<string, FakeGhResponse>>,
  authExit = 0,
  create: FakePrCreate = { number: 1 },
): string {
  const bin = join(dir, 'bin');
  rmSync(bin, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh-fake.cjs'), FAKE_GH_SCRIPT);
  writeFileSync(join(bin, 'responses.json'), JSON.stringify(responses));
  writeFileSync(join(bin, 'auth.json'), JSON.stringify({ exit: authExit }));
  writeFileSync(join(bin, 'create.json'), JSON.stringify({ exit: 0, ...create }));
  writeNodeLauncher(bin, 'gh', join(bin, 'gh-fake.cjs'));

  return bin;
}

/** The call the fake `gh pr create` recorded last, `null` when it never ran. */
export function readFakePrCreated(bin: string): FakePrCreated | null {
  const path = join(bin, 'created.json');

  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FakePrCreated) : null;
}

/**
 * Configure the bodies, by PR number, the fake `gh pr view <n> --json body` prints as
 * `{"body":…}`. A PR not listed makes that read exit 3.
 */
export function setFakePrBodies(bin: string, bodies: Readonly<Record<number, string>>): void {
  writeFileSync(join(bin, 'bodies.json'), JSON.stringify(bodies));
}

/**
 * Configure what the fake `gh pr edit` exits. Until this is called it exits 0, printing the PR URL.
 * A non-zero exit prints an error and no URL.
 */
export function setFakePrEditExit(bin: string, exit: number): void {
  writeFileSync(join(bin, 'edit.json'), JSON.stringify({ exit }));
}

/** What the fake `gh pr edit` was called with. */
interface FakePrEdited {
  /** Its argv, after `gh`. */
  readonly argv: string[];
  /** The `--body-file` content when it ran, `null` without the flag. */
  readonly body: string | null;
}

/** The call the fake `gh pr edit` recorded last, `null` when it never ran. */
export function readFakePrEdited(bin: string): FakePrEdited | null {
  const path = join(bin, 'edited.json');

  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FakePrEdited) : null;
}

/** How the fake `gh pr comment` answers. */
export interface FakePrComment {
  /** Exit code. Non-zero prints an error and no URL. Defaults to `0`. */
  readonly exit?: number;
  /** Whether an exit 0 prints the comment URL. Defaults to `true`. */
  readonly printUrl?: boolean;
  /** What an exit 0 prints instead of the comment URL, verbatim. Overrides `printUrl`. */
  readonly stdout?: string;
}

/**
 * Configure how the fake `gh pr comment` and `gh issue comment` answer. By default they exit 0,
 * printing `https://github.com/fixture/repo/{pull,issues}/<n>#issuecomment-1`.
 */
export function setFakePrComment(bin: string, comment: FakePrComment): void {
  writeFileSync(join(bin, 'comment.json'), JSON.stringify(comment));
}

/** What the fake `gh pr comment` was called with. */
interface FakePrCommented {
  /** Its argv, after `gh`. */
  readonly argv: string[];
  /** The `--body-file` content when it ran, `null` without the flag. */
  readonly body: string | null;
}

/** The call the fake `gh pr comment` recorded last, `null` when it never ran. */
export function readFakePrCommented(bin: string): FakePrCommented | null {
  const path = join(bin, 'commented.json');

  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FakePrCommented) : null;
}

/** The call the fake `gh issue comment` recorded last, `null` when it never ran. */
export function readFakeIssueCommented(bin: string): FakePrCommented | null {
  const path = join(bin, 'issue-commented.json');

  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FakePrCommented) : null;
}

/**
 * Configure how the fake `gh pr view <n>` answers: the `n`th read gets the
 * list's `n`th `mergeable` value, the last one repeating. A PR not listed
 * makes `pr view` exit 3.
 */
export function setFakePrViews(
  bin: string,
  views: Readonly<Record<number, readonly string[]>>,
): void {
  writeFileSync(join(bin, 'views.json'), JSON.stringify(views));
}

/** How many times the fake `gh pr view` answered for PR `n`, `0` when it never answered. */
export function readFakePrViewCount(bin: string, n: number): number {
  const path = join(bin, 'views-count.json');
  if (!existsSync(path)) return 0;
  const counts = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number | undefined>;

  return counts[String(n)] ?? 0;
}

/**
 * A one-entry env overlay, for a spawned process's env, putting `dir` first on `PATH`, keyed by
 * the spelling the environment already uses (win32's is `Path` under PowerShell or cmd, Git Bash's
 * is `PATH`): a second, differently cased `PATH` key would silently win or lose by spelling
 * (`PATH` over `Path` over `path`), not by insertion order (unprobed).
 */
export function prependPath(dir: string): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';

  return { [key]: `${dir}${delimiter}${process.env[key] ?? ''}` };
}

/**
 * Write an executable `name` into `bin` (`name.cmd` on Windows) that runs `script` under this
 * Node, `lead` before the caller's arguments.
 */
function writeNodeLauncher(
  bin: string,
  name: string,
  script: string,
  lead: readonly string[] = [],
): void {
  const words = [`"${process.execPath}"`, `"${script}"`, ...lead].join(' ');

  if (process.platform === 'win32') {
    writeFileSync(join(bin, `${name}.cmd`), `@${words} %*\r\n`);
  } else {
    const launcher = join(bin, name);
    writeFileSync(launcher, `#!/bin/sh\nexec ${words} "$@"\n`);
    chmodSync(launcher, 0o755);
  }
}

/**
 * Run `work` in a throwaway worktree of `main` on an existing branch, removed again after. Returns
 * what `work` returns.
 */
function inThrowawayWorktree(main: string, branch: string, work: (dir: string) => string): string {
  const tmp = mkdtempSync(join(dirname(main), 'wt-'));
  rmSync(tmp, { recursive: true });
  mustRun('git', ['worktree', 'add', '-q', tmp, branch], main);
  const sha = work(tmp);
  mustRun('git', ['worktree', 'remove', tmp], main);

  return sha;
}

function writeFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
