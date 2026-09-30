import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trimRegistry } from '../../../tooling/worktree/pool-registry-trim.js';

const REAL_REGISTRY = resolve(
  import.meta.dirname,
  '../../..',
  'src/server-pool/registry/pool-registry.json',
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ph-trim-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('trimRegistry', () => {
  // The real registry is exactly the warm set, so only an added cold entry
  // shows the filter dropping anything.
  it('drops a registered server outside the warm set', () => {
    const entries = JSON.parse(readFileSync(REAL_REGISTRY, 'utf8')) as Record<string, unknown>[];
    const source = join(dir, 'source.json');
    const dest = join(dir, 'dest.json');
    writeFileSync(
      source,
      JSON.stringify([...entries, { ...entries[0], port: 25720, rconPort: 25721 }]),
    );

    trimRegistry(source, dest);

    const kept = JSON.parse(readFileSync(dest, 'utf8')) as { rconPort: number }[];
    expect(kept.map((e) => e.rconPort)).toEqual([25701, 25703, 25711, 25713]);
  });
});
