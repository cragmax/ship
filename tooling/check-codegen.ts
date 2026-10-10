/**
 * Drift gate: each generated target must equal a fresh in-memory render — the
 * `helpers-readme.md` markers blocks, `schemas.generated.ts` ({@link checkSchemaModule}) and
 * each saved workflow in {@link WORKFLOWS} ({@link checkRenderedWorkflows}), the latter two
 * with line endings normalised.
 *
 * On drift, prints a per-target failure line and the hint
 * "Run `npm run codegen` to regenerate." then exits 1.
 *
 * Run via `npm run gate:codegen`.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderHelpersReadme } from './generate-reserved-names-targets.js';
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
  const expected = renderHelpersReadme(onDisk);
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
