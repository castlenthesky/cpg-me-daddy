# R4 — tree-sitter in Node for incremental, sparse extraction

Research date: 2026-09-11. Local spike run on macOS arm64 (Darwin 25.5), Node v20.20.2 and v24.15.0, sandbox `/tmp/ts-spike` (not in the repo). Every number labelled **measured** comes from that spike; everything else is tagged VERIFIED (source fetched) or INFERENCE.

## Executive summary

- **Use `web-tree-sitter` (wasm) for both the daemon and the VSIX.** Measured on a 1000-line/32 KB TS file: full parse 4.2 ms, incremental reparse 0.05 ms, full-file declaration/import/call query 1.4 ms. The whole tree-sitter portion of a save is <10 ms against a 2000 ms budget, so native's measured 1.6× parse advantage (2.7 ms) buys nothing, while native costs a 6-platform prebuild matrix, `--legacy-peer-deps` installs, and — measured — a hard segfault of `require('tree-sitter')` (tree-sitter@0.25.1 darwin-arm64 prebuild) under Node 20.20.2 (works under Node 24/26).
- **Pin ABI deliberately.** web-tree-sitter 0.27.0 accepts grammar ABI 13–15. Grammar `.wasm` files built with tree-sitter-cli 0.20.x (e.g. the popular `tree-sitter-wasms` package) fail to load with an *empty* `Error` (measured). Ship your own `.wasm` built with a pinned CLI, or vendor `@vscode/tree-sitter-wasm@0.3.1` (grammars built with CLI ^0.25.10; loads fine in 0.27).
- **Incremental parsing is cheap but caching trees is not.** A cached tree costs ~1.6 MB RSS per 1000-line file in wasm (measured, 500 trees → +789 MB, and the wasm heap never shrinks). Cache trees only for open documents + a small LRU; full-parse everything else (4 ms is fine).
- **Extract with `.scm` queries, not a cursor walk** (1.4 ms vs 2.6–3.9 ms measured for the same 12 node kinds), compile queries once (4.6 ms compile), and always run the full-file query; use `getChangedRanges()` only as an early-exit ("no syntactic change → no DiffGraph work").
- **Grammar set:** `typescript` for `.ts/.mts/.cts`, `tsx` for `.tsx`, `javascript` for `.js/.jsx/.mjs/.cjs` (the TS grammar rejects JSX and the TSX grammar rejects `<T>x`; measured), `python` for `.py`. All Python 3.12 syntax tested parses; TS 5.9 `import defer` does not.
- **Interface hash = hash of the normalized exported-declaration surface, propagated transitively only while a dependent's own hash changes** — exactly TypeScript's `updateShapeSignature` queue. **Node ids must not include a content hash of the file**; use `path + kind + qualified scope path (+ ordinal/body-hash for anonymous items)`, the rustc `DefPath`/SCIP-descriptor pattern.

## Binding comparison (2026-09-11)

