# Git

Part of [Platform facts](readme.md) — see the readme for the rig, the admission
bar, and the living / divergence rules. Each fact is version-stamped in its
**Platform** line. This category covers **git**, which paper-harness's own
tooling drives (the unattended-run worktree tooling), rather than the
Minecraft-side stack it tests against; facts here are stamped against the git
release in their **Platform** line, and a git release can move them.

## PF-61 · `git branch -d` deletes a branch merged to its upstream even when it is not merged to `HEAD`

- **Claim.** `git branch -d <branch>` treats a branch as merged when it is merged
  to its configured upstream (`<branch>@{upstream}`), not only when it is merged
  to `HEAD`. A pushed branch with an upstream is deleted — exit 0, with a
  warning — even while it carries commits `origin/master` lacks.
- **Implication.** `-d` is no "unmerged" guard for a branch that has been pushed
  with an upstream (every `ship/` run branch is). Guard by ancestry against the
  target ref instead —
  `git merge-base --is-ancestor <branch> refs/remotes/origin/master` — then
  delete with `git branch -D`.
- **Platform.** `git version 2.56.0.windows.1` (Git for Windows).
- **Established.** #1297 plan-time probe, falsifying #1297's proposed
  `git branch -d` guard; re-run for #1306, 2026-10-09. The probe script:

  ```sh
  set -u
  rm -rf remote.git work
  git init -q --bare -b master remote.git
  git init -q -b master work && cd work
  git config user.email p@p; git config user.name p
  git commit -q --allow-empty -m base
  git remote add origin ../remote.git
  git push -q -u origin master
  git switch -q -c ship/x
  git commit -q --allow-empty -m feature
  git push -q -u origin ship/x
  git switch -q master
  echo "upstream of ship/x: $(git rev-parse --abbrev-ref ship/x@{upstream})"
  echo "ahead of origin/master: $(git rev-list --count origin/master..ship/x)"
  git branch -d ship/x; echo "branch -d exit=$?"
  git rev-parse -q --verify refs/heads/ship/x >/dev/null && echo "ship/x still exists" || echo "ship/x deleted"
  ```

  The deciding output (`<sha>` stands for the commit id, which varies per run):

  ```text
  upstream of ship/x: origin/ship/x
  ahead of origin/master: 1
  warning: deleting branch 'ship/x' that has been merged to
           'refs/remotes/origin/ship/x', but not yet merged to HEAD
  Deleted branch ship/x (was <sha>).
  branch -d exit=0
  ship/x deleted
  ```

- **Last verified.** 2026-10-09.
- **Relied on by.** #1300's run-branch retire guard (`assertMerged` in
  `ship/src/cli/commands/retire-run.ts`), which uses `merge-base --is-ancestor` +
  `git branch -D` for this reason.

## PF-91 · `git worktree remove --force` leaves the directory behind when it holds a live junction, and spares the junction target

- **Claim.** On Windows, `git worktree remove --force <wt>` exits 0 and unregisters the worktree but leaves `<wt>` on disk holding the untracked junction. Git does not follow the junction: the target's contents are intact. Without `--force` it refuses (exit 128, "contains modified or untracked files").
- **Implication.** Teardown must unlink every link before `git worktree remove` and assert none remain (`assertNoLinksRemain`), because a later recursive delete of the leftover directory could follow the junction.
- **Platform.** `git version 2.56.0.windows.1` (Git for Windows), NTFS junction. The comment says git 2.55; 2.56.0 is the version probed.
- **Established.** Local driver in a scratch repo: `git worktree add ../wt`, then `New-Item -ItemType Junction -Path wt\link -Target ..\target`:

  ```text
  plain: fatal: '../wt' contains modified or untracked files, use --force to delete it  (exit 128)
  force: exit=0
  ls -la ../wt   -> link -> .../gp/target
  ls ../target   -> data.txt
  git worktree list -> main checkout only
  ```

- **Last verified.** 2026-10-10.
- **Relied on by.** `ship/src/cli/commands/teardown.ts` (`assertNoLinksRemain`).

## PF-105 · `commit-msg` runs for a merge commit, with `MERGE_HEAD` set

- **Claim.** git runs the `commit-msg` hook for a merge commit, both the commit a clean `git merge --no-edit` makes itself and the `git commit --no-edit` that concludes a conflicted merge. Both times `git rev-parse -q --verify MERGE_HEAD` succeeds inside the hook, and the message file holds git's `Merge branch '<name>'`.
- **Implication.** A `commit-msg` check that enforces a message format must skip merge commits itself, and `MERGE_HEAD` tells it one is being made.
- **Platform.** `git version 2.43.0` (Linux).
- **Established.** Local driver in a scratch repo, a `commit-msg` hook printing whether `MERGE_HEAD` resolves and the message's first line:

  ```text
  == clean merge:
  HOOK: MERGE_HEAD set, msg=Merge branch 'side'
  == conflicted merge then commit --no-edit:
  HOOK: MERGE_HEAD set, msg=Merge branch 's2'
  ```

- **Last verified.** 2026-10-13.
- **Relied on by.** `tooling/commit-msg.ts` (the merge skip).
