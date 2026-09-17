# 09 — Glossary

Terms as used throughout `docs/outline/`. Where a term names a thing in code, the package is given.

**AbsolutePath** — a native-separator filesystem path. Exists in exactly two adapters, `FilesystemProbe` and `SourceOpener`. Never in the graph, an id, a delta, or the store. See *WorkspacePath*.

**adapter (language adapter)** — `LanguageAdapter` in `@cpg/extract`: answers "what does this syntax node mean" one node at a time (`classify(node, container)`), never how to assemble a graph. One per grammar; `javascript` deliberately has none.

**apps/** — the front doors: `cli`, `inspector`, `vscode`, later `mcp`. Each owns exactly one composition root and may import its own host SDK and nothing else's. Contrast *packages/*.

**archive coordinate** — `archive/<lineage>-20260916:<path>`, read with `git show`. The five tags are listed in `10-lessons.yaml`. Four archived files contain NUL bytes and need `grep -a`.

**atomic replace / one statement per file** — the store's write shape: a file's whole subgraph is deleted and recreated in ONE Cypher statement (`UNWIND $rows`). Measured ~6× faster than the same work as 16 statements and 51× faster than 900; also the only way a torn write cannot lose a file's subgraph. CI asserts `statementCount === 1`.

**cascade** — re-resolution of files that depend on a changed file. Bounded by *interface hash* gating (ND-9); over-budget dependents are marked `stale` with `stale_reason` and drained in the background. Absent until U7; every earlier cascade number is a counterfactual.

**check (verify check)** — one of six machine assertions `cpg verify` runs: `filesystem-reconciliation`, `identity-invariants`, `id-uniqueness`, `render-reconciliation`, `revision-reconciliation`, `resolution-health`. Each has one of four states: `pass`, `fail`, `stale`, `unavailable`.

**composition root** — the code that decides which implementations are wired together (`createEngine()` and its callers). Exactly one per front door, always in `apps/*`, never in `packages/**` (except that `@cpg/engine` may know more than one sibling). A composition root trapped in the editor is how the previous attempt needed a 442-line duplicate harness (L-28).

**confirmedSeq / renderedSeq** — the highest `seq` confirmed by every durable sink / every ephemeral sink. The watcher's known state advances only to `confirmedSeq`. Both are reported so the picture leg and the store leg of the freshness clock are separately measurable.

**consumer** — anything that receives deltas from the producer: MemoryStore (always on), the browser inspector, FalkorStore, the VS Code panel, the MCP server. Every consumer except MemoryStore is optional and switchable (P-A).

**contract / seam** — a boundary between two stages with declared types, invariants, a list of things an implementation may not do, and a parameterised conformance suite every implementation runs. Nine of them: C-MODEL, C-WATCH, C-PARSE, C-EXTRACT, C-RESOLVE, C-SINK, C-STORE, C-CLI, C-EXT (`05-contracts.yaml`).

**CPG (code property graph)** — a property graph merging a program's syntax tree, control-flow graph and program dependence graph at statement nodes. v1 of this product is the *structural tier* of one: declarations, calls, imports, and sparse `REACHING_DEF`. It is aligned to Joern's vocabulary but is not a Joern-class CPG (`01-vision.md` §4–5).

**cross-seam defect (CS-nn)** — a defect that existed only when two contracts were composed, none inside either. Twelve were found; all are transcribed with fixes in `05-contracts.yaml`.

**delta / envelope** — `GraphDelta { seq, file, revision_id, producer, addedNodes, addedEdges, removedNodeIds }`. Removing a node removes its incident edges; edges are never enumerated for removal. An all-empty delta is unrepresentable; an edge-only delta is first-class (every cross-file edge arrives that way).

**durable / ephemeral sink** — a sink's declared durability. Durable (MemoryStore, FalkorStore, JsonlSink): a permanent failure does not advance `confirmedSeq`; repair is replay. Ephemeral (WebviewSink): a missed delta costs a stale picture; repair is one resync snapshot.

**EVAL_TYPE** — the reserved edge `CALL → SYMBOL {relation: receiver-type}` for receiver-typed calls (59.3% of achievable call edges). Reserved with `producer: none-yet`; admitted at U8 when the headless resolver reaches ≥ 95% of the language-server ceiling.

**FalkorDB** — the Redis-module property-graph database queried with Cypher; the durable store consumer from U5. Pinned image `falkordb/falkordb:v4.20.4`. Dev instance `cpg-dev` on 127.0.0.1:6382; test harness `cpg-test` on 6381 (refused by the store opener).

**file-owned / identity / overlay / filesystem / graph-singleton** — the five ownership classes of the schema, each with its write mechanism (`04-schema.yaml → ownership_classes`). The per-file replace may only delete file-owned rows.

**freshness clock (T0–T3)** — T0 the filesystem changed; T1 the watcher delivered the event (~74 ms later on macOS); T2 the debounce settled (100 ms trailing, 500 ms ceiling); T3 the change is visible in every enabled consumer. The promise is T0→T3 < 2 s per enabled consumer set (DQ-05). The three intervals are always separately reportable.

**gate** — what decides a unit is done: `cpg verify` exiting 0 plus the unit's named tests, AND a human-visible artifact. A gate is defined by what runs it; a gate nobody runs is a suggestion (L-31).

**golden** — a checked-in expected output diffed by a test. Guards regressions; never the human audit surface (L-23). `resolvedBy` and `confidence` are excluded from goldens so one golden set serves every host.

**human clock** — see *freshness clock*. Contrast the *pipeline clock* T2→T3, which is the only interval engineering can move and the one the debate first (wrongly) proposed to promise.

**id (node id)** — `path:kind:qualifiedScopePath[:ordinal|:bodyHash]`. Never contains a content hash or a position. CALL ordinals are parent-scope-relative so inserting a line above changes nothing.

**interface hash** — sha256 of a file's normalized exported-declaration surface, emitted by extraction. Unchanged ⇒ zero cascade. The mechanism every file-incremental type checker uses.

**liveness check** — what the picture is. It proves something is flowing; it cannot detect a dropped directory, an orphaned symbol, a duplicated cluster, or a stale subgraph (`06-measurements.yaml → legibility`).

**merge table** — the 20-cell (existing × incoming) table in `@cpg/watch` that says how two change events for one path combine within a debounce window. `created × changed → created`; deletes are absorbing. Exactly one table exists in the system.

**owner-discriminated merge** — how `applyGraphDelta` handles a re-added node id: fields owned by the delta's producer tier (filesystem or code) are replaced, the other tier's fields are preserved. Neither concatenation nor whole-node replacement. Two producers describing one FILE cannot destroy each other's data (L-01).

**packages/** — core: host-free, portable, runs under plain `node`, no composition roots. `model`, `watch`, `parse`, `extract`, `resolve`, `sink`, `store`, `engine`.

**producer** — the one graph pipeline (WATCH→PARSE→EXTRACT→RESOLVE→SINK→STORE). It always runs. The host may supply consumers and configuration; it may never supply producer input.

**purity proof** — the runtime check that the whole engine under plain `node` loads zero `vscode` (or DOM or MCP SDK) modules, installed as a `Module._load` trap before any import, with an anti-vacuity run that plants a violation and asserts the trap fires. Complements the static check-deps gate.

**REAL / PASSTHROUGH / SEAT** — labels on every stub: REAL delegates to working code; PASSTHROUGH does the trivial version of its job; SEAT is empty and commented for later. The whole shape lands compiling and labelled before any piece is built for real (L-37).

**RefSite / Resolution** — a reference the extractor could not answer (one per bound name; receiver sites share the CALL's node id) and the resolver's answer (a location, never a symbol; one of five statuses; a closed reason code when open).

**reopening test** — required to rename, remove or change the meaning of anything settled: state the premise that died, cite evidence dated after the decision, state what else breaks, state the cost of keeping versus changing. Comparable costs means keep.

**resolution status** — the five-value enum on `CALLS.status` and `IMPORTS.status` (the same array object): `resolved`, `ambiguous`, `external`, `unresolved`, `dynamic`. Rank ≥ 2 stops a resolver chain; rank ≤ 1 falls through. A chain may raise an answer, never lower it.

**resolver chain** — `ChainResolver` trying links in order. v1 Python: `basedpyright > python-path > null`. A host accelerator (the VS Code definition provider) may be a link only if a headless link in the same chain declares every kind it answers (capability parity).

**revision_id** — sha256 of a file's raw bytes, minted once by WATCH, carried on every `:CPG` node and on FILE. Answers "is this node derived from the current bytes of its file?" Not ordered. Never in an id. Never on an edge (F-4).

**seq** — monotonic per-workspace counter on the delta envelope, allocated by SINK. Answers "did I receive deltas in order and miss none?" Never stored on a node. With `revision_id`, one of exactly two counters in the system (F-1).

**SOURCE_FILE** — the edge `MODULE → FILE`, one per file, so the filesystem tier and the code tier form one connected graph. The 15th edge type; re-adopted after an earlier rejection.

**sparse** — one node per thing a developer or agent would name; no nodes for tokens, identifiers or literals. Measured 0.36–0.43 nodes per line against a 1.5 bar. About cardinality, not vocabulary: the graph is sparse *and* strongly typed (L-48).

**START SIMPLE** — the owner's standing instruction: build the minimum thing that proves it works; no generalization before its second concrete caller (L-43).

**structural tier / expression tier** — what v1 emits (declarations, calls, imports, sparse data flow) versus what it does not by default (identifiers, literals, locals; 5.5–5.9× the node count). The expression tier is opt-in behind `tiers.expression`, never default.

**SYMBOL** — the identity node cross-file edges point into, keyed by an SCIP-descriptor `fqn`, with no `file` property, merged on key, never deleted by a per-file replace. The reason saving one file cannot sever another file's edges (L-03, L-38).

**two-pass** — extraction is per file and knows nothing of other files; resolution runs only over a sealed set of extracted files, so results never depend on walk order. Enforced by a branded type (`ExtractedFileSet`).

**unit / milestone** — one of U0–U10; the unit of scheduling. Each has a gate, a human artifact, what it locks in, and what it rolls back to.

**WorkspacePath** — workspace-relative, POSIX separators, no leading `./`. The only path form inside the graph, ids, deltas and the store (DQ-02). Produced from an absolute path by `startsWith` + `slice`, never `String.replace` (L-10).
