/**
 * Ship's reader of the pool registry: its own copy of the pool's schema and loader, held to the
 * registry's written contract with the pool, so Ship imports nothing from `server-pool/`.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { describeError } from '../../core/describe-error.js';
import { StepFailure } from '../envelope/types.js';

/** One registry entry. */
const PoolEntrySchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  rconPort: z.number().int().positive(),
  rconPassword: z.string(),
  mcVersion: z.string(),
  type: z.enum(['paper', 'folia']),
  version: z.string(),
  resetCapability: z.enum(['rcon-only', 'restartable']),
  logPath: z.string().optional(),
});

/** One validated server in the pool registry. */
export type PoolEntry = z.infer<typeof PoolEntrySchema>;

/**
 * Load and validate a pool registry file: a JSON array of entries.
 *
 * @returns The entries, in file order, each stripped of any field the schema lacks.
 * @throws StepFailure `registry` when the file is unreadable or not JSON
 *   (`loadPoolRegistry: could not read pool registry <path>: <cause>`), or an entry fails the
 *   schema (`loadPoolRegistry: <path> pool registry entry invalid: <index>.<field>: <message>`,
 *   `; ` joined).
 */
export function loadPoolRegistry(path: string): PoolEntry[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: unknown) {
    throw new StepFailure(
      'registry',
      `loadPoolRegistry: could not read pool registry ${path}: ${describeError(err)}`,
    );
  }

  const result = z.array(PoolEntrySchema).safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

    throw new StepFailure(
      'registry',
      `loadPoolRegistry: ${path} pool registry entry invalid: ${issues.join('; ')}`,
    );
  }

  return result.data;
}
