# packages/engine: agent notes

Status (U2a.4). REAL: the walker and the filesystem tier, the `CpgEngine` port (`src/port.ts`, C-CLI Q1), `createEngine` (`connect` opens the sinks; `index` walks, then writes ONE merge-filesystem op through them; `verify` runs all six checks, `worstState`, and `--strict`; `schema` returns `CPG_SCHEMA`), and `NullGraphStore` (backs `--dry-run`). Within `verify`: `filesystem-reconciliation`, `id-uniqueness`, and `revision-reconciliation` are REAL against a store (and `unavailable` with zero sinks); `identity-invariants` and `resolution-health` are SEAT and report `unavailable` until U6c (no code tier / ResolveReport yet); `render-reconciliation` is SEAT and reports `unavailable` until U2b/U3 add a renderer consumer (ND-8); non-null `expected` (C-CLI Q9) and multiple store sinks (U5) are SEAT. Other SEATs: per-file deltas (U6a), dialing a store target (FalkorStore, U5), `resolvers`/`processHost` (U6c/U8), `resumeFrom`, and the port's `watch`/`read`/`inspect`/`doctor`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- Exports `createEngine()` but never calls it: composition roots live only in `apps/*`.
