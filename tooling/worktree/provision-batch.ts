/**
 * `provision-batch <batch> --report-dir <dir>` — make a batch worktree the
 * junction source for its slices: a real `npm ci` tree, a real `dist`, a
 * real self-install workspace, and the trimmed warm-set pool registry,
 * written outside every worktree. No rollback: this runs at launch with the
 * maintainer present, and `npm ci` cannot meaningfully be undone — a
 * failure fails the launch.
 */

import { mkdirSync } from 'node:fs';

import { NPM_TIMEOUT_MS, runStep } from './exec.js';
import {
  assertNotSelfHosted,
  assertStatusUnchanged,
  isInside,
  listWorktrees,
  requireWorktreeRoot,
  samePath,
  statusEntries,
} from './git.js';
import { linkTarget } from './links.js';
import { trimRegistry } from './pool-registry-trim.js';
import { BATCH_REGISTRY_FILE } from './run-layout.js';
import { Refusal, recordFailure, StepFailure, type ProvisionBatchResult } from './types.js';

/** Inputs of {@link provisionBatch}; paths absolute with forward slashes. */
export interface ProvisionBatchOptions {
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
    workspace: null,
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
    result.workspace = createWorkspace(batch);
    const registry = `${reportDir}/${BATCH_REGISTRY_FILE}`;
    result.warm = trimRegistry(`${batch}/src/server-pool/registry/pool-registry.json`, registry);
    result.registry = registry;
    assertStatusUnchanged(batch, before);
    result.env = { PH_PROJECT_DIR: batch, PH_POOL_REGISTRY: registry };
  } catch (err) {
    recordFailure(result, err);
  }
  return result;
}

/**
 * Pre-install guards: `npm ci` would wipe the main worktree's `node_modules` or a link's target.
 *
 * @throws Refusal `self-hosted`, `main-worktree`, `report-dir-inside-worktree` (report dir in any
 *   worktree); StepFailure `preconditions`: not a worktree root, or `node_modules` is a link.
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
  const host = listWorktrees(batch, 'preconditions').find((w) => isInside(reportDir, w.path));
  if (host !== undefined) {
    throw new Refusal(
      'report-dir-inside-worktree',
      'preconditions',
      `report dir ${reportDir} lies inside the worktree ${host.path}`,
    );
  }
}

/**
 * Create the batch's real self-install workspace (`paper-harness/{helpers,tests}`).
 *
 * @throws StepFailure `workspace` when `paper-harness` exists as a link.
 */
function createWorkspace(batch: string): string {
  const workspace = `${batch}/paper-harness`;
  if (linkTarget(workspace) !== null) {
    throw new StepFailure('workspace', `${workspace} is a link, not a real workspace`);
  }
  mkdirSync(`${workspace}/helpers`, { recursive: true });
  mkdirSync(`${workspace}/tests`, { recursive: true });
  return workspace;
}
