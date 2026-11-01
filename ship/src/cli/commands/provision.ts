/**
 * `provision <slice> --batch <batch> [--server]`: make a slice worktree
 * runnable: its `node_modules` linked to the batch worktree's real tree, a
 * real local `dist`, and vitest configs with an isolated cache.
 *
 * Never a half-provisioned tree: once any step has mutated the slice, a
 * later failure rolls back exactly what this call created (paths absent
 * before it ran). Anything an earlier provision left stays, even if this
 * call rewrote it, so a failed re-provision keeps the earlier junction and
 * configs. Its `dist` is whatever the failed build left (a build may delete
 * `dist` before failing). The last step is {@link assertStatusUnchanged}.
 */

import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import { NPM_TIMEOUT_MS, runStep } from '../git/exec.js';
import {
  assertNotSelfHosted,
  assertStatusUnchanged,
  requireWorktreeRoot,
  samePath,
  statusEntries,
  type WorktreeIdentity,
} from '../git/git.js';
import { createJunction, isRealDir, linkTarget, unlinkLink } from '../git/links.js';
import { recordFailure, StepFailure, type ProvisionResult } from '../envelope/types.js';

/** Inputs of {@link provision}: paths absolute with forward slashes. */
interface ProvisionOptions {
  /** The slice worktree to provision. */
  readonly slice: string;
  /** The batch worktree whose `node_modules` the slice links to. */
  readonly batch: string;
  /** Also write the integration-config twin. */
  readonly server: boolean;
  /** The running CLI's file, for the self-hosted guard (default: this module). */
  readonly selfPath?: string;
}

/** One vitest config the slice gets: file name, base config, cache dir. */
interface VitestConfigSpec {
  readonly file: string;
  readonly base: string;
  readonly cacheDir: string;
}

const UNIT_CONFIG: VitestConfigSpec = {
  file: 'vitest.worktree.config.ts',
  base: './config/vitest.config',
  cacheDir: './.vitest-cache',
};

const INTEGRATION_CONFIG: VitestConfigSpec = {
  file: 'vitest.worktree.integration.config.ts',
  base: './config/vitest.integration.config',
  cacheDir: './.vitest-cache-integration',
};

/** A path this call created, and how to remove it again. */
interface Created {
  readonly path: string;
  readonly kind: 'link' | 'tree';
}

/** Per-call state threaded through the steps. */
interface Run {
  readonly options: ProvisionOptions;
  readonly result: ProvisionResult;
  /** Paths this call created, in creation order. */
  readonly created: Created[];
}

/**
 * Provision a slice worktree.
 *
 * @returns The envelope: `ok` with `env`, or `failed` with the step and the
 *   paths rolled back.
 */
export function provision(options: ProvisionOptions): ProvisionResult {
  const run: Run = {
    options,
    created: [],
    result: {
      command: 'provision',
      status: 'ok',
      worktree: options.slice,
      errors: [],
      batch: options.batch,
      junctions: [],
      dist: null,
      vitestConfigs: [],
      env: null,
      rolledBack: [],
    },
  };

  try {
    checkPreconditions(options);
    const before = statusEntries(options.slice, 'preconditions');
    ensureJunction(run);
    buildDist(run);
    writeVitestConfigs(run);
    assertStatusUnchanged(options.slice, before);
    run.result.env = { PH_PROJECT_DIR: options.batch };
  } catch (err) {
    recordFailure(run.result, err);
    rollback(run);
  }

  return run.result;
}

/**
 * Throws Refusal `self-hosted` when the CLI runs inside the slice, and StepFailure `preconditions`
 * unless slice and batch are distinct linked (non-main) worktree roots of one repo, the batch has
 * a real non-empty `node_modules` and `paper-harness/` marker, and the slice's `dist` is no link.
 */
