# packages/resolve: agent notes

Status: `src/contract.ts` is C-RESOLVE (amended), types only, plus the `ProcessHost` / `SubprocessHandle` seam and `ResolveReport`. REAL (U6c.1a): `ChainResolver` (`src/chain.ts`), `createDefinitionLookup` over a sealed set (`src/lookup.ts`), `applyResolutions` (`src/apply.ts`), `unresolved`/`statusRank` (`src/resolution.ts`); `NullResolver` (`src/null.ts`) is a PASSTHROUGH by design, the control that resolves nothing. REAL: `src/lsp/` (Content-Length framing and a JSON-RPC connection that never throws), the first piece of the U8 driver. PythonPathResolver is U6c.1b; the LSP resolver U8; see `docs/outline/07-milestones.yaml`.

- `test/` holds the test doubles: `FixtureResolver` (a table-driven Resolver with `unmatched()`), `BrokenChain` (the archive's chain, which the chain suite must fail on INV-4 and INV-10c), the chain suite itself (`chain-contract.ts`) and hand-built extract output (`files.ts`). A resolve test may import one sibling (`@cpg/extract`), so it builds files by hand rather than parsing.
  Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O, except through the LSP driver's subprocess seam.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`). No runtime export, ever.
- The LSP transport spawns nothing itself. The composition root passes a `SubprocessHandle` from its `ProcessHost`.
- Readiness is not a signal you can wait on. In the 2026-11-22 spike, basedpyright sent no `$/progress` on small workspaces, and tsserver with no tsconfig sent none either. tsserver still answered an imported call with the local import binding for up to about a second after `didOpen`. Treat a definition that lands on a same-file import binding as not resolved.
