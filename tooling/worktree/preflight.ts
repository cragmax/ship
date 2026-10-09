/**
 * `preflight <main> [--attach ship/<slug>] [--slug <slug>,…]` — the checks an unattended run holds
 * before it cuts anything (ADR-0045): local `master` level with `origin/master` after a fetch, `gh`
 * logged in, every warm-set server answering RCON; with `--slug`, no leftover slice branch of each
 * run slug ({@link checkSliceBranches}); with `--attach`, the target branch's checks
 * ({@link checkAttachTarget}). It snapshots the main checkout's `HEAD`, its dirtiness, and the
 * launch shas of local `master` and of `origin`'s (`git ls-remote`, not the tracking ref) — the
 * epic end's master-check baseline. A dirty main checkout is recorded, never a problem.
 *
 * Read-only toward every worktree, so no self-hosted guard: the fetch writes only remote-tracking
 * refs. It never starts a server: an unreachable warm member is reported, not fixed. Every check
 * runs even when an earlier one failed, so one envelope names every problem; only a git or
 * registry failure stops the command.
 */

import { loadPoolRegistry, type PoolEntry } from '../../src/server-pool/index.js';
import { probeRcon, type RconProbeResult, type RconProbeTarget } from '../lib/rcon-probe.js';

import { assertPublished, attachSlug, openPr } from './cut-attach.js';
import { GH_TIMEOUT_MS, runCaptured } from './exec.js';
import {
  assertMainWorktree,
  fetchOrigin,
  git,
  lsRemoteRef,
  resolveCommit,
  statusEntries,
} from './git.js';
import { isMember, memberLabel, WARM_SET } from './pool-registry-trim.js';
import { RUN_BASE_BRANCH, runLayout, sliceBranchPrefix } from './run-layout.js';
import { assertNoLiveSlices } from './sync-master.js';
import type { PreflightCheck, PreflightProblem, PreflightResult } from './types-run.js';
import { Refusal, recordFailure, StepFailure, type WarmMember } from './types.js';

/** One RCON round trip to a warm member; the production probe is {@link probeRcon}. */
export type WarmProbe = (target: RconProbeTarget) => Promise<RconProbeResult>;

/** Inputs of {@link preflight}. */
export interface PreflightInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** An attached run's target branch (`ship/<slug>`, short form); absent for an unattached run. */
  readonly attach?: string;
  /** The run slugs whose leftover slice branches refuse; absent for none. */
  readonly slugs?: readonly string[];
  /** The warm-set probe (production: `probeRcon` with `list`). */
  readonly probe?: WarmProbe;
}

/** Where the main checkout keeps the pool registry the warm set is read from. */
const REGISTRY_PATH = 'src/server-pool/registry/pool-registry.json';

/**
 * Run every pre-flight check against the main checkout.
 *
 * @returns The envelope: `ok` with the counts and snapshot; `refused`
 *   `preflight-failed` with every problem — with `attach`, the target's
 *   `no-open-pr`, `slices-live` and `unpublished-commits` among them;
 *   `refused` `not-main-worktree`, or `not-run-batch` for an `attach` outside
 *   `ship/`; or `failed` with the step (`preconditions`, `fetch`, `master`,
 *   `snapshot`, `registry`, `slice-branches`, `unpublished`).
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const { main, attach, slugs = [], probe = (target) => probeRcon(target, 'list') } = input;
  const result: PreflightResult = {
    command: 'preflight',
    status: 'ok',
    worktree: main,
    errors: [],
    ahead: null,
    behind: null,
    snapshot: null,
    problems: [],
  };
  try {
    assertMainWorktree(main, 'preconditions');
    fetchOrigin(main);
    checkMasterLevel(main, result);
    result.snapshot = {
      head: resolveCommit(main, 'HEAD', 'snapshot'),
      dirty: statusEntries(main, 'snapshot').length > 0,
      master: {
        local: resolveCommit(main, `refs/heads/${RUN_BASE_BRANCH}`, 'snapshot'),
        remote: remoteMaster(main),
      },
    };
    result.problems.push(...checkGhAuth(main), ...(await checkWarmSet(main, probe)));
    result.problems.push(...checkSliceBranches(main, slugs));
    if (attach !== undefined) result.problems.push(...checkAttachTarget(main, attach));
    assertNoProblems(result.problems);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Count local `master` against a freshly fetched `origin/master` into `result`'s `ahead` and
 * `behind`, with one problem per side that is ahead.
 *
 * @throws StepFailure `master` when either ref does not resolve.
 */
function checkMasterLevel(main: string, result: PreflightResult): void {
  const range = `refs/heads/${RUN_BASE_BRANCH}...refs/remotes/origin/${RUN_BASE_BRANCH}`;
  const [ahead = NaN, behind = NaN] = git(
    main,
    ['rev-list', '--left-right', '--count', range],
    'master',
  )
    .split(/\s+/u)
    .map(Number);
  result.ahead = ahead;
  result.behind = behind;
  if (ahead > 0) {
    result.problems.push({
      check: 'master-ahead',
      message: `local ${RUN_BASE_BRANCH} is ${String(ahead)} commit(s) ahead of origin/${RUN_BASE_BRANCH}`,
    });
  }
  if (behind > 0) {
    result.problems.push({
      check: 'master-behind',
      message: `local ${RUN_BASE_BRANCH} is ${String(behind)} commit(s) behind origin/${RUN_BASE_BRANCH}`,
    });
  }
}

