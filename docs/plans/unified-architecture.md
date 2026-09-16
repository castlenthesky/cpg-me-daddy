# Unified architecture: one system, two hosts, verifiable at every seam

Written 2026-09-15. Synthesizes four sources into one plan:

| Source | What it contributed |
|---|---|
| **`main`** (`master` @ `27361a3`, plus `worktree-cpg-research-sweep` @ `e45574f`) | A clean layered engine with a machine-checked schema, an `IGraphStore` seam, a `WatchBackend`/`WatchSink` pipeline, a FalkorDB writer with `EXPLAIN`-gated queries, and ~300 tests. Stalled because nothing was *visible* until unit 12. |
| **`discovery`** (`24511d4`, current) | A working graph on screen from slice 1; every slice since verified visually. Strong input seams (`WatchBackend`, `Resolver`). Stalled architecturally: the vocabulary lives in the renderer, the watcher is the engine, nothing runs outside VS Code. Full review: `architecture-review.md`. |
| **Planning corpus** (`.agent/knowledge/planning-sessions/2026-09-11.*`) | Principles PR1–PR8, decisions D1–D37, the approved 14-label/15-edge schema (`50-schema.md`), the M0–M4 ladder, research R1–R6, DB selection with benchmarks. |
| **Comparative research** (`docs/research/`) + **"Stacking the Sheets"** (artifact series) | Five competitors, four convergent findings; the three-tier storage model; the verdict on what a CPG in a graph store is actually for. |

The question this document answers: *what is the architecture that gives us `main`'s decoupling with
`discovery`'s time-to-validate — a code-inspection system that runs without VS Code, with VS Code as
one interface onto it?*

---

## 0. The diagnosis in one paragraph

`main` and `discovery` failed for opposite reasons, and the fix is not a midpoint between them.
`main` believed the *verification surface* had to be the *production surface* — FalkorDB plus Cypher —
so it built the store, the schema gate, and the Docker harness before a single call edge was ever
looked at, and when a human finally could look, the surface was a terminal. `discovery` learned that a
*picture* catches problems in seconds, then let the picture's types become the system's types, so
every package now depends on the renderer. **The verification surface and the architecture are
separable.** Every service emits plain, serializable data at its boundary; one inspector renders any
stage's data, in a browser or in VS Code; the services never know the inspector exists. That single
move is what lets us have both.

---

## 1. What each source taught us — the learnings that bind

These are the constraints the architecture must satisfy. Each names its evidence so it can be argued
with rather than just asserted.

### From `main`: the process failure, precisely

- **Bottom-up ordering put the interesting part last.** F1–F4 (tooling, DB harness, binary
  acquisition, grammars), then M0.0 (schema spec, 606 lines), M0.4a/b (store + writer), and only at
  M0.11-lite could anyone run `cpg index` — against a Docker FalkorDB, inspected via Cypher. Twelve
  gated units before a human saw a graph, and the graph was a table of strings.
- **The store was in the critical path from unit 2.** F2 stood up the FalkorDB harness before there
  was anything to store. Every subsequent gate needed `docker compose up`. `60-delivery.yaml`'s own
  DL14 note (2026-09-12) is the tell: *"start getting real data into the graph … by the shortest
  honest route"* — the plan itself noticed it had built the wrong thing first.
- **Golden JSON is not a human audit surface.** GR4 made snapshot diffs the sign-off mechanism. A
  200-node JSON diff is not something a person reads and says "yes, that's right."
- **Symbol resolution was scheduled last (M0.10) but nothing upstream could pass its gate without
  it** — the `entanglement_found_2026-09-12` notes on M0.7/M0.9 record the discovery. Cross-file
  edges are the *point* of the graph; they cannot be the last thing built.

What `main` got **right** and we keep: engine purity enforced by lint, not comment (`packages/engine`
never imports `vscode`); the schema as one machine-readable object feeding validation, serialization
and the future `cpg://schema` resource; `IGraphStore`; `WatchBackend` → `NormalizedChange` →
`WatchSink` with `seq`/`cause`, at-least-once delivery, `SerialQueue`, bounded retry (`5c6880a` on
`worktree-cpg-research-sweep`); `LanguageAdapter`; `planDelta()` as a pure function with `EXPLAIN`
assertions; the unit-per-PR-with-its-gate discipline (GR1–GR3).

### From `discovery`: the architecture failure, precisely

Covered in `architecture-review.md`. The three that matter here: the type vocabulary lives inside
`graph-visualizer` (DOM/WebGL) and every Node package deep-imports it; `file-watcher` imports all
four of its downstream consumers; the composition root (`WorkspaceSession`) is trapped in `src/` so
running headless required a 442-line duplicate. No tests, no output seam, no store seam.

What `discovery` got **right** and we keep: visual-first slicing; `WatchBackend` and `Resolver` as
zero-import, consumer-declared, host-implemented, fakeable seams; symbol identity via fqn-keyed
`SYMBOL` nodes in a channel *separate* from file-owned nodes (`CpgSubgraphLike.symbols`) so a
per-file replace can never sweep one; `ChainResolver` keeping the first real answer per site; the
REAL / PASSTHROUGH / SEAT stubbing convention; and the finding that changed a recorded decision:

