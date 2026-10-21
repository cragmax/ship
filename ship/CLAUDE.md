# Ship

The `ship/` home (Repo ADR-0006): the application that performs **Unattended runs**. It imports `tooling/`, `server-pool/` and `src/` (the last two through their barrels), and nothing imports it. Code under `src/workflow/` and `src/core/` is rendered into the Saved workflows, so it value-imports only those two folders, plus two named carve-outs: the pool's `lease-timings` (from `src/workflow/` only) and `tooling/hooks/lib/platform-wide.ts` (Ship ADR-0001 decision 2).

- [README.md](README.md): what the folder holds, how a run is launched, and what Ship owns under `.claude/`.
- [GLOSSARY.md](GLOSSARY.md): Ship's terms. Read before naming things here.
- [docs/adr/](docs/adr/readme.md): Ship's decisions, cited `Ship ADR-NNNN`; every citation names its series (Repo ADR-0007).
- [docs/platform-facts/](docs/platform-facts/readme.md): Ship's platform facts, cited `Ship PF-N`.

The platform-facts policy, the testing policy and the git rules are the root's: see the root [CLAUDE.md](../CLAUDE.md).
