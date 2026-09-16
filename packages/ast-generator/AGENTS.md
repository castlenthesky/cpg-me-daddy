# @cpg/ast-generator

Status: parses one source file with `web-tree-sitter`. Callers today: `@cpg/file-watcher`'s `AstPipeline` (one file per watcher event, also dumping to disk via `writeAstJson`) and its `runAstPass` (every supported file, at ParseWorkspace time).

`Parser.init()` and each grammar's `Language.load()` are memoized per process (a failed load isn't cached), and every `parseFile` releases its `Parser`/`Tree` in a `finally` — both required by the whole-workspace pass, which would otherwise recompile the same wasm once per file and leak it.

Supported extensions: `.ts`/`.mts`/`.cts`, `.tsx`, `.js`/`.jsx`/`.mjs`/`.cjs`, `.py` — see `GRAMMAR_WASM_BY_EXTENSION` in `src/index.ts`. Check `isSupportedExtension(filePath)` before calling `parseFile`/`dumpAst` on unchecked input.

- `parseFile(filePath): Promise<ParsedFile>` — parses and returns the AST in memory; doesn't touch disk.
- `writeAstJson(parsed: ParsedFile, outputDir?): Promise<string>` — writes an already-parsed result to `<outputDir>/<filename>.ast.json`. Split out from `dumpAst` so a caller that already has a `ParsedFile` (e.g. the AST pipeline) doesn't parse the file twice.
- `dumpAst(filePath, outputDir?): Promise<string>` — convenience wrapper, `parseFile` + `writeAstJson`. Still what the CLI (`main()`) uses.

## Run

```
npm run build --workspace=@cpg/ast-generator
node dist/index.js <path/to/file> [outputDir]
```

Writes `<outputDir>/<filename>.ast.json` (default `out/ast` at repo root).
