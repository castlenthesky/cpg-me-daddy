# 03 — Architecture

This document describes the target architecture as decided; it is a plan, not a description of the tree today. `07-milestones.yaml` says which parts exist at which milestone. As of 2026-10-28 (U0 complete) the tree contains one core package (`packages/model`) and one front door (`apps/vscode`, the extension host).

## 1. Producer and consumers

```
                          ┌──────────────────────────────────────────────────────┐
   filesystem ──events──▶ │  THE PRODUCER (packages/**, host-free, plain node)  │
                          │  WATCH → PARSE → EXTRACT → RESOLVE → SINK → STORE   │
                          └───────────────┬──────────────────────────────────────┘
                                          │ numbered deltas (seq), one per save/batch
              ┌───────────────┬───────────┴───────────┬───────────────┬────────────────┐
              ▼               ▼                       ▼               ▼                ▼
        MemoryStore     apps/inspector          FalkorStore     apps/vscode        apps/mcp
        (always on)     browser picture         (Cypher store)  webview panel      ≤12 tools (U10)
                        --inspect               --store falkor  (extension)        reads the store
```

One producer, always on. Every consumer is switched on by configuration or by the front door that launched the producer (principle P-A). The host that launched it may supply **consumers and configuration**; it may never supply **producer input**. Concretely, the VS Code extension does not feed editor save events, unsaved buffers, or workspace-folder authority into the pipeline. The producer watches the disk, exactly as the CLI does.

## 2. Repository layout (decision DQ-08, option d)

```
packages/                core. host-free, portable, runs under plain node. NO composition roots.
  model/                 the vocabulary: node/edge types, GraphDelta envelope, schema registry, ids, validation   (U0 ✔, U1)
  watch/                 WatchBackend seam, coalesce merge table, debounce, session, seq allocation                (U4)
  parse/                 ParserBackend seam, language registry, grammar loading, tree lifetime                     (U6a)
  extract/               LanguageAdapter seam, two-pass walker, DeltaBuilder, node-id/symbol-id                    (U6a/b)
  resolve/               Resolver seam, ChainResolver, NullResolver, python-path, LSP subprocess driver            (U6c, U8, U9)
  sink/                  GraphSink seam, SinkDelivery driver, MemoryStore                                           (U2a)
  store/                 GraphStore seam, Cypher planner, FalkorStore, bootstrap, falkordb-service                  (U5)
  engine/                the ONLY package that knows more than one sibling: createEngine(), the pipeline wiring    (U2a)

apps/                    front doors. each owns ONE composition root and may import ITS OWN host SDK, nothing else's.
  cli/                   `cpg` binary: argv, config loading, stdout/stderr, exit codes. Imports no host SDK.        (U2a)
  inspector/             the browser picture: static server + webview bundle. May import DOM/WebGL.                 (U2b)
  vscode/                the extension: activation, webview panel, click-to-source. May import `vscode`.            (U0.2 move, U3)
  mcp/                   the MCP stdio server. May import the MCP SDK.                                              (U10)
```

**The two-tier rule** (enforced by `tools/check-deps.mjs`, proven to fail on violation, and by a runtime purity proof from U2):

1. Nothing under `packages/**` may import a host SDK (`vscode`, DOM globals, the MCP SDK) or `node:fs` where the contract forbids it (parse, extract, resolve, sink take no I/O).
2. Each `apps/*` may import only node builtins, `@cpg/*` package front doors (no deep imports), and its own host SDK.
3. Composition roots exist only in `apps/*`. A `createEngine()` call site in `packages/**` is a build failure.
4. No literal NUL byte in any source file (four archived files were invisible to `grep` because of one).

Why this and not a lint exemption: an invariant with an exemption list is how the invariant dies. `packages/` versus `apps/` puts the rank-1 constraint in a form the filesystem enforces and a reviewer cannot accidentally approve away. It also makes the CLI honest: it has a composition root, so it is a front door, not core.

## 3. The pipeline

