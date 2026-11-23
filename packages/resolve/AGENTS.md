# packages/resolve: agent notes

Status: `src/contract.ts` is C-RESOLVE (amended), types only, plus the `ProcessHost` / `SubprocessHandle` seam. REAL: `src/lsp/` (Content-Length framing and a JSON-RPC connection that never throws), the first piece of the U8 driver. Every `Resolver` is SEAT until U6c/U8/U9; see `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O, except through the LSP driver's subprocess seam.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`). No runtime export, ever.
- The LSP transport spawns nothing itself. The composition root passes a `SubprocessHandle` from its `ProcessHost`.
- Readiness is not a signal you can wait on. In the 2026-11-22 spike, basedpyright sent no `$/progress` on small workspaces, and tsserver with no tsconfig sent none either. tsserver still answered an imported call with the local import binding for up to about a second after `didOpen`. Treat a definition that lands on a same-file import binding as not resolved.
