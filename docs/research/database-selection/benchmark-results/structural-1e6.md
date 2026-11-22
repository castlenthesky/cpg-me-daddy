# FalkorDB incremental-replace benchmark — structural @ 995,520 nodes

Started 2026-09-11T20:21:44.941Z, finished 2026-09-11T20:23:59.988Z. Server 8.6.3 at 127.0.0.1:6380.
Config: batch=1000 pipeline=true deleteArm=D3 iter=200 churn=2000×10 readers=4

## Seed
2584 files × ~387 nodes = 995,520 nodes, 3,053,288 edges in 49 s (20499 nodes/s). RSS 1306 MB, graph 584 MB.

## Delete arms (ms per file delete, 5 samples each)
| arm | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| D3 | 5 | 3.1 | 3.6 | 3.6 | 3.6 |
| D4 | 5 | 4.1 | 4.3 | 4.3 | 4.3 |
| D1 | 5 | 40.3 | 41.5 | 41.5 | 41.5 |

## Replace cycle (D3, emptyWindow) — ms
| phase | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| total_wall | 200 | 68.4 | 111.9 | 138.6 | 149.7 |
| total_server | 200 | 60.7 | 101.9 | 128.7 | 141.0 |
| status_updating | 200 | 9.7 | 16.0 | 16.5 | 19.0 |
| delete | 200 | 5.4 | 20.4 | 21.5 | 24.0 |
| nodes | 200 | 15.5 | 41.1 | 50.4 | 56.6 |
| edges | 200 | 17.4 | 35.5 | 43.5 | 57.0 |
| symbols | 200 | 3.7 | 20.3 | 33.1 | 34.1 |
| gc | 200 | 2.7 | 30.7 | 40.0 | 41.7 |
| status_ready | 200 | 1.2 | 15.9 | 16.8 | 17.6 |

All per-cycle invariants held.

## Readers — writer idle (4 workers, 10 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 17410 | 0.4 | 1.0 | 1.5 | 8.8 | 1740.1 |
| callers | 13769 | 0.7 | 2.1 | 2.5 | 11.3 | 1376.2 |
| ast3 | 5054 | 0.4 | 1.0 | 1.4 | 11.1 | 505.1 |
| callgraph | 2002 | 1.0 | 1.6 | 2.0 | 3.4 | 200.1 |
| pathological | 839 | 16.4 | 18.2 | 19.3 | 22.9 | 83.9 |

## Readers — during replace cycles (4 workers, 18 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 14561 | 0.5 | 4.8 | 16.3 | 45.3 | 807.6 |
| callers | 11478 | 0.9 | 14.3 | 18.5 | 47.1 | 636.6 |
| ast3 | 4228 | 0.5 | 4.5 | 16.3 | 40.5 | 234.5 |
| callgraph | 1683 | 1.4 | 14.4 | 17.6 | 39.8 | 93.3 |
| pathological | 718 | 17.2 | 30.5 | 47.1 | 58.2 | 39.8 |

## Exploratory: single-query atomic replace (1 query, incl. GC) — ms
| condition | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| readers active | 50 | 24.2 | 43.6 | 49.2 | 49.2 |
| writer alone | 5 | 14.8 | 15.7 | 15.7 | 15.7 |

MULTI/EXEC probe: works — exec returned 2 replies; 2 probe nodes created

## Churn (2000 cycles on 10 files)
| cycles | p50 ms | p95 ms | RSS MB | graph MB |
|---|---|---|---|---|
| 100 | 19.8 | 40.5 | 1187 | 587 |
| 200 | 20.0 | 39.6 | 1186 | 587 |
| 300 | 19.9 | 40.0 | 1181 | 587 |
| 400 | 20.5 | 41.0 | 1133 | 588 |
| 500 | 21.2 | 40.9 | 1139 | 588 |
| 600 | 20.8 | 40.8 | 1172 | 588 |
| 700 | 21.2 | 41.5 | 1145 | 588 |
| 800 | 21.6 | 41.2 | 1161 | 588 |
| 900 | 21.8 | 41.8 | 1139 | 588 |
| 1000 | 22.4 | 42.8 | 1121 | 588 |
| 1100 | 22.4 | 41.7 | 1107 | 588 |
| 1200 | 22.6 | 43.0 | 1089 | 589 |
| 1300 | 21.5 | 43.0 | 1090 | 588 |
| 1400 | 21.2 | 40.0 | 1076 | 588 |
| 1500 | 21.4 | 41.3 | 1092 | 588 |
| 1600 | 21.7 | 41.2 | 1088 | 588 |
| 1700 | 21.6 | 42.9 | 1082 | 588 |
| 1800 | 22.2 | 40.9 | 1092 | 588 |
| 1900 | 22.6 | 42.2 | 1083 | 588 |
| 2000 | 22.0 | 42.1 | 1103 | 589 |

## Global invariants at end
OK — no duplicate fqns, no orphan SYMBOLs, all FILEs ready.
Final RSS 1123 MB, graph 589 MB.

## Notes
- modules: [["name","vectorset","ver",1,"path","","args",[]],["name","graph","ver",42004,"path","/var/lib/falkordb/bin/falkordb.so","args",["TIMEOUT_DEFAULT","30000","TIMEOUT_MAX","60000","CACHE_SIZE","200","NODE_CREATION_BUFFER","65536"]]]
- index used — delete D3: true, edge insert: true, point read: true
- hub-caller files (calls to src/pkg0/mod0.ts::m0): 0:17, 2148:14, 927:12, 297:11, 664:11

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