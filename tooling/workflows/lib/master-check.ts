/**
 * The epic end's forward-only check of `master`: before an epic's push,
 * `worktree.ts check-master` compares local `master` and `origin`'s with the launch shas pre-flight
 * recorded, and `origin`'s also with the synced sha, which a failed `origin` line names as its
 * restore point. The call runs inside the epic end's publish task of the repo lock
 * (`epic-end.ts`), so no other epic end talks to `origin` between the check and the push.
 *
 * **Fail closed**: anything but an `ok` check naming two moves that are `equal` or `forward`, each
 * with its current sha, is a failure — a deleted, rewound or undecidable ref, a failed or refused
 * check, and a runner that returned nothing. "Could not tell" never passes.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only, no top-level side
 * effect.
 */

import type { MasterMove } from '../../worktree/types-run.js';

import type { WorkflowHooks } from './hooks.types.js';
import type { MainSnapshot } from './preflight.js';
import type { EntrySetup } from './slice-chain.js';
import { envelopeProblem, runPlace, runTool, type CheckMasterOutput } from './tool-calls.js';

/** A ref's move that passes the check: `equal` or `forward`, its current sha known. */
export type ForwardMove = MasterMove & {
  readonly move: 'equal' | 'forward';
  readonly current: string;
};

/** A check both refs passed. */
export interface PassedMasterCheck {
  /** Always `true`. */
  readonly passed: true;
  /** Local `master`'s move. */
  readonly local: ForwardMove;
  /** `origin`'s `master` move. */
  readonly remote: ForwardMove;
}

/** A check that did not pass, or could not run. */
export interface FailedMasterCheck {
  /** Always `false`. */
  readonly passed: false;
  /** Local `master`'s move; `null` when the check named none. */
  readonly local: MasterMove | null;
  /** `origin`'s `master` move; `null` when the check named none. */
  readonly remote: MasterMove | null;
  /** What stopped the epic, one line. */
  readonly failure: string;
}

/** The epic end's forward-only check of `master`. */
export type MasterCheck = PassedMasterCheck | FailedMasterCheck;

/** The failure of a run pre-flight left no launch snapshot for. */
const NO_LAUNCH = 'no launch snapshot of master to check against';

/** The failure of an epic end whose sync named no `origin/master` sha. */
const NO_SYNCED = 'master sync named no origin/master sha to check against';

/**
 * Check that `master` only moved forward since the launch.
 *
 * @param synced - The `origin/master` sha the epic end's sync left the
 *   batch containing; `null` when the sync named none.
 * @returns Resolves to the check; with no launch snapshot, or no synced
 *   sha, a failed check and no tool call.
 */
export async function checkMasterStep(
  hooks: WorkflowHooks,
  entry: Pick<EntrySetup, 'main' | 'reportDir' | 'tag'>,
  launch: MainSnapshot | null,
  synced: string | null,
): Promise<MasterCheck> {
  if (launch === null) return { passed: false, local: null, remote: null, failure: NO_LAUNCH };
  if (synced === null) return { passed: false, local: null, remote: null, failure: NO_SYNCED };
  const { master } = launch.snapshot;
  const out = await runTool(
    hooks,
    'check-master',
    [entry.main, '--local', master.local, '--remote', master.remote, '--synced', synced],
    runPlace(entry, entry.tag),
  );
  return checkOf(out);
}

function checkOf(out: CheckMasterOutput | null): MasterCheck {
  const local = out?.local ?? null;
  const remote = out?.remote ?? null;
  if (out?.status === 'ok' && isForward(local) && isForward(remote)) {
    return { passed: true, local, remote };
  }
  return { passed: false, local, remote, failure: failureOf(out, local, remote) };
}

function failureOf(
  out: CheckMasterOutput | null,
  local: MasterMove | null,
  remote: MasterMove | null,
): string {
  const lines = [
    ...(local === null || isForward(local) ? [] : [moveLine('local', local)]),
    ...(remote === null || isForward(remote) ? [] : [moveLine('origin', remote)]),
  ];
  if (out?.status === 'refused' && out.reason === 'master-not-forward' && lines.length > 0) {
    return lines.join('; ');
  }
  return envelopeProblem('check-master', out);
}

function isForward(move: MasterMove | null): move is ForwardMove {
  return (
    move !== null && (move.move === 'equal' || move.move === 'forward') && move.current !== null
  );
}

function moveLine(which: 'local' | 'origin', move: MasterMove): string {
  const synced = move.synced === null ? '' : `, synced ${move.synced}`;
  return (
    `${which} master ${move.move}: launch ${move.launch}${synced}, now ${move.current ?? 'deleted'}` +
    ` — restore it from ${move.synced ?? move.launch}`
  );
}