/**
 * Read `origin`'s `master` live with `git ls-remote`, for the launch snapshot.
 *
 * @throws StepFailure `snapshot` when `ls-remote` fails or names no ref.
 */
function remoteMaster(main: string): string {
  const sha = lsRemoteRef(main, `refs/heads/${RUN_BASE_BRANCH}`, 'snapshot');
  if (sha === null) {
    throw new StepFailure('snapshot', 'git ls-remote origin refs/heads/master names no ref');
  }
  return sha;
}

/**
 * Ask `gh` whether it is logged in: a `gh-auth` problem carrying its output when it exits non-zero
 * or cannot run.
 */
function checkGhAuth(main: string): PreflightProblem[] {
  const r = runCaptured('gh', ['auth', 'status'], { cwd: main, timeoutMs: GH_TIMEOUT_MS });
  if (r.exitCode === 0) return [];
  return [{ check: 'gh-auth', message: `gh auth status exited ${String(r.exitCode)}: ${r.tail}` }];
}

/**
 * Probe each warm member at the RCON address the main checkout's registry gives it: one problem
 * `warm-unreachable` per member it lacks or the probe cannot reach, in {@link WARM_SET} order.
 *
 * @throws StepFailure `registry` when the registry fails to load.
 */
async function checkWarmSet(main: string, probe: WarmProbe): Promise<PreflightProblem[]> {
  const loaded = loadPoolRegistry(`${main}/${REGISTRY_PATH}`);
  if (!loaded.ok) throw new StepFailure('registry', loaded.error.message);
  const outcomes = await Promise.all(
    WARM_SET.map((member) => probeMember(member, loaded.value, probe)),
  );
  return outcomes.flatMap((reason, i) => {
    const member = WARM_SET[i];
    if (reason === null || member === undefined) return [];
    return [{ check: 'warm-unreachable' as const, message: `${memberLabel(member)}: ${reason}` }];
  });
}

/** Probe one warm member: `null` when it answered; otherwise why not. */
async function probeMember(
  member: WarmMember,
  registry: readonly PoolEntry[],
  probe: WarmProbe,
): Promise<string | null> {
  const entry = registry.find((e) => isMember(member, e));
  if (entry === undefined) return 'not in the registry';
  const r = await probe({ host: entry.host, port: entry.rconPort, password: entry.rconPassword });
  if (r.ok) return null;
  return `RCON ${r.stage} failed: ${r.error instanceof Error ? r.error.message : String(r.error)}`;
}

/**
 * One `stale-slice-branch` problem per branch under each slug's {@link sliceBranchPrefix} (its
 * trailing slash keeps `slice/<slug>2/…` out), slug by slug, in ref order (#1302).
 *
 * @throws StepFailure `slice-branches` when git cannot list them.
 */
function checkSliceBranches(main: string, slugs: readonly string[]): PreflightProblem[] {
  return slugs.flatMap((slug) => {
    const { branch } = runLayout(main, slug);
    const pattern = `refs/heads/${sliceBranchPrefix(slug)}`;
    return git(main, ['for-each-ref', '--format=%(refname:lstrip=2)', pattern], 'slice-branches')
      .split(/\r?\n/u)
      .filter((name) => name !== '')
      .map((name) => ({
        check: 'stale-slice-branch' as const,
        message: `${name} is left over from a run of ${branch}`,
      }));
  });
}

/**
 * One problem per failed check of attach target `branch` (short form), in order: `no-open-pr` (a
 * `gh` that cannot report the PR included), `slices-live`, `unpublished-commits`.
 *
 * @throws Refusal `not-run-batch` unless `branch` is a `ship/` branch; StepFailure when git fails.
 */
function checkAttachTarget(main: string, branch: string): PreflightProblem[] {
  const { batch } = runLayout(main, attachSlug(branch));
  return [
    problemOf('no-open-pr', () => openPr(main, branch)),
    problemOf('slices-live', () => {
      assertNoLiveSlices(main, batch);
    }),
    problemOf('unpublished-commits', () => {
      assertPublished(main, branch);
    }),
  ].flatMap((p) => (p === null ? [] : [p]));
}

/**
 * Run one attach guard: `null` when it passed; a thrown Refusal or `pr-state` StepFailure becomes
 * the `check` problem with its message ("could not ask" refuses, never passes).
 *
 * @throws Whatever else the guard threw.
 */
function problemOf(check: PreflightCheck, guard: () => unknown): PreflightProblem | null {
  try {
    guard();
    return null;
  } catch (err) {
    if (err instanceof Refusal || (err instanceof StepFailure && err.step === 'pr-state')) {
      return { check, message: err.message };
    }
    throw err;
  }
}

/**
 * Refuse when any check failed.
 *
 * @throws Refusal `preflight-failed` naming each problem's check.
 */
function assertNoProblems(problems: readonly PreflightProblem[]): void {
  if (problems.length === 0) return;
  throw new Refusal(
    'preflight-failed',
    'preflight',
    `pre-flight failed: ${problems.map((p) => p.check).join(', ')}`,
  );
}
