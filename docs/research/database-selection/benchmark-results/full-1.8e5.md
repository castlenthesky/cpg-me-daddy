# FalkorDB incremental-replace benchmark — full @ 178,526 nodes

Started 2026-09-11T20:13:05.431Z, finished 2026-09-11T20:16:43.174Z. Server 8.6.3 at 127.0.0.1:6380.
Config: batch=1000 pipeline=true deleteArm=D3 iter=200 churn=2000×10 readers=4

## Seed
60 files × ~2987 nodes = 178,526 nodes, 544,359 edges in 3 s (61000 nodes/s). RSS 851 MB, graph 98 MB.

## Delete arms (ms per file delete, 5 samples each)
| arm | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| D3 | 5 | 16.1 | 16.1 | 16.1 | 16.1 |
| D4 | 5 | 22.8 | 24.9 | 24.9 | 24.9 |
| D1 | 5 | 21.4 | 22.3 | 22.3 | 22.3 |

## Replace cycle (D3, emptyWindow) — ms
| phase | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| total_wall | 200 | 91.7 | 115.0 | 137.9 | 153.8 |
| total_server | 200 | 77.2 | 100.9 | 122.8 | 138.3 |
| status_updating | 200 | 0.9 | 2.2 | 3.6 | 5.4 |
| delete | 200 | 19.7 | 22.7 | 24.4 | 26.7 |
| nodes | 200 | 19.0 | 25.2 | 27.6 | 30.0 |
| edges | 200 | 35.1 | 42.5 | 70.7 | 74.0 |
| symbols | 200 | 2.9 | 5.3 | 6.1 | 6.6 |
| gc | 200 | 13.6 | 26.4 | 28.4 | 34.5 |
| status_ready | 200 | 0.8 | 1.9 | 2.3 | 2.9 |

All per-cycle invariants held.

## Readers — writer idle (4 workers, 10 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 27827 | 0.4 | 1.1 | 1.5 | 3.7 | 2781.6 |
| callers | 21941 | 0.5 | 1.2 | 1.6 | 7.0 | 2193.2 |
| ast3 | 8090 | 0.4 | 1.1 | 1.5 | 6.0 | 808.7 |
| callgraph | 3127 | 2.0 | 2.8 | 3.2 | 3.9 | 312.6 |
| pathological | 1319 | 0.8 | 1.5 | 2.0 | 2.3 | 131.8 |

## Readers — during replace cycles (4 workers, 23 s) — ms
| query | n | p50 | p95 | p99 | max | qps |
|---|---|---|---|---|---|---|
| point | 44227 | 0.5 | 1.7 | 3.5 | 19.3 | 1908.4 |
| callers | 34511 | 0.7 | 2.1 | 4.1 | 19.3 | 1489.1 |
| ast3 | 12946 | 0.5 | 2.0 | 4.9 | 17.5 | 558.6 |
| callgraph | 4928 | 2.3 | 5.1 | 14.5 | 17.7 | 212.6 |
| pathological | 2065 | 1.0 | 2.6 | 10.1 | 20.1 | 89.1 |

## Exploratory: single-query atomic replace
| strategy | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| singleQueryAtomic (1 query, incl. GC) | 5 | 79.6 | 88.7 | 88.7 | 88.7 |

MULTI/EXEC probe: works — exec returned 2 replies; 2 probe nodes created

## Churn (2000 cycles on 10 files)
| cycles | p50 ms | p95 ms | RSS MB | graph MB |
|---|---|---|---|---|
| 100 | 78.4 | 88.2 | 780 | 102 |
| 200 | 78.7 | 91.3 | 773 | 103 |
| 300 | 82.2 | 91.4 | 772 | 104 |
| 400 | 82.5 | 92.7 | 760 | 105 |
| 500 | 83.6 | 94.3 | 763 | 107 |
| 600 | 85.4 | 97.1 | 769 | 108 |
| 700 | 83.3 | 104.6 | 784 | 103 |
| 800 | 83.5 | 93.7 | 763 | 103 |
| 900 | 84.5 | 93.6 | 771 | 105 |
| 1000 | 86.6 | 96.2 | 752 | 106 |
| 1100 | 87.2 | 96.1 | 768 | 107 |
| 1200 | 89.7 | 99.7 | 770 | 108 |
| 1300 | 80.9 | 96.3 | 775 | 102 |
| 1400 | 82.6 | 95.1 | 758 | 103 |
| 1500 | 83.1 | 94.3 | 764 | 105 |
| 1600 | 83.8 | 95.0 | 759 | 106 |
| 1700 | 85.5 | 98.1 | 774 | 106 |
| 1800 | 87.5 | 100.3 | 772 | 107 |
| 1900 | 86.0 | 99.1 | 752 | 101 |
| 2000 | 80.1 | 90.1 | 775 | 102 |

## Global invariants at end
OK — no duplicate fqns, no orphan SYMBOLs, all FILEs ready.
Final RSS 775 MB, graph 102 MB.

## Notes
- modules: [["name","vectorset","ver",1,"path","","args",[]],["name","graph","ver",42004,"path","/var/lib/falkordb/bin/falkordb.so","args",["TIMEOUT_DEFAULT","30000","TIMEOUT_MAX","60000","CACHE_SIZE","200","NODE_CREATION_BUFFER","65536"]]]
- index used — delete D3: true, edge insert: true, point read: true
- hub-caller files (calls to src/pkg0/mod0.ts::m0): 0:17, 36:15, 41:12, 23:11, 51:11

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