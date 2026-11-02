---
status: current
platform: [rcon-client 4.2.5, node 24.19.0]
last-verified: 2026-10-10
relied-on-by: [ship/src/cli/commands/rcon-probe.ts]
---

# Ship PF-22: An rcon-client packet timeout, in auth or on a command, leaves the socket open

A packet timeout in rcon-client 4.2 only rejects the pending promise (`Timeout for packet id N`). Nothing ends or destroys the socket. This holds for the auth exchange, where `connect()` rejects and `rcon.socket` stays set and open, and for a command.

## Implication

A caller that gives up on a timed-out probe must destroy `rcon.socket` itself, or the connection leaks. `ship/src/cli/commands/rcon-probe.ts` destroys the socket on a failed probe.

## Established

A source read of `node_modules/rcon-client/lib/rcon.js`: the timeout handler in `sendPacket()` only `reject`s, and in `connect()` only the `Authentication failed` branch destroys. A local driver ran with `timeout: 500` against a `net` server that stayed silent (auth), then against one that authed and then went silent (command):

```text
connect err: Timeout for packet id 0
socket after auth timeout: open destroyed=false
send err: Timeout for packet id 1
socket after cmd timeout: destroyed=false writable=true
```
