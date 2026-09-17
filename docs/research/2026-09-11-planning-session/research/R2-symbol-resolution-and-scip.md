# R2 — Name/Symbol Resolution Options and the SCIP Ecosystem

Research item for cpg-me-daddy (headless CPG engine, FalkorDB, 2 s incremental budget, v1 = TS family + Python). Accessed 2026-09-11. Each claim is tagged **[V]** verified against a primary source or **[I]** inference.

## Executive summary

- **SCIP is alive and just became vendor-neutral.** The protocol moved to `github.com/scip-code/scip` under a Core Steering Committee (engineers from Uber and Meta; Sourcegraph "remains deeply committed") announced 2026-03-25; six releases shipped in 2026 (v0.7.0 → v0.10.0, latest 2026-09-03). Apache-2.0. **[V]** Adopting its symbol grammar is low-risk.
- **Adopt the SCIP symbol grammar for `SYMBOL.fqn`, but not verbatim.** Keep the descriptor grammar (`pkg/`, `Type#`, `term.`, `method().`, `(param)`, `[T]`) exactly, so a SCIP-backed resolver can map 1:1. Do **not** bake the scheme/manager prefix (`scip-typescript npm`) into the fqn — store it as node properties — because adapter-native and TS-compiler-backed resolvers would otherwise produce different fqns for the same symbol. **[I]**
- **No SCIP indexer is incremental.** scip-typescript builds one `ts.createProgram` over the whole tsconfig and indexes every file (1k–5k LOC/s); scip-python (a Pyright fork whose last upstream sync commit dates to 2022-07) also re-indexes whole projects and has had no commits since 2025-09-05. Neither offers a single-file mode. **[V]** They fit a *cold-start / nightly precision pass*, not the 2 s on-save loop.
- **The TS compiler API in-process is the only credible precise upgrade path that fits 2 s.** `createProgram(..., oldProgram)` structure reuse plus a lazy checker gives tens-of-ms program updates when module structure is unchanged (tsserver `updateOpen` ≈ 74 ms on a large monorepo, TS 5.4). **[V]** For Python, Pyright's `Program` has `markFilesDirty` + `importedBy` cascade, but `pyright-internal` is not a published library; drive basedpyright via LSP or vendor the fork. **[V/I]**
- **stack-graphs is dead** (archived 2025-09-09, "no longer supported or updated by GitHub"); tree-sitter-graph is dormant (last push 2024-12). Borrow their file-incremental idea (per-file partial paths ≈ our SYMBOL indirection); do not depend on the code. **[V]**
- **Interface hash prior art exists and works:** TypeScript's `BuilderState` hashes the *emitted `.d.ts`* per file and cascades via `referencedMap`; Pyre/Flow recheck importers only when a module's *exported types* change; Pyrefly reaches sub-10 ms rechecks this way. Our hash must cover the same surface (see §5). **[V]**

## Comparison of resolver options

| Option | Speed (single-file update) | Incrementality | Precision | Runtime deps | License | Maintenance (2026-09) |
|---|---|---|---|---|---|---|
| **Adapter-native** (tree-sitter + hand-written module resolution) | ~1–20 ms/file parse + graph lookups **[I]** | File-granular by construction | Medium: exact for imports/qualified names, heuristic for receiver types, dynamic dispatch | tree-sitter WASM/native only | Ours | Ours |
| **TS compiler API in-daemon** (persistent `Program` + `oldProgram` reuse) | 10s–100s ms when structure reused; seconds if imports change or `structureIsReused=Not` **[V/I]** | Program-level reuse; per-file `getSemanticDiagnostics`/`getSymbolAtLocation` lazy | High (compiler-grade) | `typescript` npm, tsconfig, node_modules types | Apache-2.0 | Microsoft, very active |
| **scip-typescript** (whole-project batch) | Whole project: 1k–5k LOC/s; Sourcegraph repo ≈ 5 min **[V]** | None (whole tsconfig) | High | node, tsconfig; pins `typescript ^4.5.4` in npm deps **[V]** | Apache-2.0 | Active (commits 2026-09-11); last release v0.4.0 2025-10-02 |
| **Pyright / basedpyright** (Program API or LSP) | Dirty-marking cascade; full check of pandas 144 s, numpy 71 s; ~1.7 GB RSS on Django **[V]** | `markFilesDirty` → `importedBy` cascade; new evaluator per change | High for typed code; static imports only | Node; Python env for site-packages | MIT | Microsoft / community, very active |
| **scip-python** (whole-project batch) | Whole project; no numbers published | None | High (Pyright) | Node ≥16, Python ≥3.10, `pip show` | MIT | Stalled: last commit 2025-09-05; pyright sync marker 2022-07-07 **[V]** |
| **stack-graphs / tree-sitter-graph** | Per-file partial paths (ms) | File-incremental by design | Medium (syntactic scope graphs) | Rust crates | MIT/Apache-2.0 | **Archived** 2025-09-09 |
| **Name-only heuristics** (Aider, ctags/search-based) | ms | Trivially | Low: identifier-name matching, no scoping | tree-sitter / ctags | Apache-2.0 / mixed | Active |

