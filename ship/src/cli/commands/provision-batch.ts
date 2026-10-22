/**
 * `provision-batch <batch> --report-dir <dir>` — make a batch worktree the
 * junction source for its slices: a real `npm ci` tree, a real `dist`, a
 * `paper-harness/` project-dir marker, and the trimmed warm-set pool registry,
 * written outside every worktree. No rollback: this runs at launch with the
 * maintainer present, and `npm ci` cannot meaningfully be undone — a
 * failure fails the launch.
 */

import { mkdirSync } from 'node:fs';

import { NPM_TIMEOUT_MS, runStep } from '../git/exec.js';
import {
  assertNotSelfHosted,
  assertStatusUnchanged,
  isInside,
  listWorktrees,
  requireWorktreeRoot,
  samePath,
  statusEntries,
} from '../git/git.js';
import { linkTarget } from '../git/links.js';
import { trimRegistry } from './pool-registry-trim.js';
import { BATCH_REGISTRY_FILE } from '../git/run-layout.js';
import {
  Refusal,
  recordFailure,
  StepFailure,
  type ProvisionBatchResult,
} from '../envelope/types.js';

/** Inputs of {@link provisionBatch}; paths absolute with forward slashes. */
interface ProvisionBatchOptions {
  /** The batch worktree. */
  readonly batch: string;
  /** Directory the trimmed registry is written to. */
  readonly reportDir: string;
  /** The running CLI's file, for the self-hosted guard (default: this module). */
  readonly selfPath?: string;
}

/**
 * Provision a batch worktree.
 *
 * @returns The envelope: `ok` with `env`, or `failed` / `refused`.
 */
export function provisionBatch(options: ProvisionBatchOptions): ProvisionBatchResult {
  const { batch, reportDir } = options;
  const result: ProvisionBatchResult = {
    command: 'provision-batch',
    status: 'ok',
    worktree: batch,
    errors: [],
    nodeModules: null,
    dist: null,
    projectDirMarker: null,
    registry: null,
    warm: [],
    env: null,
  };
  try {
    checkPreconditions(options);
    mkdirSync(reportDir, { recursive: true });
    const before = statusEntries(batch, 'preconditions');
    runStep('install', 'npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: batch,
      timeoutMs: NPM_TIMEOUT_MS,
    });
    result.nodeModules = `${batch}/node_modules`;
    runStep('build', 'npm', ['run', 'build'], { cwd: batch, timeoutMs: NPM_TIMEOUT_MS });
    result.dist = `${batch}/dist`;
    result.projectDirMarker = createProjectDirMarker(batch);
    const registry = `${reportDir}/${BATCH_REGISTRY_FILE}`;
    result.warm = trimRegistry(`${batch}/server-pool/src/registry/pool-registry.json`, registry);
    result.registry = registry;
    assertStatusUnchanged(batch, before);
    result.env = { PH_PROJECT_DIR: batch, PH_POOL_REGISTRY: registry };
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * `npm ci` wipes main's `node_modules` or a link target: junction (Ship PF-9), symlink (unprobed).
 * @throws Refusal `self-hosted`, `main-worktree`, `report-dir-inside-worktree` (report dir in a
 *   linked worktree); StepFailure `preconditions`: not a worktree root, or a linked `node_modules`.
 */
function checkPreconditions(options: ProvisionBatchOptions): void {
  const { batch, reportDir } = options;
  assertNotSelfHosted(batch, options.selfPath ?? import.meta.filename);
  const { main } = requireWorktreeRoot(batch, 'preconditions');
  if (samePath(main, batch)) {
    throw new Refusal('main-worktree', 'preconditions', `${batch} is the main worktree`);
  }
  if (linkTarget(`${batch}/node_modules`) !== null) {
    throw new StepFailure('preconditions', `${batch}/node_modules is a link`);
  }
  // The main checkout holds every run's report dir (`run-layout.ts`).
  const host = listWorktrees(batch, 'preconditions').find(
    (w) => !samePath(w.path, main) && isInside(reportDir, w.path),
  );
  if (host !== undefined) {
    throw new Refusal(
      'report-dir-inside-worktree',
      'preconditions',
      `report dir ${reportDir} lies inside the worktree ${host.path}`,
    );
  }
}

/**
 * Create the batch's real `paper-harness/{helpers,tests}` project-dir marker, which `loadConfig`
 * requires under `PH_PROJECT_DIR`.
 *
 * @throws StepFailure `project-dir-marker` when `paper-harness` exists as a link.
 */
function createProjectDirMarker(batch: string): string {
  const marker = `${batch}/paper-harness`;
  if (linkTarget(marker) !== null) {
    throw new StepFailure('project-dir-marker', `${marker} is a link, not a real directory`);
  }
  mkdirSync(`${marker}/helpers`, { recursive: true });
  mkdirSync(`${marker}/tests`, { recursive: true });
  return marker;
}
