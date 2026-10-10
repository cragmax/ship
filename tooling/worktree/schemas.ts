/**
 * The worktree CLI's envelope schemas: the canonical home of every envelope `tooling/worktree.ts`
 * prints (the run-branch and epic-end commands' are in `schemas-run.ts`). `types.ts` and
 * `types-run.ts` export each envelope's type as the schema's `z.infer`, and the saved workflows'
 * tool-output schemas are `.pick`s of these (`tooling/workflows/schemas/`), so a field renamed here
 * breaks every builder and reader at compile time.
 *
 * Every filesystem path in an envelope is absolute with forward slashes; the path lists of
 * `harvest`, `land`, `staged-guard`, `live-runs` and `sync-master` (`files`, `conflicts`,
 * `pending`, `expected`, `staged`, `missing`, `unexpected`, `landed`) are repository-relative, as
 * git spells them. Every count, port and number is an integer.
 *
 * Objects strip unknown keys when parsed; nothing here parses an envelope but
 * {@link guardEnvelope}, which never prints the parse output.
 */

import { z } from 'zod';

import type { ResultBase } from './types.js';

/** The envelope's outcome; `types.ts`'s header gives each status's meaning. */
export const CommandStatusSchema = z.enum(['ok', 'failed', 'refused', 'conflict']);

/** Which safety guard produced a `refused` envelope. */
export const RefusalReasonSchema = z.enum([
  'self-hosted',
  'main-worktree',
  'report-dir-inside-worktree',
  'links-remain',
  'source-shrank',
  // Teardown, retire-run: another registered worktree lies inside the target; the message names
  // each.
  'nested-worktree',
  // Harvest, land, sync-master, bump: the batch has uncommitted changes, or
  // a merge, cherry-pick or revert in progress.
  'batch-dirty',
  // Harvest: the target is missing, outside any repository, or only a subdirectory of a worktree.
  'unregistered-worktree',
  // Staged-guard: the staged set differs from the expected list; the envelope names both sides.
  'staged-mismatch',
  // Land: the slice is not exactly one commit on top of its cut.
  'slice-not-single-commit',
  // Cut-batch, preflight: the target is not the repository's main worktree.
  'not-main-worktree',
  // Cut-slice, land, bump, publish: the target is a linked worktree, but not
  // on a `ship/` run branch. Cut-batch `--attach`: the branch named is not a
  // `ship/` run branch.
  'not-run-batch',
  // Cut-batch, cut-slice: the branch to create exists already.
  'branch-exists',
  // Cut-batch, cut-slice: the directory to create exists already; with
  // cut-batch `--attach`, as anything but the branch's registered batch.
  'path-exists',
  // Cut-batch `--attach`: neither the local branch nor `origin`'s exists.
  'branch-missing',
  // Cut-batch `--attach`: the branch is checked out elsewhere than the run's batch; the message
  // names where.
  'branch-checked-out',
  // Cut-batch `--attach`: the local branch and `origin`'s each have commits the other lacks.
  'branch-diverged',
  // Cut-batch --attach: the local branch has first-parent non-merge commits origin lacks; the
  // message names the count.
  'unpublished-commits',
  // Preflight: a check failed; the envelope's `problems` names each.
  'preflight-failed',
  // Sync-master: another worktree's `node_modules` links into the batch's; the message names each.
  'slices-live',
  // Sync-master: the merge would conflict outside the lockfile and the doc indexes; nothing merged.
  'code-conflict',
  // Sync-master `--continue`: the batch has no merge in progress.
  'no-merge-in-progress',
  // Sync-master `--continue`: a conflicted path is outside the doc indexes or still holds markers.
  'unresolved',
  // Bump: the batch has no commits of its own since `origin/master`.
  'nothing-to-bump',
  // Publish: the run branch already has an open PR; the message names it.
  'pr-exists',
  // Publish `--push-only`, cut-batch `--attach`: the branch has no open PR;
  // the message names the state and the number.
  'no-open-pr',
  // Retire-run: the run branch is not in origin/master.
  'branch-unmerged',
  // Retire-run: the run root holds something besides reports/ and empty slice-* folders; the
  // message names each entry.
  'root-not-empty',
  // Check-master: a master ref was deleted or rewound since the launch, or its move could not be
  // decided; local / remote name each.
  'master-not-forward',
]);

/** One entry of the envelope's `errors` list. */
export const StepErrorSchema = z.object({
  /** The step that failed or refused (`usage`, `preconditions`, `build`, `envelope`, …). */
  step: z.string(),
  /** One-line human-readable cause. */
  message: z.string(),
  /** Captured child-output tail or other supporting detail. */
  detail: z.string().exactOptional(),
});

