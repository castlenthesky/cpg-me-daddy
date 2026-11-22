# Decision record: graph database for an incremental Code Property Graph

**Date:** 2026-09-11 · **Status:** Accepted (benchmark-backed) · **Owner:** Brian Henson
**Scope:** database choice for the greenfield rewrite of `cpg-me-daddy`

## 1. Context

`cpg-me-daddy` is a VS Code extension that builds a Joern-style Code Property Graph (AST + CFG +
PDG) from tree-sitter parses, updates it on every file save, and exposes it to AI agents over MCP.
Whole-graph analytics (PageRank, centrality, community detection, modularity) are a later goal.
The current implementation is being rewritten from scratch; this record revisits the database
choice before that rewrite commits.

### Hard constraints

| Constraint | Source |
|---|---|
| **Cypher is a hard requirement** — users and LLM agents write Cypher directly | alignment Q&A |
| **Topology:** extension starts a graph server *or* connects to an existing one; extension writes; a **separate-process AI agent reads via MCP** | alignment Q&A |
| **Platforms:** macOS + Linux now, Windows eventually | alignment Q&A |
| Ease of setup matters; bundling ideal but negotiable | vision |
| **Incremental:** on save, replace one file's subgraph (hundreds–thousands of nodes) well under a second, keep cross-file edges consistent, at 10⁵–10⁶ total nodes | vision |
| Later: PageRank / centrality / community detection / modularity | vision |

### What the survey of the existing implementation found

The current DB layer is 263 lines (`src/services/storage/FalkorDBStore.ts`, `src/services/storage/cypher/queries.ts`). Every flaw is a *usage* flaw that would cripple any engine:

- No index on `id`, `filename`, or `path` — the keys every lookup and per-file delete use.
- One string-interpolated, unparameterized Cypher statement per node and per edge (`BATCH_SIZE=50` via `Promise.all` is concurrency, not batching). Planner cache never hits.
- Node IDs are `path:TYPE:row:col` — inserting one line changes every ID below it.
- `tree.edit()` never called → tree-sitter incremental parse is not incremental.
- `DETACH DELETE` of a file's subgraph destroys inbound cross-file edges; repaired by a one-hop loop that re-parses dependents from disk.
- `MATCH (n) RETURN n` over the whole graph on every save.
- Four uncoordinated sync mechanisms → two documented total-data-loss bugs.
- Every identifier/literal is a node with a `SOURCE_FILE` edge to the FILE supernode.
- Zero analytics; fixtures ≈ 875 LOC; never exercised at scale.

**FalkorDB was used badly, not chosen badly.** That reframes the question from "which database" to "which database *and which schema/write discipline*".

## 2. Candidates (status verified 2026-09-11)

| Candidate | Cypher | Separate-process readers | Mac+Linux bundling | Algorithms | License | Maintenance risk | Verdict |
|---|---|---|---|---|---|---|---|
| **FalkorDB** 4.20 | openCypher subset | ✅ Redis server; official MCP server exists | `falkordblite` npm spawns bundled redis-server: Linux x64 + macOS arm64 ✅; macOS x64 manual; Windows = Docker/WSL | `algo.pageRank`, `betweenness`, `WCC`, `labelPropagation`, BFS, SPpaths/SSpaths, MSF (verified via `dbms.procedures()`); **no Louvain** | SSPL v1 (clients MIT) | Engine low (6k★, daily commits, Rust rewrite); `falkordblite-ts` **high** (9★, v0.3.0, 5 months old) | **Primary** |
| **LadybugDB** 0.20.4 (Kùzu fork) | Cypher | ❌ one `READ_WRITE` process per DB dir; no separate reader processes | ✅ true in-process npm (`@ladybugdb/core`, published 2026-09-10) | PageRank, Louvain, WCC in-process on projected graphs | MIT | Medium: pre-1.0, 11 months old; upstream archived | **Fallback** |
| Memgraph | full Cypher (Bolt) | ✅ server | ❌ Docker-only on macOS/Windows; whole graph in RAM | 40+ MAGE incl. Louvain | BSL 1.1 | low | "connect to existing" target only |
| Kùzu 0.11.3 | Cypher | — | — | — | MIT | **Archived 2025-10-10; Kùzu Inc. acquired by Apple** | out |
| CortexDB | ❌ SPARQL subset + "two-hop" ops | gRPC clients | Go only | none | MIT | single author; v2.100.0 with releases every 1–3 days | out |
| DuckDB + DuckPGQ | ❌ SQL/PGQ; only `ANY SHORTEST` paths | single writer | ✅ | pagerank, WCC | MIT | DuckPGQ is a CWI research project | out for the hot path (OLAP: deleted rows reclaimed only when ≥25 % of *adjacent* row groups are deleted → scattered per-file deletes bloat) |
| SQLite (WAL) | ❌ recursive CTEs | ✅ across processes | ✅✅ | none (export) | public domain | lowest | out (Cypher requirement) — otherwise the best write path |
| Neo4j | Cypher | ✅ | ❌ GPL-viral when embedded + JVM | GDS (4-core cap) | GPLv3 / commercial | — | out |
| CozoDB | Datalog | ✅ | ✅ | PageRank, communities | MPL-2.0 | **no commits since 2024-12** | out |
| SurrealDB | ❌ SurrealQL link traversal | in-process | ✅ | none | BSL 1.1 | SurrealKV beta | out |
| Local JSON | ❌ | — | — | — | — | — | not a store; a per-file content-hashed shard cache is a valid component |