> **`vscode.executeDefinitionProvider` is the highest-value resolver we have**, and it only exists
> inside VS Code. (Memory `lsp-resolver-supersedes-headless`, 2026-09-15; reverses X3/D8.)

### From the competitive research (`docs/research/00-index.yaml`)

Five tools studied, spot-checked. The findings with n ≥ 4:

- **Cross-file identity keeps collapsing into a global relink** (4 of 5, the fifth built the right
  mechanism and never wired it). Confirms D5 — SYMBOL indirection is the load-bearing decision.
- **Nobody parses with a language server** (5 of 5); tree-sitter is universal, LSP appears only as
  an optional *post-hoc enrichment pass*. This is exactly `ChainResolver([lsp, adapterNative])`.
- **Nobody is incremental at the graph-write level** (4 of 5). PR2 — near-live per-file update — is
  *unoccupied ground*, not a catch-up feature.
- **MCP surfaces of 7 tools were sufficient**; 28 was noise. AM3's ≤ 12 is generous.
- Adopt: persist the graph itself (C1); record build provenance in graph metadata (C4); analytics
  must traverse the graph, never regex raw text (anti-C1); a cohesion score before any community gets
  a label (C2).

### From "Stacking the Sheets" (ch. 3 §3.8, ch. 6)

- **"Graph database" names three different jobs.** Tier 1: in-process analysis store (one session,
  deepest queries). Tier 2: in-memory graph server (shared, Cypher, algorithms). Tier 3: facts index
  (org-scale navigation). *"A design that asks a single database to be all three will be too slow for
  the editor, too shallow for the analyst, or too expensive for the org."* `main` built tier 2 first
  and had no tier 1; `discovery` has only tier 1 and no seam for tier 2.
- **Mark every edge type as file-local or whole-program**, and keep the seam visible in storage.
  `50-schema.md` §8's ownership classes (file-owned / identity / overlay / filesystem) already do
  this. Keep them.
- **Statement-level granularity is the one 10× lever** (QVoG: 100 nodes → 10 for the same ten
  lines). That is PR1, sparse-by-design, independently validated.
- **For agents, precomputed indexes and budgeted ranked slices matter at least as much as a live
  database**; expose the schema plus a small set of named queries, with raw Cypher as the escape
  hatch. That is X4/MC-P1.
- **Verdict:** viable for code quality and architecture (cycles, layers, dead code, coupling,
  centrality — cheap queries over edges the graph already has). Conditional for security. Not yet for
  incremental interprocedural analysis. Our v1 scope (D23) sits squarely in the "viable" column.

---

## 2. Architectural principles (the rules everything below obeys)

1. **Data shapes are shared; implementations are not.** One zero-dependency package owns every
   type that crosses a boundary. Nothing else is imported across service lines.
2. **A service interface is declared by its consumer**, with no imports beyond `@cpg/model`. The
   watcher declares `WatchBackend` (it consumes raw events); the linker declares `Resolver` (it
   consumes resolutions); the engine declares `GraphSink` (it consumes somewhere to put deltas).
   This is the convention both codebases already follow at their best.
3. **Every service has a plain-data input and a plain-data output**, and a CLI subcommand that reads
   the input from a file or stdin and writes the output to a file or stdout. This is what "actually
   independent" means operationally: you can run it alone, feed it a fixture, and look at what comes
   out. In-process the same function is called directly; the CLI is a 20-line wrapper.
4. **Dependencies point toward `@cpg/model`.** No service depends on a package that renders, stores,
   or hosts. `@cpg/engine` is the only package permitted to know more than one sibling. Enforced by a
   dependency-direction check in CI, not by review.
5. **Dependency injection is a composition root, not a framework.** Exactly three places choose
   implementations: `createEngine()` (wires services), `cli/main.ts` (Node adapters), and
   `vscode/extension.ts` (VS Code adapters). Services take interfaces in their constructor or config
   and nothing else.
6. **One inspector, many inputs.** The graph renderer runs in a browser from a JSON file and in a VS
   Code webview from a live engine. It is the human audit surface for every stage's output. Services
   do not know it exists.
7. **Headless is real and resolver-degraded, not a stub.** The engine runs identically in every host.
   What varies is which `Resolver` implementations are available. The graph shape is the same; only
   the `CALLS.status` distribution differs, and `resolvedBy` on every edge says who answered.
8. **The store is a sink, not a stage.** The engine emits `GraphDelta`s. A store subscribes. The
   webview subscribes. A JSONL recorder subscribes. The engine finishes without any of them.
9. **REAL / PASSTHROUGH / SEAT, then promote one at a time.** Every new seam lands compiling and
   labeled before any body behind it becomes real.

---

## 3. The package graph

