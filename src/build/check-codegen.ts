/**
 * Drift gate: `schemas.generated.ts` must equal a fresh emission, line endings normalised
 * ({@link checkSchemaModule}), and every saved workflow is rendered afresh into `workflows/`
 * ({@link writeRenderedWorkflows}), so a source the render rejects fails here.
 *
 * On drift, prints a failure line and the hint "Run `npm run codegen` to regenerate." then exits 1.
 *
 * Run via `npm run gate:codegen`.
 */

import { resolve } from 'node:path';

import { WORKFLOWS } from './render-workflows.js';
import { writeRenderedWorkflows } from './workflow-render.js';
import { checkSchemaModule } from './workflow-schemas.js';

const ROOT_DIR = resolve(import.meta.dirname, '../..');

async function main(): Promise<void> {
  const schema = await checkSchemaModule(ROOT_DIR);
  await writeRenderedWorkflows(WORKFLOWS, ROOT_DIR);

  if (!schema.ok) {
    console.error(`FAIL: ${schema.target} — ${schema.reason ?? 'unknown'}`);
    console.error('\nRun `npm run codegen` to regenerate.');
    process.exit(1);
  }

  console.log('codegen-check: OK');
}

await main();