| | `web-tree-sitter` (wasm) | `tree-sitter` (node-tree-sitter, N-API) |
|---|---|---|
| Latest npm version | **0.27.0** (2026-08-30); tracks tree-sitter core releases | **0.25.1** (2026-07-28); prior 0.25.0 (2025-06-02), 0.22.4 (2024-12-30); GitHub releases stopped at v0.22.4 |
| Grammar loading | `Language.load(path\|URL\|Uint8Array)` of a `.wasm`; also `loadSync(WebAssembly.Module)` | `require('tree-sitter-typescript').typescript` → native `.node` addon per grammar |
| Grammar distribution | Grammar npm packages ship **no** `.wasm`; GitHub releases attach `tree-sitter-*.wasm`; `@vscode/tree-sitter-wasm` bundles ts/tsx/js/py + core | Grammar packages ship `prebuilds/{darwin,linux,win32}-{x64,arm64}/*.node` (measured); core too |
| Full parse, 1000-line TS (measured) | 4.2 ms (Node 20), 4.4 ms (Node 24) | 2.7 ms (Node 24) |
| Full parse, 5000-line TS | 21.0 ms | 11.2 ms |
| Incremental reparse, 1-char edit | 0.05 ms (1000 l), 0.17 ms (5000 l) | 0.03 ms / 0.11 ms |
| Query (8 patterns, full file) | 1.4 ms / 7.2 ms | 1.1 ms / 7.8 ms |
| Cursor walk, all nodes | 2.6–3.9 ms / 20 ms | 3.3 ms / 16.5 ms (per-call N-API overhead) |
| Memory | ~1.6 MB per cached 1000-line tree; wasm heap grows (`ALLOW_MEMORY_GROWTH`) and is never returned; `tree.delete()` mandatory | GC-finalized; RSS ballooned to 843 MB in a bench that never freed trees |
| `worker_threads` | 4 workers + main, OK (measured) | 4 workers + main, OK under Node 24 (measured); historical "Module did not self-register" (#57) |
| ABI pitfalls | Core 0.27 accepts grammar ABI 13–15; CLI-0.20 wasm → empty `Error` (measured; issue #5171) | `tree-sitter-typescript@0.23.2` peer-depends on `tree-sitter@^0.21` → ERESOLVE vs 0.25.1; needs `--legacy-peer-deps` (measured, works at runtime) |
| Node compat | Any Node with WebAssembly | **Segfault at `require` under Node 20.20.2**, OK under 24.15/26.3 (measured); issue #268 reports "No native build was found" + C++ std problems on Node 24 |
| Index encoding | `startIndex` = UTF-16 code units = JS string index (measured) | same (measured) |
| VSIX | Copy `.wasm` files, `Parser.init({locateFile})`; one universal VSIX | Needs `vsce package --target <platform>` per platform (9 targets) |
| Custom query predicates | Not supported (Pulsar blog) | Supported |

## 1. Bindings

VERIFIED: the official web binding README states "executing .wasm files in Node.js is considerably slower than running Node.js bindings"; Pulsar's maintainers, who ship wasm in an Electron app, report the penalty is "small enough that most users won't notice", and chose wasm because grammars "don't have to be built for the user's architecture, nor rebuilt when the version of Electron changes". Their pain points: explicit `delete()` of trees, a fixed-growth wasm heap, Emscripten version coupling for grammars with external scanners, no custom predicates.

Measured: the gap is 1.6–1.9× on parsing and ~0 on queries; cursor walks are actually *slower* natively because every `gotoFirstChild()` crosses N-API. node-tree-sitter 0.25 moved to Node-API + prebuildify with binaries on npm (VERIFIED via package contents), which in principle makes one prebuild work across Node/Electron — but the darwin-arm64 prebuild crashed Node 20 (napi 9) and only worked on napi-10 runtimes, which is exactly the kind of failure a VSIX cannot tolerate.

VS Code itself ships tree-sitter as wasm (`@vscode/tree-sitter-wasm`, "Pre-built WASM files for Tree-Sitter and Tree-Sitter languages that VS Code uses", behind `editor.experimental.preferTreeSitter.typescript`), and extensions with native modules must publish platform-specific VSIXs (`vsce publish --target win32-x64 …`). **Recommendation: wasm.** INFERENCE: keep the parser behind a small `ParserBackend` interface so native could be added to the standalone daemon later, but do not plan on it.

## 2. Incremental reparse

VERIFIED API (`web-tree-sitter.d.ts` 0.27): `tree.edit({startIndex, oldEndIndex, newEndIndex, startPosition, oldEndPosition, newEndPosition})` then `parser.parse(newText, oldTree)`; `oldTree.getChangedRanges(newTree)` "returning a sequence of ranges whose syntactic structure has changed… this syntax tree must have been edited such that its ranges match up to the new tree". Docs: "First, you must edit the syntax tree, which adjusts the ranges of its nodes so that they stay in sync with the code." Indices are UTF-16 code units in both bindings (measured), so JS string offsets can be used directly; points are `{row, column}` with column also in UTF-16 units.

Computing edits when only saved text is available (measured, 1000/5000 lines):

| method | 1-char change | scattered 2%-of-lines change |
|---|---|---|
| common prefix/suffix → one edit | 0.07 / 0.39 ms | 0.00 ms but span = 95–100% of file |
| jsdiff `diffLines` → n edits | 0.19 / 0.68 ms | 0.28 / 2.14 ms |
| fast-myers-diff on lines | — | 0.26 / 0.85 ms |
| jsdiff `diffChars` | 1.09 / 4.87 ms | — |

Recommendation: prefix/suffix (one edit) — it is exact for the common single-region save; when the span exceeds ~50% of the file, skip `edit()` and full-parse (4 ms). When hosted in VS Code, `TextDocumentContentChangeEvent` gives exact `range`/`rangeLength`/`text`; apply changes sequentially (each is relative to the state after the previous one — LSP semantics, INFERENCE for the VS Code API mirror), accumulating the tree edits between keystrokes and reparsing once on save.

Measured incremental vs full: 0.02–0.05 ms vs 4.2 ms (1000 l) and 0.16–0.28 ms vs 21 ms (5000 l) for single-line inserts, a 4-line function insert, a 200-line delete and a brace removal — ~80–130× regardless of position (inserting at line 0 shifts every byte yet costs 0.04 ms). `getChangedRanges` returned 1 range; span was 4–125 chars for clean edits but 16 266 chars (half the file) for the missing brace, so treat changed ranges as a hint, not a bound. No published benchmark for this file-size band was found; the tree-sitter README's own claim is that incremental parsing "is much faster than the first parse". **Not worth it when** the old tree is not resident (memory: 1.6 MB/tree), the edit is a whole-file rewrite (formatter, branch switch), or edits were mis-computed (a wrong edit yields a wrong tree with no error — guard with a periodic S-expression equality check against a fresh parse).

## 3. Queries vs cursor, ranges, errors

Measured: an 8-pattern query covering imports, classes, methods, functions, interfaces, type aliases, calls and exports takes 1.4 ms (655 matches) on 1000 lines; `captures()` 1.5 ms; the same kinds via a hand-written `TreeCursor` walk 2.6–3.9 ms. Query compilation is 4.6 ms — compile once per language and cache. `matches()` groups captures per pattern (needed to pair `@fn` with `@fn.name`); `captures()` is a flat ordered stream. `QueryOptions` supports `startPosition/endPosition`, `startIndex/endIndex` (matches that *intersect*) and `startContainingIndex/endContainingIndex` (matches *fully contained*; C API `ts_query_cursor_set_containing_byte_range`); a 40-line window query ran in 0.06 ms. Also `matchLimit`, `maxStartDepth` (use 1–2 to enumerate top-level declarations without descending into bodies). Predicates `#eq? #match? #any-of?` work in wasm; custom ones do not.

Error recovery (VERIFIED docs, measured): the parser inserts zero-width `MISSING` nodes and wraps unparseable text in `ERROR`; `node.hasError`, `isError`, `isMissing`. Removing one `}` from the 1000-line file produced 0 ERROR + 1 MISSING and the query still returned all 655 matches; on the 5000-line file, 2 ERROR + 1 MISSING and 3270/3273. Extractor policy: (a) run the query anyway; (b) drop captures whose enclosing declaration `hasError` *and* has no name capture; (c) if the root's error span covers > N% of the file (measured brace case: 50%), keep the previous DiffGraph and mark the file `status: dirty` rather than deleting half a module's symbols from the graph; (d) recompute when the next save is clean.

## 4. Grammars

| grammar | npm | GitHub release | last commit | wasm | peer dep |
|---|---|---|---|---|---|
| tree-sitter-typescript | 0.23.2 (2024-11-11) | v0.23.2, assets `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` | 2025-01-30 | release assets / vscode pkg | `tree-sitter ^0.21.0` (stale, even on master) |
| tree-sitter-javascript | 0.25.0 (2026-05-18 npm) | v0.25.0 2025-09-01, `.wasm` attached | 2025-09-15 | yes | `^0.25.0` |
| tree-sitter-python | 0.25.0 (2025-09-11) | v0.25.0 2025-09-11, `.wasm` attached | 2025-09-15 | yes | `^0.25.0` |

Measured coverage with the `@vscode/tree-sitter-wasm` builds: **TS grammar fails on JSX** (`<div>` → ERROR + MISSING `>`), **TSX grammar fails on `<number>x`** type assertions, both parse `<T,>(x)=>x` and `<T>(x)=>x` arrows. Passing in `typescript`: `using`, `const T` type params, decorators with args + `accessor`, `satisfies`, import attributes `with {type:'json'}`, enums/namespaces/overloads, abstract/index signatures/mapped types, regex + ASI. **Failing:** TS 5.9 `import defer` (ERROR). The JS grammar parses JSX, `#private`, `?.`/`??`, top-level `await`, `import.meta`, CJS `require`/`module.exports` — use it for `.js/.jsx/.mjs/.cjs`; the TS grammar happens to parse plain JS too, but not JSX in `.js`. Python 0.25: `match`, PEP 695 `type X[T]`/`def f[T]`/`class C[T]`, PEP 701 nested same-quote and multi-line f-strings, `except*`, walrus, positional-only, async comprehensions — all parse. INFERENCE: the TS grammar is the least maintained of the three (npm release 22 months old, master still at 0.23.2 with a `^0.21` peer); budget for building it from master yourself with tree-sitter-cli pinned to the web-tree-sitter version.

## 5. Stable identity

Prior art (VERIFIED): **SCIP** symbols are `scheme manager package version descriptor+`, descriptors are a qualified path (`ns/ Type# method(). term. [T] (param) meta:`), `local N` for document-local entities, and scip-typescript disambiguates same-named properties with a per-name counter (`metaDescriptor(name + counter.next())`) and constructors as `<constructor>`. **rustc** replaces unstable `DefId`s with `DefPath` ("based on the path to the identified item, e.g. `std::collections::HashMap`") so dep-graph nodes can be matched across sessions, and marks results green by comparing result fingerprints even when an input was red. **Kythe** VNames are `(signature, corpus, root, path, language)` with an opaque, analyzer-defined signature. **Joern** `METHOD.FULL_NAME` includes the signature "for languages that have overriding"; its numeric ids are per-CPG sequential (INFERENCE: `<lambda>N` naming for closures in the JS/Python frontends).

Recommendation: do **not** put `fileHash` in the id — it changes on every save, forcing every node in the file to be deleted and re-created and breaking inbound cross-file edges; store `contentHash` as a property instead. Use `id = h(relPath ‖ kind ‖ scopePath)` where `scopePath` is the qualified declaration chain (`Service1.load`, `helper1`); anonymous functions/lambdas/arrows get `<arrow>@h8(normalizedBodyText)` with `#ordinal` appended only on collision; overloads get `f(h8(paramTypesText))` (SCIP-style disambiguator). Consequences: moving a function within a file or inserting lines above it → same id; renaming → one delete + one create (optionally emit `RENAMED_FROM` when the body hash matches a deleted node); duplicating → second copy gets `#1`. Ordinal-only schemes churn every later sibling when an anonymous node is inserted; body-hash naming confines churn to the edited node.

## 6. Interface hashing

VERIFIED from TypeScript 5.9.2 `builderState.ts`/`builder.ts`: `FileInfo = {version, signature, affectsGlobalScope, impliedFormat}` — `version` hashes the source, `signature` hashes the **emitted `.d.ts` text** (plus declaration diagnostics) via `computeSignatureWithDiagnostics`; `updateShapeSignature` returns whether the signature changed; `getFilesAffectedByUpdatedShapeWhenModuleEmit` walks `referencedBy` and keeps enqueuing dependents **only while each dependent's own signature changes**; files affecting global scope invalidate everything; `isolatedModules` short-circuits to the file itself. `exportedModulesMap` no longer exists in 5.9.2. **Bazel ijar** strips method bodies, private members, constants and debug attributes so "any change that does not change the interface… doesn't cause any downstream recompilations" (50 ms typical). **Turborepo** hashes task inputs (globs), env, lockfile slices and package.json, and includes upstream task hashes so a dependency change cascades; **Nx** does the same with `namedInputs`. **rustc** fingerprints every query result.

For cpg-me-daddy the interface hash of a file should include, for each **exported** symbol: kind, name, type parameters, parameter names + annotation text (normalized whitespace/comments), return annotation, class public member signatures, enum members, interface/type-alias body text, and default-export shape; exclude bodies, private members, comments, ordering. **Re-exports:** `export {a as b} from './x'` contributes the resolved target's *per-symbol* signature; `export * from './x'` and barrel files contribute `./x`'s whole interface hash, so compute hashes in dependency order and, on cycles, fall back to file-level re-evaluation (TS's queue does the same). Python: top-level `def`/`class`/assignments not starting with `_`, honouring `__all__`; include annotation text and default *presence*, not default values.

## Recommendation for cpg-me-daddy

**Binding:** `web-tree-sitter@0.27.0`, grammars as `.wasm` built in CI with `tree-sitter-cli@0.27.0` from pinned grammar commits (typescript master, javascript v0.25.0, python v0.25.0); assert `Language.version ∈ [MIN_COMPATIBLE_VERSION, LANGUAGE_VERSION]` at startup. Fallback for day one: vendor `@vscode/tree-sitter-wasm@0.3.1`.

**Per-save pipeline, 1000-line TS file (measured wasm numbers):**
1. Read file, `sha1` → 0.01 ms; unchanged → stop.
2. Edits: VS Code change events if hosted, else prefix/suffix (0.07 ms); span > 50% → full parse.
3. Parse: cached tree → `edit` + reparse 0.05 ms; no tree → 4.2 ms. Trees cached only for open documents + LRU(100) ≈ ≤160 MB; `delete()` on eviction.
4. `getChangedRanges` → if empty and content hash changed, update `contentHash` only.
5. Full-file `.scm` `matches()` 1.4 ms → per-file symbol table keyed by stable id → DiffGraph = set difference vs previous table (~0.2 ms).
6. Interface hash over exported symbols (~0.1 ms); changed → enqueue importers (reverse index) for edge re-linking, not reparse; propagate while hashes keep changing.
7. Write DiffGraph to FalkorDB (R-other; dominates the budget). Tree-sitter share: **≈6 ms cold, ≈2 ms warm** of the 2000 ms budget; 5000-line files ≈30 ms cold.

**Spikes (pass/fail):**
- S1 ABI: CI test loads every shipped `.wasm` in the pinned web-tree-sitter; fail on version out of range or empty-`Error` load.
- S2 Latency: p95 full parse < 15 ms and incremental < 1 ms for 1000-line TS/TSX/JS/PY on the CI runner; 5000-line < 60 ms.
- S3 Memory: ≤ 2 MB per cached tree; LRU(100) keeps RSS growth ≤ 250 MB over 10k saves; no growth after eviction.
- S4 Incremental correctness: 1000 random edits, `newTree.rootNode.toString()` equals fresh parse 100%.
- S5 Error tolerance: one removed brace anywhere → ≥ 95% of declarations still extracted; >50% error span → previous DiffGraph retained.
- S6 Interface-hash precision on a real repo history: body-only commits change 0 hashes; export-signature commits change exactly the touched files + barrel re-exporters.
- S7 Id stability: move/insert-above/reformat → 0 id changes; rename → exactly 1 delete + 1 create.
- S8 Worker isolation: wasm parser in `worker_threads` under Node 20/22/24, 10k parses, no crash, main thread never blocked > 5 ms.
- S9 VSIX: esbuild `loader: {'.wasm': 'file'}` + `Parser.init({locateFile})`; one universal VSIX runs in the Extension Development Host on macOS/Linux/Windows.

## Sources (accessed 2026-09-11)

- web-tree-sitter README (perf note, ABI table, loading): https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md
- web-tree-sitter 0.27.0 typings (`Edit`, `getChangedRanges`, `QueryOptions`, `LANGUAGE_VERSION`): `node_modules/web-tree-sitter/web-tree-sitter.d.ts`; npm https://www.npmjs.com/package/web-tree-sitter
- node-tree-sitter: https://github.com/tree-sitter/node-tree-sitter ; npm `tree-sitter` versions/times via `npm view`; issue #268 (Node 24 prebuilds/C++): https://github.com/tree-sitter/node-tree-sitter/issues/268 ; issue #57 (threads): https://github.com/tree-sitter/node-tree-sitter/issues/57
- ABI mismatch web-tree-sitter 0.26 vs CLI 0.20 wasm: https://github.com/tree-sitter/tree-sitter/issues/5171
- Tree-sitter docs — advanced parsing (`TSInputEdit`, edit-before-reparse): https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html ; query API (`set_byte_range`, `set_containing_byte_range`): https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/using-parsers/queries/4-api.md ; MISSING nodes: https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/using-parsers/queries/1-syntax.md
- Discussion #2057 (getChangedRanges semantics, maintainer answers): https://github.com/tree-sitter/tree-sitter/discussions/2057
- Pulsar "Modern Tree-sitter, part 7" (wasm vs native trade-offs): https://blog.pulsar-edit.dev/posts/20240902-savetheclocktower-modern-tree-sitter-part-7/
- @vscode/tree-sitter-wasm 0.3.1 (package.json, cgmanifest): https://www.npmjs.com/package/@vscode/tree-sitter-wasm ; https://github.com/microsoft/vscode-tree-sitter-wasm ; VS Code setting `editor.experimental.preferTreeSitter.typescript`: https://github.com/microsoft/vscode/pull/245350
- VS Code platform-specific extensions: https://code.visualstudio.com/api/working-with-extensions/publishing-extension ; bundling: https://code.visualstudio.com/api/working-with-extensions/bundling-extension
- Grammars: https://github.com/tree-sitter/tree-sitter-typescript (README, master package.json, `common/define-grammar.js`), https://github.com/tree-sitter/tree-sitter-javascript , https://github.com/tree-sitter/tree-sitter-python (`grammar.js`); release/asset data via `api.github.com/repos/*/releases`
- tree-sitter 0.25 ABI 15 announcement: https://newreleases.io/project/github/tree-sitter/tree-sitter/release/v0.25.0 ; peer-dep staleness: https://github.com/tree-sitter/tree-sitter-cpp/issues/349 , https://github.com/tree-sitter/tree-sitter/issues/5081
- SCIP symbol grammar: https://github.com/scip-code/scip/blob/main/docs/scip.md ; scip-typescript symbol construction: https://github.com/sourcegraph/scip-typescript/blob/main/src/ScipSymbol.ts , https://github.com/sourcegraph/scip-typescript/blob/main/src/FileIndexer.ts
- rustc incremental compilation in detail (fingerprints, DefPath, try-mark-green): https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation-in-detail.html
- Kythe storage model (VName): https://kythe.io/docs/kythe-storage.html
- Joern CPG spec (METHOD.FULL_NAME / SIGNATURE): https://cpg.joern.io/
- TypeScript 5.9.2 `builderState.ts` / `builder.ts` (signature, `updateShapeSignature`, `computeSignatureWithDiagnostics`): https://raw.githubusercontent.com/microsoft/TypeScript/v5.9.2/src/compiler/builderState.ts , https://raw.githubusercontent.com/microsoft/TypeScript/v5.9.2/src/compiler/builder.ts
- Bazel ijar README: https://github.com/bazelbuild/bazel/tree/master/third_party/ijar ; https://fzakaria.com/2024/10/29/bazel-knowledge-what-s-an-interface-jar
- Turborepo caching/hash inputs: https://turborepo.dev/docs/crafting-your-repository/caching ; Nx inputs: https://nx.dev/docs/reference/inputs
- Python 3.12 PEP 701 / PEP 695: https://peps.python.org/pep-0701/ ; https://docs.python.org/3/whatsnew/3.12.html
- Local spike scripts: `/tmp/ts-spike/{bench,gen,syntax-wasm,diffcost,mem,worker-test}.mjs` (web-tree-sitter 0.27.0, tree-sitter 0.25.1, tree-sitter-typescript 0.23.2, tree-sitter-javascript 0.25.0, tree-sitter-python 0.25.0, @vscode/tree-sitter-wasm 0.3.1, tree-sitter-wasms 0.1.13, diff, fast-myers-diff)