```
                                 ┌──────────────────────────┐
                                 │        @cpg/model        │  zero deps · zero DOM
                                 │  vocabulary · schema     │  the ONLY shared import
                                 │  registry · delta · event│
                                 └────────────▲─────────────┘
                                              │
          ┌──────────┬──────────┬─────────────┼─────────────┬──────────┬──────────┐
          │          │          │             │             │          │          │
     @cpg/scan  @cpg/watch  @cpg/parse   @cpg/extract   @cpg/link  @cpg/store  @cpg/viz
       walk ·     events ·   tree-sitter   ParsedFile →   Resolver ·  GraphStore  render
       ignore ·   debounce · → ParsedFile  CpgSubgraph    symbols ·   Memory ·    only
       hash ·     bulk ·                   per language   defn index  Falkor ·
       fs tier    deliver                                             Jsonl
          ▲          ▲          ▲             ▲             ▲          ▲
          └──────────┴──────────┴──────┬──────┴─────────────┴──────────┘
                                       │
                               ┌───────┴───────┐
                               │  @cpg/engine  │   the orchestrator · createEngine(config)
                               │  phases ·     │   the ONLY package that knows > 1 sibling
                               │  sinks ·      │
                               │  events       │
                               └───▲───────▲───┘
                                   │       │
                          ┌────────┴──┐ ┌──┴──────────────┐
                          │ @cpg/cli  │ │  apps/vscode    │      thin hosts
                          │ scan ·    │ │  adapters ·     │      adapters only
                          │ parse ·   │ │  LSP resolver · │
                          │ extract · │ │  webview sink · │
                          │ link ·    │ │  views          │
                          │ index ·   │ └─────────────────┘
                          │ watch ·   │
                          │ inspect · │ ┌─────────────────┐
                          │ mcp       │ │  @cpg/mcp       │      later · SEAT
                          └───────────┘ └─────────────────┘
```

Eight service packages plus three hosts. Each service is a separate package because each has a
different **owner, clock, and reason to change**: grammars change when tree-sitter does; extraction
changes per language; resolution changes per resolver; storage changes per backend; rendering changes
per UI decision. Putting two of those in one package means two people editing one thing.

### 3.1 Service contracts

| Package | Consumes (interface it declares) | Input | Output | CLI stage | Inspector view | Port from |
|---|---|---|---|---|---|---|
| **`@cpg/model`** | — | — | types, schema registry, `applyGraphDelta`, `nodeLocation` | — | — | `discovery` `graph-visualizer/src/contract.ts` + `main` `engine/src/schema/{nodes,edges,enums,validate}.ts` |
| **`@cpg/scan`** | filesystem | root path, ignore config | `FileRecord[]` (path, hash, lang, loc) + filesystem-tier `GraphDelta` (`DIRECTORY`/`FILE`/`HAS_ENTRY`) | `cpg scan <root>` | directory tree | `discovery` `file-watcher/src/index.ts` (`walkWorkspace`, `WorkspaceGraphIndex`); `main` `engine/src/workspace/*` |
| **`@cpg/watch`** | `WatchBackend` (raw FS events) | root, ignore predicate + globs | `ChangeBatch { seq, cause, changes: NormalizedChange[] }` → `WatchSink` | `cpg watch <root> --record` (JSONL) | change log | `worktree-cpg-research-sweep` `engine/src/watch/*` incl. `sink.ts`, `queue.ts`; `discovery` `changes.ts`, `debounce.ts` |
| **`@cpg/parse`** | `ParserBackend` | file path + bytes | `ParsedFile` (CST, grammar id, ranges in UTF-16 columns) | `cpg parse <file>` | AST tree | `discovery` `ast-generator` (drop `REPO_ROOT`, drop disk dump); `main` `engine/src/parser/*` (ABI check, wasm locator) |
| **`@cpg/extract`** | `LanguageAdapter` | `ParsedFile` | `CpgSubgraph { nodes, edges, symbols, refSites }` — file-owned nodes only, symbols in a separate channel | `cpg extract <file>` | per-file subgraph | `discovery` `cpg-generator/src/{subgraph,significant,fqn,imports,refSites}.ts`; `main` `engine/src/extract/*` |
| **`@cpg/link`** | `Resolver`, `DefinitionLookup` | `RefSite[]` + definition index | resolution edges (`CALLS`/`IMPORTS`/`INHERITS_FROM`/…) with `status`/`resolvedBy`/`confidence`; unresolved report | `cpg link <subgraphs.jsonl>` | cross-file edges + unresolved table | `discovery` `cpg-generator/src/{resolve,chain,nullResolver,pythonPath}.ts` + `graph-builder` (split into `FileNodeRegistry`, `SymbolRegistry`, `DefinitionIndex`) |
| **`@cpg/store`** | `GraphStore` (readers) | `GraphDelta` stream | queries | `cpg query` (Falkor) · `cpg dump` (any) | — | `discovery` `applyGraphDelta` (Memory); `main` `engine/src/store/*` + `falkordb-service` (Falkor) |
| **`@cpg/viz`** | — | `GraphPayload`/`GraphDelta` | pixels | (used by `inspect`) | it *is* the view | `discovery` `graph-visualizer` minus `contract.ts` |
| **`@cpg/engine`** | `GraphSink`, `EventSink` (+ all of the above as injected deps) | `EngineConfig` | `GraphDelta` → sinks; `EngineEvent` → event sink | `cpg index <root>` | whole graph | `discovery` `workspaceSession.ts`, `parseWorkspace`, `astPass`, `resolvePass`, `AstPipeline`; `main` `indexer/index-workspace.ts`, `watch/watch-workspace.ts` |
| **`@cpg/cli`** | — | argv | files/stdout | all of the above + `inspect` | — | `main` `packages/cli` (`run.ts`, `io.ts` — already tested); `discovery` `src/dev/resolveHarness.ts` (delete) |
| **`apps/vscode`** | — | VS Code | UI | — | embedded inspector | `discovery` `src/*` minus `workspaceSession.ts` and `dev/` |