| stage | package | in | out | contract |
|---|---|---|---|---|
| WATCH | `watch` (+ the walker in `engine` for a cold index) | filesystem events (or a directory walk) | `ChangeBatch { seq, cause, changes[], clock }` with workspace-relative POSIX paths and the file's `revision_id` | C-WATCH |
| PARSE | `parse` | `ParseRequest { key, text, language? }` | `ParseHandle` over a live `SyntaxNode` tree; diagnostics; explicit release | C-PARSE |
| EXTRACT | `extract` | `ExtractRequest { path, grammarId, root, contentDigest, lineCount }` | `ExtractedFile { nodes, symbols, edges, refSites, stats, elementDigest, interface_hash }` per file, zero cross-file knowledge | C-EXTRACT |
| RESOLVE | `resolve` | a sealed `ExtractedFileSet` and per-file `RefSite[]` | `ResolveBatch` per file: one `Resolution` per site, in order, plus diagnostics; `ResolveReport` for the run | C-RESOLVE |
| SINK | `sink` | `Envelope { kind: snapshot|delta, seq, cause, payload|delta, files }` | fan-out to every enabled `GraphSink`; `confirmedSeq` (min over durable sinks), `renderedSeq` (ephemeral sinks) | C-SINK |
| STORE | `store` | `WriteOp { replace-file | filesystem }` built by `toWriteOp(file)` | one atomic statement per file; `WriteReceipt { statementCount, ... }` | C-STORE |
| surfaces | `apps/*` | the store or the delta stream | picture, panel, tools | C-CLI, C-EXT |

Two passes, mandatory and in the types: extraction is per file and knows nothing of other files; resolution runs only over a *sealed* set of extracted files, so a call in the first file walked can target a definition in the last, and results never depend on walk order (lesson L-20, L-44). "Resolve while still walking" does not typecheck.

## 4. Stage ownership of data (decision DQ-03)

This table is the deliverable of DQ-03. It exists because nine contracts once described thirteen responsibilities as "somebody else's job", which is how a 677-line unowned component grew in both prior attempts. Every row is a required signature in `05-contracts.yaml`, not a sentence.

| stage | owns / mints | reads | must not touch |
|---|---|---|---|
| **WATCH** | `path` (WorkspacePath), `size`, `mtime`, change kind, **`revision_id` = sha256 of the raw bytes**, batch `clock` (T1 first event, T2 settled) | the filesystem, the admission predicate shared with the walker | anything graph-shaped; file contents beyond hashing; parsing |
| **PARSE** | the syntax tree, `language`, parse diagnostics, tree lifetime | the text it is handed plus `revision_id` (never the disk) | node identity, graph structure, any graph label |
| **EXTRACT** | declarations, `kind`, `name`, `range`, **node ids**, per-file `SYMBOL` mints, `refSites` (unanswered), `elementDigest`, **`interface_hash`** | the tree | anything cross-file; any resolution; any I/O |
| **RESOLVE** | edge targets, `status`, `reason`, `resolvedBy`, `confidence`; `applyResolutions(set, batches) → edges`; the `ResolveReport` | declarations across files through `DefinitionLookup` | node identity; node properties; minting or renaming a symbol |
| **SINK** | **`seq`** (the one allocator), delivery, retry, `confirmedSeq`, `renderedSeq`, degradation reports | the delta envelope | the delta's contents |
| **STORE** | persistence, ownership-class dispatch, the atomic per-file replace, `toWriteOp(file: ExtractedFile): WriteOp`, `WriteReceipt` | the delta and the schema registry | deriving anything new |
| **engine (composition root in apps/\*)** | wiring; the walker for a cold index; the file bytes read once and handed to PARSE; the enabled consumer set | config | allocating `seq` or `revision_id`; resolving; deciding what is salient |

Two clarifications the table forces:

- **Who reads the file bytes?** WATCH hashes them to mint `revision_id`; the engine reads them once for a cold index or on a live change and hands the text to PARSE. PARSE never opens a path. This closes the "reading the file bytes is nobody's job" hole (CS-2).
- **`AbsolutePath` exists in exactly two adapters:** `FilesystemProbe` (the walker/watcher touching the disk) and `SourceOpener` (the VS Code adapter opening a file). Everywhere else a path is a `WorkspacePath`: relative, POSIX, no leading `./`. The store's scope delete and every node's `file` property therefore agree (CS-1).

## 5. The seams

Every seam is declared by its consumer, has zero dependencies of its own, and is implemented by whichever host holds the real capability, so a fake is free (lesson L-35). Signatures are in `05-contracts.yaml`; this is the map.

| seam | consumer | implementations at v1 | fake |
|---|---|---|---|
| `WatchBackend` | `watch` session | `ParcelWatchBackend` (headless, lazy native import) | `FakeWatchBackend` (~45 lines) |
| `WatchSink` | `watch` session | the engine's projector | any `onBatch` recorder |
| `ParserBackend` | `parse` | `WebTreeSitterBackend` (wasm) | hand-built `SyntaxNode` fakes |
| `LanguageAdapter` | `extract` walker | `python`, `typescript`/`tsx` (javascript deliberately has none) | table-driven fake |
| `Resolver` / `DefinitionLookup` | `resolve` chain | `NullResolver`, `PythonPathResolver`, `BasedpyrightResolver` (U8), `TsServerResolver` (U9); optional host link `VsCodeDefinitionResolver` registered by `apps/vscode`, never primary | `FixtureResolver` (table of positions → definitions, fails on unmatched rows) |
| `GraphSink` | `sink` delivery | `MemoryStore` (durable), `FalkorStore` (durable, U5), `WebviewSink` (ephemeral, U3), `JsonlSink` (durable, test recorder) | `MemoryStore` is the fake |
| `GraphStore` | `store` | `MemoryStore`, `FalkorStore` | `NullGraphStore` (counts, persists nothing; backs `--dry-run`) |
| `ProcessHost` | `resolve` LSP driver | node `child_process` | scripted subprocess |

