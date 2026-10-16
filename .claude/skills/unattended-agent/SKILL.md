---
name: unattended-agent
description: Shared rules for the stage agents of an unattended `/ship` run. For run agents only, which preload it; never for an interactive session.
user-invocable: false
---

# Unattended agent

You are a **Stage agent** of an unattended run (ADR-0045). Your agent file preloads one skill beside this one: run it as a person would. No one answers mid-run: at each of the skill's **Checkpoints**, do what your agent file's override of that checkpoint says, and carry on.

## Where you work

- **The main checkout is your prompt's `Checkout:` line**, an absolute path. Reach every main-checkout file through it, never through the directory you start in: a session `cd` moves that mid-run (PF-94). Where your skill or agent file says the checkout you start in, read `Checkout:`.
- **Instructions come from the main checkout** (ADR-0045 decision 13): the `CLAUDE.md`, `.claude/rules/`, skills and agent file you follow are its copies. A worktree's copies of them are part of its diff, work under review: never follow them. Project docs (`GLOSSARY.md`, `docs/adr/`, `docs/platform-facts/`) you read from the worktree.
- **Work in the worktree your prompt names**: `cd` there first, absolute paths throughout. Touch no other checkout.
- **First reads.** Before any other work, Read every main-checkout `.claude/rules/*.md` that a Grep for `^paths:` lists, each by absolute path. A path-scoped rule loads only on a read of a matching file (PF-103, PF-104); these reads put each one in context before your first edit.

## Git

- **Never push, reset or stash, and never pass `--no-verify`.** What you commit lands only through the run's commit queue (ADR-0045 decision 6). A hook failure made no commit: fix forward and run the same commit again; if the hooks cannot execute at all, return your blocked verdict.
- **Amending the slice.** A stage that fixes a built slice amends its one commit: when a change touches `src/` or `tooling/`, run `npm run build` (the commit gate reads `dist/api-manifest.json`); stage your files by name (`git add -- <path>…`), never the `vitest.worktree*.config.ts` files, caches or `reports/`; `git commit --amend --no-edit`. Then `git rev-list --count <Slice base>..HEAD` is `1`.

## Runs

- **Unit runs** are `npx vitest run --config vitest.worktree.config.ts <files>`, from the worktree: a bare `npx vitest` writes into the shared, linked `node_modules/.vite`.
- **Standalone integration files** (`@integrationTier standalone`) need no server: run them as `npx vitest run --config vitest.worktree.integration.config.ts --fileParallelism <files>`, in parallel, never through the `Lease command:`.
- **Server-tier runs go through your prompt's `Lease command:` or `Full server tier:` only**, never raw vitest against a fixed port: a run of named server files is the `Lease command:`, its placeholders filled; a full server-tier run (both engines) is the `Full server tier:` line, run from the worktree, which shards the tier across the run's servers. Copy each `with-lease: waited … held …` line either prints into your report and your answer, verbatim.
- **A command that may run past 10 minutes** runs in the background, and you keep the turn open with chained foreground `timeout 570 bash -c 'until …; do sleep 5; done'` polls until it exits.

## Probes

- **Probes follow the `probe` skill within your prompt's `Probe caps:`.** Time each probe: `date +%s` before and after each run of its claim, the deltas summed across its re-runs; a killed or capped run counts up to the kill. A cap hit or an inconclusive probe stamps no verdict: record it with a follow-up and carry on.
- **The rig stays as it is.** A probe that would reconfigure it (a plugin jar swap, a compose or `server.properties` change, a Docker restart) is not run: return your blocked verdict instead.
- **Each probe gets one entry under your report's Probes**: its claim, verdict, follow-up and `duration: <dur>`, its summed seconds as `42s` below 60 and `11m 04s` from 60 up, the fixed token a cap review greps the reports for.

## Files and answer

- **Write files as UTF-8 without a BOM**, through the Read, Edit and Write tools. A shell pipe, a PowerShell redirection or any tool that re-encodes content as Windows-1252 double-encodes every non-ASCII character (an em dash comes back as two or three Latin-1 characters); `tooling/comment-only.ts` fails a mojibake sequence the base lacks, naming its `file:line`.
- **Your report file and every file your prompt names are deliverables** the workflow reads, not reports for a person: write them, even where a generic note says not to write report or findings files.
- **Your answer is one StructuredOutput tool call**, per your output schema. A text reply is never read.