### 3.2 The three seams that make it independent

**Input seam — `WatchBackend`** (declared by `@cpg/watch`). Already exists in both lineages with
nearly identical shape. `main`'s version:

```ts
interface WatchBackend {
  subscribe(root: string, onEvents: (events: readonly RawEvent[]) => void,
            options: { ignore: readonly string[]; onError?: (e: Error) => void }): Promise<WatchSubscription>;
}
```

Implementations: `ParcelWatchBackend` (Node, `@parcel/watcher`, per R1/D33 — the source of truth),
`VsCodeWatchBackend` (hints only: `onDidSaveTextDocument` for fast-path, `onDidRenameFiles` for
authoritative rename pairs), `FakeWatchBackend` (tests, replays a JSONL recording).

**Resolution seam — `Resolver`** (declared by `@cpg/link`). `discovery`'s version is the richer one
and is kept as-is (`open` / `fileChanged` / `resolve(RefSite[]) → Resolution[]` / `close`, batch per
file, every site gets an answer, `unresolved` is a value not an error). Composed by `ChainResolver`.

| Host | Chain | Expected quality |
|---|---|---|
| VS Code | `[VsCodeDefinitionResolver, PythonPathResolver]` | highest — member-access calls resolve |
| CLI / CI / daemon | `[PythonPathResolver]` today; `[TsCompilerResolver, BasedpyrightResolver, adapterNative]` per AM4 when built | medium → high |
| Tests | `[FixtureResolver]` | deterministic |

The graph has the same shape in every row. The **unresolved rate is a first-class metric** the CLI
prints and the inspector shows, so "headless is worse" is a number, not a feeling.

**Output seam — `GraphSink`** (declared by `@cpg/engine`). This is the seam neither lineage has
today and the one that makes "the extension is just an interface" literally true:

```ts
interface GraphSink {
  onSnapshot(graph: GraphPayload, meta: { seq: number; cause: 'initial' | 'catch-up' }): Promise<void>;
  onDelta(delta: GraphDelta, meta: { seq: number; cause: 'live' | 'cascade' | 'bulk' }): Promise<void>;
}
```

Async from day one because a process boundary lands here eventually (the daemon, D36). Delivery
contract is the one `service-boundaries.md` already specifies: at-least-once, serialized by `seq`,
retried with bounded backoff, degraded paths reported. Implementations: `MemoryStore` (also a
`GraphStore`), `WebviewSink` (posts to the pane), `JsonlSink` (append-only log → replayable
fixture), `FalkorStore` (also a `GraphStore`), later `McpSink`-shaped readers over `GraphStore`.

### 3.3 The vocabulary decision

`50-schema.md` is normative. It was produced by an eight-lens debate, four research reports, and a
signed divergence table; `discovery`'s labels were chosen ad hoc while getting pixels on screen.
Reconciliation on port:

| `discovery` today | Becomes | Why |
|---|---|---|
| `file`, `directory` | `FILE`, `DIRECTORY` | normative names |
| `CONTAINS` (filesystem nesting) | `HAS_ENTRY` | `CONTAINS` collides with Joern's near-opposite `METHOD → CFG_NODE`; §4 |
| `CONTAINS` (lexical nesting, AST parent→child) | `DECLARES` | §4 |
| `METHOD`, `TYPE_DECL`, `CALL`, `IMPORT`, `SYMBOL` | unchanged | already aligned |
| `LOCAL` | dropped from default tier; available as opt-in expression tier | PR1 / §9b |
| `RECEIVER` edge | `CALL.receiver` property | §10 "folded into existing CALL properties" |
| `EVAL_TYPE` edge | **kept — proposed amendment** | 50-schema defers it to v2, but `discovery`'s LSP resolver *produces receiver-type resolution today* and it is the mechanism that makes `greeter.greet()` resolve. Pull forward the same way `REACHING_DEF` was (DL13). **Needs your sign-off.** |
| `DEFINES`, `CALLS`, `IMPORTS` | unchanged, gain `status` enum per §7 | one signal, one place |

Two renderer rules that stop label changes from being cross-team edits: `NODE_TYPES` becomes
derive-and-fallback like `RELATIONSHIP_TYPES` already is (unknown label → grey, raw name); the layout
seeds from `HAS_ENTRY` and `DECLARES` via config, not hardcoded strings.

### 3.4 Storage, by tier

| Tier | Package | Present when | Purpose |
|---|---|---|---|
| **1 — in-process** | `MemoryStore` | always | powers the inspector and every test; what `GraphBuilder`'s maps + `applyGraphDelta` already are |
| **2 — graph server** | `FalkorStore` | from the MCP wedge onward | Cypher (D1 hard requirement), separate-process readers, in-engine PageRank/betweenness/WCC; `main`'s `planDelta` + `falkordb-service` ported whole |
| **3 — facts index** | — | never at v1 scale | structural tier is ~450 nodes/300 LOC; not needed |

