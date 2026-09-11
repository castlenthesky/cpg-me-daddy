# Project outline & alignment — 2026-09-11

Planning session for the **greenfield rewrite** of `cpg-me-daddy`. Captures the product vision as
stated, the constraints agreed in Q&A, what the survey of the existing code found, and the design
rules the rewrite will follow. The database-selection research and benchmark that came out of this
session live in `../2026-09-11.database-research/`.

## Vision (as stated)

A VS Code extension that captures a codebase as a **Code Property Graph** (AST + CFG + PDG layers)
at monorepo scale, **updates the graph incrementally on every file save** with low latency, exposes
it to **AI agents over MCP** so they can understand and drive code edits, and later supports
**whole-graph analytics** (PageRank, centrality, modularity, community detection). Most existing
tools re-index the whole codebase and handle incremental updates badly; this one must not.

## Alignment Q&A (answers given 2026-09-11)

| Question | Answer | Consequence |
| --- | --- | --- |
| Is Cypher a hard requirement? | **Yes** — users and LLM agents write Cypher directly | Rules out SQLite / DuckDB / CozoDB / SurrealDB as the primary store |
| Who reads the graph, from where? | Extension **starts a server or connects to an existing one**; extension writes; a separate-process **AI agent reads via MCP tools** | Server topology → rules out single-owner in-process engines (LadybugDB) as primary unless the extension hosts MCP itself |
| Platforms? | **macOS + Linux now, Windows eventually** | FalkorDB Lite's bundled binaries (Linux x64, macOS arm64) are acceptable today; Windows via Docker/WSL until native builds exist |
| Relationship to cpg-me-daddy? | **Greenfield rewrite**; existing code is reference only | DB choice is free; the existing `IGraphStore` seam and pipeline shape are worth copying, the storage code is not |

## What the survey of the existing code found

The current implementation's failures are **usage** flaws, not engine flaws (`src/services/storage/FalkorDBStore.ts`, `src/services/storage/cypher/queries.ts`, 263 lines total):

- No index on `id`, `filename`, or `path` — the keys every lookup and every per-file delete use.
- One string-interpolated, unparameterized Cypher statement per node and per edge; `BATCH_SIZE=50` via `Promise.all` is concurrency, not batching.
- Node IDs are `path:TYPE:row:col` (`UastBuilder.ts:61`) — inserting one line changes every ID below it.
- `tree.edit()` is never called, so tree-sitter's incremental reparse isn't incremental.
- `DETACH DELETE` of a file's subgraph destroys inbound cross-file edges; repaired by a one-hop loop that re-parses dependents from disk.
- `MATCH (n) RETURN n` over the whole graph on every save (webview refresh).
- Four uncoordinated sync mechanisms (watcher, 5 s bootstrap timer, 60 s reconciler, full refresh) → two documented total-data-loss bugs (`.claude/journal/2026-04-03-*`, `2026-04-04-*`).
- Every identifier and literal is a node with a `SOURCE_FILE` edge to the FILE supernode.
- Zero analytics implemented, planned, or available via a library.
- Test fixtures are ~875 LOC total; nothing was ever exercised at scale.

## Design rules for the rewrite

These are database-independent, but they are what makes an incremental CPG work on *any* engine.

