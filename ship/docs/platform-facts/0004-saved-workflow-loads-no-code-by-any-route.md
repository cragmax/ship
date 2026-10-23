---
status: current
platform: [claude-code 2026-09-28]
last-verified: 2026-09-28
relied-on-by: [Ship ADR-0001, ship/src/build/workflow-render.ts, ship/src/build/check-codegen.ts]
---

# Ship PF-4: A saved workflow loads no code by any route: no `import`, no `require`, `process`, or `fetch`, and no `eval` or `new Function`

A saved workflow script cannot load code at run time. A static `import` declaration is refused before launch (`SyntaxError: Unexpected token '{'. import call expects one or two arguments.`), because the body is wrapped in a function. A dynamic `import()` of a relative `.mjs`, a relative `.ts`, or an absolute `file:///` URL is refused before launch (`SyntaxError: import() is not available in workflow scripts.`). `require`, `process`, `fetch`, `Bun`, `Deno`, and `module` are `undefined`. `eval('1+1')` and `new Function(...)` throw `Code generation from strings disallowed for this context`.

## Implication

Everything a saved workflow runs must be inside its own text. Repo TypeScript reaches it only by rendering, and anything that needs git, `gh`, or the filesystem runs as a CLI an `agent()` invokes. Ship ADR-0001 decision 1 rests on this, with the render (`ship/src/build/workflow-render.ts`) and `gate:codegen`.

## Scope

The Claude Code release was not recorded. The `platform` stamp is the probe date.

## Established

The #1026 Q1 probe ([verdict comment](https://github.com/cragmax/paper-harness/issues/1025#issuecomment-5869948581)) ran `.claude/workflows/ph-probe-import-static.js` by `name` and by `scriptPath`, then dynamic-import and globals variants, each refused or `undefined` as above.
