# Ship ADR-0003: Ship's folders follow where its code runs, so render-safety rests on the folder

Ship's source is split by where each part runs, and a dependency-cruiser (depcruise) rule confines the rendered folders to value imports of each other. So render-safety rests on the folder, not on review.

## Decision

1. **The folders.**
   - `ship/src/workflow/` runs inside the Workflow runtime, rendered.
   - `core/` holds pure, render-safe decisions that both sides use.
   - `cli/` is the input and output (I/O) of the runner or the session.
   - `schemas/` holds the zod sources for codegen.
   - `build/` renders, emits, and checks.
2. **The import rule.** A depcruise rule lets `workflow/` and `core/` value-import only each other, plus two carve-outs that the render inlines. Neither carve-out imports anything:
   - `server-pool/src/lease-timings.ts`, for `workflow/` only, in place of the pool barrel (Pool ADR-0003 decision 2).
   - `tooling/hooks/lib/platform-wide.ts`, for the pull request (PR) body's full-tiers line. (amended 2026-11-02: this carve-out is gone. The PR body reads Ship's own copy, `ship/src/workflow/pr/push-scope.ts`, since Ship imports nothing from tooling.)

   Type-only imports are free, since the render erases them.

3. **The whole worktree command-line interface (CLI) is Ship's.** The interactive `commit` command is included, since running a CLI is no import edge (Framework ADR-0077 decision 1). (amended 2026-11-02: the interactive `commit` command moved to `tooling/git/commit.ts`, since no run calls it, and the worktree CLI no longer carries it.)
4. **Ship's part of `.claude/` stays where Claude Code reads it.** Ship's README lists it (Framework ADR-0045 decision 3).
