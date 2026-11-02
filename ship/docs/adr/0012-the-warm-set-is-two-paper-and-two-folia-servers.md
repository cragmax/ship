# Ship ADR-0012: The Warm set is 2 Paper and 2 Folia servers

A run's slices are the per-invocation consumer of Pool ADR-0003, on the four registry servers that the batch's registry trim keeps. Pre-flight requires all four to be warm.

## Decision

1. **The four servers fit the host.** Together, they peaked at about 16.6 GiB with no out-of-memory (OOM) error, and their ticks per second (TPS) never fell below 19.6 (Pool PF-1).
2. **The registry servers run a 2G heap under Pool ADR-0001.** Pool PF-1 measured the figures above at 4G, and Pool PF-2 holds the 2G measurements.
