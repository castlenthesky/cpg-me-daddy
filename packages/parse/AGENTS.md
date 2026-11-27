# packages/parse: agent notes

Status (U6a.1): REAL are `src/registry.ts` (extension routing, C-PARSE I5/I6), `src/service.ts` (`createParseService` over web-tree-sitter 0.27.0: grammar loading with provenance, parse, handle lifetime, dispose), `src/abi.ts` (the ABI gate behind the `ParserRuntime` seam, I13; controller decision 99) and `src/grammar-dir.ts` (`resolveGrammarDir`, the locator, I10/I11). SEAT: `retain` / `releaseDocument`, the retained-tree cache (I25/I26), which throw until a caller exists. The composition root supplies a `GrammarSource`, built over `resolveGrammarDir`. See `docs/outline/07-milestones.yaml`.
Layout and rules: `docs/outline/03-architecture.md` §2. Root `AGENTS.md` applies.

- No host SDK and no I/O: source text comes in, trees go out. Grammar bytes arrive only through an injected `GrammarSource`.
- Routing is by extension only. No aliasing, no default grammar, no shebang sniffing.
- `src/contract.ts` holds only statement-level `import type` / `export type` from `@cpg/model` (check-deps rule `contract-types-only`).
- `src/ladder.test.ts` runs every `[parse]` line of `fixtures/ladder` through the real parser. Rungs 09 and 12 are the syntax-error and tsx-routing cases.
- web-tree-sitter's `LANGUAGE_VERSION` / `MIN_COMPATIBLE_VERSION` are live bindings that are undefined until `Parser.init()` resolves. Read them only through `createAbiGate` (`src/abi.ts`): its `range()` throws `AbiNotReadyError` until init has resolved, and an unreadable range is `abi-unreadable`, never a skipped check (I13).
- The locator reads only its request (`env` and `resolvePackageJson` are injected), never `process.env`, `__dirname` or the cwd, and refuses a relative directory instead of resolving it (I10).
