# @cpg/ast-generator

Status: parses one source file with `web-tree-sitter`, dumps its AST as JSON. Only caller today: `@cpg/file-watcher`'s `monitorWorkspace`. Not wired into `@cpg/cpg-generator` yet.

Supported extensions: `.ts`/`.mts`/`.cts`, `.tsx`, `.js`/`.jsx`/`.mjs`/`.cjs`, `.py` — see `GRAMMAR_WASM_BY_EXTENSION` in `src/index.ts`. Check `isSupportedExtension(filePath)` before calling `parseFile`/`dumpAst` on unchecked input.

## Run

```
npm run build --workspace=@cpg/ast-generator
node dist/index.js <path/to/file> [outputDir]
```

Writes `<outputDir>/<filename>.ast.json` (default `out/ast` at repo root).