This **amends D2**: FalkorDB stays the primary *tier-2* store, but it is no longer first. It enters
when there is a separate-process reader to serve (MCP), which is also the first moment its two
distinctive properties — Cypher and cross-process reads — are load-bearing. Before that it is a
Docker dependency on every gate for no user-visible gain, which is exactly what stalled `main`.

Ownership classes from §8 are how the tier-2 write path stays incremental: file-owned nodes are
`DELETE + CREATE` per save; identity nodes (`SYMBOL`, `TAG`) are `MERGE`-on-key; overlay edges
(`COMMUNITY`, `TARGETS`, `DEPENDS_ON`) are written only by the async analytics job, never inside a
per-file replace. The `EXPLAIN`-must-show-`Node By Index Scan` gate from M0.4b comes with the port.

---

## 4. The inspector — how every slice becomes visible

This is the process fix, and it is mostly free: `@cpg/viz` is already browser code with zero VS Code
dependencies. It is trapped in a webview only because nothing else serves it.

**`cpg inspect <input>`** starts a local static server, opens the browser, renders whatever it is
given:

| Input | Renders | Produced by |
|---|---|---|
| `fs.json` | directory tree | `cpg scan` |
| `foo.ast.json` | one file's CST | `cpg parse` |
| `foo.cpg.json` | one file's subgraph, symbols highlighted | `cpg extract` |
| `linked.json` | cross-file edges, unresolved sites flagged red, unresolved-rate badge | `cpg link` |
| `graph.json` | the whole workspace | `cpg index` |
| `changes.jsonl` | the change log as a timeline; scrub to replay | `cpg watch --record` |
| `deltas.jsonl` | graph over time; scrub to replay | `JsonlSink` |
| `--live <root>` | live: runs the engine, subscribes the browser as a `GraphSink` | `cpg watch --serve` |

The VS Code extension is the same renderer plus click-to-source, breadcrumb follow, and the Insights
panel. Same `GraphPayload` in, same pixels out.

**What this changes about gates.** Every unit's gate has three parts: a test (machine), a golden
fixture (regression), and an inspector screenshot or a one-line "open X in the inspector and you
should see Y" (human). The golden fixture is what the inspector renders — so the JSON that was
unreadable as a diff on `main` becomes a picture. GR4's "paste the snapshot diff into the PR" becomes
"paste the before/after inspector screenshot."

**What this does not buy.** The inspector shows shape, not correctness of every property. A wrong
`nameRange` looks fine until you click it. The tests still carry that load; the inspector is for the
class of error a picture catches — missing nodes, duplicate subtrees, orphaned symbols, a cluster
where there should be a chord. That is most of what went wrong in both lineages.

---

## 5. Hosts

### 5.1 `@cpg/cli` — the system's own front door

`main`'s `packages/cli` (`run.ts`, `io.ts`, `usage.ts`, unit-tested) is the skeleton. Subcommands:

```
cpg scan <root>              → fs.json                  stage
cpg parse <file>             → ast.json                 stage
cpg extract <file|glob>      → cpg.jsonl                stage
cpg link <cpg.jsonl>         → linked.json + report     stage
cpg index <root>             → graph.json               engine, one-shot
cpg watch <root> [--record|--serve]                     engine, live
cpg inspect <input>                                     viewer
cpg query "<cypher>"                                    tier-2 store (later)
cpg mcp --workspace <root>                              shim (later)
```

`cpg index . | cpg inspect -` producing the same picture the extension shows is **the acceptance test
for "functions independent of VS Code."** It is step 4 in §7, not step 12.

### 5.2 `apps/vscode` — adapters and glue

`extension.ts` becomes roughly:

```ts
const engine = createEngine({
  rootPath: folder.uri.fsPath,
  watch:    new VsCodeWatchBackend(),                  // hints; parcel underneath when the daemon lands
  resolver: new ChainResolver([new VsCodeDefinitionResolver(log), new PythonPathResolver()]),
  sinks:    [memoryStore, new WebviewSink(graphView)],
  events:   new InsightsPanelSink(logs, { throttleEvery: 25 }),
});
await engine.start();
```

Everything else in `src/` is an adapter (`watch/`, `resolve/`, `sinks/`) or a view. The 200-entry
panel cap, the `relative()` path formatting, the every-25-files throttle — all presentation decisions
— live in `InsightsPanelSink`, not in the engine. The webview `graphApp.ts` is unchanged.

Later (M3 in the corpus): attach-or-spawn a detached daemon per D36/R5, register the MCP server
definition provider per R5 §5, the four relocatable views per AM2. None of that changes the
composition above; it changes what `watch` and `sinks` are wired to.

### 5.3 `@cpg/mcp` — SEAT until tier 2 exists

R3's design stands unchanged: dual-era `serveStdio`, static-manifest handshake before engine attach,
`--workspace` explicit, ≤ 12 tools, `RO_QUERY` + write-clause reject + timeout + caps. It reads
through `GraphStore` — the same interface the inspector's live mode reads through — so a query that
works in the inspector works in MCP. Shared query library per MC-FR3/VZ-FR6.

---

## 6. Decisions this plan records

Amendments to the corpus, in its own `was / now / why` style. Each needs your confirmation to become
`agreed`.

