/**
 * Drift gate: render the generated artifacts in-memory and string-compare
 * them to the on-disk equivalents. Mirrors `tooling/check-manifest-coverage.ts`
 * but simpler — no checker context, just string equality.
 *
 * Target checks:
 *
 * 1. `src/init/templates/helpers-readme.md` — content equals
 *    `replaceBetweenMarkers(onDisk, renderReservedNamesMarkdown())`.
 * 2. `tooling/workflows/lib/schemas.generated.ts` — equals a fresh emission
 *    from its zod sources under `tooling/workflows/schemas/`, line endings
 *    normalised ({@link checkSchemaModule}).
 * 3. Each saved workflow in {@link WORKFLOWS} — the committed
 *    `.claude/workflows/<name>.js` equals a fresh render, line endings
 *    normalised ({@link checkRenderedWorkflows}).
 *
 * The former `src/tools/promote-script.ts` destructure target was retired
 * by #580; the body→suite-of-one wrapper at
 * `src/tools/script-ingest/wrap-body-as-suite.ts` imports `CONTEXT_BAG_NAMES`
 * at runtime and is drift-proof by construction.
 *
 * On drift, prints a per-target failure line and the hint
 * "Run `npm run codegen` to regenerate." then exits 1.
 *
 * Run via `npm run gate:codegen`.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  renderReservedNamesMarkdown,
  replaceBetweenMarkers,
} from './generate-reserved-names-targets.js';
import { checkRenderedWorkflows } from './lib/workflow-render.js';
import { checkSchemaModule } from './lib/workflow-schemas.js';
import { WORKFLOWS } from './render-workflows.js';

// ── Configuration (paths mirror generate-reserved-names-targets.ts) ────────

const ROOT_DIR = resolve(import.meta.dirname, '..');
const SCAFFOLD_README = resolve(ROOT_DIR, 'src/init/templates/helpers-readme.md');

// ── Check results ──────────────────────────────────────────────────────────

type CheckResult = { target: string; ok: boolean; reason?: string };

async function checkMarkersFile(absPath: string, displayPath: string): Promise<CheckResult> {
  const onDisk = await readFile(absPath, 'utf-8');
  // Computing the expected: take the on-disk file, splice in the freshly
  // rendered between-markers content. If the on-disk content already matches
  // the rendered output, this is a no-op and equality holds.
  const expected = replaceBetweenMarkers(onDisk, renderReservedNamesMarkdown());
  if (expected === onDisk) {
    return { target: displayPath, ok: true };
  }
  return {
    target: displayPath,
    ok: false,
    reason: 'markers-block content differs from rendered output',
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results: CheckResult[] = [
    await checkMarkersFile(SCAFFOLD_README, 'src/init/templates/helpers-readme.md'),
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
