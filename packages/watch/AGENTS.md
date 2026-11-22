# packages/watch: agent notes

Status (U1.3.1): SEAT, types only. `src/contract.ts` is C-WATCH layer A plus the outbound `NormalizedChange`/`ChangeBatch`/`WatchSink`; `index.ts` re-exports it with `export type *`. Layer B and the backends land in U4; see `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK. The producer watches the disk itself; a host never feeds it events.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`). No runtime export, ever.
