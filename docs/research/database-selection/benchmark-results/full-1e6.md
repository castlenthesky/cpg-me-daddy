# FalkorDB incremental-replace benchmark — full @ 996,729 nodes

Started 2026-09-11T20:16:54.147Z, finished 2026-09-11T20:21:44.453Z. Server 8.6.3 at 127.0.0.1:6380.
Config: batch=1000 pipeline=true deleteArm=D3 iter=200 churn=2000×10 readers=4

## Seed
335 files × ~2987 nodes = 996,729 nodes, 3,039,203 edges in 21 s (48127 nodes/s). RSS 1310 MB, graph 540 MB.

## Delete arms (ms per file delete, 5 samples each)
| arm | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| D3 | 5 | 17.7 | 37.0 | 37.0 | 37.0 |
| D4 | 5 | 34.7 | 44.0 | 44.0 | 44.0 |
| D1 | 5 | 56.5 | 67.9 | 67.9 | 67.9 |

## Replace cycle (D3, emptyWindow) — ms
| phase | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| total_wall | 200 | 116.0 | 155.6 | 198.2 | 198.9 |
| total_server | 200 | 100.8 | 140.9 | 179.0 | 181.4 |
| status_updating | 200 | 1.4 | 3.1 | 4.8 | 6.0 |
| delete | 200 | 21.9 | 26.1 | 29.2 | 104.9 |
| nodes | 200 | 25.2 | 38.7 | 44.0 | 52.5 |
| edges | 200 | 41.4 | 54.2 | 76.4 | 84.4 |
| symbols | 200 | 3.7 | 6.5 | 8.7 | 9.4 |
| gc | 200 | 27.2 | 40.1 | 75.3 | 98.6 |
| status_ready | 200 | 1.2 | 3.4 | 4.0 | 4.2 |

All per-cycle invariants held.

## Readers — writer idle (4 workers, 10 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 25018 | 0.4 | 1.1 | 1.5 | 9.9 | 2501.3 |
| callers | 19665 | 0.6 | 1.3 | 1.7 | 10.1 | 1966.1 |
| ast3 | 7248 | 0.4 | 1.1 | 1.5 | 7.2 | 724.7 |
| callgraph | 2811 | 2.1 | 2.7 | 3.2 | 4.5 | 281.0 |
| pathological | 1195 | 2.9 | 3.8 | 4.5 | 10.5 | 119.5 |

## Readers — during replace cycles (4 workers, 36 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 54079 | 0.5 | 1.9 | 4.1 | 108.0 | 1506.8 |
| callers | 42060 | 0.8 | 2.6 | 7.9 | 108.7 | 1171.9 |
| ast3 | 15724 | 0.5 | 2.1 | 12.8 | 89.6 | 438.1 |
| callgraph | 5999 | 2.3 | 8.4 | 17.7 | 108.4 | 167.1 |
| pathological | 2516 | 3.5 | 9.4 | 20.9 | 105.0 | 70.1 |

## Exploratory: single-query atomic replace (1 query, incl. GC) — ms
| condition | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| readers active | 50 | 87.2 | 122.4 | 136.6 | 136.6 |
| writer alone | 5 | 97.9 | 111.3 | 111.3 | 111.3 |

MULTI/EXEC probe: works — exec returned 2 replies; 2 probe nodes created

## Churn (2000 cycles on 10 files)
| cycles | p50 ms | p95 ms | RSS MB | graph MB |
|---|---|---|---|---|
| 100 | 95.7 | 140.2 | 1453 | 546 |
| 200 | 99.2 | 137.0 | 1286 | 547 |
| 300 | 99.6 | 150.2 | 1281 | 544 |
| 400 | 98.9 | 130.7 | 1342 | 546 |
| 500 | 100.2 | 130.9 | 1347 | 546 |
| 600 | 102.0 | 132.5 | 1373 | 547 |
| 700 | 96.6 | 142.3 | 1327 | 544 |
| 800 | 99.0 | 132.8 | 1319 | 546 |
| 900 | 100.0 | 145.6 | 1286 | 547 |
| 1000 | 103.9 | 133.1 | 1255 | 547 |
| 1100 | 99.9 | 135.0 | 1307 | 544 |
| 1200 | 97.7 | 132.8 | 1344 | 546 |
| 1300 | 100.4 | 126.7 | 1327 | 548 |
| 1400 | 103.3 | 134.5 | 1327 | 549 |
| 1500 | 99.7 | 134.0 | 1299 | 544 |
| 1600 | 98.5 | 136.2 | 1312 | 546 |
| 1700 | 100.4 | 129.0 | 1327 | 547 |
| 1800 | 103.0 | 133.5 | 1318 | 548 |
| 1900 | 103.4 | 139.6 | 1315 | 545 |
| 2000 | 98.2 | 134.4 | 1330 | 546 |

## Global invariants at end
OK — no duplicate fqns, no orphan SYMBOLs, all FILEs ready.
Final RSS 1327 MB, graph 546 MB.

## Notes
- modules: [["name","vectorset","ver",1,"path","","args",[]],["name","graph","ver",42004,"path","/var/lib/falkordb/bin/falkordb.so","args",["TIMEOUT_DEFAULT","30000","TIMEOUT_MAX","60000","CACHE_SIZE","200","NODE_CREATION_BUFFER","65536"]]]
- index used — delete D3: true, edge insert: true, point read: true
- hub-caller files (calls to src/pkg0/mod0.ts::m0): 0:15, 36:13, 41:10, 51:10, 218:10

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