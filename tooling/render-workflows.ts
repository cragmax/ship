/**
 * Build-time script: render each saved workflow in {@link WORKFLOWS} from its
 * typed sources under `tooling/workflows/` into `.claude/workflows/`
 * (ADR-0045 decision 1). The rendered files are committed and never
 * hand-edited; `tooling/check-codegen.ts` (`npm run gate:codegen`) is their
 * drift check. The render itself is `tooling/lib/workflow-render.ts`.
 *
 * Run via `npm run codegen`.
 */

import { resolve } from 'node:path';

import { writeRenderedWorkflows, type WorkflowSpec } from './lib/workflow-render.js';
import { RESYNC_META } from './workflows/resync.meta.js';
import { SHIP_META } from './workflows/ship.meta.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');

/**
 * Every saved workflow. To add one: write its entry (exporting
 * `run<Name>(hooks, rawArgs)`) and its meta, add a row, run `npm run codegen`.
 */
export const WORKFLOWS: readonly WorkflowSpec[] = [
  {
    name: 'ship',
    entry: 'tooling/workflows/ship.ts',
    meta: SHIP_META,
    out: '.claude/workflows/ship.js',
  },
  {
    name: 'resync',
    entry: 'tooling/workflows/resync.ts',
    meta: RESYNC_META,
    out: '.claude/workflows/resync.js',
  },
];

/** Render and write every workflow. */
async function main(): Promise<void> {
  const written = await writeRenderedWorkflows(WORKFLOWS, ROOT_DIR);
  console.log(`[codegen] Rendered ${String(written.length)} workflow(s): ${written.join(', ')}.`);
}

// Only when invoked as a CLI: tooling/check-codegen.ts and the unit tests
// import WORKFLOWS, and an import must never write the rendered files.
if (import.meta.main) {
  await main();
}
