# Timeline: how we got here

A chronological account of what was built, what was learned, what was reverted, and why —
stitched together from the original implementation's journals, the 2026-09-11 planning session,
the `discovery` redo, and the 2026-09-15 architecture review. See `what-worked.md` and
`what-was-sloppy.md` for the lessons extracted from this timeline; this doc is the sequence of
events they're extracted from.

## 1. The original implementation (pre-2026-09-11, `master`)

A CPG implementation already existed, aligned to Joern's vocabulary, writing into FalkorDB. It
worked well enough to be actively developed and debugged — `docs/history/archive/journal/`
preserves four dated entries (2026-04-03/04) of concrete bugs found and fixed in it: a wildcard
delete in the reconciler that wiped the whole graph (twice), Cypher injection via string
interpolation, TOCTOU races, an unconditional force-graph reheat on every save, a silent fallback
masking language-detection errors, and a `DETACH DELETE` that destroyed cross-file edges. See
`what-was-sloppy.md` for what these bugs indicate about the process, not just the code.

## 2. The 2026-09-11 planning session (`master`/`discovery`, identical)

A deliberate, thorough greenfield-design pass, now at `docs/research/2026-09-11-planning-session/`
(see its `ERRATA.md` first). Produced: 8 principles (PR1–8), 14 proposals (X1–14), 37 decisions
(D1–37), a normative v1 schema (`50-schema.md`), an F/M0–M4 delivery ladder (`60-delivery.yaml`),
six research spikes (R1–R6), and — in a separate, rigorously benchmarked session — the choice of
FalkorDB over Memgraph/Neo4j/Kùzu/CozoDB/DuckDB/SQLite (`docs/research/database-selection/`).

Two decisions from this session matter most for reading everything that follows: **D8** committed
to a headless, standalone-daemon engine, and rejected VS Code's language-service APIs as a
resolver (X3) on the grounds that they "conflict with X1." Both are reversed later — see §5.

## 3. The Bun/oxlint build, and its revert

The delivery ladder was built as planned: Bun workspaces, oxlint, oxfmt, lefthook, and standing CI
(`4e3ddab feat(F1): bun workspace monorepo skeleton + standing gates + CI`), with packages `cli`,
`engine`, `vscode`, `falkordb-service` — a layered engine, a machine-checked schema, an
`IGraphStore` seam, a FalkorDB writer with `EXPLAIN`-gated queries, and roughly 300 tests.

It stalled. The delivery ladder put the FalkorDB/Docker harness at unit 2 and symbol resolution —
the actual point of a cross-file graph — at unit 10, so nothing was visible to a human until
around unit 12, and even then the "graph" was a Cypher result table. The plan's own DL14 note
(2026-09-12) records the moment this was noticed: *"start getting real data into the graph … by
the shortest honest route."* It had built the wrong thing first.

The whole build was reverted on `discovery` (rebuild commit `4cbf180`): Bun, oxlint, oxfmt,
lefthook, the Docker FalkorDB harness, most of `design/`, and the `cli`/`engine`/`vscode`/
`falkordb-service` packages are all gone. **This was a process revert, not a tools verdict** — the
tools were later called "probably the right choice" on their own merits; what failed was building
several layers deep with no verification gate until the very end. This is the origin of the
incremental-verifiable-steps working process still in use.

## 4. The `discovery` redo (minimal packages, visual-first)

In place of the Bun stack: plain npm + tsc, and new minimal package skeletons — `ast-generator`,
`cpg-generator`, `file-watcher`, `graph-builder`, `graph-visualizer`. The first slice was
deliberately small: a workspace file-traversal function producing a JSON tree, rendered in the
graph webview (previously a hardcoded demo graph) — the smallest slice that proves the
extension-host-to-webview pipeline end to end, verified visually before anything else was added.

On 2026-09-14, on top of that slice, the extension's activation flow was split into two named
phases — **ParseWorkspace** (full walk) and **MonitorWorkspace** (live changes) — feeding one
shared update path. This landed using the **REAL/PASSTHROUGH/SEAT** stubbing convention: the whole
shape named and wired compiling, with each piece's body labeled by how real it is, before any of
the hard parts (async parse, move-preserving renames, VS Code watcher wiring) were built for real.

## 5. The 2026-09-15 turning point: architecture review + reversed resolver decision

Two things happened the same day. First, `vscode.executeDefinitionProvider` was chosen as the
**poc/mvp** cross-file symbol resolver, behind a `Resolver` seam — reversing D8/X3 from the
planning session, because the headless engine those decisions were protecting had already been
deleted in the `discovery` rebuild; "must run headless" had quietly become a future option, not a
constraint. See `docs/research/2026-09-11-planning-session/ERRATA.md`.

Second, a structural review of `discovery` (`docs/architecture/current-target.md`) found the seam
*craft* excellent (`WatchBackend`, `Resolver` are held up as the pattern to replicate) but the seam
*placement* wrong: the type vocabulary lives inside the renderer package, `file-watcher` is
secretly the whole engine, and there is no composition root outside the VS Code extension — visible
in the wild as a 442-line hand-rolled harness duplicating a 120-line session class. It gives a
concrete target package layout and a 9-step migration plan.

That same day, `docs/plans/unified-architecture.md` synthesized `master`'s engine work, `discovery`'s
visual-first redo, the planning corpus, and a competitive-landscape study of five external
code-graph tools (`docs/research/competitive-landscape/`, itself from 2026-09-14) into one
9-step delivery plan: keep `main`'s decoupling discipline, keep `discovery`'s time-to-validate, and
let FalkorDB re-enter at the point it earns its keep (the MCP wedge) instead of first.

## 6. 2026-09-16: centralizing the research (this work)

By this point the record of all of the above was split across three branches — `master` held the
original implementation, its journals, and the planning/design corpus; `discovery` held the
architecture review, the competitive-landscape study, and the redo's own docs; `develop` held only
a byte-identical copy of `discovery`'s `unified-architecture.md`, not an actual synthesis of its
own. This centralization brought the load-bearing material from all three onto `develop` under
`docs/`, added errata notes where a decision has since been reversed or reverted, and wrote this
timeline plus `what-worked.md`/`what-was-sloppy.md` so the lessons don't have to be re-derived from
scratch next time.
