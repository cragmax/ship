// Ship's render-safe folders, the Workflow sources and the pure core.
const RENDER_SAFE = '^src/(workflow|core)/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'render-safe-folders',
      severity: 'error',
      comment:
        'src/workflow/ and src/core/ value-import only each other: ' +
        'the workflow render inlines every relative value import, so one reaching ' +
        'the CLI, build or zod code would break the Saved workflow. Type-only edges are erased.',
      from: { path: RENDER_SAFE },
      to: {
        pathNot: RENDER_SAFE,
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-code-imports-tests',
      severity: 'error',
      comment: 'No code imports a test file; tests import code, never the reverse.',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'An import that resolves to no file fails at run time.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Shipped code imports only runtime dependencies; the build scripts under src/build/ ' +
        'run at build time and may import the build tools.',
      from: { path: '^src/', pathNot: '^src/build/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    exclude: { path: '^(?:workflows/|test/fixtures/worktree-fixture-template/)' },
    detectProcessBuiltinModuleCalls: true,
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
