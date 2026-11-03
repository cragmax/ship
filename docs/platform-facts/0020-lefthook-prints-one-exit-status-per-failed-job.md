---
status: current
platform: [lefthook 2.1.4, node 24.19.0, git 2.56.0]
last-verified: 2026-10-24
relied-on-by: [src/cli/git/hooked.ts]
---

# Ship PF-20: lefthook prints one `exit status N` per failed job, and on Windows a Node crash's N depends on its exception

lefthook 2.1.4 prints an `exit status N` line for each job that failed, a plain `exit 1` included, and none for a job that passed, inside a parallel group as alone. The line has no trailing newline: the next job's header or output follows on the same line. On Windows, N for a Node process that crashed is not POSIX's 128 plus the signal number: Git Bash maps the process's NTSTATUS, so an access violation (`0xC0000005`) run through a bash wrapper such as `npx` reads `Segmentation fault` and 139, one run directly by lefthook reads 2816, and a stack overflow (`0xC00000FD`) reads 127 either way, as does a fail-fast (`0xC0000409`).

## Implication

`hookCrash` finds every failed job's status by matching `exit status (\d+)`, and calls the failure a crash when each is 128 or above. An access violation is a crash whether or not a wrapper ran the process. A stack-overflow or fail-fast crash reads 127, the status a missing command also gives, and is a gate failure, never retried.

## Scope

Windows 11, Git Bash 5.3.15 on the Cygwin runtime 3.6.10, lefthook run by its npm package. The crashes were exits with the NTSTATUS value, except one real stack overflow; a parent sees only the exit code, and the real stack overflow read the same 127 as its emulation. Not run on Linux or macOS.

## Established

A throwaway repo's hooks, run with `node node_modules/lefthook/bin/index.js run <hook>` (2026-10-24). A parallel group of `exit 1`, `exit 139`, `true`, `node av.js` and `bash wrap.sh av.js` (`av.js` is `process.exit(0xC0000005|0)`, `wrap.sh` runs node as `npx` does) printed:

```text
┃  group (0) ❯ pass ❯
┃  group (0) ❯ shexit ❯
exit status 139┃  group (0) ❯ gate ❯
exit status 1┃  group (0) ❯ av-direct ❯
exit status 2816wrap.sh: line 2: 11082 Segmentation fault         "$(command -v node)" "$@"
┃  group (0) ❯ av-wrapped ❯
exit status 139
```

A lone `node --stack-size=100000 so.js` (`so.js` recurses without end; its raw status was `0xC00000FD`) printed `exit status 127`, and so did the same through `wrap.sh`. Under Git Bash directly, `process.exit` with `0xC00000FD` and `0xC0000409` gave 127, `0xC0000005` gave 139 and `0xC000001D` gave 132 (`Illegal instruction`).