function checkPreconditions(options: ProvisionOptions): void {
  assertNotSelfHosted(options.slice, options.selfPath ?? import.meta.filename);
  const slice = requireLinkedWorktree(options.slice, 'slice');
  const batch = requireLinkedWorktree(options.batch, 'batch');

  const fail = (message: string): never => {
    throw new StepFailure('preconditions', message);
  };

  if (samePath(options.slice, options.batch)) fail('slice and batch are the same worktree');
  if (!samePath(slice.commonDir, batch.commonDir))
    fail('slice and batch belong to different repositories');
  const modules = `${options.batch}/node_modules`;

  if (!isRealDir(modules) || readdirSync(modules).length === 0) {
    fail(`${modules} is not a real, non-empty directory`);
  }

  if (!existsSync(`${options.batch}/paper-harness`))
    fail(`${options.batch}/paper-harness is missing`);
  // The build deletes `dist`, which must never reach through a link.
  if (linkTarget(`${options.slice}/dist`) !== null) fail(`${options.slice}/dist is a link`);
}

/**
 * Require `path` to be a worktree root other than the main worktree.
 *
 * @param role - `slice` or `batch`, for the message.
 * @throws StepFailure `preconditions` otherwise.
 */
function requireLinkedWorktree(path: string, role: string): WorktreeIdentity {
  const identity = requireWorktreeRoot(path, 'preconditions');

  if (samePath(identity.main, path)) {
    throw new StepFailure('preconditions', `the ${role} ${path} is the main worktree`);
  }

  return identity;
}

/**
 * Link `<slice>/node_modules` to `<batch>/node_modules`, created when absent, reused when it
 * already links there. `run` gains the junction.
 *
 * @throws StepFailure `junction` when the path exists as anything else.
 */
function ensureJunction(run: Run): void {
  const link = `${run.options.slice}/node_modules`;
  const target = `${run.options.batch}/node_modules`;
  const existing = linkTarget(link);

  if (existing === null && existsSync(link)) {
    throw new StepFailure('junction', `${link} exists and is not a link`);
  }

  if (existing !== null && !samePath(existing, target)) {
    throw new StepFailure('junction', `${link} links to ${existing}, not ${target}`);
  }

  if (existing === null) {
    createJunction(link, target);
    run.created.push({ path: link, kind: 'link' });
  }

  run.result.junctions.push({ path: link, target });
}

/**
 * Build the slice's real local `dist` with `npm run build`.
 *
 * @param run - Call state: gains `dist`.
 * @throws StepFailure `build` carrying the build's output tail.
 */
function buildDist(run: Run): void {
  const dist = `${run.options.slice}/dist`;
  if (!existsSync(dist)) run.created.push({ path: dist, kind: 'tree' });
  runStep('build', 'npm', ['run', 'build'], { cwd: run.options.slice, timeoutMs: NPM_TIMEOUT_MS });
  if (existsSync(dist) && !lstatSync(dist).isSymbolicLink()) run.result.dist = dist;
}

/**
 * Write the slice's vitest configs (the integration twin only with
 * `--server`).
 *
 * @param run - Call state: gains each written config.
 */
function writeVitestConfigs(run: Run): void {
  const specs = run.options.server ? [UNIT_CONFIG, INTEGRATION_CONFIG] : [UNIT_CONFIG];

  for (const spec of specs) {
    const path = `${run.options.slice}/${spec.file}`;
    if (!existsSync(path)) run.created.push({ path, kind: 'tree' });
    writeFileSync(path, renderConfig(spec));
    run.result.vitestConfigs.push(path);
  }
}

/** Render a merged vitest config: the base plus a top-level `cacheDir`. */
function renderConfig(spec: VitestConfigSpec): string {
  return [
    "import { defineConfig, mergeConfig } from 'vitest/config';",
    `import baseConfig from '${spec.base}';`,
    '',
    `export default mergeConfig(baseConfig, defineConfig({ cacheDir: '${spec.cacheDir}' }));`,
    '',
  ].join('\n');
}

/**
 * Remove, in reverse, every path this call created. A link is unlinked,
 * never deleted recursively. Updates the envelope's fields to what remains.
 *
 * @param run - Call state: `result.rolledBack` gains each removed path.
 */
function rollback(run: Run): void {
  for (const { path, kind } of [...run.created].reverse()) {
    if (kind === 'link') unlinkLink(path);
    else if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    else continue;
    run.result.rolledBack.push(path);
  }

  const removed = new Set(run.result.rolledBack);
  run.result.junctions = run.result.junctions.filter((j) => !removed.has(j.path));
  run.result.vitestConfigs = run.result.vitestConfigs.filter((p) => !removed.has(p));
  if (run.result.dist !== null && removed.has(run.result.dist)) run.result.dist = null;
}
