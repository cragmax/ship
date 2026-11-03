/**
 * Build-time script: emit the saved workflows' schema module
 * (`src/workflow/schemas.generated.ts`) from its zod sources under
 * `src/schemas/`. The module is committed and never
 * hand-edited. `src/build/check-codegen.ts` (`npm run gate:codegen`) is its
 * drift check. The emit itself is `src/build/workflow-schemas.ts`.
 *
 * Run via `npm run codegen`, which runs it before `src/build/render-workflows.ts`:
 * the render inlines the module, so it must be current first.
 */

import { resolve } from 'node:path';

import { writeSchemaModule } from './workflow-schemas.js';

const ROOT_DIR = resolve(import.meta.dirname, '../..');

/** Emit and write the module. */
async function main(): Promise<void> {
  const written = await writeSchemaModule(ROOT_DIR);
  console.log(`[codegen] Emitted ${written}.`);
}

// Only when invoked as a CLI, as src/build/render-workflows.ts does.
if (import.meta.main) {
  await main();
}