1. **Stable, content-derived IDs** — `${fileHash}:${kind}:${scopePath}:${ordinal}`, never positions. Every CPG node carries its kind label **plus a shared `:CPG` label** with indexes on `CPG.id` and `CPG.file`.
2. **SYMBOL indirection (SCIP model)** — `(:CALL)-[:CALLS]->(:SYMBOL {fqn})<-[:DEFINES]-(:METHOD)`. SYMBOL nodes are not `:CPG` and have no `file`, so a per-file delete cannot touch them; cross-file edges survive a replace by construction. Never create bare-name SYMBOLs for unresolved dynamic calls (store `resolved:false` + `calleeName` on the CALL). GC symbols per save, bounded to touched fqns. `UNIQUE SYMBOL.fqn` constraint as a tripwire.
3. **Two-tier schema** — *structural* tier by default (FILE, NAMESPACE_BLOCK, TYPE_DECL, METHOD, PARAM, METHOD_RETURN, MEMBER, LOCAL, BLOCK, CONTROL_STRUCTURE, RETURN, CALL, SYMBOL; args/receiver/literals folded into CALL properties; REACHING_DEF from LOCAL/PARAM to CALL/RETURN). *Expression* tier (IDENTIFIER, LITERAL, FIELD_IDENTIFIER, REF, full REACHING_DEF) is opt-in. ~450 vs ~3,000 nodes per 300-line file. Drop `SOURCE_FILE`/`CONTAINS` edges — `file` is a property.
4. **Joern-style DiffGraph per save** → parameterized `UNWIND $rows` per label / per edge type, endpoints via indexed `MATCH (s:CPG {id})`. Readers use `GRAPH.RO_QUERY`.
5. **Replace strategy — one atomic Cypher query per save** (delete → nodes → edges → SYMBOL merge → DEFINES/CALLS → GC, chained with `WITH count(*)` barriers). The benchmark showed this works on FalkorDB 4.20, verifies, and is ~3× faster under reader load than a 23-query sequence (24 vs 68 ms p50 at 10⁶ nodes). Fallback: multi-query "empty window" bracketed by FILE-level `status`/`version` markers. Generation tags were rejected (duplicate METHODs per fqn visible to readers; single-property indexes degrade `(id, gen)` lookups; 2× peak memory).
6. **Analytics on projections**, not the raw CPG — call graph, import graph, type graph are 10³–10⁵ nodes. In-engine `algo.*` for PageRank/betweenness/WCC; `graphology-communities-louvain` (pure JS, MIT) for Louvain/modularity over an exported projection.
7. **The CPG is a cache** — fully rebuildable from source; per-file content hash for staleness; durability is soft.
8. **Server lifecycle behind a `ServerManager` interface** — `Spawned` / `Remote` / `Docker` implementations; pin the engine version.
9. **Client over RESP**, not Bolt (Bolt is off by default, experimental, and drops `RO_QUERY`/`EXPLAIN`/`PROFILE`/`MEMORY USAGE`).

## Database decision (summary — full record in `../2026-09-11.database-research/`)

**Keep FalkorDB as the primary store**, redesigned per the rules above. With Cypher mandatory and a
separate-process MCP reader, the realistic field was FalkorDB vs Memgraph (BSL, Docker-only on macOS)
vs Neo4j (GPL/JVM), with **LadybugDB** (in-process Kùzu fork, MIT, single-owner) as the fallback.
Kùzu is archived (Apple acquisition), CozoDB is dead, CortexDB isn't a graph DB, DuckDB/SQLite fail
the Cypher requirement.

**Fallback trigger:** if FalkorDB misses the structural-tier benchmark thresholds after tuning
(replace p95 ≤ 150 ms at 10⁶ nodes; reader p95 ≤ 150 ms under writes; no unbounded memory growth
under churn), or the empty-window semantics prove unacceptable to the MCP consumer.

## Spike deliverables

- `ast-demo/bench/` — FalkorDB incremental-replace benchmark harness (TypeScript, pinned `falkordb/falkordb:v4.20.4` on port 6380).
- `ast-demo/docs/research/graph-db-selection.md` — decision record with results (copied into `../2026-09-11.database-research/`).

## Follow-ons (not in this spike)

- Full rewrite architecture: watcher → debounce → tree-sitter incremental parse (`tree.edit`) → per-file DiffGraph → single replace → projection refresh.
- Own a thin FalkorDB spawner over release binaries rather than depending on `falkordblite` (9★, v0.3.0).
- Windows: connect-to-existing / Docker until FalkorDB ships native builds.
- SSPL review for a FOSS repo that spawns (not redistributes) FalkorDB binaries.
