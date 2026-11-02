import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPoolRegistry } from '../../../../src/cli/commands/pool-registry.js';
import { StepFailure } from '../../../../src/cli/envelope/types.js';
import { compareStrings } from '../../../../src/core/strings.js';
import { FIXTURE_REGISTRY } from '../../../helpers/fixtures.js';

const ENTRY = {
  host: 'localhost',
  port: 25700,
  rconPort: 25701,
  rconPassword: 'pw',
  mcVersion: '1.21.11',
  type: 'paper',
  version: '1.21.11',
  resetCapability: 'rcon-only',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ph-registry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadPoolRegistry', () => {
  it('reads the registry fixture as six entries, each carrying every contract field', () => {
    const contract = [
      'host',
      'logPath',
      'mcVersion',
      'port',
      'rconPassword',
      'rconPort',
      'resetCapability',
      'type',
      'version',
    ];

    const entries = loadPoolRegistry(FIXTURE_REGISTRY);

    expect(entries.map((entry) => Object.keys(entry).sort(compareStrings))).toEqual(
      Array(6).fill(contract),
    );
  });

  it('returns the entries in file order, an optional logPath kept and an unknown field dropped', () => {
    const second = { ...ENTRY, port: 25710, rconPort: 25711, type: 'folia', logPath: 'a/b.log' };
    const path = registry(JSON.stringify([{ ...ENTRY, extra: 1 }, second]));

    expect(loadPoolRegistry(path)).toEqual([ENTRY, second]);
  });

  it('fails the registry step naming each invalid field by index', () => {
    const path = registry(JSON.stringify([ENTRY, { ...ENTRY, type: 'forge', rconPort: -1 }]));
    const err = failure(path);

    expect(err.step).toBe('registry');
    expect(err.message).toBe(
      `loadPoolRegistry: ${path} pool registry entry invalid: ` +
        '1.rconPort: Too small: expected number to be >0; ' +
        '1.type: Invalid option: expected one of "paper"|"folia"',
    );
  });

  // One row per field of the registry's written contract with the pool; a missing key is written
  // as `undefined`, which JSON.stringify drops.
  it.each<[string, string, Record<string, unknown>]>([
    ['a missing host', 'host', { host: undefined }],
    ['a missing port', 'port', { port: undefined }],
    ['a missing rconPort', 'rconPort', { rconPort: undefined }],
    ['a missing rconPassword', 'rconPassword', { rconPassword: undefined }],
    ['a missing mcVersion', 'mcVersion', { mcVersion: undefined }],
    ['a missing type', 'type', { type: undefined }],
    ['a missing version', 'version', { version: undefined }],
    ['a missing resetCapability', 'resetCapability', { resetCapability: undefined }],
    ['a fractional port', 'port', { port: 25700.5 }],
    ['a zero port', 'port', { port: 0 }],
    ['an unknown resetCapability', 'resetCapability', { resetCapability: 'manual' }],
    ['a logPath that is no string', 'logPath', { logPath: 7 }],
  ])('fails the registry step on %s, naming only that field', (_, field, change) => {
    const path = registry(JSON.stringify([{ ...ENTRY, ...change }]));
    const err = failure(path);

    expect(err.step).toBe('registry');
    expect(err.message).toMatch(new RegExp(`pool registry entry invalid: 0\\.${field}: [^;]+$`));
  });

  it.each([
    ['a file that is not JSON', (): string => registry('[{')],
    ['a missing file', (): string => join(dir, 'absent.json')],
  ])('fails the registry step on %s, giving the cause', (_, path) => {
    const file = path();
    const err = failure(file);
    const head = `loadPoolRegistry: could not read pool registry ${file}: `;

    expect(err.step).toBe('registry');
    expect(err.message.startsWith(head)).toBe(true);
    expect(err.message.slice(head.length)).toMatch(/\S/);
  });
});

/** The `StepFailure` `loadPoolRegistry` throws for `path`. */
function failure(path: string): StepFailure {
  try {
    loadPoolRegistry(path);
  } catch (err: unknown) {
    if (err instanceof StepFailure) return err;

    throw err;
  }

  throw new Error('loadPoolRegistry did not throw');
}

/** Writes `content` as a registry file and returns its path. */
function registry(content: string): string {
  const path = join(dir, 'registry.json');
  writeFileSync(path, content);

  return path;
}