- **D8 (headless engine).**
  was: standalone daemon is *the* engine; the extension is a thin host.
  now: the engine runs identically in every host; **resolution quality is host-dependent** and
  measured. VS Code hosts the most precise resolver; headless runs the adapter-native chain until
  AM4's compiler-API resolvers exist.
  why: `executeDefinitionProvider` proved to be the highest-value resolver (2026-09-15) and cannot
  leave VS Code. The seam keeps the door open; the metric keeps it honest.

- **D2 (FalkorDB primary).**
  was: FalkorDB is the store; built first (F2/F3).
  now: FalkorDB is the tier-2 store, entering at the MCP wedge. `MemoryStore` is tier 1 and always
  present.
  why: §1 process failure; ch. 3 §3.8 three-tier model. Cypher and cross-process reads are only
  load-bearing when there is a second process.

- **Schema: `EVAL_TYPE` pulled forward from v2.**
  was: reserved (§9c, V2.1).
  now: adopted, `CALL → SYMBOL {relation: receiver-type}`, produced only by resolvers that can answer
  it.
  why: same reasoning as DL13 pulled `REACHING_DEF` forward — a producer exists.

- **60-delivery.yaml: a seventh ground rule.**
  GR7 — *every unit's gate names an inspector-visible artifact.* The unit ordering in §7 below
  supersedes the F/M0 ordering; the units themselves (their `delivers` and `gate` text) are reused
  where cited.

- **Tooling.** npm + tsc + vitest now. oxlint/oxfmt/lefthook return at step 4 when there is a CLI
  to gate (per memory `bun-oxlint-tooling-reverted`: the revert was about process, not the tools).
  Bun is not required by anything in this plan; revisit if install/test speed becomes the bottleneck.

- **Vocabulary.** `50-schema.md` normative; `discovery` labels mapped per §3.3.

- **Python first, TypeScript second** (2026-09-15 decision). `@cpg/extract` ships the Python adapter
  first; `main`'s TypeScript adapter (`extract/typescript.ts`, tested against goldens) ports second.

---

## 7. Delivery: ordered so every step is visible

Nine steps. Each is a PR-sized unit or two (GR3), lands compiling with new seams labeled
REAL / PASSTHROUGH / SEAT, and has a test gate plus an inspector gate. Where a step absorbs a unit
from `60-delivery.yaml`, it says so, so the work already specified there is reused rather than
re-planned.

### Step 0 — Foundation: `@cpg/model`, vitest, the inspector *(1–2 units)*

- Create `@cpg/model`: move `contract.ts` in verbatim; add the label/edge registry with ownership
  class from `main`'s `schema/{nodes,edges}.ts` as **data** (the validator comes with it, the
  generated-doc tooling does not yet). Rewrite the five deep imports. Delete the four comment blocks
  that explained them.
- `vitest` at the root. First suites from fakes that already exist: `ChangeBatcher` with injected
  clock; `WorkspaceGraphIndex.applyChange` idempotency; `GraphBuilder` symbol survival across
  `replaceFile`. Port `resolveHarness.ts`'s assertions as tests over a checked-in fixture (absorbs
  DL1: the correctness fixture lives in-repo).
- `cpg inspect <graph.json>`: static server + the existing `graphWebviewHtml` shell + `@cpg/viz`
  bundle. Add a "dump current payload" command to the extension so there is a file to open.
- Dependency-direction check: a 30-line script over each `package.json` asserting nothing but
  `apps/vscode` and `@cpg/cli` depends on `@cpg/viz`, and `@cpg/model` has an empty `dependencies`.

**Inspector gate:** dump the graph the extension shows today; `cpg inspect graph.json` shows the
same picture in a browser with VS Code closed.
**Test gate:** `npm test` green; the direction check fails on a deliberately wrong edge, then passes.

### Step 1 — `@cpg/scan` and `@cpg/watch` *(2 units)*

- `@cpg/scan` from `file-watcher/src/index.ts`'s walk + index + ignore handling, plus content
  hashing from `main`'s `workspace/hash.ts`. Emits `FileRecord[]` and a filesystem-tier delta with
  `FILE`/`DIRECTORY`/`HAS_ENTRY`. (Absorbs M0.2.)
