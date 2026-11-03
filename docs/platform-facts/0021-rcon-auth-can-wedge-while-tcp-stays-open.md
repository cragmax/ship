---
status: current
platform: [paper 1.21.11]
last-verified: 2026-06-10
relied-on-by: [src/cli/commands/rcon-probe.ts, src/cli/commands/preflight.ts]
---

# Ship PF-21: RCON AUTH can wedge, timing out on packet id 0, while TCP stays open

Under Java virtual machine (JVM) starvation from host memory exhaustion, a server's RCON can wedge half-alive. The TCP port still accepts connections, but the AUTH request never completes (`Timeout for packet id 0`). TCP-reachable and AUTH-serviceable are two distinct health states. The wedge did not heal itself once host memory recovered. Recovery required restarting the Docker engine and warming the servers again.

## Implication

A liveness check must complete an RCON AUTH round trip, as `src/cli/commands/rcon-probe.ts` does, never just a TCP connect or a check that the container is running. The pool pre-flight (`src/cli/commands/preflight.ts`) checks every warm server with that AUTH round trip. If a lease or reset layer sees storms of `RESET_FAILED` or auth timeouts, suspect host memory pressure before retrying (#833). A wedged server's reset failure is slow, not connection-refused.

## Scope

Two Paper 1.21.11 servers (itzg image, warm pool `docker-compose.parallel.yaml`) ran under Docker Desktop and WSL2 at its default memory ceiling, with no `.wslconfig`: Docker `MemTotal` ~11.6 GB on a 23.9 GB host.

## Established

A live incident occurred during the first parallel `/ship-issues` batch, on 2026-06-10. Warming 4×4G servers ran the WSL virtual machine out of memory: engine API 500s, `docker info` hung, vmmemWSL collapsed to ~1.4GB, and both Paper servers' RCON AUTH wedged with TCP open.
