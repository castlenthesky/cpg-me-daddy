# packages/engine: agent notes

Status (U2a.2d). REAL: the walker and the filesystem tier, the `CpgEngine` port (`src/port.ts`, C-CLI Q1), and `createEngine` (`connect` opens the sinks; `index` walks, then writes ONE merge-filesystem op through them). Also REAL: `NullGraphStore`, which backs `--dry-run`. SEAT: per-file deltas (U6a), dialing a store target (FalkorStore, U5), `resolvers`/`processHost` (U6c/U8), `resumeFrom`, and the port's `watch`/`read`/`verify`/`inspect`/`doctor`/`schema`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- Exports `createEngine()` but never calls it: composition roots live only in `apps/*`.
