/**
 * Build-time script: render each saved workflow in {@link WORKFLOWS} from its typed sources under
 * `src/workflow/` into the gitignored {@link RENDER_DIR}, a build output like `dist/`.
 * `src/build/install.ts` copies each render into `.claude/workflows/`, and its `--check` is
 * the drift check. The render itself is `src/build/workflow-render.ts`.
 *
 * Run via `npm run codegen`.
 */

import { resolve } from 'node:path';

import { writeRenderedWorkflows, type WorkflowSpec } from './workflow-render.js';
import { RESYNC_META } from '../workflow/resync.meta.js';
import { SHIP_META } from '../workflow/ship.meta.js';

const ROOT_DIR = resolve(import.meta.dirname, '../..');

/** Where the renders go, repository-relative. */
const RENDER_DIR = 'workflows';

/**
 * Every saved workflow. To add one: write its entry (exporting
 * `run<Name>(hooks, rawArgs)`) and its meta, add a row, run `npm run fix`.
 */
export const WORKFLOWS: readonly WorkflowSpec[] = [
  {
    name: 'ship',
    entry: 'src/workflow/ship.ts',
    meta: SHIP_META,
    out: `${RENDER_DIR}/ship.js`,
  },
  {
    name: 'resync',
    entry: 'src/workflow/resync.ts',
    meta: RESYNC_META,
    out: `${RENDER_DIR}/resync.js`,
  },
];

/** Render every workflow. */
async function main(): Promise<void> {
  const written = await writeRenderedWorkflows(WORKFLOWS, ROOT_DIR);
  console.log(`[codegen] Rendered ${String(written.length)} workflow(s): ${written.join(', ')}.`);
}

// Only when invoked as a CLI: src/build/check-codegen.ts and the unit tests
// import WORKFLOWS, and an import must never write the rendered files.
if (import.meta.main) {
  await main();
}
