# FalkorDB incremental-replace benchmark — structural @ 99,794 nodes

Started 2026-09-11T20:07:30.174Z, finished 2026-09-11T20:08:41.149Z. Server 8.6.3 at 127.0.0.1:6380.
Config: batch=1000 pipeline=true deleteArm=D3 iter=200 churn=2000×10 readers=4

## Seed
259 files × ~387 nodes = 99,794 nodes, 305,970 edges in 3 s (35821 nodes/s). RSS 334 MB, graph 60 MB.

## Delete arms (ms per file delete, 5 samples each)
| arm | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| D3 | 5 | 3.5 | 3.5 | 3.5 | 3.5 |
| D4 | 5 | 4.4 | 5.4 | 5.4 | 5.4 |
| D1 | 5 | 6.8 | 6.8 | 6.8 | 6.8 |

## Replace cycle (D3, emptyWindow) — ms
| phase | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| total_wall | 200 | 26.7 | 32.3 | 34.6 | 39.4 |
| total_server | 200 | 19.8 | 25.0 | 27.4 | 30.7 |
| status_updating | 200 | 0.7 | 1.8 | 2.3 | 2.4 |
| delete | 200 | 5.1 | 6.1 | 6.9 | 7.1 |
| nodes | 200 | 5.7 | 8.2 | 10.1 | 10.9 |
| edges | 200 | 5.8 | 7.9 | 8.7 | 10.1 |
| symbols | 200 | 2.6 | 4.5 | 5.1 | 5.6 |
| gc | 200 | 4.8 | 10.1 | 11.4 | 13.4 |
| status_ready | 200 | 0.7 | 1.8 | 2.0 | 2.2 |

All per-cycle invariants held.

## Readers — writer idle (4 workers, 10 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 28827 | 0.4 | 1.0 | 1.4 | 3.2 | 2882.4 |
| callers | 22707 | 0.6 | 1.2 | 1.7 | 4.1 | 2270.5 |
| ast3 | 8396 | 0.4 | 1.0 | 1.4 | 3.3 | 839.5 |
| callgraph | 3247 | 1.0 | 1.7 | 2.1 | 3.0 | 324.7 |
| pathological | 1356 | 1.9 | 2.6 | 3.0 | 4.4 | 135.6 |

## Readers — during replace cycles (4 workers, 7 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 15188 | 0.4 | 1.5 | 4.1 | 6.0 | 2041.4 |
| callers | 11942 | 0.7 | 2.0 | 4.6 | 6.7 | 1605.1 |
| ast3 | 4391 | 0.5 | 1.7 | 4.3 | 6.8 | 590.2 |
| callgraph | 1752 | 1.2 | 2.8 | 5.3 | 6.8 | 235.5 |
| pathological | 742 | 2.2 | 5.2 | 6.2 | 8.8 | 99.7 |

## Exploratory: single-query atomic replace
| strategy | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| singleQueryAtomic (1 query, incl. GC) | 5 | 16.6 | 19.7 | 19.7 | 19.7 |

MULTI/EXEC probe: works — exec returned 2 replies; 2 probe nodes created

## Churn (2000 cycles on 10 files)
| cycles | p50 ms | p95 ms | RSS MB | graph MB |
|---|---|---|---|---|
| 100 | 21.6 | 27.2 | 407 | 62 |
| 200 | 22.4 | 26.8 | 407 | 63 |
| 300 | 22.3 | 27.0 | 422 | 63 |
| 400 | 22.2 | 26.4 | 428 | 63 |
| 500 | 22.0 | 27.9 | 426 | 62 |
| 600 | 21.7 | 26.4 | 431 | 62 |
| 700 | 21.8 | 26.5 | 453 | 62 |
| 800 | 22.2 | 26.4 | 447 | 62 |
| 900 | 22.3 | 27.3 | 450 | 62 |
| 1000 | 22.8 | 28.8 | 451 | 63 |
| 1100 | 23.0 | 27.2 | 458 | 63 |
| 1200 | 22.4 | 26.1 | 453 | 63 |
| 1300 | 23.0 | 26.8 | 448 | 63 |
| 1400 | 23.3 | 26.9 | 439 | 63 |
| 1500 | 22.9 | 26.7 | 451 | 63 |
| 1600 | 23.2 | 27.3 | 442 | 63 |
| 1700 | 23.3 | 28.6 | 436 | 63 |
| 1800 | 23.1 | 27.8 | 425 | 63 |
| 1900 | 23.5 | 27.6 | 435 | 64 |
| 2000 | 23.5 | 27.1 | 429 | 64 |

## Global invariants at end
OK — no duplicate fqns, no orphan SYMBOLs, all FILEs ready.
Final RSS 429 MB, graph 64 MB.

## Notes
- modules: [["name","vectorset","ver",1,"path","","args",[]],["name","graph","ver",42004,"path","/var/lib/falkordb/bin/falkordb.so","args",["TIMEOUT_DEFAULT","30000","TIMEOUT_MAX","60000","CACHE_SIZE","200","NODE_CREATION_BUFFER","65536"]]]
- index used — delete D3: true, edge insert: true, point read: true
- hub-caller files (calls to src/pkg0/mod0.ts::m0): 0:18, 137:12, 29:11, 36:11, 86:11

## EXPLAIN
<details><summary>delete D3</summary>

```
Delete
    Node By Index Scan | (n:CPG)
```
</details>
<details><summary>delete D1</summary>

```
Delete
    Filter
        All Node Scan | (n)
```
</details>
<details><summary>edge insert AST</summary>

```
Create
    Apply
        Unwind
        Cartesian Product
            Node By Index Scan | (s:CPG)
                Argument
            Node By Index Scan | (t:CPG)
                Argument
```
</details>
<details><summary>reader point</summary>

```
Results
    Project
        Node By Index Scan | (n:CPG)
```
</details>
<details><summary>reader callers</summary>

```
Results
    Limit
        Project
            Conditional Traverse | (s:SYMBOL)->(m:METHOD)
                Conditional Traverse | (s)->(c:CALL)
                    Node By Index Scan | (s:SYMBOL)
```
</details>
<details><summary>reader callgraph</summary>

```
Results
    Limit
        Project
            Conditional Traverse | (c)->(b:METHOD)
                Conditional Variable Length Traverse | (a)-[@anon_0:AST*1..4]->(c)
                    Conditional Traverse | (a:METHOD)->(a:METHOD)
                        Node By Index Scan | (a:CPG)
```
</details>
<details><summary>verify inbound</summary>

```
Results
    Aggregate
        Filter
            Conditional Traverse | (s)->(c:CALL)
                Project
                    Node By Index Scan | (s:SYMBOL)
                        Unwind
```
</details>