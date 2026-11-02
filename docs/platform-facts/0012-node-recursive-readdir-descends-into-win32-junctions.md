---
status: current
platform: [node 24.19.0, windows 10.0.26300]
last-verified: 2026-10-10
relied-on-by: [ship/src/cli/git/links.ts]
---

# Ship PF-12: `fs.readdirSync(dir, { recursive: true })` descends into directory junctions on win32

On win32, `readdirSync(dir, { recursive: true })` lists the entries beneath a directory junction inside `dir`, as if the link target were a real subdirectory.

## Implication

A recursive walk or count over a tree that holds junctions sees the link target's contents, and a cleanup would reach them. Walk manually with `lstat` and stop at links. Every walk in `ship/src/cli/git/links.ts` is a manual `lstat` walk.

## Scope

The probe ran on Windows 11 Pro 10.0.26300.

## Established

A local driver: junction `dir/lnk` -> a directory holding `inner/f.txt` and `t.txt`. Deciding output:

```text
recursive readdir of dir: [ 'lnk', 'lnk\\inner', 'lnk\\t.txt', 'lnk\\inner\\f.txt' ]
```
