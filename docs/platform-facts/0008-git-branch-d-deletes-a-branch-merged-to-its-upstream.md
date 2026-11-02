---
status: current
platform: [git 2.56.0.windows.1]
last-verified: 2026-10-09
relied-on-by: [ship/src/cli/commands/retire-run.ts]
---

# Ship PF-8: `git branch -d` deletes a branch merged to its upstream even when it is not merged to `HEAD`

`git branch -d <branch>` treats a branch as merged when it is merged to its configured upstream (`<branch>@{upstream}`), not only when it is merged to `HEAD`. A pushed branch with an upstream is deleted, with exit 0 and a warning, even while it carries commits `origin/master` lacks.

## Implication

`-d` is no "unmerged" guard for a branch that has been pushed with an upstream, and every `ship/` run branch is. Guard by ancestry against the target ref instead, with `git merge-base --is-ancestor <branch> refs/remotes/origin/master`, then delete with `git branch -D`. The run-branch retire guard, `assertMerged` in `ship/src/cli/commands/retire-run.ts`, uses `merge-base --is-ancestor` + `git branch -D` for this reason.

## Scope

The probe ran on Git for Windows.

## Established

A plan-time probe for #1297 falsified its proposed `git branch -d` guard. It was re-run for #1306 on 2026-10-09. The probe script:

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
