/**
 * Build-time script: render each saved workflow in {@link WORKFLOWS} from its
 * typed sources under `ship/src/workflow/` into `.claude/workflows/`
 * (ADR-0045 decision 1). The rendered files are committed and never
 * hand-edited; `ship/src/build/check-codegen.ts` (`npm run gate:codegen`) is their
 * drift check. The render itself is `ship/src/build/workflow-render.ts`.
 *
 * Run via `npm run codegen`.
 */

import { resolve } from 'node:path';

import { writeRenderedWorkflows, type WorkflowSpec } from './workflow-render.js';
import { RESYNC_META } from '../workflow/resync.meta.js';
import { SHIP_META } from '../workflow/ship.meta.js';

const ROOT_DIR = resolve(import.meta.dirname, '../../..');

/**
 * Every saved workflow. To add one: write its entry (exporting
 * `run<Name>(hooks, rawArgs)`) and its meta, add a row, run `npm run fix`.
 */
export const WORKFLOWS: readonly WorkflowSpec[] = [
  {
    name: 'ship',
    entry: 'ship/src/workflow/ship.ts',
    meta: SHIP_META,
    out: '.claude/workflows/ship.js',
  },
  {
    name: 'resync',
    entry: 'ship/src/workflow/resync.ts',
    meta: RESYNC_META,
    out: '.claude/workflows/resync.js',
  },
];

/** Render and write every workflow. */
async function main(): Promise<void> {
  const written = await writeRenderedWorkflows(WORKFLOWS, ROOT_DIR);
  console.log(`[codegen] Rendered ${String(written.length)} workflow(s): ${written.join(', ')}.`);
}

// Only when invoked as a CLI: ship/src/build/check-codegen.ts and the unit tests
// import WORKFLOWS, and an import must never write the rendered files.
if (import.meta.main) {
  await main();
}