## 1. SCIP: protocol, CLI, symbol grammar, roles, license, maintenance

**State.** Canonical repo is `scip-code/scip` (the old `sourcegraph/scip` URL now resolves there). Apache-2.0. GitHub releases API: v0.7.0 2026-03-24, v0.7.1 2026-04-14, v0.8.0 2026-06-02 (Java/Kotlin bindings, `SignatureDocumentation`), v0.8.1 2026-06-04 (TS bindings on npm, Haskell), v0.9.0 2026-06-29, v0.10.0 2026-09-03 (.NET bindings, Odin). **[V]** Sourcegraph's "The future of SCIP" (2026-03-25) moved governance to a Core Steering Committee with an RFC process ("SCIP Enhancement Proposals"); Sourcegraph self-hosted upgraded to SCIP 0.9.0 in July 2026 and normalizes deprecated `range` into typed ranges. **[V, via search snippets; the blog page itself returned 403]**

**CLI** (`scip`): `lint`, `print --json`, `snapshot`, `stats`, `test`, `expt-convert` (→ SQLite). **[V]**

**Symbol grammar (scip.proto, verbatim structure):**
```
<symbol>   ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
<package>  ::= <manager> ' ' <package-name> ' ' <version>
<descriptor> ::= <name>'/' (namespace) | <name>'#' (type) | <name>'.' (term)
              | <name>'(' disambiguator? ').' (method) | '[' <name> ']' (type-param)
              | '(' <name> ')' (parameter) | <name>':' (meta) | <name>'!' (macro)
```
Scheme/manager/name/version: any UTF-8, spaces escaped as double space, `.` placeholder for empty. Identifiers made of `_ + - $` and ASCII alphanumerics are unescaped; anything else is wrapped in backticks with backticks doubled. `local N` symbols must not be reachable outside a Document. **[V]**

**Concrete examples.** scip-typescript's `ScipSymbol.ts` builds the prefix `"scip-typescript npm ${name} ${version} "` (anonymous package → `scip-typescript npm . .`), and its snapshots show descriptors `src/`class.ts`/Class#method().`, `Class#`<constructor>`().`, `Class#`<constructor>`().(constructorParam)`, `Class#classProperty.`. **[V]** So a TS method is:
```
scip-typescript npm @acme/web 1.2.3 src/`users.ts`/UserService#findById().
```
scip-python snapshots show `class_nohint/Example#something().`, `Example#__init__().(self)`, module `class_nohint/__init__:`, and stdlib refs `python-stdlib 3.11 builtins/print().` **[V]**; the snapshot printer omits the `scip-python python` scheme/manager **[I]**, giving:
```
scip-python python acme-svc 1.2.3 acme/users/UserService#find_by_id().
```
Note: file path segments are namespace descriptors, so the module path is embedded — matching our SYMBOL model.

**Occurrence roles** (bitset): Definition 0x1, Import 0x2, WriteAccess 0x4, ReadAccess 0x8, Generated 0x10, Test 0x20, ForwardDefinition 0x40. Occurrences carry `typed_range` (Single/MultiLineRange), `symbol`, `symbol_roles`, `syntax_kind`, `typed_enclosing_range`. **[V]**

## 2. scip-typescript and scip-python

