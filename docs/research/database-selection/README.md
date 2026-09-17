# Database research — 2026-09-11

Research spike answering: *is FalkorDB a reasonable database for the incremental-CPG rewrite, and
what must the design do differently?* Companion to `../2026-09-11.project-outline/`.

- `graph-db-selection.md` — the decision record: constraints, candidate survey (FalkorDB, LadybugDB/Kùzu, Memgraph, Neo4j, CozoDB, SurrealDB, CortexDB, DuckDB+DuckPGQ, SQLite, local JSON), design rules, decision, benchmark results, risks, sources.
- `benchmark-results/` — raw reports from the harness (`ast-demo/bench/`), FalkorDB 4.20.4 in Docker on Apple silicon:
  - `structural-1e5.md`, `structural-1e6.md` (+ `.json`) — structural tier (~387 nodes/file)
  - `full-1.8e5.md`, `full-1e6.md` (+ `.json`) — full tier incl. IDENTIFIER/LITERAL nodes (~2,987 nodes/file)

## Decision in one paragraph

**Keep FalkorDB**, redesigned: stable content-derived IDs on a shared `:CPG` label indexed on `id`/`file`;
cross-file edges through persistent `SYMBOL` nodes (SCIP model); structural-first two-tier schema; **one
atomic Cypher query per file save**; analytics on projections. At 10⁶ nodes with 4 reader threads active,
a structural file replace is **68 ms p50 / 112 ms p95** as 23 queries and **24 ms p50** as one atomic
query; full-tier 116 / 156 ms; indexed delete flat at ~3 ms from 10⁵→10⁶; readers' p95 ≤ 15 ms during
writes; 2,000-cycle churn shows no latency or memory drift; every cycle verified. LadybugDB (in-process,
MIT Kùzu fork) remains the fallback; its trigger was not hit.

## Reproduce

```sh
cd ~/projects/demos/ast-demo/bench && npm install && npm run up
PROFILE=structural TOTAL_NODES=1000000 READERS=4 npm run bench
PROFILE=full       TOTAL_NODES=1000000 READERS=4 npm run bench
```
