/**
 * `preflight <main>` — the checks an unattended run needs to hold before it
 * cuts anything (ADR-0045): local `master` level with `origin/master` after
 * a fetch, `gh` logged in, and every warm-set server answering RCON. It
 * also snapshots the main checkout's `HEAD` and whether it is dirty; a
 * dirty main checkout is recorded, never a problem.
 *
 * Read-only toward every worktree, so there is no self-hosted guard (like
 * `live-runs`): the fetch writes only `.git`'s remote-tracking refs. It
 * never starts a server — an unreachable warm member is a problem to
 * report, not to fix.
 *
 * Every check runs even when an earlier one failed, so one envelope names
 * every problem; only a git or registry failure stops the command.
 */

import { loadPoolRegistry, type PoolEntry } from '../../src/server-pool/index.js';
import { probeRcon, type RconProbeResult, type RconProbeTarget } from '../lib/rcon-probe.js';

import { GH_TIMEOUT_MS, runCaptured } from './exec.js';
import { assertMainWorktree, fetchOrigin, git, resolveCommit, statusEntries } from './git.js';
import { isMember, memberLabel, WARM_SET } from './pool-registry-trim.js';
import { RUN_BASE_BRANCH } from './run-layout.js';
import type { PreflightProblem, PreflightResult } from './types-run.js';
import { Refusal, recordFailure, StepFailure, type WarmMember } from './types.js';

/** One RCON round trip to a warm member; the production probe is {@link probeRcon}. */
export type WarmProbe = (target: RconProbeTarget) => Promise<RconProbeResult>;

/** Inputs of {@link preflight}. */
export interface PreflightInput {
  /** The main checkout, absolute with forward slashes. */
  readonly main: string;
  /** The warm-set probe (production: `probeRcon` with `list`). */
  readonly probe?: WarmProbe;
}

/** Where the main checkout keeps the pool registry the warm set is read from. */
const REGISTRY_PATH = 'src/server-pool/registry/pool-registry.json';

/**
 * Run every pre-flight check against the main checkout.
 *
 * @param input - The main checkout and the probe seam.
 * @returns The envelope: `ok` with the counts and snapshot; `refused`
 *   `preflight-failed` with every problem; `refused` `not-main-worktree`;
 *   or `failed` with the step (`preconditions`, `fetch`, `master`,
 *   `snapshot`, `registry`).
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const { main, probe = (target) => probeRcon(target, 'list') } = input;
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
    };
    result.problems.push(...checkGhAuth(main), ...(await checkWarmSet(main, probe)));
    assertNoProblems(result.problems);
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Count local `master` against `origin/master` and record a problem for
 * each side that is ahead.
 *
 * @param main - The main checkout, freshly fetched.
 * @param result - Envelope; gains `ahead`, `behind` and any problems.
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
 * Ask `gh` whether it is logged in.
 *
 * @param main - The main checkout (`gh`'s working directory).
 * @returns A `gh-auth` problem carrying `gh`'s output when it exits
 *   non-zero or cannot be run; none otherwise.
 */
function checkGhAuth(main: string): PreflightProblem[] {
  const r = runCaptured('gh', ['auth', 'status'], { cwd: main, timeoutMs: GH_TIMEOUT_MS });
  if (r.exitCode === 0) return [];
  return [{ check: 'gh-auth', message: `gh auth status exited ${String(r.exitCode)}: ${r.tail}` }];
}

/**
 * Probe every warm-set member at the RCON address and password the main
 * checkout's registry gives it.
 *
 * @param main - The main checkout.
 * @param probe - The probe.
 * @returns One `warm-unreachable` problem per member the registry lacks or
 *   the probe could not reach, naming it; in {@link WARM_SET} order.
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

/**
 * Probe one warm member.
 *
 * @param member - The member.
 * @param registry - The main checkout's registry entries.
 * @param probe - The probe.
 * @returns `null` when it answered; otherwise why not.
 */
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
 * Refuse when any check failed.
 *
 * @param problems - Every failed check.
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