- `@cpg/watch` from `worktree-cpg-research-sweep`'s `engine/src/watch/*` (`backend`, `events`,
  `normalize`, `debounce`, `sink`, `queue`, `watch-workspace`) — the `WatchSink` delivery contract
  with `seq`/`cause`/retry/degraded already written and tested there — plus `discovery`'s
  `VsCodeWatchBackend`. Takes an ignore predicate from config; knows nothing about `scan`. Its
  `package.json` depends on `@cpg/model` and `@parcel/watcher` and **nothing else** — that line is
  the architectural assertion. (Absorbs M1.1's normalization half; bulk mode stays SEAT.)
- `cpg scan`, `cpg watch --record`.

**Inspector gate:** `cpg scan . | cpg inspect -` shows the tree; `cpg watch . --record > c.jsonl`
while renaming a file yields one `moved` change; `cpg inspect c.jsonl` shows it on the timeline.
**Test gate:** `FakeWatchBackend` replays `c.jsonl` into a recording sink; the batch sequence is
exactly asserted; a rejecting sink is retried and then reported degraded.

### Step 2 — `@cpg/parse` and `@cpg/extract` *(2 units, Python first)*

- `@cpg/parse` from `ast-generator`: drop `REPO_ROOT` and `DEFAULT_OUTPUT_DIR`; drop `writeAstJson`
  from the library (it becomes `cpg parse`'s output). Take `main`'s `parser/abi.ts` ABI assertion
  and `wasm-locator.ts`. (Absorbs F4.)
- `@cpg/extract` from `cpg-generator`'s `toSubgraph` / `significant` / `fqn` / `imports` / `refSites`
  behind `LanguageAdapter`. Labels mapped per §3.3. `symbols` stays a separate channel. Python
  adapter REAL; TypeScript adapter ported from `main`'s `extract/typescript.ts` next. (Absorbs
  M0.6–M0.9's extraction; `main`'s hello-world goldens at `test/fixtures/golden/simple/{python,typescript}/hello_world.cpg.json`
  and the test that pins the extractor to them, `packages/engine/test/unit/golden/hello-world.cpg.test.ts`,
  come across as the first fixtures.)
- `cpg parse`, `cpg extract`.

**Inspector gate:** `cpg extract hello_world.py | cpg inspect -` shows `MODULE → METHOD → CALL`
with the `SYMBOL` the file defines sitting beside its definition.
**Test gate:** per-file golden JSON for the Python and TS hello-world fixtures; `assertGraphDeltaValid`
from `main`'s `schema/validate.ts` rejects a deliberately undeclared label.

### Step 3 — `@cpg/link` *(2 units)*

- Split `GraphBuilder` into `FileNodeRegistry` (per-file id lifecycle), `SymbolRegistry` (fqn-keyed
  lifetime, merge-on-key), `DefinitionIndex` (`symbolAt`/`symbolNamed`/`hasSymbol`/`isIndexed`,
  now `implements DefinitionLookup` from `@cpg/model` so the coupling is checked).
- Move `Resolver`, `ChainResolver`, `NullResolver`, `PythonPathResolver`, `runResolvePass` here.
  Edges gain the §7 `status` enum. Unresolved-rate report as a first-class output.
- `cpg link`. (Absorbs M0.10.)

**Inspector gate:** over the layered Python fixture (`api → services → database`), cross-file
`CALLS` chords appear between file clusters; unresolved sites are red; the badge reads e.g.
"41/47 resolved · 4 external · 2 unresolved".
**Test gate:** `FixtureResolver` golden; symbol survives a re-parse of its defining file; no orphan
`SYMBOL`s; no bare-name `SYMBOL` minted for an unresolved call (design rule 2).

### Step 4 — `@cpg/engine` + `MemoryStore`: the headless proof *(2 units)*

- `createEngine(config)` from `WorkspaceSession` + `parseWorkspace` + `AstPipeline` + `main`'s
  `indexWorkspace` hooks (`onProgress`/`onWarning`/`AbortSignal`). Phases: Scan → Parse → Link →
  Monitor. `GraphSink[]` and `EventSink` on config. `UpdateQueue` stays PASSTHROUGH. Structured
  `EngineEvent` replaces the eight listener types and the `log` string.
- `@cpg/store`: `MemoryStore` REAL (it is `applyGraphDelta` over a map, plus `GraphStore` reads);
  `JsonlSink` REAL; `FalkorStore` SEAT.
- `cpg index`, `cpg watch --serve`. Bring oxlint/lefthook back here.

**Inspector gate — the vision check:** `cpg index . | cpg inspect -` with VS Code closed shows the
workspace graph. Then open VS Code on the same workspace: same picture, more green edges (LSP).
**Test gate:** `cpg index` over the fixture equals the whole-graph golden (absorbs M0.11's gate);
an `EngineEvent` sequence for one indexed file is exactly asserted; the engine finishes with zero
sinks attached.

### Step 5 — `apps/vscode` rewired *(1 unit)*

- `extension.ts` per §5.2. `src/workspaceSession.ts` and `src/dev/` deleted. `InsightsPanelSink`
  owns formatting and throttling. `VsCodeDefinitionResolver` unchanged, now in the front of a chain
  the engine never sees the inside of.

**Inspector gate:** identical behaviour to today, plus "Dump graph" and "Open in browser inspector"
commands.
**Test gate:** `src/` imports only `@cpg/engine`, `@cpg/model`, `@cpg/viz`, `@cpg/link` (for
`ChainResolver`), and `vscode`.

### Step 6 — Live updates through the seams *(2 units)*

- `UpdateQueue` PASSTHROUGH → REAL with `pause()`/`resume()` around the initial parse (closes the
  blind window `workspaceSession.ts` documents). Watch → engine → sinks end to end. Debounce/coalesce
  per R1's adopted defaults. Bulk-mode detection REAL, bulk *processing* PASSTHROUGH (still per-file).
  (Absorbs M1.1's remainder, M1.2's in-memory analogue.)
- `AstPipeline`'s disk dump becomes a `JsonlSink`, off by default; the hot path has no I/O.

**Inspector gate:** save a file in VS Code — the delta lands in both the webview and a
`cpg watch --serve` browser tab within a second; `git checkout` of a large diff produces one
`bulk`-caused batch, not a storm.
**Test gate:** recorded change log replays to the same final graph as a fresh `cpg index`
(convergence); two rapid saves of one file apply in order.

### Step 7 — `FalkorStore` *(2–3 units)*

- Port `main`'s `store/{cypher,falkordb-store,bootstrap,open}.ts` and `packages/falkordb-service`
  whole. `planDelta` stays a pure function; the `EXPLAIN` gate (per-op-kind, no `All Node Scan`, no
  `Label Scan`) comes with it. `ServerManager` Spawned/Remote/Docker per F3. (Absorbs F2, F3, M0.4a,
  M0.4b — all already built and verified on `main`.)
- `cpg query`.

**Inspector gate:** counts from `cpg query "MATCH (n:CPG) RETURN labels(n)[1], count(*)"` match the
inspector's legend counts exactly.
**Test gate:** `main`'s integration suite (30 tests) green against the pinned image; cross-file
`CALLS` survives a rewrite of the defining file.

### Step 8 — `@cpg/mcp`, analytics *(the M2/M4 outlines, unchanged)*

R3's shim over `GraphStore`; the ≤ 12 tools; `cpg://schema` generated from `@cpg/model`'s registry;
analytics projections off the hot path with `run_id`/`computed_at` (D6/D15). The `60-delivery.yaml`
`m2_outline`/`m4_outline` unit lists apply as written.

### What this order buys

Steps 0–4 deliver the user-stated vision — a graph produced with no VS Code, viewed in a browser,
the same graph the extension shows — in roughly ten PR-sized units, every one of which ends with a
picture. `main`'s FalkorDB/Cypher stack is not thrown away; it arrives at step 7, ported rather than
rebuilt, at the first moment it pays for itself. `discovery`'s live-update work is not thrown away;
it is re-homed behind seams at step 6.

---

## 8. What we are deliberately not doing

- **CFG, PDG beyond sparse `REACHING_DEF`, taint.** D10/D23, confirmed by ch. 6's "not yet." Names
  reserved per §9b so the schema does not preclude them.
- **The detached daemon and attach-or-spawn** until there is a second process to serve (MCP).
  D36/R5's design stands; it is a step-8 concern.
- **Windows, multi-root, remote agents, HTTP transport, any write tool in MCP.** Out of v1 scope in
  the corpus; unchanged.
- **Layer rules, persisted labels, annotations.** D15/D16/X9 — north star.
- **A DI container.** Three composition roots and constructor injection are enough; a framework
  would be the kind of ceremony that stalled `main`.
- **Rewriting anything that works.** Both lineages contain tested, working code. This plan moves
  it; the port table in §3.1 says from where.

---

## 9. Rules to enforce mechanically, from step 0

1. `@cpg/model` has an empty `dependencies` block — CI asserts it.
2. Dependency direction: nothing depends on `@cpg/viz` except the two hosts; nothing depends on
   `@cpg/store`'s Falkor implementation except `@cpg/engine`'s composition and `@cpg/cli`;
   `@cpg/watch` depends on `@cpg/model` only. One script, run in CI, seen to fail once.
3. No `vscode` import outside `apps/vscode` — `main`'s `no-restricted-imports` rule, restored with
   oxlint at step 4.
4. Every package has an `exports` map; deep imports are resolution errors.
5. Every label and edge type written anywhere is declared in `@cpg/model`'s registry —
   `main`'s `test:schema`, ported at step 2.
6. Every unit's PR description contains an inspector screenshot or a one-line reproduction.

---

## Appendix A — Where the code is

| Lineage | Ref | Recover with |
|---|---|---|
| `main` engine, cli, vscode, falkordb-service, tests, schema module, planDelta | `master` @ `27361a3` | `git show master:packages/engine/src/store/cypher.ts` |
| `WatchSink`, `SerialQueue`, `withRetry`, `filesystem-projector`, `service-boundaries.md` | `worktree-cpg-research-sweep` @ `e45574f` (commit `5c6880a`) | `git show worktree-cpg-research-sweep:packages/engine/src/watch/sink.ts` |
| current visual pipeline, LSP resolver, symbol registry, viz | `discovery` @ `24511d4` (working tree) | in place |
| planning corpus, research, schema spec | `.agent/knowledge/planning-sessions/2026-09-11.*` | in place on both branches |
| competitive research | `docs/research/*.yaml` | in place |

## Appendix B — Corpus cross-reference

Principles and decisions this plan relies on without restating: PR1 (sparse), PR2 (speed),
PR3 (graph is a cache), PR5 (deterministic identity), PR7 (local), PR8 (explicit state);
D5 (SYMBOL indirection), D6 (analytics on projections), D19 (stdio first), D26 (adapter-native first,
seam now), D31 (id rule), D32 (wasm), D33 (parcel), D34 (SCIP descriptors), D35 (dual-era shim),
D36 (detached daemon), D37 (Joern alignment option b). Amended here: D2, D8, one §9c reservation.
Research adopted defaults (`40-research.yaml`) apply unchanged to `@cpg/watch`, `@cpg/parse`,
`@cpg/link`, `@cpg/mcp`.