The `Resolver` seam returns a **location, never a symbol**. That single property is what makes swapping a resolver safe: it can never change a symbol id and therefore can never invalidate an edge another file already points at.

## 6. Identity and freshness, side by side

| | node id | `revision_id` | `seq` |
|---|---|---|---|
| what | `path:kind:qualifiedScopePath[:ordinal|:bodyHash]` | sha256 of the owning file's bytes | monotonic per workspace |
| lives on | every node | every `:CPG` node and FILE | the delta envelope only, never a node |
| must | stay stable across saves so inbound edges survive | change whenever the file changes | increase by one per delivery, no gaps |
| answers | "which thing is this?" | "is this node derived from the current bytes?" | "did I receive deltas in order and miss none?" |
| minted by | EXTRACT | WATCH | SINK |
| never contains | a content hash, a position, a property value | | |

Cross-file edges carry no revision (F-4). An edge A→B is re-evaluated when either endpoint's node is re-derived; blast radius is a resolver/cascade computation (ND-9), not an edge attribute.

## 7. The freshness clock (decision DQ-05)

```
T0  filesystem changed            ─┐ ~74 ms macOS FSEvents (measured, two replicas within 5%; outside our code)
T1  backend delivers the event    ─┤ 100 ms trailing debounce, 500 ms ceiling, declared maxWaitMs (policy, dialable)
T2  batch settles                 ─┤ parse ~5 ms · extract ~8 ms · RESOLVE (the term that matters) · write ~8 ms · read-back ~1 ms
T3  visible in every enabled consumer (renderedSeq for the picture, confirmedSeq for durable stores)
```

The promise is **T0→T3 < 2 s, per enabled consumer set, p95 over the fixture**, and every reported number carries the consumer set that produced it. A headless run does not pay the render leg. The assembled budget for a 1,068-line Python save is about 1,674 ms at p50 with the resolver at 88%; it fits at the median and fails at the tail, which is why the resolver harness (epic E-VERIFY) exists (`06-measurements.yaml → budget`). Bulk-mode bursts (git checkout, install) are explicitly outside the budget in v1.

## 8. Consumers and their switches

| consumer | package | durability | switch | freshness leg |
|---|---|---|---|---|
| memory store | `sink`/`store` | durable | always on | confirmedSeq |
| browser inspector | `apps/inspector` | ephemeral | `cpg … --inspect` or `cpg inspect <input>` | renderedSeq |
| FalkorDB | `store` | durable | `--store falkor` / `cpg.config.yaml: store: falkor` | confirmedSeq (read-back after commit) |
| VS Code panel | `apps/vscode` | ephemeral | launching the extension | renderedSeq |
| MCP | `apps/mcp` | reader of the store | `cpg mcp` | n/a (reads confirmed state) |

`cpg verify`'s `render-reconciliation` check reports `unavailable` when no ephemeral consumer is enabled (ND-8). That is a correct answer under P-A, and `--strict` turns it into a failure for anyone who needs the picture verified.

## 9. Configuration

One file at the workspace root, `cpg.config.yaml`, is the source of truth for what the engine indexes and which consumers run. Manifests (`package.json` workspaces, `pyproject`, `tsconfig` paths) are read for **discovery** only. Precedence: **CLI flags > `CPG_*` environment > `cpg.config.yaml` > manifest discovery > built-in defaults**. Generated state lives in `.cpg/` (gitignored by the engine writing `.cpg/.gitignore`). Only host-level UI preferences live in VS Code settings; anything that changes what is indexed lives in the file so headless and IDE behaviour are identical.

```yaml
version: 1
include: [apps/*, packages/*, services/*]        # default: discovered from manifests, else "."
exclude: ["**/node_modules", "**/dist", "**/__pycache__", "**/.venv"]   # merged with .gitignore
languages: { python: true, typescript: true }
watch: { debounce_ms: 100, ceiling_ms: 500, bulk_threshold_files: 50 }
consumers: { inspect: false, store: memory | falkor, vscode: auto }
store: { falkor: { mode: remote | docker, host: 127.0.0.1, port: 6382, graph: cpg } }
resolve: { per_file_ms: 500, per_site_ms: 250 }
```

