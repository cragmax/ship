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
 * @throws {@link Error} as {@link workflowSpec} or {@link renderWorkflow}.
 */
export async function renderFresh(name: string): Promise<string> {
  return renderWorkflow(workflowSpec(name), ROOT);
}

/** Run a rendered workflow over a fake run's hooks. */
export function runRendered(js: string, run: FakeRun, args: string): Promise<unknown> {
  // The runtime's wrapper: the file as a function body, `export` dropped,
  // hooks + `args` as globals (unprobed).
  const script = `(async function () {\n${js.replace(/^export /, '')}\n})()`;

  // eslint-disable-next-line sonarjs/code-eval -- runs a fresh render of the repo's own sources, never user input
  return vm.runInContext(script, vm.createContext({ ...run.hooks, args })) as Promise<unknown>;
}
