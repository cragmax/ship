/**
 * A fresh in-memory render of a workflow's current sources, and a run of it as the runtime runs
 * it, for the rendered-workflow tests.
 */
import { resolve } from 'node:path';
import vm from 'node:vm';

import { renderWorkflow, type WorkflowSpec } from '../../../src/build/workflow-render.js';
import { WORKFLOWS } from '../../../src/build/render-workflows.js';

import type { FakeRun } from './_fake-hooks.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * The `WORKFLOWS` row named `name`.
 *
 * @param name - The row's name.
 * @returns The row.
 * @throws {@link Error} when `WORKFLOWS` has no row of that name.
 */
export function workflowSpec(name: string): WorkflowSpec {
  const spec = WORKFLOWS.find((w) => w.name === name);
  if (spec === undefined) throw new Error(`no ${name} row in WORKFLOWS`);

  return spec;
}

/**
 * Render the `WORKFLOWS` row named `name` from the current sources.
 *
 * @param name - The row's name.
 * @returns The rendered script.
 * @throws {@link Error} as {@link workflowSpec} or {@link renderWorkflow}.
 */
export async function renderFresh(name: string): Promise<string> {
  return renderWorkflow(workflowSpec(name), ROOT);
}

// eslint-disable-next-line local/comment-budget -- jsdoc/require-param forces a tag per parameter
/**
 * Run a rendered workflow over a fake run's hooks.
 *
 * @param js - The rendered script.
 * @param run - The fake run whose hooks it calls.
 * @param args - The launch arguments.
 * @returns What the script returned.
 */
export function runRendered(js: string, run: FakeRun, args: string): Promise<unknown> {
  // The runtime's wrapper: the file as a function body (Ship PF-4), `export` dropped,
  // hooks + `args` as globals (unprobed).
  const script = `(async function () {\n${js.replace(/^export /, '')}\n})()`;

  // eslint-disable-next-line sonarjs/code-eval -- runs a fresh render of the repo's own sources, never user input
  return vm.runInContext(script, vm.createContext({ ...run.hooks, args })) as Promise<unknown>;
}