**scip-typescript.** Runs as `scip-typescript index` in a directory with `tsconfig.json`; `--infer-tsconfig` for JS-only; `--yarn-workspaces`/`--pnpm-workspaces`; recurses `projectReferences`. `ProjectIndexer` does `ts.createProgram(config.fileNames, config.options, host)` and `program.getTypeChecker()`, then a `FileIndexer` per file in `config.fileNames` (node_modules `.d.ts` excluded). No incremental or per-file mode. **[V]** Published speed: 1k–5k LOC/s; Sourcegraph's own CI went 40 min (12 jobs) → 5 min (1 job); memory needs `--max-old-space-size` on big repos; no output-size figures. **[V]** Apache-2.0; npm 0.4.0 declares `typescript: ^4.5.4` **[V]** (i.e. it type-checks with TS 4.x regardless of the project's TS 5.x — **[I]** a precision/compat risk for TS ≥5 syntax). Repo is active (three commits on 2026-09-11 adding SCIP symbol kinds and document languages). **[V]**

**scip-python.** "A Sourcegraph fork of pyright"; MIT (Microsoft copyright). Node ≥16, Python ≥3.10; `scip-python index . --project-name=X --project-version=Y`, `--target-only`, `--project-namespace`, `--environment=<json>` to bypass `pip show` discovery of site-packages. No incremental mode; needs the target venv/interpreter on PATH for third-party resolution. **[V]** Dynamic imports (`importlib.import_module`, `__import__`) are not resolved — Pyright resolves static `import` statements only; a snapshot suite `unresolved_import` exists. **[I]** npm 0.6.6 2025-09-05 = last commit; `pyright-last-sync` points at a pyright commit dated 2022-07-07. **[V]** → the type-evaluator core is roughly four years behind upstream Pyright. **[I]**

**JS-only community indexers:** none beyond scip-typescript's `--infer-tsconfig` (and an npm fork `@vidoc/scip-typescript`). Sourcegraph's JS fallback is search-based (ctags/tree-sitter), not a SCIP indexer. **[V]**

## 3. Alternative resolvers

