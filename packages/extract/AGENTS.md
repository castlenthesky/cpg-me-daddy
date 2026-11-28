# packages/extract: agent notes

Status (U6a.2-4a): `src/contract.ts` is C-EXTRACT's types. It owns `FileOwnedLabel`, `PropertyValue`, `EndpointRef`, `EdgeElement` and the `ExtractedFileSet` brand (controller decision 88). REAL: `createExtractor` (python only; typescript, tsx and javascript fail `grammar-unsupported`, decision 96), the builder's I5-I10/I19 asserts, `elementDigest`, `interfaceHash`, `sealExtractedFiles`, the walker's MODULE tier and Pass A (TYPE_DECL, METHOD with `nameRange`, PARAM, MEMBER, an UNKNOWN per ERROR region, decorated definitions; a repeated id takes an ordinal) and Pass B's calls (`src/pass-b.ts`: CALL with per-region ordinals, decorator CALLs, IN_SCOPE, same-file and builtin CALLS, REACHING_DEF, one call ref site per CALL plus declined receiver sites). Not yet: Pass B imports (BMO-134); the Python coverage table marks IMPORT declared-not-emitted with that tracking id.

- `test/fixtures/pass-a/` and `test/fixtures/pass-b/` are extract's own fixtures in the ladder's format (each its files' whole code tier, SOURCE_FILE aside); `src/ladder.test.ts` reads them beside `fixtures/ladder`.

- `node:crypto` is the one builtin allowed (interfaceHash's sha256). `src/purity.test.ts` runs the built dist under a `Module._load` trap, so run `bun run typecheck` (it runs `tsc -b`) before running that test alone.
- When a pass starts emitting a label or edge, flip its row in `src/python.ts`'s coverage table in the same change: `src/ladder.test.ts` checks the table against the ladder both ways (I14).
  Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`). So `SyntaxNode` (C-PARSE's) and `RefSite` (C-RESOLVE's) are declared again here, structurally. `apps/cli/src/contracts-agree.test-d.ts` pins each copy to its owner both ways: change both sides together.
- Mint node ids with `makeNodeId` and SYMBOL fqns with `makeSymbolFqn` (both `@cpg/model`). Emit 0-based `SourceRange` objects; the store formats the schema's `range` string with `formatRange`.
