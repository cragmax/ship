import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { trimRegistry } from '../../../../src/cli/commands/pool-registry-trim.js';
import { StepFailure } from '../../../../src/cli/envelope/types.js';
import { FIXTURE_REGISTRY } from '../../../helpers/fixtures.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ph-trim-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('trimRegistry', () => {
  it('drops a registered server outside the warm set', () => {
    const dest = join(dir, 'dest.json');
    const source = JSON.parse(readFileSync(FIXTURE_REGISTRY, 'utf8')) as {
      type: string;
      rconPort: number;
    }[];

    // Without a cold server in the source, the trim has nothing to drop and this passes vacuously.
    expect(source.map((e) => [e.type, e.rconPort])).toEqual([
      ['paper', 25701],
      ['paper', 25703],
      ['paper', 25705],
      ['folia', 25711],
      ['folia', 25713],
      ['folia', 25715],
    ]);

    trimRegistry(FIXTURE_REGISTRY, dest);

    const kept = JSON.parse(readFileSync(dest, 'utf8')) as { rconPort: number }[];
    expect(kept.map((e) => e.rconPort)).toEqual([25701, 25703, 25711, 25713]);
  });

  it('fails the registry step with the loader’s message on an unreadable source, writing no dest', () => {
    const dest = join(dir, 'dest.json');
    let thrown: unknown;

    try {
      trimRegistry(join(dir, 'absent.json'), dest);
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StepFailure);
    expect(thrown).toMatchObject({
      step: 'registry',
      message: expect.stringMatching(/^loadPoolRegistry: could not read pool registry /u),
    });
    expect(existsSync(dest)).toBe(false);
  });
});
