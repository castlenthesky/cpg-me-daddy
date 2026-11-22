# packages/engine: agent notes

Status: the walker and the filesystem tier (U2a.2a). createEngine lands in U2a.2c.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- Exports `createEngine()` but never calls it: composition roots live only in `apps/*`.
