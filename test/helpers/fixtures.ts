/**
 * The repo-level files Ship's tests stand on, each a fixture under `ship/test/fixtures/`: a Ship
 * test reads none of this repository's own root files.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/**
 * A pool registry holding every field of the registry's contract with the pool: the warm set plus
 * one cold server of each type.
 */
export const FIXTURE_REGISTRY = join(FIXTURES, 'pool-registry.json');

/** The Prettier config the rendered workflows are formatted under. */
export const FIXTURE_PRETTIER_CONFIG = join(FIXTURES, 'prettier.json');

let gitignoreText: string | undefined;

/** The main checkout's `.gitignore`, which every fixture repo commits by default. */
export function fixtureGitignore(): string {
  gitignoreText ??= readFileSync(join(FIXTURES, 'main-checkout.gitignore'), 'utf8');

  return gitignoreText;
}
