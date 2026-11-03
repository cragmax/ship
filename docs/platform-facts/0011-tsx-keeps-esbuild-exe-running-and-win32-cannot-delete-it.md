---
status: current
platform: [tsx 4.21.0, esbuild 0.27.4, node 24.19.0, windows 10.0.26300]
last-verified: 2026-10-10
relied-on-by: [src/cli/git/git.ts]
---

# Ship PF-11: tsx runs `esbuild.exe` from the checkout's `node_modules`, and a running exe cannot be deleted or overwritten on win32

A script run through the checkout's `tsx` keeps `node_modules\@esbuild\win32-x64\esbuild.exe` running for its lifetime. A running `.exe` on win32 refuses deletion (EPERM) and overwrite (EBUSY), and rename succeeds.

## Implication

`npm ci` or removing that `node_modules` fails, or half-applies, while a tsx-hosted CLI runs from it, so such a CLI must refuse to mutate its own checkout. `assertNotSelfHosted` in `src/cli/git/git.ts` does so.

## Scope

The probe ran on Windows 11 Pro 10.0.26300.

## Established

Local drivers:

1. `node node_modules/tsx/dist/cli.mjs sleep.ts` in the background, then a CIM query for `esbuild.exe`.
2. A copy of the same `esbuild.exe` spawned with `--service=0.27.4`, then `unlinkSync` / `writeFileSync` / `renameSync` on it.

Deciding output:

```text
ExecutablePath : C:\Users\maxim\source\paper-harness\node_modules\@esbuild\win32-x64\esbuild.exe   (while tsx ran)
unlink EPERM
rename OK
overwrite EBUSY
unlink after exit OK
```