**(a) TS compiler API in-daemon.** `ts.createProgram(rootNames, options, host, oldProgram)` → `tryReuseStructureFromOldProgram` yielding `StructureIsReused.{Not, SafeModules, Completely}`; a `LanguageService` layers `LanguageServiceHost` versions + `DocumentRegistry` (shared `SourceFile`s). The checker is lazy: "the checker is completely starting from scratch, but it only requests information about what you're typing." **[V]** Data point: tsserver `updateOpen` averaged 74.29 ms on a ~10k-project monorepo (TS 5.4.2) and regressed to >50 s when `structureIsReused` was `Not` (TS 5.5.2, issue #60311). **[V]** Cost model for one saved file **[I]**: re-parse (≈1–5 ms/kLOC) → program update (10–100 ms if imports unchanged; module resolution re-runs otherwise) → new checker → `getSymbolAtLocation`/`getResolvedSignature` per call site, cost ∝ types touched (first call on a heavy dependency chain can cost 100s of ms). Startup = full program parse: seconds to tens of seconds and 0.5–2+ GB on medium repos. Fits 2 s for the edited file; dependents must be bounded by the interface hash (§5).

**(b) Pyright/basedpyright.** Architecture: service → `Program` → `SourceFile` (tokenizer/parser/binder/checker + typeEvaluator), `importResolver`. `Program.markFilesDirty()` → `_markFileDirtyRecursive` over `importedBy` ("This will retrigger analysis of these other files"), then `_createNewEvaluator()` to drop stale caches; `checkOnlyOpenFiles` limits checking; `setFileOpened/Closed` drive it without LSP. **[V]** But `pyright-internal` is not published; basedpyright says the npm package "is only really intended for internal use." **[V]** Memory ≈1.7 GB on Django; full check pandas 144 s / numpy 70.9 s. **[V]** Import resolution + binding alone is much cheaper than checking **[I]**. Practical routes: (1) headless `basedpyright-langserver --stdio` and issue `textDocument/definition` per call site (many round-trips; ~ms each once warm **[I]**); (2) vendor the fork as scip-python did. Pyrefly (Meta, Rust) reports sub-10 ms rechecks and is the likely 2027 candidate. **[V]**

**(c) tree-sitter-only heuristics.** Aider links `def`/`ref` tags **by identifier name only** (`defines[tag.name]`, `references[tag.name]`), damping `_`-prefixed names ×0.1, names with >5 definers ×0.1, `sqrt(num_refs)`, then PageRank — it never claims resolution, only ranking. **[V]** Sourcegraph search-based navigation admits false positives/negatives "more often for tokens with common names (such as Get)". **[V]** No tool publishes an unresolved-call rate; the acceptable rate is whatever the consumer tolerates, which is why we must measure ours (§6d). **[I]**

**(d) stack-graphs / tree-sitter-graph.** `github/stack-graphs` archived 2025-09-09, read-only, "no longer supported or updated by GitHub"; last releases 2024-12-13 (stack-graphs 0.14.1, tsg-typescript 0.4.0, tsg-python 0.3.0); MIT/Apache-2.0. `tree-sitter/tree-sitter-graph` not archived but last push 2024-12-11 (crate 0.12.0). **[V]** The paper's core property — "for each source file, we create an isolated subgraph without any knowledge of ... any other file", resolution = path search over partial paths — is exactly our SYMBOL-indirection idea. **[V]** Fit: conceptually yes, practically no (Rust, dead upstream, open Python module-resolution bugs #430).

## 4. Prior art on incremental cross-file resolution

- **Kythe:** compilation-unit granularity; cache by compilation digest; "no way to avoid the possibility of a complete re-index for a given change"; caching saves 1/3–1/2; ~40k C++ files in 25 min with 500 workers. Not file-incremental. **[V]**
- **CodeQL:** overlay analysis (all languages since 2025-09; CLI ≥2.23.8) re-extracts only files whose git OIDs changed against an overlay-base DB; dependent handling is not documented. **[V]** Diff-informed alerts filter to changed lines. Extraction is per-file; cross-file resolution is redone at query time by the evaluator. **[I]**
- **Glean:** stacked DBs; facts owned by "units" (files); ownership propagates across the stack; "incremental derivation on the stacked DB ... isn't implemented yet." **[V]**
- **Joern:** whole-project import; no incremental CPG in core (hashes only "to determine whether code has already been analyzed"); Plume (research) regenerated per-method subtrees. jssrc2cpg leans on the TS compiler for types with a type-recovery pass. **[V]**
- **Pyre/Flow/Pyrefly:** Pyre tracks exported types per module; on save it rechecks A, and only if A's exports changed rechecks importers transitively. Flow's paper calls these "signature flow constraints": a file is not rechecked if none of its dependencies' signatures changed — "order-of-magnitude differences in recheck times." Pyrefly: sub-10 ms. **[V]**
- **TypeScript BuilderState:** `computeDtsSignature` hashes the emitted `.d.ts`; `referencedMap` is bidirectional; `updateShapeSignature` → `getFilesAffectedByUpdatedShape`; files that "augment global scope" (non-module files, `declare global`) invalidate everything. **[V]**

Conclusion: only the type-checker family (TS Builder, Pyre/Flow/Pyrefly, Pyright's dirty cascade) is file-incremental, and all of them gate the cascade on an *exported-interface signature*. That is the design to copy.

## 5. What an interface hash must include

Sound rule: hash the **fully-resolved export surface** of a file — the set of (exported name, kind, normalized signature/shape, *target symbol identity for re-exports*) — not the source text. Inputs and pitfalls:

**TypeScript**
- Every `export` binding: name, kind (value/type/namespace/class-both), and a normalized signature (params + types + return; class members with visibility; enum members; type alias RHS; interface members). Prefer the emitted-`.d.ts`-text hash (the BuilderState trick) once the TS-compiler resolver exists; adapter-native hashes the tree-sitter export declarations' text minus bodies/comments.
- **Type-only exports** (`export type`, `import type`) still affect dependents' *resolution* (they name symbols), so include them; tag them so `CALLS` cascades can skip type-only edges. **[I]**
- **Re-exports** `export { a as b } from './x'` and **`export *`** / **barrel files:** hash must include the *resolved* target fqn of each re-export; for `export *` include the exporting module's own interface hash (transitive), otherwise a change in `x.ts` never reaches `index.ts` consumers. `export * as ns` is a namespace descriptor.
- **Default exports:** SCIP names them `default.`; renaming the local binding must not change the hash but changing the exported entity must.
- **Declaration merging** (interface + namespace + class with the same name; function + namespace): merge before hashing, one entry per name.
- **Ambient / global files:** any file with no import/export, `declare global`, `declare module 'x'`, or triple-slash refs is global-scope: its hash change invalidates all files (BuilderState does exactly this). Include `tsconfig` `paths`/`baseUrl`/`moduleResolution` and `package.json` `exports`/`main`/`types` in a *workspace* hash, since they alter every resolution. **[I]**
- CommonJS `module.exports = {...}` / `exports.foo =` in `.js/.cjs` count as exports.

**Python**
- Module-level bindings not starting with `_` (defs, classes, assignments, imports — imports are re-exports in Python), plus `__all__` when present (which *overrides* the underscore rule and makes `from m import *` consumers depend on it). Hash the resolved target for `from x import y` and for `from x import *` include x's hash transitively (same barrel problem as `__init__.py`).
- Decorators change the callable's effective signature (`@property`, `@staticmethod`, `@classmethod`, `@overload`, `@dataclass`); include decorator names in the signature. **[I]**
- Class bodies: methods, nested classes, class attributes, and `self.x = ...` assignments in `__init__` (instance attributes are part of the class surface); `__slots__`; base classes (MRO changes alter attribute resolution).
- **Dynamic attribute assignment** (`setattr`, `globals()[...] =`, `module.attr = ...` from another file) cannot be hashed soundly; mark such modules "dynamic" so their consumers use name-only fallback and are always re-resolved when the module changes. **[I]**
- Conditional/try-except imports and `if TYPE_CHECKING:` blocks: include both branches.
- Stubs (`.pyi`) shadow `.py` for resolution; hash the stub when present. Package layout files (`pyproject.toml`, `setup.cfg` package dirs, `__init__.py` existence, namespace packages) belong in the workspace hash.

Rule of thumb: when in doubt, over-include — a false "changed" costs a bounded re-resolve of importers; a false "unchanged" leaves stale `CALLS` edges.

## Recommendation for cpg-me-daddy

**(a) Resolver interface.** Make the seam *per-file, batch-of-references in, symbol-candidates out*, with the resolver owning nothing about the graph:

```ts
// Shared vocabulary (SCIP-compatible)
export type Descriptor =
  | { kind: 'namespace'; name: string }   // 'src/`users.ts`/' or 'acme/users/'
  | { kind: 'type'; name: string }        // 'UserService#'
  | { kind: 'term'; name: string }        // 'count.'
  | { kind: 'method'; name: string; disambiguator?: string } // 'findById().'
  | { kind: 'typeParameter'; name: string } | { kind: 'parameter'; name: string }
  | { kind: 'meta'; name: string } | { kind: 'macro'; name: string };

export interface SymbolId {
  scheme: string;            // 'cpg-ts' | 'cpg-py' | 'scip-typescript' | ...
  manager: string;           // 'npm' | 'python' | '.'
  pkg: string; version: string;   // '.' when unknown (SCIP placeholder)
  descriptors: Descriptor[];
  fqn: string;               // canonical descriptor string WITHOUT scheme/pkg prefix
}                            // → SYMBOL.fqn; scheme/pkg/version live as SYMBOL props

export interface RefSite {   // produced by the tree-sitter adapter
  id: string; file: string; range: Range;
  kind: 'call' | 'new' | 'import' | 'read' | 'write' | 'typeRef' | 'inherit' | 'decorator';
  nameParts: string[];       // ['svc','findById'] for svc.findById(...)
  scopePath: string[];       // enclosing defs, for local-scope lookup
  arity?: number;
}

export interface Resolution {
  ref: string;               // RefSite.id
  candidates: Array<{ symbol: SymbolId; confidence: number; roles: number /* SCIP SymbolRole bitset */ }>;
  status: 'resolved' | 'ambiguous' | 'external' | 'unresolved' | 'dynamic';
  reason?: string;           // 'no-import' | 'receiver-unknown' | 'dynamic-import' | ...
}

export interface FileInterface { file: string; exports: ExportEntry[]; hash: string; globalScope: boolean; }

export interface Resolver {
  readonly id: string; readonly precision: 'syntactic' | 'checker' | 'index';
  open(ws: WorkspaceSnapshot): Promise<void>;                  // tsconfig/pyproject, roots
  fileChanged(file: string, text: string | null): Promise<void>; // null = deleted
  defineSymbols(file: string, defs: DefSite[]): Promise<SymbolId[]>;   // stable fqns for DEFINES
  exportsOf(file: string): Promise<FileInterface>;               // interface hash input
  resolve(file: string, refs: RefSite[]): Promise<Resolution[]>; // batch, one file
  dependentsOf?(file: string): Promise<string[]>;                // optional: checker-backed
  close(): Promise<void>;
}
```
The engine composes resolvers: `ChainResolver([tsChecker?, adapterNative])` picks the highest-precision `resolved`, else falls through; every `Resolution` records `resolver.id` on the `CALLS` edge (`resolvedBy`, `confidence`). A SCIP-backed resolver implements the same interface by loading an index into a map keyed by `(file, range)` and answering `resolve` from occurrences; its `fileChanged` marks the file stale (answers degrade to `unresolved` until the next batch run).

**(b) SCIP symbol strings.** Adopt the descriptor grammar and escaping verbatim as `SYMBOL.fqn` (`src/`users.ts`/UserService#findById().`; Python `acme/users/UserService#find_by_id().`), plus `scheme/manager/pkg/version` as properties. Reasons: 1:1 mapping to a SCIP index, stable across resolvers (the prefix differs: `scip-typescript npm` vs our `cpg-ts`), and readable Cypher (`WHERE s.fqn ENDS WITH '#findById().'`). Keep `local N` symbols out of the graph (file-local `LOCAL` nodes instead).

**(c) Adapter-native rules to implement first.**
TS: (1) parse `tsconfig.json` (`extends`, `baseUrl`, `paths`, `rootDirs`, `moduleResolution`), (2) relative + `paths` + Node resolution (`index.*`, extension probing `.ts/.tsx/.d.ts/.js/.mjs/.cjs`, `package.json` `exports`/`types`/`main`), (3) import binding table per file incl. `import type`, namespace imports, default, CJS `require`, (4) re-export following (`export {} from`, `export *`) with cycle guard, (5) intra-file scoping (block scopes, class members, `this.x` → own class), (6) receiver typing for `new X()` locals, constructor-assigned fields, and parameters with explicit type annotations; everything else → `unresolved:receiver-unknown`.
Python: (1) package roots from `pyproject.toml`/`src` layout/`__init__.py`, sys.path-like roots from config, (2) absolute + relative import resolution incl. namespace packages and `.pyi` preference, (3) `from m import *` via `__all__`/underscore rule, (4) `__init__.py` re-export following, (5) class attribute tables (methods, `self.x` in `__init__`, bases with MRO over resolved bases), (6) receiver typing from annotations, `x = ClassName(...)`, `isinstance` guards; decorators recorded on the def.

**(d) Measuring unresolved rate.** Every `Resolution` status is persisted on the edge (or a `:UNRESOLVED` node), so `MATCH (c:CALL) RETURN c.status, count(*)` gives the rate per file/package/reason. Build a golden corpus: run scip-typescript/scip-python once on 3–5 OSS repos (e.g. one Nest/Express service, one React app, one Django/FastAPI service), convert occurrences to `(file, range) → symbol`, and compute precision/recall of adapter-native against it per `RefSite.kind`. Target for v1: ≥90 % of `call` sites resolved with ≥95 % precision on statically-typed TS; report Python separately. Track the metric in CI so resolver changes are regression-tested.

**(e) Upgrade path.** The **TS compiler API in-process** is the likelier fit for the 2 s budget: persistent `Program` with `oldProgram` reuse, `getSymbolAtLocation` on only the edited file's call sites, dependents gated by the interface hash. scip-typescript is whole-project (minutes) and pinned to TS 4.x; use it only as the golden oracle and for cold-start precision on CI. For Python, the near-term precise path is headless basedpyright over LSP (definition requests for unresolved call sites only), with Pyrefly as the watch item.

**Spikes**
1. **TS Program reuse cost:** on a ~50k-LOC repo, measure `createProgram(oldProgram)` + resolving all call sites of one edited file, for (i) body-only edit, (ii) import-list edit, (iii) new file. Pass if p95 < 500 ms after warm-up.
2. **Interface hash soundness:** implement `exportsOf` for TS via tree-sitter and diff against `computeDtsSignature`-style `.d.ts` emit hashes over 200 commits of a real repo; count false-unchanged.
3. **Golden oracle:** scip-typescript + scip-python → JSONL of occurrences; harness computing unresolved/precision per `RefSite.kind`.
4. **Headless basedpyright:** startup time, RSS, and latency of 100 `textDocument/definition` requests on a 30k-LOC Django app.
5. **Barrel cascade bound:** measure how many files an `export *` chain invalidates with and without the transitive hash rule on a large monorepo.

## Sources (accessed 2026-09-11)

- SCIP repo (new home): https://github.com/scip-code/scip · releases API: https://api.github.com/repos/scip-code/scip/releases · scip.proto: https://raw.githubusercontent.com/scip-code/scip/main/scip.proto · CLI docs: https://github.com/sourcegraph/scip/blob/main/docs/CLI.md
- "The future of SCIP" (2026-03-25): https://sourcegraph.com/blog/the-future-of-scip (403 on fetch; content via https://news.ycombinator.com/item?id=47544238 and https://scip-code.org/) · Sourcegraph changelog 2026-07-06: https://sourcegraph.com/changelog/2026-07-06
- scip-typescript: https://github.com/sourcegraph/scip-typescript · ScipSymbol.ts, ProjectIndexer.ts, main.ts (raw.githubusercontent.com/sourcegraph/scip-typescript/main/src/…) · snapshot: …/snapshots/output/syntax/src/class.ts · releases API: https://api.github.com/repos/sourcegraph/scip-typescript/releases · npm: https://registry.npmjs.org/@sourcegraph%2Fscip-typescript · announcement: https://sourcegraph.com/blog/announcing-scip-typescript · perf issue: https://github.com/sourcegraph/scip-typescript/issues/175
- scip-python: https://github.com/sourcegraph/scip-python · LICENSE.txt, pyright-last-sync (branch `scip`) · snapshot: …/packages/pyright-scip/snapshots/output/class_nohint/class_nohint.py · npm: https://registry.npmjs.org/@sourcegraph%2Fscip-python · commits API (sha=scip) · pyright commit b5134c5e: https://api.github.com/repos/microsoft/pyright/commits/b5134c5e32f05b5d27b22629b8086c0cd7cd44ec
- TypeScript: Performance wiki https://github.com/microsoft/TypeScript/wiki/Performance · Language Service API wiki https://github.com/microsoft/TypeScript/wiki/Using-the-Language-Service-API · builderState.ts (v5.6.2) https://raw.githubusercontent.com/microsoft/TypeScript/v5.6.2/src/compiler/builderState.ts · program reuse PR https://github.com/microsoft/TypeScript/pull/3616 · issue #60311 https://github.com/microsoft/TypeScript/issues/60311 · issue #5192 https://github.com/microsoft/TypeScript/issues/5192
- Pyright: program.ts https://github.com/microsoft/pyright/blob/main/packages/pyright-internal/src/analyzer/program.ts · internals https://docs.basedpyright.com/dev/development/internals/ · basedpyright https://github.com/DetachHead/basedpyright · benchmarks https://pyrefly.org/blog/speed-and-memory-comparison/ , https://dev.to/romdevin/comparing-python-type-checkers-speed-and-memory-benchmarks-to-identify-the-most-efficient-tool-26db · Pyrefly 18× https://pyrefly.org/blog/2026/02/06/performance-improvements/ · Pyre incremental https://pyre-check.org/docs/getting-started/ · Flow paper https://arxiv.org/pdf/1708.08021
- stack-graphs: https://github.com/github/stack-graphs · repo API https://api.github.com/repos/github/stack-graphs · releases https://github.com/github/stack-graphs/releases · issue #430 https://github.com/github/stack-graphs/issues/430 · paper https://arxiv.org/abs/2211.01224 · tree-sitter-graph https://github.com/tree-sitter/tree-sitter-graph , https://docs.rs/tree-sitter-graph
- Aider repo map: https://aider.chat/docs/repomap.html · https://aider.chat/2023/10/22/repomap.html · repomap.py https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py · Sourcegraph search-based nav https://sourcegraph.com/docs/code-navigation/search-based-code-navigation
- Kythe incremental thread: https://groups.google.com/d/topic/kythe/RVwJZGB_tHU · CodeQL overlay: https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-the-command-line/incremental-analysis , https://github.blog/changelog/2025-09-23-incremental-security-analysis-with-codeql-is-now-available-for-all-languages/ · Glean incrementality: https://glean.software/docs/implementation/incrementality/ · Joern: https://docs.joern.io/frontends/javascript/ , https://cpg.joern.io/ , Plume https://plume-oss.github.io/plume-docs/
