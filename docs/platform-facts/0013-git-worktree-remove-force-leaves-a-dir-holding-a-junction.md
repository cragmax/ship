---
status: current
platform: [git 2.56.0.windows.1]
last-verified: 2026-10-10
relied-on-by: [src/cli/commands/teardown.ts]
---

# Ship PF-13: `git worktree remove --force` leaves the directory behind when it holds a live junction, and spares the junction target

On Windows, `git worktree remove --force <wt>` exits 0 and unregisters the worktree but leaves `<wt>` on disk holding the untracked junction. Git does not follow the junction: the target's contents are intact. Without `--force` it refuses (exit 128, "contains modified or untracked files").

## Implication

Teardown must unlink every link before `git worktree remove` and assert none remain (`assertNoLinksRemain` in `src/cli/commands/teardown.ts`), because a later recursive delete of the leftover directory could follow the junction.

## Scope

The probe ran on Git for Windows with an NTFS junction.

## Established

A local driver in a scratch repo: `git worktree add ../wt`, then `New-Item -ItemType Junction -Path wt\link -Target ..\target`:

```text
plain: fatal: '../wt' contains modified or untracked files, use --force to delete it  (exit 128)
force: exit=0
ls -la ../wt   -> link -> .../gp/target
ls ../target   -> data.txt
git worktree list -> main checkout only
```
