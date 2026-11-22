# packages/parse: agent notes

Status (U6a.1, first unit): `src/registry.ts` is REAL (extension routing, C-PARSE I5/I6). `src/contract.ts` holds the C-PARSE types; `ParseService` and the web-tree-sitter backend are SEAT until the next unit. See `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O: source text comes in, trees go out. Grammar bytes arrive only through an injected `GrammarSource`.
- Routing is by extension only. No aliasing, no default grammar, no shebang sniffing.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`).
- `fixtures/ladder` rungs 09 and 12 are the hand-checked parse cases (syntax error, tsx routing).
