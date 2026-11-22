# packages/resolve: agent notes

Status (U1.3.1): SEAT, types only. `src/contract.ts` is C-RESOLVE (amended); `index.ts` re-exports it with `export type *`. Implementations land in U3, U6c, U8, U9; see `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O, except through the LSP driver's subprocess seam.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`). No runtime export, ever.
