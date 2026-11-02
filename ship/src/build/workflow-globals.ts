/**
 * The names the workflow runtime binds as globals in a saved workflow's
 * scope (unprobed): the one list both the renderer
 * (`workflow-render.ts`, which reserves them as top-level names) and the
 * `config/eslint.config.js` (which declares them for the rendered
 * files' `no-undef`) read.
 *
 * **Leaf data, zero imports: a contract.** `config/eslint.config.js` imports this
 * file directly under Node's type stripping, which resolves no `.js`
 * specifier to its `.ts` source. An import here would break the lint config.
 */

/** The runtime's globals: the hooks, then `args`, `budget` and `workflow`. */
export const WORKFLOW_GLOBALS: readonly string[] = [
  'agent',
  'parallel',
  'pipeline',
  'phase',
  'log',
  'args',
  'budget',
  'workflow',
];