/** Fields every command's envelope carries. */
export const ResultBaseSchema = z.object({
  /** The subcommand as given on the command line. */
  command: z.string(),
  status: CommandStatusSchema,
  /** The worktree the command targeted; `null` only for a usage error without one. */
  worktree: z.string().nullable(),
  /** Empty when `status` is `ok`; otherwise the failing or refusing step. */
  errors: z.array(StepErrorSchema),
  /** Present only when `status` is `refused`. */
  reason: RefusalReasonSchema.exactOptional(),
  /**
   * When the command finished: a UTC ISO-8601 instant, stamped by the CLI
   * shell on every envelope it prints (usage errors included); absent on an
   * envelope built in-process.
   */
  at: z.string().exactOptional(),
});

/** A directory link and the absolute directory it points at. */
export const LinkRecordSchema = z.object({ path: z.string(), target: z.string() });

/** Envelope of `provision <slice> --batch <batch> [--server]`. */
export const ProvisionResultSchema = ResultBaseSchema.extend({
  /** The batch worktree the slice was provisioned against. */
  batch: z.string(),
  /** Links in place for the slice after the command (created or reused). */
  junctions: z.array(LinkRecordSchema),
  /** The slice's built `dist`; `null` when no build produced it or it was rolled back. */
  dist: z.string().nullable(),
  /** Vitest config files this call wrote that are still in place. */
  vitestConfigs: z.array(z.string()),
  /**
   * The slice-specific part of a lease run's environment; `null` unless `ok`.
   * Not the whole of it: `PH_POOL_REGISTRY` comes from the batch's
   * `provision-batch` `env` — without it a lease run reads the full registry,
   * cold servers included.
   */
  env: z.object({ PH_PROJECT_DIR: z.string() }).nullable(),
  /** Paths this call created and removed again after a failure. */
  rolledBack: z.array(z.string()),
});

/** One member of the fixed warm pool set. */
export const WarmMemberSchema = z.object({
  type: z.enum(['paper', 'folia']),
  host: z.string(),
  /** RCON port — the member's identity within the host. */
  rconPort: z.int(),
});

/** Envelope of `provision-batch <batch> --report-dir <dir>`. */
export const ProvisionBatchResultSchema = ResultBaseSchema.extend({
  /** The batch's installed `node_modules`, or `null` when not installed. */
  nodeModules: z.string().nullable(),
  /** The batch's built `dist`, or `null` when not built. */
  dist: z.string().nullable(),
  /** The batch's `paper-harness/` project-dir marker, or `null` when not created. */
  projectDirMarker: z.string().nullable(),
  /** The trimmed pool registry written for the batch, or `null`. */
  registry: z.string().nullable(),
  /** The warm members the trimmed registry holds. */
  warm: z.array(WarmMemberSchema),
  /** Environment lease runs in the batch and its slices need; `null` unless `ok`. */
  env: z.object({ PH_PROJECT_DIR: z.string(), PH_POOL_REGISTRY: z.string() }).nullable(),
});

/** A link target's entry count before and after teardown's unlink step. */
export const SourceCountSchema = z.object({
  /** The link target. */
  path: z.string(),
  /** Count at teardown start; `null` when the target was missing (not gated). */
  before: z.int().nullable(),
  /**
   * Latest count; `null` before the first recount, or when the target is no
   * longer a real directory (gated as a shrink).
   */
  after: z.int().nullable(),
});

/** Envelope of `teardown <worktree>`. */
export const TeardownResultSchema = ResultBaseSchema.extend({
  /** Links removed from the worktree. */
  unlinked: z.array(LinkRecordSchema),
  /**
   * Each distinct link target outside the worktree, with its counts; a target
   * that exists as a non-directory (a file, or another link) is not recorded.
   */
  sources: z.array(SourceCountSchema),
  /** Whether the worktree directory was removed. */
  removed: z.boolean(),
  /** Whether git still lists the worktree after the command. */
  registered: z.boolean(),
});

/** Envelope of `retire-run <main> --branch ship/<slug>`. */
export const RetireRunResultSchema = ResultBaseSchema.extend({
  /** Whether the run branch was deleted. */
  branchDeleted: z.boolean(),
  /** Whether the run root was removed. */
  rootRemoved: z.boolean(),
  /** The slice branches (`slice/<slug>/…`) deleted, sorted; empty unless every guard passed. */
  sliceBranches: z.array(z.string()),
});

