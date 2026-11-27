# packages/extract: agent notes

Status (U6a.2-1): `src/contract.ts` is C-EXTRACT, types only. It owns `FileOwnedLabel`, `PropertyValue`, `EndpointRef`, `EdgeElement` and the `ExtractedFileSet` brand (controller decision 88). SEAT: everything that runs (`createExtractor`, the walker, the Python adapter, the builder, the digests, `sealExtractedFiles`) lands in U6a.2-2..4; see `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`). So `SyntaxNode` (C-PARSE's) and `RefSite` (C-RESOLVE's) are declared again here, structurally. `apps/cli/src/contracts-agree.test-d.ts` pins each copy to its owner both ways: change both sides together.
- Mint node ids with `makeNodeId` and SYMBOL fqns with `makeSymbolFqn` (both `@cpg/model`). Emit 0-based `SourceRange` objects; the store formats the schema's `range` string with `formatRange`.
