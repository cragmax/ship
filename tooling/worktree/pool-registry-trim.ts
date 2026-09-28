/**
 * Trim a pool registry to the warm set — the servers every concurrent
 * unattended run on the machine may lease (ADR-0032). Lease runs in a batch
 * worktree and its slices read the trimmed copy (`PH_POOL_REGISTRY`), so a
 * cold-but-registered server never enters candidate selection.
 */

import { writeFileSync } from 'node:fs';

import { loadPoolRegistry, type PoolEntry } from '../../src/server-pool/index.js';

import { StepFailure, type WarmMember } from './types.js';

/**
 * The fixed, machine-wide warm set: one Paper and one Folia server (the
 * compose services `minecraft` and `minecraft-folia`). Pinned, never derived
 * from the registry, so concurrent runs agree on it without coordinating,
 * and registry drift fails {@link trimRegistry} loudly.
 */
export const WARM_SET: readonly WarmMember[] = [
  { type: 'paper', host: 'localhost', rconPort: 25701 },
  { type: 'folia', host: 'localhost', rconPort: 25711 },
];

/**
 * Whether a registry entry is the given warm member.
 *
 * @param member - Warm-set member.
 * @param entry - Registry entry.
 * @returns `true` when type, host and RCON port all match.
 */
function isMember(member: WarmMember, entry: PoolEntry): boolean {
  return (
    entry.type === member.type && entry.host === member.host && entry.rconPort === member.rconPort
  );
}

/**
 * Write the warm-set subset of `source` to `dest` (2-space JSON, trailing
 * newline). Kept entries are copied verbatim, relative `logPath` included.
 *
 * @param source - Registry to read.
 * @param dest - File to write.
 * @returns The warm set, in {@link WARM_SET} order.
 * @throws StepFailure `registry` when `source` fails to load (the loader's
 *   message) or lacks any warm member; `dest` is not written then.
 */
export function trimRegistry(source: string, dest: string): WarmMember[] {
  const loaded = loadPoolRegistry(source);
  if (!loaded.ok) throw new StepFailure('registry', loaded.error.message);
  const kept = loaded.value.filter((entry) => WARM_SET.some((member) => isMember(member, entry)));
  const missing = WARM_SET.filter((member) => !kept.some((entry) => isMember(member, entry)));
  if (missing.length > 0) {
    throw new StepFailure(
      'registry',
      `${source} lacks warm member(s): ${missing.map((m) => `${m.type}@${m.host}:${String(m.rconPort)}`).join(', ')}`,
    );
  }
  writeFileSync(dest, `${JSON.stringify(kept, null, 2)}\n`);
  return [...WARM_SET];
}
