---
status: current
platform: [typescript-language-server 6.0.2, typescript 5.9.3, node 24.19.0, windows 11]
last-verified: 2026-10-23
relied-on-by: [CLAUDE.md]
---

# Ship PF-19: While tsserver loads a configured project, a references request gets the open file's own occurrences only

A `textDocument/references` request sent right after `textDocument/didOpen`, while tsserver is still loading the configured project, is answered with the occurrences in the open file only, and no error says the answer is partial. The same request sent once the project has loaded returns the occurrences in every file of the project. The early answer comes from the syntax-only server that typescript-language-server runs beside the semantic one (`--serverMode partialSemantic`, Ship PF-17), which sees open files only (unprobed: the driver read the answers, not which server sent them).

## Implication

If a first `findReferences` answer lists only the open file's occurrences, ask again before treating the symbol as unused elsewhere. The `LSP` line of `CLAUDE.md` says so: a first answer from a cold index is asked again.

## Scope

typescript-language-server 6.0.2 was a global install, run over stdio. TypeScript 5.9.3 was the repo's `node_modules/typescript`, passed as `tsserver.path`.

## Established

2026-10-23, #1714. A throwaway Node driver spawned typescript-language-server 6.0.2 with `--stdio` against TypeScript 5.9.3, sent `initialize` with the repo as its root, opened `src/config/loader.ts`, sent `textDocument/references` on `loadConfig` at once, waited 90 s, and sent the same request again. Deciding output:

```text
   428ms notify $/progress {"kind":"begin","title":"Initializing JS/TS language features…"}
   529ms refs#1 (sent at open, during project load) locations=1 files=1 trees=src
    src/config/loader.ts 1
  8358ms notify $/progress {"kind":"end"}
 90676ms refs#2 (after wait) locations=44 files=13 trees=server-pool,src,test
```