/** Envelope of `harvest <batch> <slice-sha>`; `worktree` is the batch. */
export const HarvestResultSchema = ResultBaseSchema.extend({
  /** The slice commit's full sha; `null` until it resolves. */
  sha: z.string().nullable(),
  /**
   * Every path the slice commit changes, both endpoints of a rename, in
   * code-unit order — the list a caller hands `staged-guard` next.
   */
  files: z.array(z.string()),
  /**
   * Paths that would not apply; non-empty only on a conflict — `status`
   * `conflict`, or `failed` when the rollback after it failed.
   */
  conflicts: z.array(z.string()),
  /** Whether a started pick was reset and the batch verified clean afterwards. */
  rolledBack: z.boolean(),
});

/** Envelope of `staged-guard <worktree> <file>…`; every list is sorted. */
export const StagedGuardResultSchema = ResultBaseSchema.extend({
  /** The expected paths, normalised and deduplicated. */
  expected: z.array(z.string()),
  /** The paths staged in the worktree, a rename as both endpoints. */
  staged: z.array(z.string()),
  /** Expected but not staged. */
  missing: z.array(z.string()),
  /** Staged but not expected. */
  unexpected: z.array(z.string()),
});

/** A run branch's pull request as `gh` reports it. */
export const PrInfoSchema = z.object({
  /**
   * `none`: `gh` found no PR for the branch; `unknown`: `gh` could not be
   * asked or answered unreadably — never read as `none`.
   */
  state: z.enum(['open', 'merged', 'closed', 'none', 'unknown']),
  /** The PR number; `null` for `none` and `unknown`. */
  number: z.int().nullable(),
  /**
   * The PR's head commit as `gh` names it (`headRefOid`); `null` for `none`
   * and `unknown`, or when `gh` names none.
   */
  headOid: z.string().nullable(),
});

/** One live unattended run: a registered worktree on a run branch. */
export const LiveRunSchema = z.object({
  /** The worktree root as git lists it. */
  path: z.string(),
  /** The short branch name, e.g. `ship/epic-1025`. */
  branch: z.string(),
  /** Commits on the branch not on the base branch. */
  ahead: z.int(),
  /** `git merge-base` of the base branch and the run branch. */
  mergeBase: z.string(),
  /** Paths the run changed since the merge-base, both endpoints of a rename, sorted. */
  landed: z.array(z.string()),
  /** Uncommitted changes in the worktree; `null` when its directory is missing. */
  dirty: z.boolean().nullable(),
  /** The branch's pull request. */
  pr: PrInfoSchema,
  /**
   * The PR is merged or closed **and** the run's tip is contained in the
   * PR's head — the run is over and awaits cleanup. A run re-cut after its
   * PR merged has commits beyond that head, so it is live.
   */
  spent: z.boolean(),
  /**
   * The PR is merged or closed, but its head commit is unnamed or absent
   * locally, so containment cannot be checked; `spent` is then `false`.
   */
  spentUnverified: z.boolean(),
  /** Registered worktrees (any branch) strictly inside this one. */
  nested: z.array(z.string()),
});

/** Envelope of `live-runs <main>`; `worktree` is the main checkout. */
export const LiveRunsResultSchema = ResultBaseSchema.extend({
  /** Every live run, sorted by branch. */
  runs: z.array(LiveRunSchema),
});

/**
 * Check an envelope against its command's schema before it is printed.
 *
 * @param result - The envelope the command returned, `at` already stamped.
 * @param schema - The command's envelope schema.
 * @returns `result` itself when the schema accepts it — never the parse
 *   output, which would drop keys the schema does not name. Otherwise a new
 *   `failed` envelope: `result`'s `command`, its `worktree` when a string
 *   (else `null`), its `at` when a string, and one error at step `envelope`
 *   naming each failing path and issue. None of `result`'s other fields is
 *   carried over, `detail` included, so a malformed field never reaches a
 *   reader.
 */
export function guardEnvelope(result: ResultBase, schema: z.ZodType): ResultBase {
  const parsed = schema.safeParse(result);
  if (parsed.success) return result;
  const issues = parsed.error.issues.map((i) => `${issuePath(i.path)}: ${i.message}`);
  const raw = result as Readonly<Record<string, unknown>>;
  return {
    command: typeof raw['command'] === 'string' ? raw['command'] : '',
    status: 'failed',
    worktree: typeof raw['worktree'] === 'string' ? raw['worktree'] : null,
    errors: [{ step: 'envelope', message: `envelope fails its schema: ${issues.join('; ')}` }],
    ...(typeof raw['at'] === 'string' && { at: raw['at'] }),
  };
}

/**
 * A zod issue's path as a reader spells it.
 *
 * @returns `a.b[0].c`; `(root)` for the envelope itself.
 */
function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  const steps = path.map((key) =>
    typeof key === 'number' ? `[${String(key)}]` : `.${String(key)}`,
  );
  return steps.join('').replace(/^\./, '');
}