No reference CPG tool ships incremental per-file updates today: Joern builds whole CPGs (flatgraph,
in-memory), CodeQL says "delete and recreate the database" (GitHub Next has a research project on
incrementalization), FalkorDB's own `code-graph` has an open issue for it. SCIP (Sourcegraph) is the
one design that is incremental per file — because cross-file references go through **stable symbol
strings**, not database IDs.

## 3. Design rules that matter more than the engine

1. **Stable IDs** — `${fileHash}:${kind}:${scopePath}:${ordinal}`, never positions. Every CPG node carries its kind label **plus a shared `:CPG` label**, indexed on `CPG.id` and `CPG.file`. One indexed query deletes a file regardless of kind; edge inserts do two index lookups per edge with no label scan.
2. **SYMBOL indirection (SCIP model)** — `(:CALL)-[:CALLS]->(:SYMBOL {fqn})<-[:DEFINES]-(:METHOD)`. SYMBOL nodes are not `:CPG` and have no `file`, so a per-file delete cannot touch them; cross-file edges survive by construction and the repair loop disappears. Rules: key by `fqn` (signature on the edge); never create bare-name SYMBOLs for unresolved dynamic calls (`resolved:false` + `calleeName` on the CALL — avoids 10⁴-degree hubs poisoning PageRank); GC per save bounded to touched fqns; `UNIQUE SYMBOL.fqn` constraint as tripwire.
3. **Two-tier schema** — *structural* tier default (FILE, NAMESPACE_BLOCK, TYPE_DECL, METHOD, PARAM, METHOD_RETURN, MEMBER, LOCAL, BLOCK, CONTROL_STRUCTURE, RETURN, CALL, SYMBOL; args/receiver/literals folded into CALL properties). *Expression* tier (IDENTIFIER, LITERAL, FIELD_IDENTIFIER, REF, full REACHING_DEF) opt-in. ≈ 390 vs ≈ 3,000 nodes per 300-line file. Drop `SOURCE_FILE`/`CONTAINS` edges — `file` is a property.
4. **DiffGraph per save** (Joern's pattern) → parameterized `UNWIND $rows` per label / per edge type. Readers use `GRAPH.RO_QUERY`.
5. **Replace strategy — one atomic Cypher query per save** (delete → nodes → edges → SYMBOL merge → DEFINES/CALLS → GC, chained with `WITH count(*)` cardinality barriers). The benchmark (§5.2) showed it works on FalkorDB 4.20, verifies, and is ~3× faster under reader load than the multi-query path. Fallback: the multi-query "empty window" bracketed by FILE-level `status`/`version` markers. Generation tags rejected (duplicate METHODs per fqn visible to readers; single-property indexes degrade `(id, gen)` lookups; 2× peak memory).
6. **Analytics on projections** (call graph, import graph, type graph — 10³–10⁵ nodes), not the raw CPG. In-engine `algo.*` for PageRank/betweenness/WCC; `graphology-communities-louvain` (pure JS, MIT) for Louvain/modularity over an exported projection.
7. **The CPG is a cache** — rebuildable from source; per-file content hash for staleness; durability soft (RDB off is fine).
8. **Client over RESP** (`falkordb` npm 6.8), not Bolt (off by default, experimental, loses `RO_QUERY`/`EXPLAIN`/`PROFILE`/`MEMORY USAGE`).
9. **Server lifecycle behind `ServerManager`** — `Spawned` (falkordblite today; own a thin spawner over release binaries later), `Remote`, `Docker`. Pin the module version.

## 4. Decision

**Keep FalkorDB as the primary store, with the schema and write path in §3.**

With Cypher mandatory and a separate-process MCP reader, the field is three servers (FalkorDB,
Memgraph, Neo4j) plus one in-process engine that would force the extension to host MCP itself
(LadybugDB). FalkorDB alone has a Mac+Linux spawn story today, an MIT client, an existing MCP
server, and in-engine PageRank/betweenness/WCC. SSPL is compatible with a local tool that is not
FalkorDB-as-a-service; binaries are downloaded at first run, not redistributed.

**Fallback → LadybugDB in an extension-owned sidecar (Cypher + MCP)** if FalkorDB misses the
structural-tier thresholds below after tuning, or if the empty-window semantics prove unacceptable
to the MCP consumer. Ladybug's win is true multi-statement ACID + MIT; its costs are owning DB
lifecycle/RPC, rigid typed node tables for a ~37-label sparse schema, and pre-1.0 fork risk.

### Thresholds (10⁶ nodes, Docker-on-macOS)

| Metric | Full | Structural |
|---|---|---|
| Replace cycle p50 / p95 / p99 | ≤ 250 / 500 / 800 ms | ≤ 80 / 150 / 300 ms |
| Reader p95 (point + callers) during writes | ≤ 300 ms | ≤ 150 ms |
| Delete latency growth 10⁵ → 10⁶ | ≤ 1.5× | ≤ 1.5× |
| Churn drift over 2,000 cycles (after cycle 200) | p50 +≤ 20 %, memory +≤ 10 % | same |
| Graph memory | ≤ 4 GB | ≤ 2 GB |

## 5. Benchmark results

_Harness: `bench/` (see its README). Server: `falkordb/falkordb:v4.20.4` in Docker Desktop on an
Apple-silicon Mac (8 GB / 18 CPU allocated), `TIMEOUT_DEFAULT 30000 CACHE_SIZE 200
NODE_CREATION_BUFFER 65536`, RDB off. Client: `falkordb` 6.8.0 on Node 20, batch 1000, queries of a
phase auto-pipelined. Every measured cycle is verified (counts, inbound cross-file edges unchanged,
no orphan SYMBOLs, FILE marker `ready`)._

### 5.1 Replace cycle — the hot path (ms, 4 reader threads active, 200 measured cycles each)

| Profile @ nodes | files × nodes/file | p50 | p95 | p99 | max | threshold p50/p95/p99 | verdict |
|---|---|---|---|---|---|---|---|
| structural @ 99,794 | 259 × 387 | 26.7 | 32.3 | 34.6 | 39.4 | — | — |
| **structural @ 995,520** | 2,584 × 387 | **68.4** | **111.9** | **138.6** | 149.7 | 80 / 150 / 300 | **pass** |
| full @ 178,526 | 60 × 2,987 | 91.7 | 115.0 | 137.9 | — | — | — |
| **full @ 996,729** | 335 × 2,987 | **116.0** | **155.6** | **198.2** | 198.9 | 250 / 500 / 800 | **pass** |

Per-phase at structural @ 10⁶ (p50): status marker 9.7 · delete 5.4 · nodes 15.5 · edges 17.4 · symbols 3.7 · GC 2.7 · status marker 1.2. The cycle is 23 queries; under reader load each query pays a lock wait, which is why the 10⁵→10⁶ growth (27→68 ms) is mostly per-query overhead rather than data volume. The same cycles with the writer alone (churn phase) run at **~21 ms** (structural) / **~100 ms** (full).

### 5.2 Single-query atomic replace — the better strategy

The entire replace (delete → nodes → edges → SYMBOL merge → DEFINES/CALLS → GC) as one Cypher query chained with `WITH count(*)` barriers **works on FalkorDB 4.20** (later clauses see nodes created earlier in the same query via the index), **verified every cycle**, and is atomic because one query is one transaction:

| Profile @ 10⁶ | condition | n | p50 | p95 | p99 |
|---|---|---|---|---|---|
| structural | 4 readers active | 50 | **24.2** | 43.6 | 49.2 |
| structural | writer alone | 5 | 14.8 | 15.7 | 15.7 |
| full | 4 readers active | 50 | **87.2** | 122.4 | 136.6 |
| full | writer alone | 5 | 97.9 | 111.3 | 111.3 |

Under load it is **~3× faster than the 23-query empty-window path** at structural scale (24 vs 68 ms p50) and removes the need for FILE status markers on the read side. **Adopt it as the default replace strategy**; keep the multi-query path as a fallback for a file whose single query would exceed parameter/size limits (no such limit was hit at ~3,000 nodes / ~10,000 edges per query here). Redis `MULTI/EXEC` around `GRAPH.QUERY` also works (probe succeeded) but was not load-tested.

### 5.3 Delete by indexed `file` — flat across scale

| arm | structural 10⁵ | structural 10⁶ | full 10⁶ (3k-node file) |
|---|---|---|---|
| **D3** `MATCH (n:CPG {file:$f}) DELETE n` (production) | 3.5 | **3.1** | 17.7 |
| D4 by id list (`UNWIND $ids`) | 4.4 | 4.1 | 34.7 |
| D1 label-less `MATCH (n {file:$f})` (the old code's shape) | 6.8 | **40.3** | 56.5 |

`EXPLAIN` confirms `Node By Index Scan` for D3, for both endpoints of the edge insert, and for the point read; D1 plans as `All Node Scan` + `Filter`. Growth 10⁵→10⁶ for D3: 0.9× (threshold ≤ 1.5×).

### 5.4 Readers during writes (4 worker threads, ~2–5k queries/s, ms)

| query | structural 10⁶ idle p95 | structural 10⁶ under write p95 / p99 | full 10⁶ under write p95 / p99 | threshold p95 |
|---|---|---|---|---|
| point read by id | 1.0 | 4.8 / 16.3 | 1.9 / 4.1 | 150 / 300 |
| callers of a symbol (2 hops) | 2.0 | 14.3 / 18.5 | 2.6 / 7.9 | 150 / 300 |
| `AST*1..3` from a method | 1.1 | 4.5 / 16.3 | 2.1 / 12.8 | — |
| file-scoped call-graph projection (`LIMIT 1000`) | 1.7 | 14.4 / 17.6 | 8.4 / 17.7 | — |
| pathological unindexed `CALL.name` filter | 17.3 | 30.5 / 47.1 | 9.4 / 20.9 | — |

Writes hold an exclusive per-graph lock, so reader tail latency during a replace is bounded by the longest single write query (~15–50 ms) — visible in the p99 column. Comfortably inside the thresholds.

### 5.5 Churn — tombstones and compaction (2,000 replaces on 10 hot files, writer alone)

| profile @ 10⁶ | p50 @100 → @2000 | p95 @100 → @2000 | RSS @100 → @2000 | graph MB @100 → @2000 |
|---|---|---|---|---|
| structural | 19.8 → 22.0 ms | 40.5 → 42.1 | 1,187 → 1,103 MB | 587 → 589 |
| full | 95.7 → 98.2 ms | 140.2 → 134.4 | 1,453 → 1,330 MB | 546 → 546 |

No latency drift, no memory growth (threshold ≤ +20 % / +10 %). The delete-churn tombstone concern that motivated FalkorDB's 4.14.10 compaction work does not show up at this scale on 4.20.4.

### 5.6 Capacity and seed

| profile @ 10⁶ | edges | seed time | seed rate | RSS after seed | graph memory | threshold |
|---|---|---|---|---|---|---|
| structural | 3.05 M | 49 s | 20.5 k nodes/s | 1.3 GB | 584 MB | ≤ 2 GB ✅ |
| full | 3.04 M | 21 s | 48 k nodes/s | 1.3 GB | 540 MB | ≤ 4 GB ✅ |

A cold full re-index of a 10⁶-node workspace is under a minute through the same insert path.

### 5.7 Correctness

Every measured and churn cycle verified: node and intra-file edge counts equal the generated file; DEFINES/CALLS counts equal; **inbound cross-file CALLS into the file's symbols unchanged across the replace** (the property the old `DETACH DELETE` design violated); no orphan SYMBOLs among touched fqns; FILE marker `ready`. Global at end of every run: no duplicate `SYMBOL.fqn`, no orphan SYMBOLs. Zero failures in ~9,000 verified cycles across the four runs.

### 5.8 Verdict

**Go.** FalkorDB 4.20.4 meets every threshold at 10⁶ nodes for both profiles, with the structural tier leaving 2–3× headroom and the single-query atomic replace adding another ~3× under load. The LadybugDB fallback trigger was not hit.

Threats to validity, honestly: the graph is synthetic (calibrated to the old implementation's label/edge histograms, Zipf-distributed cross-file calls, but random tree shapes); it ran on Docker Desktop on Apple silicon, not a native Linux sidecar; the reader load is a saturating 4-thread loop, which is harsher than an MCP agent but also uniform; per-file replace is the worst case — real saves change a few lines and 95 % of ids stay stable, so a method-granular diff would only improve on these numbers.

## 6. Consequences and risks

- **`falkordblite-ts` maturity.** 9★, v0.3.0. Mitigation: `ServerManager` seam; plan to own a thin spawner over FalkorDB release binaries; `Remote`/`Docker` modes are first-class from day one.
- **Windows.** No native FalkorDB build verified. Mitigation: connect-to-existing / Docker / WSL until upstream ships one; revisit when the Rust rewrite lands.
- **SSPL.** Fine for a local tool that does not offer FalkorDB as a service. Review before the FOSS repo publishes a marketplace listing that *downloads* the binaries.
- **No Louvain in-engine.** `algo.labelPropagation` is the in-engine community option; Louvain/modularity run in `graphology` over an exported projection (10³–10⁵ nodes — cheap).
- **No multi-statement transactions.** Solved by the single-query replace (§5.2), which is atomic by construction; the multi-query empty-window path needs FILE status markers. MULTI/EXEC around `GRAPH.QUERY` works (probe) but was not load-tested.
- **Query-pattern sensitivity.** Two planner traps surfaced during the spike and belong in the rewrite's query review checklist: a two-node pattern under `UNWIND` planned as a label scan until a `WITH` barrier forced the index (700 ms → 1 ms), and `OPTIONAL MATCH … count(r)` for "has no inbound edges" is O(degree) on hub symbols where `WHERE NOT (s)<-[]-()` is an existence check (36 ms → 2.7 ms). Always `GRAPH.EXPLAIN` new query shapes.
- **openCypher subset.** Coverage gaps exist (see FalkorDB's Cypher support page); the LLM-facing MCP layer should document them.

## 7. Open questions

- Real-code calibration: run the prior UAST/CFG/PDG builders over `cpg-me-daddy/test/fixtures/code_examples/python/src/` to replace the synthetic label/edge histograms and add a replay mode.
- Native Linux (non-Docker) numbers, and a macOS x64 machine.
- Whether `rustworkx` has landed Louvain (only matters if a Python analytics sidecar is ever wanted).
- FalkorDB native Windows status.

## Sources

FalkorDB: [repo](https://github.com/FalkorDB/FalkorDB) · [license](https://github.com/FalkorDB/FalkorDB/blob/master/LICENSE.txt) · [algorithms](https://docs.falkordb.com/algorithms/) · [v4.14.10 delete compaction](https://www.falkordb.com/news-updates/falkordb-v4-14-10-memory-optimization-compact-storage/) · [falkordblite-ts](https://github.com/FalkorDB/falkordblite-ts) · [Rust rewrite](https://www.falkordb.com/blog/rewriting-falkordb-in-rust/) · [Bolt support](https://docs.falkordb.com/integration/bolt-support.html) · [code-graph incremental issue](https://github.com/FalkorDB/code-graph/issues/614)
Kùzu / LadybugDB: [kuzu archived](https://github.com/kuzudb/kuzu) · [The Register](https://www.theregister.com/software/2025/10/14/kuzudb-graph-database-abandoned-community-mulls-options/1142229) · [9to5Mac on the Apple acquisition](https://9to5mac.com/2026/02/11/kuzu-database-company-joins-apples-list-of-recent-acquisitions/) · [LadybugDB](https://github.com/LadybugDB/ladybug) · [concurrency model](https://docs.ladybugdb.com/concurrency/) · [algo extension](https://docs.ladybugdb.com/extensions/algo/) · [write-path changes](https://blog.ladybugdb.com/post/ladybug-flying-solo/)
Others: [CortexDB](https://github.com/liliang-cn/cortexdb) · [DuckPGQ](https://github.com/cwida/duckpgq-extension) · [DuckDB CHECKPOINT semantics](https://duckdb.org/docs/1.3/sql/statements/checkpoint.html) · [DuckDB concurrency](https://duckdb.org/2024/10/30/analytics-optimized-concurrent-transactions) · [Memgraph](https://github.com/memgraph/memgraph) · [MAGE](https://docs.memgraph.com/mage/) · [Neo4j embedded licensing](https://neo4j.com/open-core-and-neo4j/) · [CozoDB](https://github.com/cozodb/cozo) · [SurrealDB node](https://github.com/surrealdb/surrealdb.node) · [graphology Louvain](https://graphology.github.io/standard-library/communities-louvain.html)
CPG prior art: [Joern flatgraph](https://flatgraph.joern.io/) · [CPG spec](https://cpg.joern.io/) · [Incremental CodeQL](https://githubnext.com/projects/incremental-codeql/) · [SCIP](https://sourcegraph.com/blog/announcing-scip)