The loader ships with `cpg index` at U2c and produces one `CpgConfigInput` object; the engine never reads the environment itself.

## 10. CLI surface (`apps/cli`)

| verb | milestone | does |
|---|---|---|
| `cpg index [dir]` | U2a | cold walk → graph → enabled consumers; `--dry-run` uses `NullGraphStore`; `--json` report |
| `cpg verify [dir]` | U2a | the six checks, four states, `--strict`, `--format=json` (08-verification.md) |
| `cpg inspect <input|->` | U2b | serve the picture from a payload, a JSONL delta stream, or `--live <root>` |
| `cpg schema --print` | U1/U2 | print the registry as data; `schema --check` fails on drift |
| `cpg watch [dir]` | U4 | live; text lines or `--json` NDJSON per event |
| `cpg query "<cypher>"` | U5 | RO_QUERY against the store; rows on stdout, timing on stderr |
| `cpg status` | U10 | engine/consumer/coverage status |
| `cpg mcp` | U10 | stdio MCP server |

Exit codes: `0` ok · `1` operation failed · `2` usage error. `run(argv, io) → Promise<number>`; `main.ts` is a shebang wrapper that sets `process.exitCode` and never calls `process.exit`, so the entire surface is testable in-process. Machine output on stdout, diagnostics on stderr, so `cpg query … --json | jq` works. Usage text is derived from the same flag table that parses, never hand-maintained (a lesson from the archived CLI).

## 11. The VS Code extension (`apps/vscode`)

The extension is `createEngine(config with consumers { vscode: true })` plus adapters: a `WebviewSink` that posts deltas into the panel, a `SourceOpener` that resolves a node id against the host's own merged snapshot and opens the range (`nameRange ?? range`), and optionally a `VsCodeDefinitionResolver` registered as an extra link in the resolver chain behind the same seam (never primary; capability parity with a headless link is enforced by the chain). Zero new engine code; the two-tier rule makes that a build failure rather than a promise. Webview views relocate between primary sidebar, panel and secondary sidebar; an editor-area surface is a separate `WebviewPanel` with a serializer (platform limit, AM-2). The webview announces `ready` last, the host merges every delta locally and posts only the delta, so a hidden-then-shown webview gets a correct snapshot.

## 12. FalkorDB (`store`)

- Modes in v1: **remote** (default dev endpoint 127.0.0.1:6382, a persistent compose instance named `cpg-dev`) and **docker** (run the pinned image on an OS-chosen port). Spawned mode is deferred (ND-2). The integration test harness is a separate compose project on 6381 named `cpg-test`, refused by the store opener as a safety interlock, with a provenance nonce so tests never write into a stranger's database.
- Write shape: **one Cypher statement per file**, `UNWIND $rows`, scope delete `MATCH (n:CPG {file:$file}) DELETE n` (never `DETACH DELETE`, which severs other files' inbound edges), a `WITH s, row` barrier between the two `MATCH`es of every edge query (a measured 700 ms → 1 ms planner trap), MERGE-on-key properties pruned of nulls before `SET`. CI asserts `statementCount === 1`.
- Reads use `GRAPH.RO_QUERY` (write clauses refused server-side; `GRAPH.QUERY` on a missing key silently creates it). `TIMEOUT <ms>` is a trailing command argument; `CYPHER timeout=` is accepted and silently inert. Defaults are 30000/60000 ms, not 1000. A timed-out write rolls back fully but overshoots ~1.7× wall, so client socket timeouts for writes are ≥ 2× `TIMEOUT`. Bootstrap creates only missing indexes (CREATE INDEX is not idempotent), creates `UNIQUE SYMBOL.fqn` with a supporting index, and read-compares `META_DATA.schema_version` (mismatch → rebuild).
- The label registry is sticky: deleting every node of a label leaves it in `db.labels()`; live conformance counts nodes, never trusts the label list. `db.indexes()` returns one merged row per label.

## 13. What is deliberately not in this architecture (v1)

A detached daemon or shim-to-engine IPC (MCP reads the store, ND-1). Spawned FalkorDB (ND-2). A DI container (three composition roots, hand-wired). Parsing unsaved buffers. Any MCP write tool. HTTP transport. Windows native store. Multi-root workspaces (compose N sessions later). Expression-tier nodes, CFG/PDG beyond sparse `REACHING_DEF`, taint. Layout algorithms beyond the seeded radial force layout.
