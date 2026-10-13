/**
 * Drift gate: each generated target must equal a fresh in-memory render —
 * `schemas.generated.ts` ({@link checkSchemaModule}) and each saved workflow in
 * {@link WORKFLOWS} ({@link checkRenderedWorkflows}), with line endings normalised.
 *
 * On drift, prints a per-target failure line and the hint
 * "Run `npm run codegen` to regenerate." then exits 1.
 *
 * Run via `npm run gate:codegen`.
 */

import { resolve } from 'node:path';

import { checkRenderedWorkflows } from './lib/workflow-render.js';
import { checkSchemaModule } from './lib/workflow-schemas.js';
import { WORKFLOWS } from './render-workflows.js';

// ── Configuration ──────────────────────────────────────────────────────────

const ROOT_DIR = resolve(import.meta.dirname, '..');

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = [
    await checkSchemaModule(ROOT_DIR),
    ...(await checkRenderedWorkflows(WORKFLOWS, ROOT_DIR)),
  ];

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`FAIL: ${f.target} — ${f.reason ?? 'unknown'}`);
    }
    console.error('\nRun `npm run codegen` to regenerate.');
    process.exit(1);
  }

  console.log(`codegen-check: OK (${String(results.length)} targets)`);
}

await main();
