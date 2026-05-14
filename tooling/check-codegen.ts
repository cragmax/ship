/**
 * Drift gate: render `RESERVED_NAMES`-derived artifacts in-memory and string-
 * compare to the on-disk equivalents. Mirrors `tooling/check-manifest-coverage.ts`
 * but simpler — no AST walking, no checker context, just exact-string equality.
 *
 * Three target checks:
 *
 * drift-check-allow: .mjs — codegen-tool target filename
 * 1. `src/init/templates/eslint-config.mjs` — full-file equality with
 *    `renderEslintTemplate()`.
 * 2. `src/init/templates/helpers-readme.md` — content equals
 *    `replaceBetweenMarkers(onDisk, renderReservedNamesMarkdown())`.
 * 3. `src/tools/promote-script.ts` — `buildTestFile` destructure between
 *    `// <!-- BEGIN-CONTEXT-BAG-DESTRUCTURE -->` ... `// <!-- END-CONTEXT-BAG-DESTRUCTURE -->`
 *    matches `renderPromoteScriptDestructure()` output (13 names from
 *    `CONTEXT_BAG_NAMES` joined as `bot, expect, server, ...`).
 *
 * On drift, prints a per-target failure line and the hint
 * "Run `npm run codegen` to regenerate." then exits 1.
 *
 * Run via `npm run gate:codegen`.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  renderEslintTemplate,
  renderPromoteScriptDestructure,
  renderReservedNamesMarkdown,
  replaceBetweenMarkers,
  replaceBetweenMarkersWith,
} from './generate-reserved-names-targets.js';

// ── Configuration (paths mirror generate-reserved-names-targets.ts) ────────

const ROOT_DIR = resolve(import.meta.dirname, '..');
// drift-check-allow: .mjs — codegen-tool target filename
const ESLINT_TEMPLATE = resolve(ROOT_DIR, 'src/init/templates/eslint-config.mjs');
const SCAFFOLD_README = resolve(ROOT_DIR, 'src/init/templates/helpers-readme.md');
const PROMOTE_SCRIPT = resolve(ROOT_DIR, 'src/tools/promote-script.ts');

const PROMOTE_MARKER_START = '// <!-- BEGIN-CONTEXT-BAG-DESTRUCTURE -->';
const PROMOTE_MARKER_END = '// <!-- END-CONTEXT-BAG-DESTRUCTURE -->';

// ── Check results ──────────────────────────────────────────────────────────

type CheckResult = { target: string; ok: boolean; reason?: string };

async function checkEslintTemplate(): Promise<CheckResult> {
  const expected = renderEslintTemplate();
  const actual = await readFile(ESLINT_TEMPLATE, 'utf-8');
  if (expected === actual) {
    // drift-check-allow: .mjs — codegen-tool target filename
    return { target: 'src/init/templates/eslint-config.mjs', ok: true };
  }
  return {
    // drift-check-allow: .mjs — codegen-tool target filename
    target: 'src/init/templates/eslint-config.mjs',
    ok: false,
    reason: 'rendered output differs from on-disk file',
  };
}

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

async function checkPromoteScript(): Promise<CheckResult> {
  const onDisk = await readFile(PROMOTE_SCRIPT, 'utf-8');
  // Computing the expected: take the on-disk file, splice in the freshly
  // rendered destructure between the markers. If the on-disk content
  // already matches the rendered output, this is a no-op and equality holds.
  const expected = replaceBetweenMarkersWith(
    onDisk,
    renderPromoteScriptDestructure(),
    PROMOTE_MARKER_START,
    PROMOTE_MARKER_END,
  );
  if (expected === onDisk) {
    return { target: 'src/tools/promote-script.ts', ok: true };
  }
  return {
    target: 'src/tools/promote-script.ts',
    ok: false,
    reason: 'buildTestFile destructure differs from CONTEXT_BAG_NAMES rendering',
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = await Promise.all([
    checkEslintTemplate(),
    checkMarkersFile(SCAFFOLD_README, 'src/init/templates/helpers-readme.md'),
    checkPromoteScript(),
  ]);

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`FAIL: ${f.target} — ${f.reason ?? 'unknown'}`);
    }
    console.error('\nRun `npm run codegen` to regenerate.');
    process.exit(1);
  }

  console.log('codegen-check: OK (3 targets)');
}

await main();
