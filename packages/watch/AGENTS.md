# packages/watch: agent notes

Status: `src/contract.ts` is C-WATCH layer A plus the outbound `NormalizedChange`/`ChangeBatch`/`WatchSink`, types only. REAL: `src/parcel-backend.ts`, the @parcel/watcher backend, and `src/coalesce.ts`: `coalesce` (the merge table) and `flushBatch` (the batch order); each departure from 05-contracts is marked AMENDED there. SEAT: the WatchSession until U4.1.2 completes; see `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK. The producer watches the disk itself; a host never feeds it events.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`). No runtime export, ever.
- `@parcel/watcher` loads by dynamic import inside `subscribe`, never at module load. Importing `@cpg/watch` must not load a `.node` file.
- What parcel really delivers on Linux is in `docs/outline/06-measurements.yaml` `M-RESEARCH-watcher-linux`: it merges events per path inside ~50 ms, a rename is delete + create, and a file created right after its new directory can go unreported. Layer B repairs these (C-WATCH OQ-9, OQ-10); the backend must not.
