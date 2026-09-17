# CPG Ontology Debate -- full transcript

Session date: 2026-09-11. Parent planning session:
.agent/knowledge/planning-sessions/2026-09-11.project-outline/00-vision.yaml.
Baseline: the current v1 draft schema (10-graph-engine.yaml), the previous implementation's Joern-spec
port (src/types/cpg.ts), and two independent research passes against the live canonical Joern CPG
schema (https://cpg.joern.io/ and github.com/ShiftLeftSecurity/codepropertygraph), SCIP, LSIF, Kythe,
Glean, and CodeQL.

8 lenses, 3 rounds. Rounds 2 and 3 are genuine rebuttal rounds -- each lens read every other lens's
prior-round statement in full before writing.

Lenses: Security & Taint Analysis, Code Complexity & Maintainability, Graph Analytics & Path Tracing, Incremental Update & Identity, Agent / MCP Consumption Ergonomics, Cross-Language & Symbol Resolution, Storage & Query Performance (Cypher/FalkorDB), Standards & Interoperability.

Note on provenance: this transcript was reconstructed directly from the orchestrating workflow's
run journal after its own "write transcript verbatim" finishing step failed repeatedly (the prompt
carrying the full transcript inline was too large and the step kept being interrupted). All 24
debate results below (8 lenses x 3 rounds) completed successfully and are reproduced exactly as
each lens returned them -- nothing here was regenerated, summarized, or altered.

---

# Round 1 -- opening positions

## Security & Taint Analysis -- Round 1

**Top priority:** The CALLS.status enum (resolved|ambiguous|external|unresolved|dynamic) plus SYMBOL indirection must stay first-class and queryable in v1 — that is what makes today's actual attack-surface blind spot (unresolved/dynamic call targets) visible to an agent, and every future CFG/PDG/taint edge must compose through CALL→SYMBOL without a redesign.

## Framing

My job starts long after v1 ships: tracing untrusted input to a sink across function/file boundaries. CFG, PDG, and REACHING_DEF are correctly deferred (RK1) — I'm not arguing to pull them in. My only concern is whether v1's shape lets me bolt those on later without breaking identity, without a rename war, and without losing the one signal that already exists today: **where resolution failed**.

## Dispositions

**CALLS edge, `status`/`reason`/`confidence`/`resolvedBy` (v1 draft) — ADOPT AS-IS, and treat as load-bearing, not cosmetic.** `unresolved` and `dynamic` are exactly where taint leaks today in JS/TS (`eval`, computed `require`, `Function()`, prototype-pollution-driven dispatch) and Python (`getattr`, `exec`, dynamic imports). An agent that can query "all CALL nodes with status=unresolved OR status=dynamic" already has a usable pre-taint triage tool before a single CFG edge exists. Do not let this get simplified away as "just a resolved boolean."

**Joern's edge `CALL` (node CALL → METHOD via load-time METHOD_FULL_NAME linking) — REJECT, explicitly.** Section 10 asks for a disposition on every Joern edge, and I want this one on record: adopting Joern's actual linking mechanism would mean re-resolving the whole graph on every save, which is the opposite of D5/PR2. Our CALLS→SYMBOL replaces it entirely. This is not a naming choice, it's a mechanism rejection.

**Section 6 CONTAINS collision — resolve by renaming the filesystem edge, not the future one.** I want `CONTAINS` reserved for Joern's actual meaning (METHOD → everything physically in its body) because that is exactly the anchor future CFG/PDG nodes will attach to, and every dataflow paper/tool that talks about "contains" in a CPG means that relationship. Rename ours to `TREE_CONTAINS` or `PATH_CONTAINS` (filesystem nesting) now, while it's cheap, so we don't have to rename a live, queried edge later. `IN_METHOD` (CALL→METHOD) can stay as a v1-only convenience projection; when CFG ships it becomes derivable from `CONTAINS`, or gets folded into it.

**TAG / TAGGED_BY — EXTEND (pull forward into v1 scope, not deferred).** Joern's TAG/TAGGED_BY is a generic key-value annotation attachable to any node. This is the cheapest possible hook for sensitive-data classification and sink/source/sanitizer marking — e.g., tag known dangerous SYMBOLs (`child_process.exec`, `fs.writeFile`, `subprocess.run`, `os.system`) or MEMBER nodes holding secrets, entirely as data, config-driven, with zero taint engine required. This is explicitly listed in section 3 as deferred ("persisted layer/annotation labels") — I'm asking for it to move up, because without *some* place to hang classification metadata, every future taint feature has nowhere to start. Cost mitigation for AM3: this need not consume an MCP tool slot — it's a property/edge an existing query tool can filter on, not a new agent-facing verb.

**CALL.kind — EXTEND slightly.** The current enum (call|new|decorator|await) doesn't distinguish reflective/dynamic-dispatch call shapes from ordinary unresolved ones. I'd rather this ride on the existing `status=dynamic` value than add a new property — flagging it now so it isn't lost: `dynamic` should be documented as *specifically* meaning reflective/computed dispatch, not just "we didn't try."

**DEFINES: PARAM → SYMBOL — EXTEND.** Section 3's DEFINES list omits PARAM. Future intra-procedural taint (tainted parameter → sink in body) needs parameters to have the same stable cross-reference identity everything else gets. Cheap now, expensive to retrofit once callers depend on PARAM having no SYMBOL.

**Future-tier names (IDENTIFIER, LITERAL, FIELD_IDENTIFIER, REF, CONTROL_STRUCTURE, BLOCK, RETURN, REACHING_DEF, CDG, CFG) — no v1 action, but reserve Joern's exact names for when these ship.** Every taint tool and paper speaks this vocabulary; renaming it later buys nothing and costs everyone re-learning.

## Concession

I accept CFG/PDG/expression-tier deferral fully — PR1/PR2's density argument is sound and my needs don't override it. My asks (TAG/TAGGED_BY, PARAM→SYMBOL, the CONTAINS rename) are all cheap, additive, and don't reopen that tradeoff.

**Proposed additions/changes:**
- [edge] TAG / TAGGED_BY (cf. Joern TAG, TAGGED_BY) -- Generic annotation hook, pulled forward from deferred into v1, to mark known sources/sinks/sanitizers on SYMBOL/CALL/MEMBER nodes before any taint engine exists — near-zero cost, high leverage, no new MCP tool required.
- [edge] DEFINES (extend domain to include PARAM) (cf. Joern REF / PARAMETER_LINK (partial analogy)) -- Parameters currently have no SYMBOL identity; future intra-procedural taint propagation needs a stable anchor for params the same way it has one for methods/types/members.
- [edge] TREE_CONTAINS or PATH_CONTAINS (rename of v1 filesystem CONTAINS) -- Frees the name CONTAINS for Joern's actual METHOD-body-membership semantic, which is exactly the anchor future CFG/PDG nodes will attach to — renaming the cheap, unused-by-anyone-yet edge now avoids renaming a live, queried one later.
- [status_value] CALL.status=dynamic (clarified semantics) -- Document this value as specifically meaning reflective/computed dispatch (eval, getattr, Function(), computed require) so it doubles as a pre-taint triage signal today, not just a generic 'unresolved' catch-all.

**Rebuttals:**
- to Standards & Interoperability: Do not adopt Joern's node-CALL-to-METHOD edge type named CALL (the load-time METHOD_FULL_NAME linker) even in a renamed form — its mechanism (whole-graph relink) is structurally incompatible with D5/PR2, so this is a REJECT on the mechanism, not a naming disagreement to be smoothed over by alignment.
- to Ergonomics & Tool Budget: TAG/TAGGED_BY should not be counted against the 12-tool MCP budget (AM3) — it's a property/edge existing query tools can filter on, not a new agent-facing verb, so the marginal ergonomics cost is much lower than a full new node type.

**Concessions made:**
- Full CFG/PDG/REACHING_DEF deferral out of v1 is accepted without reservation — PR1's density argument and PR2's speed budget are sound and my needs don't override them.
- The expression tier (IDENTIFIER/LITERAL/FIELD_IDENTIFIER/REF) staying opt-in in v1 is accepted; I only ask that Joern's exact names be reserved for when it ships.
- Joern's automatic load-time CALL-edge linker is rightly out of scope entirely (not just deferred) — SYMBOL indirection is the correct incremental-safe replacement, not a stopgap.

## Code Complexity & Maintainability -- Round 1

**Top priority:** METHOD and TYPE_DECL must carry complexity metrics (cyclomatic_complexity, max_nesting_depth, loc, visibility) as computed scalar properties at parse time — not as materialized CONTROL_STRUCTURE/BLOCK nodes — so hotspot and god-class detection work in v1 without the expression/CFG tier.

## Top priority: complexity signal without CFG

A "hotspots" tool needs cyclomatic complexity, nesting depth, and size per method/class. Joern gets this by materializing CONTROL_STRUCTURE nodes (IF/FOR/WHILE/SWITCH/TRY) and BLOCK nodes as first-class AST nodes, then counting them via CPGQL traversals at query time. That is the wrong move for us: PR1 already measures the expression tier at ~7x node-count density, and CONTROL_STRUCTURE/BLOCK belong to that same dense AST-tier world (D23 explicitly defers CFG). If we adopt them as nodes, every `if` and every `{}` block in the workspace becomes a graph row, and my lens's queries turn into expensive traversals over a table that grew 7x for no benefit metrics can't already get statically.

**REJECT (for v1, not forever): CONTROL_STRUCTURE, BLOCK, MODIFIER, JUMP_TARGET, JUMP_LABEL, RETURN-as-node.** None of these need to exist as graph nodes for complexity/maintainability metrics. A frontend can compute cyclomatic complexity (branches+1), max nesting depth, and LOC during the same AST walk that produces METHOD/TYPE_DECL, and simply write the numbers as scalar properties. This is strictly additive later — nothing about storing `cyclomatic_complexity: 14` on a METHOD node precludes adding real CONTROL_STRUCTURE nodes in a future CFG overlay (RK1 satisfied), it just means v1's hotspots tool doesn't pay AST-tier density to get a number a compiler pass can hand it directly.

**EXTEND: METHOD.cyclomatic_complexity, METHOD.max_nesting_depth, METHOD.loc.** These are the single highest-value addition my lens can propose. Without them, "find the most complex methods in this file" either requires the expression tier (violates PR1) or requires this lens to give up and only report LOC-by-range (weak signal — a 40-line switch and a 40-line straight-line function are not equally risky). Cheap to compute, zero ontology cost (properties, not new labels), directly serves AM3 (still one node type to query, `MATCH (m:METHOD) WHERE m.cyclomatic_complexity > 10`).

**EXTEND: METHOD.visibility.** MEMBER already has `visibility`; METHOD does not. Public-API-surface vs. internal-complexity is a real distinction for coupling analysis (a complex private helper is a local maintainability problem; a complex public method is also an API-design problem for every caller). Cheap, symmetric with MEMBER, worth adding.

**REJECT duplication: TYPE_DECL.method_count / member_count as stored properties.** God-class fan-out (`too many methods/members`) is already answerable via `DECLARES` fan-out count (`MATCH (t:TYPE_DECL)-[:DECLARES]->(x) RETURN t, count(x)`), which is index-backed and cheap per PR2's own benchmark philosophy. Don't duplicate what a one-hop aggregate already gives you — that's ontology bloat against a metric this lens can get for free.

**ADOPT AS-IS: METHOD, TYPE_DECL, CALL** — names match Joern, which matters for my lens specifically because hotspot/cycle queries are exactly the kind of query someone will want to sanity-check against a Joern-produced graph on a shared repo (section 5's differential-export oracle). Keeping the labels aligned costs nothing and buys a correctness check for free.

**ADOPT (draft's) DECLARES, IN_METHOD, D5's SYMBOL indirection** — these three together are what make dead-code and coupling analysis possible without a global load-time linker: fan-in per SYMBOL (`MATCH (c:CALL)-[:CALLS]->(s:SYMBOL) WHERE s.fqn = ...`) is O(edges to that symbol) and survives per-file incremental replace. A SYMBOL with zero incoming CALLS/IMPORTS edges is my lens's dead-code candidate query, and it stays cheap and correct exactly because CALLS never points directly at another CPG node (Joern's METHOD_FULL_NAME-linker model would force a full-graph re-link to keep this query trustworthy after every save — a nonstarter for PR2).

**EXTEND: an analytics-tier `FILE -[:DEPENDS_ON]-> FILE` edge, computed and refreshed like COMMUNITY**, not a structural-tier edge. Import-cycle detection currently requires walking IMPORT→SYMBOL→(DEFINES-reverse)→MODULE.file per import, which is fine for one file but the wrong shape for "find all cycles in the workspace" — that wants a materialized file-level graph a cycle-detection algorithm can run over directly, the same way COMMUNITY is a periodic derived overlay rather than a live-computed one. This keeps the sparse structural tier untouched.

**Section 6 CONTAINS collision:** my lens uses IN_METHOD constantly (it's how "what does this method call" and "callers_of" both resolve) and it already avoids the name collision by not being called CONTAINS. My recommendation: rename the filesystem nesting edge (DIRECTORY→DIRECTORY|FILE) away from CONTAINS — e.g. to `DIR_ENTRY` — and leave CONTAINS free rather than repurposing it. IN_METHOD's existing name and direction should stand as-is.

**Proposed additions/changes:**
- [property] METHOD.cyclomatic_complexity -- Computed as a scalar at parse time (branches+1) instead of materializing CONTROL_STRUCTURE nodes; gives hotspot queries a direct complexity signal without paying AST-tier density, and is additive if a future CFG overlay adds real CONTROL_STRUCTURE nodes.
- [property] METHOD.max_nesting_depth -- Deep nesting is a distinct maintainability smell from raw branch count (e.g. a flat switch with 10 cases vs. 4 levels of nested if); needs its own scalar, computed the same AST walk as cyclomatic_complexity.
- [property] METHOD.loc -- FILE already has loc; METHOD does not, forcing every 'long method' query to derive it from range.start/range.end at query time instead of filtering an indexed property directly.
- [property] METHOD.visibility (cf. Joern MODIFIER (partial, not adopted as a node)) -- MEMBER already has visibility; METHOD lacks the symmetric property, which is needed to distinguish public-API complexity (a coupling risk for every caller) from private-helper complexity (a purely local concern).
- [edge] DEPENDS_ON (FILE -> FILE, analytics-tier, computed like COMMUNITY) -- Import-cycle detection needs a materialized file-level dependency graph to run a cycle algorithm over cheaply; deriving it live via IMPORT->SYMBOL->DEFINES-reverse per file pair is the wrong shape for a workspace-wide cycle scan, same reasoning that justifies COMMUNITY as a periodic derived overlay rather than a live traversal.

## Graph Analytics & Path Tracing -- Round 1

**Top priority:** The SYMBOL indirection must not force every centrality/PageRank/call-graph traversal to pay a 3-hop tax on what is logically a single edge — we need a materialized, rebuildable shortcut edge for resolved call/import/inheritance targets, exactly mirroring Joern's own linker-created "Shortcuts" layer, sitting alongside (not replacing) SYMBOL.

## Top priority: the SYMBOL tax on projections

D5's SYMBOL indirection is correctly non-negotiable for incremental safety, but as drafted it means a logical "A calls B" edge for call-graph analytics is actually `CALL-[CALLS]->SYMBOL<-[DEFINES]-METHOD` — a 3-hop pattern for what PageRank, betweenness centrality, and any "blast radius of this change" traversal need as a single monopartite edge. At v1's stated density (~450 CPG nodes/file) this is survivable per-query, but it compounds badly for whole-graph analytics runs and for the visualization pane's "load a scoped neighbourhood" case, where every extra hop is a fan-out through SYMBOL's (likely high-degree) nodes.

Joern already solved this exact tension: METHOD_FULL_NAME is a *soft string reference* at frontend-creation time, and the CALL **edge** type (distinct from the CALL **node** type) is a materialized shortcut, created only by the linker/overlay pass in Joern's "Shortcuts" schema layer — explicitly *not* something a frontend is allowed to create. That is the same pattern I'm asking for, just with a graph node (SYMBOL) instead of a bare string as the soft reference.

**EXTEND**: add `TARGETS`: `CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL`, populated only when resolution status is `resolved` and the target lives in this graph. It is computed in the same resolution pass that already sets `CALLS.status`, is fully rebuildable (satisfies PR3), and needs no transactional atomicity with the per-file write since it is derived, not authoritative — SYMBOL stays the identity source of truth, `TARGETS` is purely a query-perf projection. One new edge name covers three projections I need (call graph, import graph, inheritance graph), which is cheap against the AM3 budget for the value it returns.

## Section 6 ruling: CONTAINS collision

**RENAME** our filesystem edge away from `CONTAINS` — propose `DIR_CONTAINS` (or `PATH_CHILD`). It costs nothing today (greenfield, no persisted data) and it frees `CONTAINS` for its Joern meaning (METHOD → contained CFG node) if/when D23's CFG layer lands, rather than shipping a name that means the opposite of what every Joern-literate reader will assume. **Keep `IN_METHOD` as-is** — do not "fix" the collision by renaming it to a reversed `CONTAINS`; that recreates the exact problem one hop later. IN_METHOD's direction (CALL→METHOD) is fine for graph-analytics purposes — FalkorDB traverses relationships in either direction at comparable cost, so this is a naming question, not a performance one.

## Other calls

- **IMPORT is unreachable by edge from its MODULE** — only a `.file` property links them. For neighborhood-scoped loading and a clean file-level import-graph projection this should be a real edge, not a property scan. **EXTEND**: broaden `DECLARES`'s target set to include `IMPORT` rather than inventing a new name.
- **Module-level calls have no home.** `IN_METHOD` only targets METHOD, but TS/Python both have real top-level side-effecting calls (route registration, decorators-as-calls, module init). Any impact-of-change trace that stops at "not in a method" undercounts. **EXTEND**: broaden the target to `METHOD|MODULE` (rename to `IN_SCOPE` if that reads better) so no call is an analytics dead-end.
- **COMMUNITY/MEMBER_OF**: the run_id-on-both-node-and-edge shape is right (ADOPT AS-IS) — it lets multiple algorithm runs coexist without deletion, consistent with the project's explicit-state ethos. Two cheap additions: (1) a `projection`/`edge_basis` property on COMMUNITY recording which edge set the algorithm ran over (calls-only? calls+imports?) — without it the grouping is uninterpretable; (2) a `level` int (default 0) to leave room for hierarchical/multi-resolution community detection (Louvain dendrograms) later, since the visualization pane will eventually want a "zoom out" view.
- **NAMESPACE/NAMESPACE_BLOCK**: **REJECT**. These exist in Joern mainly to merge C-family namespaces declared across multiple files; TS/Python module scoping is already file-scoped and fully covered by MODULE + DIRECTORY. Adding them buys nothing and costs ontology budget.
- **DOMINATE/POST_DOMINATE/CDG/REACHING_DEF**: correctly deferred with D23, but flagging now for the record — these are exactly what "blast radius" / dominance-based impact analysis needs, and when CFG/PDG ship I want them **ADOPTED AS-IS** (standard compiler-theory names, no reason to rename).

I have no strong opinion on TYPE_ARGUMENT/TYPE_PARAMETER/BINDS/BINDS_TO/INHERITS_FROM specifics — that's the Type System lens's territory, though I do want EXTENDS/IMPLEMENTS included in the `TARGETS` shortcut above since inheritance is a real edge in impact-of-change traversal.

**Proposed additions/changes:**
- [edge] TARGETS (cf. Joern CALL (edge type, in Joern's Shortcuts layer)) -- Materialized, rebuildable shortcut from CALL|IMPORT|TYPE_DECL directly to the resolved in-graph METHOD|TYPE_DECL, computed during the same resolution pass that sets CALLS.status. Avoids a 3-hop SYMBOL detour on every call-graph/import-graph/inheritance-graph edge for centrality, PageRank, and impact-of-change traversal. Mirrors Joern's own pattern of a soft reference (METHOD_FULL_NAME / our SYMBOL) plus a linker-materialized shortcut edge, so it does not compromise D5/PR5 incrementality — it is derived, not authoritative.
- [edge] DIR_CONTAINS (cf. Joern CONTAINS (renamed away from, to resolve the section 6 collision)) -- Frees the name CONTAINS for eventual alignment with Joern's METHOD-contains-CFG-node semantics when D23's CFG layer ships, instead of shipping a filesystem-nesting edge that means the opposite of what Joern-literate readers will assume CONTAINS means.
- [property] COMMUNITY.projection -- Records which edge set (calls-only, imports-only, calls+imports, etc.) the community-detection algorithm ran over, so a consumer can interpret what a given community actually groups by.
- [property] COMMUNITY.level -- Reserves room for hierarchical/multi-resolution community detection (e.g. Louvain dendrogram levels) for a future 'zoom out' visualization view, at near-zero schema cost now.
- [edge] DECLARES (extend target set to include IMPORT) (cf. Joern AST (partial analogue)) -- IMPORT currently has no edge back to its containing MODULE, only a .file property — makes file-scoped neighbourhood loading and file-level import-graph projection a property scan instead of a graph traversal. Reusing DECLARES avoids adding a new edge name against the AM3 budget.

**Concessions made:**
- Type-system-specific Joern edges (BINDS, BINDS_TO, INHERITS_FROM, TYPE_ARGUMENT, TYPE_PARAMETER) are outside my lens's core concern beyond wanting EXTENDS/IMPLEMENTS folded into the TARGETS shortcut for impact-of-change traversal; I defer their detailed shape to the Type System lens.
- I'm not taking a position on expression-tier (IDENTIFIER/LITERAL/REF) inclusion timing — that's primarily a sparsity/PR1 tradeoff for another lens, though I'd want REACHING_DEF and REF prioritized over LITERAL/IDENTIFIER whenever the expression tier does get built, since data-flow beats raw AST density for analytics.

## Incremental Update & Identity -- Round 1

**Top priority:** Every edge into or out of a :CPG node must survive that node being deleted and recreated on the next save of its own file — which means proving, for MEMBER_OF in particular, whether our per-file replace transaction is MERGE-on-id or DELETE+CREATE, because that undocumented choice is the actual fault line D5/SYMBOL was built to protect and the current draft has one edge (MEMBER_OF) that walks right past it.

## The one test that matters
My only question for any node or edge, old or new: does it survive `DiffGraph.replace(file)` without orphaning a cross-file pointer or requiring a whole-graph reload? Section 6's CONTAINS collision and section 9's "adopt Joern where it overlaps" recommendation both have to clear this bar before naming or interop considerations get a vote.

## CONTAINS collision: RENAME ours, decisively
Joern's CONTAINS (METHOD → CFG node) is a load-time-linked, whole-method containment relation. Our filesystem CONTAINS (DIRECTORY → DIRECTORY|FILE) is a completely different concept, and critically, **Joern has no DIRECTORY node and no filesystem-tree concept at all** — its FileSystem layer is overlay/linker-only (section 5) and never produces a directory hierarchy. So reusing the name "CONTAINS" buys us zero interop credit — there is nothing on Joern's side to align with — while creating exactly the misreading section 6 warns about. Verdict: **ADOPT RENAMED** → `HAS_ENTRY` (DIRECTORY → DIRECTORY|FILE). This edge is mutated only by GE-UC5 (move/rename), never by the per-file :CPG subgraph replace, so renaming it costs nothing incrementally. `IN_METHOD` (CALL → METHOD) I'd leave exactly as drafted: it already avoids the collision, and since CALL and METHOD are always co-located in the same file's subgraph, direction is a pure query-ergonomics call with zero identity cost either way — I defer that to whoever owns agent ergonomics.

## SYMBOL indirection: REJECT Joern's CALL/INHERITS_FROM/BINDS_TO model outright
Joern resolves CALL, INHERITS_FROM, and BINDS_TO by a global load-time linker walking METHOD_FULL_NAME/TYPE_FULL_NAME strings across the *entire* graph. That is structurally incompatible with a 24ms single-file replace under concurrent readers (PR2) — it requires relinking, not a bounded cascade. Our CALLS/IMPORTS/EXTENDS/IMPLEMENTS → SYMBOL model is the correct answer and I **REJECT** any softening of it toward Joern's direct-edge shape, no matter what the differential-export oracle (section 5/9) tempts us with. That oracle is a legitimate reason to align *names*, never a reason to reopen the *resolution mechanism*.

General rule I want other lenses to test every future proposal against: **the SYMBOL boundary is drawn at the file boundary, not the node-tier boundary.** Intra-file-only edges (a future REF for expression tier, CFG, REACHING_DEF/PDG) never need SYMBOL indirection, however deep the tier gets, because both endpoints die and are reborn together on the same save. Anything that can legitimately point at another file's node must indirect through SYMBOL. This is also why RK1's deferred CFG/PDG doesn't scare me: as long as it's recomputed per-changed-method, not as a whole-graph dominance pass the way Joern's DOMINATE/POST_DOMINATE/CDG are, it stays incremental.

## Two concrete risks in the current draft
1. **MEMBER_OF is the one edge that skips SYMBOL and points at a node that gets deleted+recreated on save.** COMMUNITY → METHOD/TYPE_DECL/FILE only survives a save if the replace transaction is MERGE-on-id, preserving the underlying vertex; if it's DELETE-all+CREATE-all, every analytics edge into a touched file's nodes is silently severed every save. This needs an explicit, tested answer, not an assumption — I'm proposing it as a required addition below.
2. **REJECT Joern's SOURCE_FILE edge.** We already tag `file` as a property on every :CPG node, which is exactly the shared-label index the PR2 benchmark measured a 13x indexed-delete speedup on. Trading that property for an edge would directly undercut the mechanism our own incrementality claim depends on.

## Minor identity note
CALL is the hardest id case in the whole schema — a method calling the same function twice needs an ordinal scoped to its *parent method*, not the file, or PR5's "insert-above → 0 id changes" guarantee breaks the moment someone adds an unrelated call above it. Worth an explicit golden-file test (section 8's SCIP-corpus spirit applies here too), not just a property name.

**Proposed additions/changes:**
- [edge] HAS_ENTRY -- Replaces the filesystem-layer CONTAINS edge to resolve the section 6 naming collision. Joern's FileSystem layer is overlay-only and has no DIRECTORY-tree concept at all, so the old name bought zero interop value while inviting exactly the misreading section 6 flags.
- [other] MERGE-on-id write contract for per-file :CPG replace -- GE-UC2 says 'replace the file's :CPG subgraph in one transaction' but never states whether that's DELETE-all+CREATE-all or MERGE keyed on the stable id. Only MERGE preserves the underlying graph vertex that any inbound edge from a non-SYMBOL, non-file-scoped node (MEMBER_OF today, any future overlay/analytics edge tomorrow) depends on to survive a save. This needs to be an explicit, tested contract, not an implementation detail left to whoever writes the DiffGraph code.
- [other] Parent-scope-relative ordinal for CALL identity -- PR5's measured 'insert-above -> 0 id changes' guarantee only holds for CALL nodes if duplicate calls within one method are disambiguated by an ordinal scoped to the parent METHOD's qualifiedScopePath, not a file-relative position. Worth a golden-file test case (two identical call expressions in one function, then an unrelated statement inserted above) rather than trusting the id_rule prose alone.

**Rebuttals:**
- to Standards & Interoperability: The differential-export oracle (joern-export --format=neo4jcsv vs our FalkorDB dump) is worth having, but it only requires our NODE/EDGE NAMES to line up with Joern's — it is not an argument for adopting Joern's load-time-linked resolution semantics for CALL/INHERITS_FROM/BINDS_TO, which are structurally incompatible with per-file replace. Don't let 'the oracle wants it' become the reason to soften D5.
- to Sparse-by-Design / Density: I'll back rejecting Joern's per-operator CALL desugaring on density grounds alone, but note there's a second, independent reason: 7x more CALL-shaped nodes means 7x more surface area where the ordinal-vs-bodyHash id scheme has to be gotten right, for zero incremental-replace benefit since these are single-purpose, intra-file nodes anyway.
- to Agent Ergonomics / Tool Budget: If you want to collapse IN_METHOD into DECLARES to save a relationship type against the 12-tool budget, I have no PR5/D5 objection — both are intra-file edges with identical replace-survivability. Just confirm consumers never need to tell 'declared inside' apart from 'called inside' (e.g. a call inside a nested callback that isn't itself a declared METHOD) before merging them.

**Concessions made:**
- Property-name bikeshedding (Joern's `code`/`lineNumber`/`columnNumber` vs our current names) is Standards & Interoperability's call, not mine — as long as no such property is ever incorporated into the id computation itself (id must stay derived from path:kind:qualifiedScopePath[:ordinal|:bodyHash] only).
- The direction of IN_METHOD (CALL->METHOD) vs Joern's CONTAINS(METHOD->CALL) is a query-ergonomics decision, not an identity-survivability one, since both endpoints are always intra-file and co-replaced — I defer the direction call to whichever lens owns agent/query ergonomics.
- I have no objection to COMMUNITY/MEMBER_OF existing in v1 as drafted, conditional only on the merge-on-id write contract below being confirmed or on MEMBER_OF being explicitly documented as fully regenerated after every cascade (in which case transient orphaning during the gap doesn't matter).

## Agent / MCP Consumption Ergonomics -- Round 1

**Top priority:** Keep the agent-facing vocabulary small and single-pattern, and resolve the CONTAINS collision now — reject Joern's expression-tier density, collapse resolution-signaling onto one consistent edge-status pattern, and never let an agent guess which CONTAINS it's looking at.

I'm the one who has to write correct Cypher cold, from a schema resource and at most 12 tool descriptions, with no human in the loop to explain a surprising result. My test for every type in this debate: does an agent write the right query the first time, and can it tell how much to trust what comes back?

**Sparse tier: REJECT Joern's expression vocabulary for v1, full stop.** IDENTIFIER, LITERAL, FIELD_IDENTIFIER, LOCAL, METHOD_REF, TYPE_REF, BLOCK, CONTROL_STRUCTURE, RETURN, JUMP_TARGET, JUMP_LABEL, and the 74 `<operator>.*` CALL constants are not things an agent asking "what does this function call" or "who implements this interface" should ever have to filter out of a result set. PR1's ~7x density gap isn't only a storage cost, it's a cognitive one — every extra label is a label an agent must learn to exclude from a MATCH. CALL folding args/receiver/kind into properties instead of child nodes (v1 draft) is the right call: ADOPT AS-IS.

**SYMBOL indirection is an agent-ergonomics win, not just an incrementality win.** ADOPT, and EXTEND beyond what Joern documents — Joern has no queryable resolution-confidence signal at all; a CALL's METHOD_FULL_NAME is either right or silently wrong after the global linker runs. `CALLS -> SYMBOL {status(resolved|ambiguous|external|unresolved|dynamic)}` gives the agent something to branch on: "resolved, cite it confidently" vs "ambiguous, say so" vs "external, don't chase it." That's the single most agent-useful property in the whole draft.

**status/version on every :CPG and FILE node (D21/PR8): EXTEND relative to Joern, and non-negotiable.** Joern's graph has no notion of "this part might be stale or mid-index" — a node is just there. An agent that can't tell `stale`/`indexing`/`error` from `ready` will confidently answer from a half-rebuilt graph. This is worth a line in every tool description: "callers should treat non-`ready` results as provisional."

**One real inconsistency I want fixed before v1 ships: resolution signaling has two competing patterns.** CALL carries `resolved(bool)` *and* the CALLS edge carries a richer `status` enum — two sources of truth for the same question. IMPORT carries `resolved(bool)` but the IMPORTS edge carries no status at all, unlike CALLS. An agent has to remember, per edge type, whether to check a node bool or an edge enum. Fix: one pattern everywhere — resolution status lives on the *edge* as the four/five-value enum, never as a bare bool on the node. EXTEND: add `status` to IMPORTS matching CALLS; then drop `resolved` from both CALL and IMPORT.

**CONTAINS collision (Section 6): rename our filesystem edge, don't touch Joern's meaning.** An agent trained on or shown Joern docs will read `CONTAINS` as "physically inside this body," which is the opposite of "this file lives in this directory." Worse, D23 says CFG is deferred, not gone — the day we add it, Joern's `CONTAINS(METHOD->CALL)` and our filesystem `CONTAINS(DIRECTORY->FILE)` would coexist under one name in the same schema resource. Rename now while it's free: `DIRECTORY -[:HAS_CHILD]-> DIRECTORY|FILE`. Reserve `CONTAINS` for the Joern-shaped meaning if/when CFG lands. `IN_METHOD` is fine as-is — different name from Joern's reversed `CONTAINS`, no collision, and honestly a better name for what an agent is asking ("what method is this call in") than Joern's direction gives you for free.

**EXTENDS / IMPLEMENTS as two direct edges: ADOPT (v1) over Joern's BINDING/BINDS/BINDS_TO/INHERITS_FROM machinery, REJECT that machinery for v1.** An agent asking "does X implement Y" wants one edge to traverse, not to reconstruct dispatch resolution from three node/edge types built for a linker's method-resolution-order computation we don't do.

**Abstract Joern base types (AST_NODE, CFG_NODE, EXPRESSION, DECLARATION, CALL_REPR): REJECT as schema, but keep the *idea*.** They're Scala type-hierarchy scaffolding with no Cypher shape. Our shared `:CPG` label already gives an agent the "match anything code-related regardless of kind" query it would otherwise reach for these for — ADOPT `:CPG` as strictly better here.

**Tool-budget spillover: watch COMMUNITY/MEMBER_OF.** I don't oppose the node, but I won't spend one of 12 tool slots on a dedicated community-query tool until a concrete agent task needs it — expose it through the general Cypher escape hatch instead, not a first-class tool.

**Proposed additions/changes:**
- [edge] HAS_CHILD (cf. Joern CONTAINS (name collision only — different relation)) -- Renames the v1 draft's filesystem-nesting CONTAINS (DIRECTORY -> DIRECTORY|FILE) so the name CONTAINS stays free for a future Joern-shaped METHOD->CFG-node meaning if CFG lands (D23), and so an agent never has to disambiguate two unrelated relations sharing one name.
- [property] IMPORTS.status (cf. Joern no equivalent (Joern's IMPORT/IMPORTS are Hidden, unspecced)) -- Mirrors CALLS.status so resolution confidence always lives on the edge as the same enum shape across the whole schema — one pattern for an agent to learn instead of a per-edge-type special case.
- [other] remove CALL.resolved and IMPORT.resolved bool properties -- Redundant with the richer edge-level status enum once IMPORTS.status exists; two sources of truth for the same fact is an ergonomics tax an agent pays on every query that needs to check trust.

**Rebuttals:**
- to Standards & Interoperability: The differential-export oracle against Joern (Section 5) is a real testing asset, but it doesn't require the agent-facing v1 schema to carry expression-tier density — run the oracle against a separate detailed/export-only mode or a test fixture, not against the primary schema an agent queries daily.
- to Performance / Storage: If SYMBOL indirection's extra join is raised as a cost, the tradeoff still favors keeping it: the query-time hop is cheap and indexed, while the resolution-confidence signal it carries is what lets an agent avoid confidently reporting a wrong or ambiguous call site.
- to Completeness / Correctness: If someone argues for keeping both CALL.resolved (bool) and CALLS.status (enum) for redundancy/safety, push back: redundant signals that can drift out of sync are worse for an agent than one enforced source of truth — add a test that keeps status correct, don't add a second property as a hedge.

**Concessions made:**
- The expression tier shouldn't be deleted from the schema entirely — keeping it as a documented, opt-in escape hatch (clearly marked as rare/advanced in the schema resource) is fine, as long as the default agent-facing surface stays sparse.
- COMMUNITY/MEMBER_OF can stay in the schema as a node type even without a dedicated tool in the v1 12-tool budget; my objection is only to spending a scarce tool slot on it prematurely, not to modeling it at all.
- Naming fights (e.g. PARAM vs METHOD_PARAMETER_IN, MODULE vs NAMESPACE_BLOCK) matter less to me than the resolution-signaling consistency and the CONTAINS rename — I'll defer to whatever the Standards lens argues on pure naming as long as the underlying shape stays sparse and single-pattern.

## Cross-Language & Symbol Resolution -- Round 1

**Top priority:** Nail down SYMBOL identity and canonicalization under re-export/alias chains (TS barrel files and re-exports, Python __init__.py re-exports) before anything else, because every other cross-language guarantee (comparable CALLS resolution, comparable IMPORTS/EXTENDS) is only as good as "does this fqn always point at the one true definition."

## SYMBOL / SCIP descriptor grammar: ADOPT AS-IS, but EXTEND with a first-class alias edge

D5's SCIP-descriptor SYMBOL is the single most important decision in the whole draft for this lens, and I ADOPT it as-is against Joern's alternative. Joern's own FULL_NAME format (`Test0.ts::program:Greeter:foo`, per section 9) is a display string produced by its global load-time linker, not a resolution mechanism designed for cross-package identity — it bakes file path into the identifier and has no notion of package/manager/version. SCIP's descriptor grammar was built for exactly the problem we have (a symbol defined in one file, consumed through an arbitrary chain of re-exports/aliases across a workspace, sometimes across package boundaries later). Any push to "align wholesale" with Joern's naming (section 9's own framing of the research recommendation) must stop at the SYMBOL boundary — adopting FULL_NAME-shaped strings here would be a straightforward regression.

But the current draft is incomplete for TS/Python re-export patterns: barrel files (`export * from './x'`), `export { X as Y }`, Python `from .foo import bar as baz` inside `__init__.py`, and multi-hop re-export chains all currently resolve only through the `IMPORT.alias` *string property*. That means "find the canonical symbol" requires chasing string properties across files rather than a graph traversal — exactly the kind of thing Cypher is good at and string properties are bad at. I propose **EXTEND**: add `ALIAS_OF: SYMBOL -> SYMBOL`, adapting Joern's real (if recent) `ALIAS_OF` edge. This lets a resolver do `MATCH (s:SYMBOL)-[:ALIAS_OF*0..]->(canonical)` instead of re-parsing alias strings, and it prevents SYMBOL proliferation (one alias hop must never mint a second "real" SYMBOL for the same entity). This is worth doing in v1, not deferred — it's cheap (one edge type) and it's exactly the seam where TS and Python re-export idioms diverge in syntax but converge in meaning, so it's a good test of whether the ontology actually generalizes.

## METHOD.kind and TYPE_DECL.kind: mostly ADOPT the draft's enum, EXTEND with orthogonal flags instead of new kind values

`async` is already a separate boolean on METHOD, which is right — I want the same treatment for **generators**: TS generator functions/async generators and Python generators/async generators are an orthogonal axis, not a `kind`. I propose EXTEND: add `METHOD.generator (bool)`, sibling to `async`, so `kind × async × generator` composes cleanly across both languages instead of needing `lambda_named_async_generator`-style kind explosion. Joern has no clean equivalent here (it desugars generator bodies into CONTROL_STRUCTURE/BLOCK machinery, which is expression/CFG tier we've deferred) — this is a place our sparser model needs its own answer.

Similarly, Python's `TypedDict`/`NamedTuple`/`Protocol` and TS `interface` are all *structural* type declarations, contrasted with *nominal* `class`/`dataclass`/`enum`. Rather than growing `TYPE_DECL.kind` per decorator/keyword pair per language, I propose EXTEND: add `TYPE_DECL.structural (bool)`. This keeps the kind enum from becoming a language-specific dumping ground and gives cross-language queries ("show me all structural contracts this class satisfies") a single predicate instead of an `IN [...]` list that has to be kept in sync with two languages' vocabularies.

## REJECT for v1: METHOD_REF, TYPE_REF, REF, BINDING/BINDS/BINDS_TO, TYPE/TYPE_PARAMETER/TYPE_ARGUMENT, CLOSURE_BINDING

All of these are expression-tier or full-generics/data-flow machinery (PR1, D23 already defer this) — I flag them only to note a real gap they leave: passing a function as a value (`array.map(fn)`, a Python callback param) currently produces no edge at all in the structural tier, since it's neither a CALL nor an IMPORT. That's an honest call-graph completeness gap, not a bug to fix now — track it as a risk alongside RK1, don't let it justify smuggling IDENTIFIER/METHOD_REF back in through the side door.

I specifically REJECT adopting Joern's `BINDING`/`BINDS`/`BINDS_TO` (its vtable-style polymorphic dispatch resolution mechanism) even for later. It requires whole-type-hierarchy computation at load time — structurally the same global-linker problem D5 rejected Joern's CALL-edge model for. Keep `CALLS.status=ambiguous` (a single edge, honestly labeled uncertain) rather than reintroducing a multi-candidate binding table.

## CALLS.status: needs precise, per-language-neutral definitions, not just five names

`resolved/ambiguous/external/unresolved/dynamic` only works cross-language if "dynamic" and "ambiguous" mean the same thing in both frontends. I propose the debate pin down: **dynamic** = target determined by a runtime dispatch mechanism the frontend cannot follow statically (`getattr(obj, name)()`, computed member access, Python `__getattr__`/`__call__` overrides, TS `obj[key]()`); **ambiguous** = multiple statically-plausible static candidates exist (overload sets, duplicate imports). Without this written down, one language's frontend will silently use "ambiguous" for what the other calls "dynamic," and cross-language callers_of queries become unreliable — a correctness bug agents won't be able to detect.

## Section 6 CONTAINS collision (not my top priority, but I'll go on record)

I'm not the primary lens for this, but for symbol resolution purposes filesystem `CONTAINS` and Joern's method-body `CONTAINS` are never confused in practice because SYMBOL indirection means resolution never walks a directory tree — so I have no resolution-correctness objection to keeping the name, but I'd still support renaming ours (e.g. `PARENT_DIR`) purely to stop humans/agents pattern-matching on Joern docs and assuming CFG-node containment exists in v1.

## On reprolang (section 8)

ADOPT reprolang as the base conformance target for resolver *logic* — forward-definition, duplicate-symbol handling, cross-file/cross-document linking are exactly our SYMBOL-resolution concerns and are genuinely language-neutral. But concede up front: reprolang is synthetic and will not exercise TS/Python-specific failure modes (decorator-wrapped functions changing effective identity, destructuring imports, Python name-mangled `_Class__attr`, re-export barrels). We need a small hand-written TS+Python golden fixture set alongside reprolang, not instead of it.


**Proposed additions/changes:**
- [edge] ALIAS_OF (SYMBOL -> SYMBOL) (cf. Joern ALIAS_OF) -- Models import-alias and re-export chains (TS barrel files/`export {X as Y}`, Python `__init__.py` re-exports) as a graph-traversable edge instead of a string property on IMPORT, so canonical-symbol resolution is a Cypher traversal and re-export hops never mint duplicate SYMBOL nodes for the same entity.
- [property] METHOD.generator (bool) -- TS and Python both have generator and async-generator functions; treating generator as an orthogonal boolean (sibling to the existing `async`) avoids combinatorial kind-enum growth and composes correctly across both languages. Joern instead desugars generator bodies into CFG/BLOCK machinery, which is expression-tier machinery we've deferred, so there is no direct borrow available.
- [property] TYPE_DECL.structural (bool) -- Distinguishes structural type declarations (TS interface, Python Protocol/TypedDict/NamedTuple) from nominal ones (class, dataclass, enum) with one predicate instead of growing the `kind` enum per language-specific keyword, keeping cross-language 'what contracts does this satisfy' queries uniform.

**Rebuttals:**
- to Standards & Interoperability: Section 9's 'align to Joern where names overlap' recommendation must not be read as license to align on SYMBOL's *format*. Joern's FULL_NAME strings are load-time-linker artifacts with no package/manager/version concept; adopting that shape for SYMBOL.fqn would break the SCIP descriptor grammar D5 already committed to and would regress our cross-package story with no compensating benefit — name-alignment yes, identity-format-alignment no.
- to Speed / Storage: If a performance-motivated push emerges to precompute Joern-style BINDING/vtable edges for O(1) virtual-call lookup, resist it: that computation requires a whole-type-hierarchy pass at load/update time, which is the same global-relink cost D5 rejected Joern's CALL-edge model for. A single CALLS.status=ambiguous edge is the right trade, not a multi-candidate binding table.

**Concessions made:**
- Joern's jssrc2cpg/pysrc2cpg frontend test suites, while not machine-reusable (Scala/ScalaTest/flatgraph), are worth mining by hand for the edge cases they enumerate (decorator handling, destructuring desugaring, generator bodies) even though I reject adopting their AST-level density.
- reprolang is a good base conformance target for resolver logic but is language-agnostic by design and will not catch TS/Python-specific identity bugs (decorator-wrapped function identity, name-mangled Python attributes, destructured imports); we still need hand-written golden fixtures per language.
- The section 6 CONTAINS collision is real and should be renamed even though it doesn't directly threaten symbol-resolution correctness under the SYMBOL-indirection model — I'll defer to whichever lens owns graph-structure ergonomics for the final name.

## Storage & Query Performance (Cypher/FalkorDB) -- Round 1

**Top priority:** Reject every Joern node type whose cardinality scales per-keyword, per-usage-site, or per-return-slot rather than per-declaration (MODIFIER, TYPE, METHOD_RETURN, the ANNOTATION family, TYPE_PARAMETER/TYPE_ARGUMENT) since each is a multiplicative tax on every node in the monorepo, and resolve the section-6 CONTAINS collision by renaming our filesystem edge before any query pattern gets written against it.

## Framing

My only concern is what happens on FalkorDB at monorepo scale: label-index cardinality, adjacency-list size, and whether a single-file atomic replace stays fast as the schema grows. Section 2's numbers are my constitution: 450 vs ~3,000 nodes per 300-line file is a 7x multiplier, and 24.2ms p50 atomic replace is the number every new node/edge type must not blow up.

## Reject Joern's per-token node explosions

- **MODIFIER — REJECT.** Joern emits one node per modifier keyword (`public`, `static`, `async`...) linked by AST. That's an unbounded multiplier per class member. Fold into `MEMBER.visibility` and `METHOD.exported/async` booleans, exactly as the draft already does. This is the single clearest anti-pattern in the whole spec for a property-graph store — a modifier is a property, not an entity.
- **METHOD_RETURN — REJECT.** Joern gives every method a dedicated return-type node (1:1 with METHOD, doubling method-adjacent node count) so it has an AST slot for CFG/return-flow overlays we've explicitly deferred (D23). Fold into a `return_type_text` string property on METHOD until PDG lands.
- **ANNOTATION / ANNOTATION_LITERAL / ANNOTATION_PARAMETER / ANNOTATION_PARAMETER_ASSIGN — REJECT.** Four node types plus edges for what the draft already handles as `CALL{kind:decorator} -> SYMBOL`. That's strictly sparser and reuses machinery we already need for calls. Keep the draft's approach; do not import Joern's annotation subgraph.
- **TYPE_PARAMETER / TYPE_ARGUMENT — REJECT for v1.** Generic instantiation sites are usage-site cardinality, the same failure mode as expression tier. Absorb into a `type_text` string (e.g. `Array<string>`) on PARAM/MEMBER/METHOD. EXTEND later only if an agent workflow needs generic-aware queries badly enough to justify the density.
- **TYPE (as distinct from TYPE_DECL) — REJECT for v1.** One node per type *reference* is exactly the expression-tier density PR1 opts out of by default. `type_text` string properties are the sparse equivalent; we give up string-based type-usage queries in exchange for staying inside the 450-node budget. That trade is deliberate.

## Reject a structural dependency Joern's own NAMESPACE creates

**NAMESPACE — REJECT for v1, and I'd argue never.** Joern's NAMESPACE is a *logical, cross-file merged* node — multiple NAMESPACE_BLOCKs (one per file) get linked into one NAMESPACE by an overlay pass. That means writing to it on save requires touching a node shared across files outside the one being replaced — precisely the cross-file mutation D5/SYMBOL indirection was built to avoid, and it would tank the 24.2ms single-file-transaction number. If we need "all files under package X," that's a `WHERE f.path STARTS WITH` scan on the FILE label index, not a merged node.

## Keep the draft's typed-edge decomposition over Joern's generic AST/REF

Joern uses one `AST` edge for all parent-child structure and one `REF` edge for most resolved references, disambiguated afterward by target-node label or property. Cypher/FalkorDB benefits from relationship-type-specific adjacency and per-type cardinality stats; collapsing DECLARES/HAS_PARAM/DEFINES back into a generic AST edge, or CALLS/IMPORTS/EXTENDS/IMPLEMENTS back into generic REF, would force every traversal to post-filter instead of letting the planner prune by edge type. **ADOPT RENAMED (keep the draft's split), REJECT Joern's generic AST/REF for our purposes.**

## SYMBOL indirection and CALLS properties

**ADOPT AS-IS (already-agreed D5).** From a pure write-path view this is the correct call: per-file replace never has to touch another file's edges. One addition I'd make: `CALLS.status` should get a relationship property index once FalkorDB's version here supports it, since "find all unresolved/dangling calls after a rename" is exactly the maintenance query D21/PR8's status model exists to answer, and it should not be a label scan.

## The CONTAINS collision (section 6) — explicit ruling

Rename the filesystem edge. Propose **HAS_ENTRY** (DIRECTORY -> DIRECTORY|FILE). This frees `CONTAINS` entirely, so if CFG lands later we can `ADOPT AS-IS` Joern's real `CONTAINS(METHOD -> CFG_NODE)` without a second collision. Keep `IN_METHOD` (CALL -> METHOD) as-is — direction doesn't cost anything in FalkorDB's adjacency storage, and `MATCH (c:CALL)-[:IN_METHOD]->(m:METHOD)` reads better for the callers-of-without-CFG use case than a reversed CONTAINS would.

## PARAM / MEMBER as their own labels

**ADOPT AS-IS (draft's own labels, not Joern's METHOD_PARAMETER_IN/OUT split).** Keep PARAM but **REJECT METHOD_PARAMETER_OUT** outright — it exists in Joern for by-reference/out-param languages (C++, PHP), which neither TS nor Python v1 needs. Don't pay for a label+index that never gets a row.


**Proposed additions/changes:**
- [edge] HAS_ENTRY (cf. Joern CONTAINS (deliberately renamed away from — name collision per section 6)) -- Frees the CONTAINS name for a future CFG-tier edge that would actually match Joern's METHOD->CFG_NODE semantics, and stops our filesystem-nesting edge from silently meaning the opposite of what anyone who knows Joern will assume.
- [property] return_type_text (cf. Joern METHOD_RETURN) -- Collapses a 1:1-with-METHOD node type into a string property; avoids doubling method-adjacent node count for a feature (return-type overlay hooks) we don't need until PDG/CFG land.
- [property] type_params_text (cf. Joern TYPE_PARAMETER / TYPE_ARGUMENT) -- Absorbs generic parameter/argument information as a string on TYPE_DECL/METHOD instead of one node per generic slot per usage site, keeping generics inside the structural-tier density budget.
- [status_value] resolvedBy enum values (declared|inferred|heuristic) -- If we index CALLS.status for the dangling-reference maintenance query, resolvedBy should be a small closed enum too so it can share the same property index cheaply rather than becoming a free-text field that forces a scan.
- [other] relationship-property index on CALLS.status -- D21/PR8 makes status a first-class trust signal; the 'find all unresolved calls after rename' query this enables is common enough (and cheap enough on FalkorDB) that it deserves an index rather than a label scan plus filter.

**Rebuttals:**
- to Standards & Interoperability: The section-9 recommendation to formalize 'already ~60% Joern-named' will be tempting to extend to MODIFIER/TYPE/METHOD_RETURN/ANNOTATION for the differential-export oracle in section 5 — but the oracle only needs a translation/mapping layer at export time, not identical in-store cardinality; don't let a nice-to-have correctness oracle justify a multiplicative storage cost we'd pay on every write and every scan forever.
- to Ergonomics / Agent Consumption: Folding modifiers, return types, and generics into string properties trades some queryability (can't cheaply ask 'find all public static methods' as a label match) for sparsity — I'd rather agents write one extra WHERE clause on a string property than have every method carry 3-5 satellite nodes.

**Concessions made:**
- I concede TYPE-as-usage-node might become necessary once an agent workflow demands cross-file type-usage queries that string matching on type_text can't serve well (e.g. rename-safety checks) — that's a real future EXTEND candidate, just not at v1's density budget.
- I concede the exact replacement name for the filesystem CONTAINS edge (I proposed HAS_ENTRY) is as much a naming/Standards call as a perf call — my requirement is only that the name stops colliding with Joern's CONTAINS before query code is written against it, not that HAS_ENTRY specifically wins.
- I concede CALLS carrying four properties (status, reason, confidence, resolvedBy) is fine for storage (edge properties are cheap relative to nodes) even though it's richer than Joern's plain CALL edge — this is a case where richness on an edge is nearly free and I have no perf objection to it.

## Standards & Interoperability -- Round 1

**Top priority:** Resolve the section 6 CONTAINS collision by renaming OUR filesystem edge away from CONTAINS — freeing that name for its one true Joern meaning if CFG ever lands — and require every other rename/rejection in this debate to clear the same bar: a specific, non-cosmetic reason, not merely "it fits our project."

## The collision must be resolved now, and in our favor to change

Section 6 is not a stylistic quibble — it's a correctness hazard. Anyone who has used Joern will read our `DIRECTORY -[:CONTAINS]-> FILE` and assume it means what Joern's `CONTAINS` means: METHOD → the CFG nodes physically inside its body. Ours means the opposite kind of thing (pure filesystem nesting, no code semantics at all). Shipping that is worse than not aligning at all, because it actively misleads anyone porting Joern intuition into our tool.

**Ruling: rename our filesystem edge to `PARENT_OF` (`DIRECTORY -[:PARENT_OF]-> DIRECTORY|FILE`).** This keeps `CONTAINS` unclaimed and available for its correct future use the day CFG lands (D23/RK1) — `METHOD -[:CONTAINS]-> BLOCK|CONTROL_STRUCTURE|CALL|RETURN`, identical to Joern. That is a free option on future interoperability; squatting on the name now for an unrelated purpose burns it. `IN_METHOD` (our `CALL -> METHOD`) isn't a name collision, just Joern's `CONTAINS(METHOD->CALL)` reversed and renamed — I'd leave it alone for now but flag it: once CFG's real `CONTAINS` exists, `IN_METHOD` becomes a derivable shortcut of it, and should be re-justified as a materialized-path optimization, not a parallel primitive.

## Adopt as-is — these are free wins already, formalize them

`TYPE_DECL`, `METHOD`, `MEMBER`, and `CALL` already match Joern's exact names and roughly its concept. No rename needed; just note it explicitly in the divergence doc so it reads as deliberate alignment, not accident. `IMPORT`/`IMPORTS` already match Joern's actual implementation (section 5's Hidden.scala) — cite that precisely as "matches implementation," never "matches spec," but keep the names.

Two more I'd actively add: **`META_DATA`** (one node per graph carrying schema/overlay version) costs almost nothing and directly serves D21's "state must always be explicit" principle — it's a natural home for schema-version bookkeeping that the current draft has no node for. And **`UNKNOWN`**, Joern's catch-all for unparseable content — this is a real robustness win for our incremental pipeline: when a parser chokes on a file, an `UNKNOWN` node (paired with the existing `status=error`) gives us a place to put "we saw something here and it failed" instead of silently dropping it. Neither eats meaningfully into the AM3 budget since agents rarely query either directly.

## Adopt renamed — earn the rename explicitly

Rename `PARAM` → **`METHOD_PARAMETER_IN`**, Joern's exact name for the concept. We don't need `METHOD_PARAMETER_OUT` (by-ref output params are a C/C++ concern, not TS/Python) — that's a legitimate omission, not a rename, and costs nothing to state plainly in the divergence doc.

Merge `EXTENDS`/`IMPLEMENTS` into a single **`INHERITS_FROM`** edge with a `relation` property (`extends`|`implements`). Joern already unifies these into one edge; adopting that shape is a rare case where alignment and our own AM3 tool-budget pressure point the same direction — fewer edge types, same information, plus alignment. I'd push hard for this one specifically because there's no load-bearing reason TS's extends/implements distinction needs two edge *types* rather than one edge with a property, the same way `CALL.kind` already distinguishes call/new/decorator/await on one edge.

Keep `CALLS` (not Joern's bare `CALL`) as a deliberate, justified divergence: Joern overloads `CALL` as both a node label and an edge label, which is genuinely confusing to carry into Cypher pattern-matching. `CALLS` avoids that ambiguity. This is the kind of rename my brief should approve of — it earns its keep with a concrete parsing/readability argument, not vibes.

## Extend — no Joern equivalent, and that's fine when it's structural

`DIRECTORY` (Joern's 39 concrete node types have no filesystem-tree node at all — FileSystem is an overlay-only layer in its own conformance model, so we're not diverging from anything, we're filling a real gap). `SYMBOL` and `COMMUNITY` likewise have no Joern equivalent — I address SYMBOL honestly below.

## Where I concede the divergence is load-bearing, not cosmetic

Two things cut against my own brief and I won't soften them. First, **SYMBOL indirection (D5) has no Joern equivalent because it can't** — Joern's `CALL` edge is created by a global load-time linker over `METHOD_FULL_NAME`, which structurally requires whole-graph relinking. That is incompatible with per-file incremental replace (PR2/PR3), full stop. Second, **SCIP's descriptor grammar for `SYMBOL.fqn` is genuinely incompatible with Joern's `FULL_NAME`** format (e.g., `Test0.ts::program:Greeter:foo`) — adopting Joern's naming convention here would mean giving up SCIP interop we already have. Both are real, structural, not stylistic. I'd rather say so plainly now than have another lens "discover" it later and use it to discredit the alignment argument everywhere else.

One more concession: Joern's `MODIFIER`-as-node and its 74 `<operator>.*` CALL desugaring are exactly the density PR1 measured and rejected (7x). I won't argue for adopting those; folding modifiers/operators into properties is correct, and conceding this cleanly protects my credibility on the calls I do want to win.


**Proposed additions/changes:**
- [edge] PARENT_OF -- Renames our filesystem-nesting edge away from CONTAINS to resolve the section 6 collision, freeing CONTAINS for its correct future Joern-aligned use (METHOD -> CFG nodes) if/when CFG lands.
- [node] METHOD_PARAMETER_IN (cf. Joern METHOD_PARAMETER_IN) -- Rename PARAM to Joern's exact name at zero cost; METHOD_PARAMETER_OUT is legitimately omitted (no by-ref out-params in TS/Python), not renamed.
- [edge] INHERITS_FROM (cf. Joern INHERITS_FROM) -- Merge EXTENDS/IMPLEMENTS into Joern's single edge name with a relation property — reduces vocabulary (helps AM3) and aligns with Joern simultaneously.
- [node] UNKNOWN (cf. Joern UNKNOWN) -- Adopt as an escape hatch for unparseable content, paired with existing status=error, at near-zero AM3 cost since agents rarely query it directly.
- [node] META_DATA (cf. Joern META_DATA) -- One node per graph for schema/overlay version bookkeeping — serves D21's explicit-state principle, and Joern already has the exact concept.
- [edge] CALLS (cf. Joern CALL) -- Deliberately renamed from Joern's CALL edge to avoid the node/edge label ambiguity Joern itself has (CALL is both a node type and an edge type) — a concrete, non-cosmetic reason to diverge.
- [node] SYMBOL -- No Joern equivalent is possible without inheriting Joern's global load-time linker, which is structurally incompatible with per-file incremental replace (PR2/PR3). Conceded as load-bearing, not cosmetic.
- [node] DIRECTORY -- Joern's 39 concrete node types have no filesystem-tree node; FileSystem is overlay-only in its own conformance model. This fills a real gap rather than diverging from anything.

**Concessions made:**
- SYMBOL indirection (D5) has no Joern equivalent and cannot have one without inheriting Joern's global load-time linker over METHOD_FULL_NAME, which is structurally incompatible with per-file incremental replace — this is load-bearing, not a stylistic choice.
- SCIP's descriptor grammar for SYMBOL.fqn is genuinely incompatible with Joern's FULL_NAME format — adopting Joern's naming here would mean sacrificing real SCIP interoperability we already have.
- Joern's MODIFIER-as-node and its <operator>.* CALL desugaring represent exactly the density PR1 measured and rejected (~7x); folding modifiers and operators into properties instead of nodes is correct and I won't argue to reverse it.

---

# Round 2 -- rebuttal and revision

## Security & Taint Analysis -- Round 2

**Top priority:** Consolidate resolution-trust signaling onto edge-level status enums everywhere (CALLS and now IMPORTS, per Ergonomics' ask) — including a "dynamic" value on IMPORTS for computed/dynamic imports — and adopt Cross-Language's ALIAS_OF so that TAG-based sink/source classification on a canonical SYMBOL doesn't go blind the moment code reaches it through a re-export chain.

## Where the round moved me

**Agent/MCP Ergonomics' bool-vs-enum consolidation — ADOPT, with one sharpening.** Dropping `CALL.resolved` and `IMPORT.resolved` in favor of one edge-level status enum is correct, and it directly serves my lens: one predicate to check instead of two sources that can drift. But I want to be precise about what "add status to IMPORTS" means: it must be the *same five-value enum* as CALLS (`resolved|ambiguous|external|unresolved|dynamic`), not a fresh two-value bool-replacement. Dynamic import resolution — `require(computedPath)`, `importlib.import_module(name)`, conditional `import` inside a try/except used as a feature-detection gate — is a real, symmetric blind spot to dynamic calls, and today's draft has nowhere to record it. If IMPORTS only gets `resolved/unresolved`, I lose the one case (dynamic import as a supply-chain/path-injection vector) that most resembles `eval`.

**Cross-Language's ALIAS_OF — strong ADOPT, and I want to extend the rationale.** Cross-Language proposed `ALIAS_OF: SYMBOL -> SYMBOL` for barrel/re-export resolution. I'm adopting it for a reason specific to my lens: TAG/TAGGED_BY (my Round 1 ask) only works as a sink/source classifier if tagging the *canonical* SYMBOL (`child_process.exec`, `subprocess.run`) is enough to flag every call site — including ones that reach it through a re-exported wrapper. Without ALIAS_OF, a barrel-re-exported dangerous function is invisible to a tag-based query the instant someone does `export { exec as run } from './shell'`. This is exactly the kind of cross-lens dependency the debate should surface: my ask is only as good as Cross-Language's.

**Cross-Language's precise `dynamic`/`ambiguous` definitions — ADOPT verbatim.** This operationalizes the exact thing I flagged loosely in Round 1 ("dynamic should mean reflective/computed dispatch"). Their split (dynamic = runtime-dispatch-the-frontend-can't-follow; ambiguous = multiple statically-plausible candidates) should go into the schema doc as normative text, cross-language, so a JS frontend and a Python frontend can't silently disagree about which bucket a given call falls into. That disagreement would be invisible to an agent and would corrupt my triage query without anyone noticing.

**Analytics' TARGETS shortcut — endorse, with a hard constraint.** The `CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL` materialized shortcut is fine and even useful for future data-flow composition (fewer hops when propagating taint through a resolved call graph) — *provided* it only ever materializes for `status=resolved`, which Analytics already specified. I want that made explicit as a hard invariant: a TARGETS edge existing must never be read as "this call is trustworthy" independent of checking CALLS.status, or agents will start querying TARGETS and silently drop the unresolved/dynamic/ambiguous population that is my entire reason for existing.

**Identity & Incremental's SYMBOL-boundary rule — adopt as the design constraint for every future taint edge.** Their framing ("intra-file tiers never need SYMBOL; anything crossing a file boundary must indirect through SYMBOL") is exactly the rule I need for REACHING_DEF/PDG when it eventually ships: intra-procedural taint stays file-local and dies/reborns with its file; inter-procedural taint (source in file A reaching a sink through a call into file B) must go through SYMBOL or TARGETS, never a direct cross-file pointer. This should be written down now as a constraint on RK1, not discovered later.

**Standards' UNKNOWN + status=error — adopt and extend as a coverage-gap signal.** A file Joern-style `UNKNOWN`/parse-failure marks is an *unanalyzed* attack surface — no different in kind from a `CALL.status=unresolved`, just at the file granularity. I want parity: an agent's triage query should be able to ask "what fraction of this workspace is either resolution-uncertain (CALL/IMPORT status) or coverage-uncertain (FILE status=error/UNKNOWN)" in one mental model, not two.

## Concession on naming

Six lenses independently proposed a rename for the filesystem CONTAINS edge (`TREE_CONTAINS`/`PATH_CONTAINS` mine, `DIR_ENTRY`, `DIR_CONTAINS`, `HAS_ENTRY` ×2, `HAS_CHILD`, `PARENT_OF`). `HAS_ENTRY` has plurality (Identity, Performance). I withdraw my own proposed name and second `HAS_ENTRY` — my only real stake was freeing `CONTAINS` for a future METHOD-body-membership anchor, which every proposal satisfies equally.

## Remaining disagreement: none substantive

No lens argued against TAG/TAGGED_BY, DEFINES-for-PARAM, or the CALLS.status semantics I asked for in Round 1 — this round was mostly convergence and sharpening, not conflict. The one thing I'd flag as still open: TAG's attachment point should default to SYMBOL (propagates to every call site for free via existing CALLS edges) and MEMBER (local secrets), with CALL-level tags reserved for per-call-site sanitizer annotations — a refinement, not a reversal, of my Round 1 ask.

**Proposed additions/changes:**
- [property] IMPORTS.status (same 5-value enum as CALLS: resolved|ambiguous|external|unresolved|dynamic) -- Ergonomics proposed adding status to IMPORTS generically; I'm pinning it to the identical enum vocabulary as CALLS so dynamic/computed imports (require(computedPath), importlib.import_module(name)) are visible as the same class of blind spot as dynamic calls, not lost to a generic bool-replacement.
- [edge] ALIAS_OF (SYMBOL -> SYMBOL) (cf. Joern ALIAS_OF) -- Endorsing Cross-Language's proposal with an added rationale: TAG-based sink/source classification on a canonical SYMBOL only works end-to-end if re-export/alias chains resolve back to it — without ALIAS_OF, a barrel-re-exported dangerous function is invisible to a tag query.
- [other] SYMBOL-boundary rule applied to future taint/dataflow edges -- Adopting Identity & Incremental's general rule as the explicit design constraint for RK1: intra-procedural taint (future REACHING_DEF) stays file-local and needs no SYMBOL indirection; any taint edge crossing a file boundary must indirect through SYMBOL or the TARGETS shortcut, never a direct cross-file pointer.
- [property] FILE.status=error / UNKNOWN treated as coverage-gap signal, queried alongside CALL.status=unresolved (cf. Joern UNKNOWN) -- Extending Standards' UNKNOWN-node proposal: an unparsed file is unanalyzed attack surface at file granularity, the same category of blind spot as an unresolved call at call granularity, and both should be queryable under one triage mental model.
- [edge] TAG/TAGGED_BY attachment scoping: primary anchor SYMBOL/MEMBER, secondary CALL (cf. Joern TAG, TAGGED_BY) -- Refining my own Round 1 ask: tagging the canonical SYMBOL (e.g. child_process.exec) propagates to every call site for free via existing CALLS edges, avoiding per-call-site duplication; CALL-level tags remain useful only for per-site sanitizer/verified-safe annotations.

**Rebuttals:**
- to Agent / MCP Consumption Ergonomics: Agree to drop CALL.resolved and IMPORT.resolved bools in favor of edge-level status, but IMPORTS.status must use the identical 5-value enum as CALLS.status (including 'dynamic'), not just 'add a status field' — dynamic import resolution is a real, symmetric blind spot to dynamic calls and deserves the same vocabulary, not a narrower one.
- to Cross-Language & Symbol Resolution: Fully adopting ALIAS_OF, and flagging a dependency the original proposal didn't state: without it, TAG-based sink/source classification on a canonical SYMBOL goes blind the instant a dangerous function is reached through a re-export/barrel alias — my lens's TAG ask and your ALIAS_OF ask are load-bearing for each other.
- to Standards & Interoperability: Converging on HAS_ENTRY for the CONTAINS rename over my own TREE_CONTAINS/PATH_CONTAINS proposal — the substantive win (freeing CONTAINS for a future CFG anchor) is unanimous across six lenses and the specific string doesn't matter to mine. Separately, endorsing UNKNOWN + status=error but extending it: it should be queryable as a coverage-gap signal on equal footing with CALL.status=unresolved, not just a robustness escape hatch.
- to Incremental Update & Identity: Adopting your SYMBOL-boundary rule verbatim as the design constraint for every future taint/dataflow edge: intra-file tiers (future REACHING_DEF) never need SYMBOL; anything crossing a file boundary — inter-procedural taint propagation included — must indirect through SYMBOL or TARGETS, exactly like CALLS does today.
- to Graph Analytics & Path Tracing: Endorsing the TARGETS shortcut edge as compatible with my needs, on one hard condition already implicit in your proposal but worth stating as an invariant: it must only materialize for status=resolved. If agents start treating TARGETS-exists as a trust signal independent of CALLS.status, the unresolved/dynamic/ambiguous population my lens depends on silently disappears from view.

**Concessions made:**
- Withdrawing my own TREE_CONTAINS/PATH_CONTAINS proposal in favor of HAS_ENTRY (Identity & Incremental's and Performance's name), which has plurality support across lenses for the section 6 CONTAINS rename — my stake was only in freeing the name, not in the specific string.
- Accepting Ergonomics' removal of CALL.resolved/IMPORT.resolved bare bools, conditional only on IMPORTS.status using the identical enum vocabulary as CALLS.status (stated as a proposed addition above, not a blocking objection).
- Accepting Complexity & Maintainability's cyclomatic_complexity/max_nesting_depth/loc properties as orthogonal to my lens with no objection; I note (without requiring it) that a complex method plus an unresolved/dynamic call is a plausible compound risk signal for later, but this is not a v1 ask.

## Code Complexity & Maintainability -- Round 2

**Top priority:** Converge on HAS_ENTRY for the filesystem edge rename, and stop Graph Analytics' proposed TARGETS shortcut from being written inline during per-file replace — it must be a periodic rebuildable overlay like COMMUNITY (and my own DEPENDS_ON), or it silently reintroduces the exact cross-file dangling-edge fragility that D5/SYMBOL was built to eliminate.

## CONTAINS rename: converge, don't keep bikeshedding

Six lenses independently proposed six different names for the same rename (DIR_ENTRY, TREE_CONTAINS/PATH_CONTAINS, DIR_CONTAINS, HAS_ENTRY ×2, HAS_CHILD, PARENT_OF). Everyone agrees on the *what*; only the *spelling* differs, and that's a waste of debate budget against AM3. **I'm withdrawing my DIR_ENTRY proposal and converging on `HAS_ENTRY`** (Incremental/Identity and Storage/Performance both landed there independently, for the same reason I care about: it's mutated only on move/rename, never touched by per-file :CPG replace, so it costs nothing to rename and frees `CONTAINS` cleanly for D23's eventual CFG layer). `IN_METHOD` stays as-is — nobody in this whole debate argued to change it, which is itself a signal it's right.

## Rebuttal: Graph Analytics' TARGETS edge has the exact fragility Incremental/Identity flagged for MEMBER_OF — just worse

Graph Analytics proposes `TARGETS: CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL`, "computed during the same resolution pass that already sets CALLS.status" and framed as a same-transaction write. Incremental/Identity's Round 1 top priority was exactly this question for MEMBER_OF: does per-file replace MERGE-on-id or DELETE+CREATE the touched file's :CPG nodes? If it's DELETE+CREATE (which is the entire reason D5/SYMBOL indirection exists — Standards and Security both independently confirmed CALLS/IMPORTS/EXTENDS never point directly at another :CPG node *specifically so cross-file edges survive a replace*), then a `TARGETS` edge computed "during the resolution pass" of file A, pointing at a METHOD node living in file B, dies the instant file B is next saved — and nothing in file A's save touches it to notice or repair it. That's not a hypothetical: it's the identical failure mode MEMBER_OF has, except MEMBER_OF only breaks community-membership queries (cosmetic-ish), while a dangling TARGETS edge would silently corrupt call-graph/PageRank results — worse for correctness than for it not to exist at all, because a stale TARGETS edge looks like a live one.

This directly bears on my lens: hotspot and coupling metrics are worthless if the underlying graph can be silently stale in a way `status=ready` doesn't catch (D21/PR8 promises a reader can always tell what to trust — a dangling TARGETS edge violates that promise invisibly). **My ask: TARGETS must be explicitly specified as a periodic, rebuildable, batch-recomputed overlay** — same contract as COMMUNITY, same contract I already proposed for my own `DEPENDS_ON` (FILE→FILE) — never a write inside the per-file save transaction. This isn't a rejection of TARGETS' value (I'd use it too, e.g. "hotspot methods with high fan-in"), it's a rejection of *when* it gets written. Graph Analytics and I actually want the same mechanism; I'm just insisting it be named and constrained precisely so a future implementer doesn't reach for "just write it during resolution" as the obvious-seeming but wrong answer.

## Concessions and reinforcements

**Standards' INHERITS_FROM merge (EXTENDS/IMPLEMENTS → one edge + relation property): I now actively support this**, and add a reason from my own lens I hadn't raised in Round 1 — Depth-of-Inheritance-Tree and Number-of-Children are classic god-class-adjacent metrics, and a single recursive `INHERITS_FROM` edge is strictly easier to traverse (`MATCH (t:TYPE_DECL)-[:INHERITS_FROM*]->(a)`) than unioning two edge types at every hop. I'm not proposing DIT/NOC as *stored* properties, though — same principle as my Round 1 rejection of `TYPE_DECL.method_count`: a cheap recursive traversal over an existing edge beats a duplicated stored aggregate, and this is a clean second example of that principle holding.

**Cross-Language's `METHOD.generator` and `TYPE_DECL.structural` booleans validate my own design pattern** — orthogonal booleans sibling to an existing property (their `async`/`generator`, my `exported`/`visibility`) instead of enum explosion. Good convergent evidence this is the right shape for the whole schema, not just my corner of it.

**Storage & Performance's rejections of MODIFIER, TYPE_PARAMETER/TYPE_ARGUMENT, METHOD_RETURN, ANNOTATION-family** land on identical reasoning to my CONTROL_STRUCTURE/BLOCK rejection (usage-site cardinality masquerading as structural nodes) — noting this as independent convergence, not just agreement.

**Ergonomics' proposal to drop `CALL.resolved`/`IMPORT.resolved` bools in favor of edge-level `status` enums**: no objection from my lens, and it's a good example of the same "don't duplicate signal in two places" discipline I applied to `TYPE_DECL.method_count`.

**Security's TAG/TAGGED_BY**: fine as pulled forward, with one boundary I want on record — generic key-value TAG is right for classification metadata (source/sink/sanitizer marking), but computed numeric metrics like `cyclomatic_complexity` must stay typed scalar properties, never TAG values, because range queries (`WHERE m.cyclomatic_complexity > 10`) need an index-backed number, not a string to parse. No lens proposed otherwise, but I want the boundary explicit before someone suggests "just tag it complex" as a shortcut.


**Proposed additions/changes:**
- [other] TARGETS write-timing contract: periodic rebuildable overlay, not inline write (cf. Joern Joern's Shortcuts layer (CALL edge type) is itself linker-only, created in a separate pass from frontend AST construction -- the same separation-of-passes discipline Graph Analytics' own citation implies but the current TARGETS proposal doesn't yet specify for write timing.) -- Constrains Graph Analytics' proposed TARGETS edge to be computed and refreshed the same way COMMUNITY is (a periodic derived overlay), not written inside the per-file replace transaction that created the resolution -- because TARGETS can point at a node in a different file than the one just saved, and that target node may be deleted+recreated on its own file's next save with nothing in the writing file's transaction able to detect or repair the resulting dangling edge.

**Rebuttals:**
- to Graph Analytics & Path Tracing: TARGETS as described ("computed during the same resolution pass") is a same-transaction write from file A pointing at a node in file B; if per-file replace is DELETE+CREATE for :CPG nodes (the whole reason D5/SYMBOL exists), that edge dangles silently the moment file B is next saved, with no mechanism in either file's save to notice. It must be specified as a periodic rebuildable overlay (COMMUNITY's contract), not an inline write.
- to Incremental Update & Identity: Your MERGE-on-id question for MEMBER_OF applies with higher stakes to Graph Analytics' proposed TARGETS edge — a dangling TARGETS edge doesn't just miss a community, it silently corrupts call-graph/centrality results while still looking valid, which is a worse violation of D21's 'reader must be able to tell what to trust' than MEMBER_OF's failure mode.
- to Standards & Interoperability: Supporting the EXTENDS/IMPLEMENTS -> INHERITS_FROM merge from a complexity-metrics angle: a single recursive edge is what a DIT/NOC-style traversal actually wants, reinforcing the AM3 argument you already made on different grounds.

**Concessions made:**
- Withdrawing my own DIR_ENTRY proposal for the CONTAINS rename in favor of HAS_ENTRY, since Incremental/Identity and Storage/Performance both converged there independently and further bikeshedding on the exact name wastes debate budget everyone agrees is scarce (AM3).
- Conceding TYPE_DECL.method_count/member_count stay rejected, and extending the same reasoning to DIT/NOC: these are derivable via a recursive INHERITS_FROM traversal once Standards' merge is adopted, so no new stored aggregate property is needed for inheritance-depth complexity metrics either.
- No objection to Ergonomics' proposal to drop CALL.resolved/IMPORT.resolved booleans in favor of a single edge-level status enum pattern — consistent with my own Round 1 principle of not storing a signal in two places when one derivable/indexed source already gives it cheaply.

## Graph Analytics & Path Tracing -- Round 2

**Top priority:** TARGETS only survives Incremental Update's replace-safety test if it is maintained as an async, rebuildable overlay pass — like COMMUNITY, never written synchronously inside the per-file save transaction — because as I drafted it in Round 1, it has exactly the direct-cross-file-pointer problem Incremental Update flagged for MEMBER_OF.

## Conceding to Incremental Update: my own TARGETS proposal had the MEMBER_OF bug

Incremental Update's "one test that matters" — does an edge survive `DiffGraph.replace(file)` without orphaning a cross-file pointer — is the sharpest single point in this whole round, and I have to apply it to myself before anyone else does. Their general rule: "anything that can legitimately point at another file's node must indirect through SYMBOL." My Round-1 `TARGETS: CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL` is exactly such an edge — it points from file A's CALL directly at file B's METHOD, bypassing SYMBOL for query-performance reasons. If file B's per-file replace is DELETE-all+CREATE-all (still undocumented, per their finding), every inbound TARGETS edge from every other file is silently severed on every save of B, not just renames. I under-weighted this in Round 1 by calling TARGETS "derived, not authoritative" without actually specifying *when* it gets rebuilt.

**Revision:** TARGETS is not written in the synchronous per-file save path at all. It is maintained by the same kind of periodic/on-demand projection pass that already computes COMMUNITY — recomputed by walking `CALLS/IMPORTS/INHERITS_FROM -> SYMBOL <- DEFINES` and materializing the shortcut, tolerant of being briefly stale between a save and the next projection run. This is consistent with PR3 (cache, fully rebuildable) and costs nothing structurally, since SYMBOL — the thing that actually survives the save — is still the resolution source of truth. This also means TARGETS' "3-hop tax" argument now only wins for *analytics/visualization reads*, never for write-path cost, which is a more honest version of my Round 1 claim.

This same fix unifies cleanly with **Complexity & Maintainability's `DEPENDS_ON` (FILE -> FILE)**: I now propose both TARGETS and DEPENDS_ON come out of one derived-overlay job — TARGETS is the fine-grained shortcut, DEPENDS_ON is a file-granularity rollup of the same resolved edges. One projection pass, two materializations, no duplicated resolution logic. I'd rather have one well-specified async job than two ad hoc ones.

**Cross-Language's `ALIAS_OF` (SYMBOL->SYMBOL) is a required input to this pass, not a separate concern.** Any TARGETS/DEPENDS_ON resolution must walk `ALIAS_OF*` to the canonical SYMBOL before materializing the shortcut, or re-export barrels will produce shortcut edges to the wrong node, or duplicate shortcuts per alias hop. I'm folding this into my proposal rather than treating it as someone else's problem.

## CONTAINS rename: converge on `HAS_ENTRY`, drop the word "contains" entirely

Every lens wants the filesystem edge renamed — unanimous, first time this debate has that. But `DIR_CONTAINS` (mine), `PATH_CHILD`, `TREE_CONTAINS`/`PATH_CONTAINS` (Security) all keep the substring "CONTAINS," which partially defeats the point: an agent or human pattern-matching on the word will still half-associate it with Joern's meaning. I'm withdrawing my own `DIR_CONTAINS`/`PATH_CHILD` suggestion and converging on **`HAS_ENTRY`** (Incremental Update, Storage/Perf) — it shares no substring with CONTAINS, reads correctly in both traversal directions, and two lenses independently landed on the identical string, which is itself a signal it's the least contested option. I'll defer final bikeshedding to Standards/Ergonomics if they disagree, but I'm actively picking a side now instead of leaving four synonyms on the table.

## Defending IN_METHOD's shape against a hypothetical merge

Incremental Update floated (as a rebuttal target, not their own position) collapsing IN_METHOD into DECLARES to save AM3 budget, conditional on no consumer needing to distinguish "declared inside" from "called inside." I do need that distinction: a call-graph query and a symbol-table/outline query are different questions, and conflating them would mean every call-graph traversal has to post-filter DECLARES by target-label, which is precisely the "post-filter instead of edge-type pruning" cost Storage & Query Performance argued against for AST/REF. Keep IN_METHOD (broadened to `METHOD|MODULE`, per my Round 1 ask, still unchallenged) as its own edge type.

## Other convergences, no new argument needed
Standards' `INHERITS_FROM` merge (EXTENDS+IMPLEMENTS with a `relation` property) is a clean TARGETS source — I'll adjust my shortcut's inheritance leg to read from one edge instead of two. Ergonomics' drop of `CALL.resolved`/`IMPORT.resolved` bools in favor of edge-level status enums only helps my queries (one predicate shape instead of two). Security's TAG/TAGGED_BY doesn't conflict with anything here and could eventually feed `COMMUNITY.label_hint`, though that's speculative, not a Round 2 ask.

**Proposed additions/changes:**
- [edge] TARGETS (revised: async-maintained overlay) (cf. Joern CALL (edge type, Shortcuts layer)) -- Materialized shortcut from CALL|IMPORT|TYPE_DECL to resolved METHOD|TYPE_DECL, avoiding the SYMBOL 3-hop tax for centrality/PageRank/impact-of-change. REVISED from Round 1: must be computed by an async/periodic projection pass (like COMMUNITY), never written synchronously in the per-file save transaction, because a direct cross-file pointer bypassing SYMBOL has exactly the replace-survivability risk Incremental Update flagged for MEMBER_OF. Must resolve through ALIAS_OF chains to the canonical SYMBOL before materializing.
- [edge] HAS_ENTRY (converged rename of filesystem CONTAINS) (cf. Joern CONTAINS (renamed away from to resolve section 6 collision)) -- Withdrawing my own DIR_CONTAINS/PATH_CHILD proposal in favor of converging with Incremental Update and Storage/Perf on HAS_ENTRY, which unlike DIR_CONTAINS/TREE_CONTAINS/PATH_CONTAINS drops the substring 'CONTAINS' entirely, actually resolving the pattern-matching confusion rather than partially preserving it.
- [edge] DEPENDS_ON (FILE -> FILE, unified with TARGETS as one projection job) -- Supporting Complexity & Maintainability's proposal, with the addition that it should be produced by the same async overlay pass as TARGETS rather than a separate resolution mechanism -- one job, two materializations (fine-grained shortcut + file-level rollup), avoiding duplicated resolution logic.

**Rebuttals:**
- to Incremental Update & Identity: You're right and I'm revising: my Round-1 TARGETS edge (CALL->METHOD across files, bypassing SYMBOL) has exactly the MEMBER_OF replace-survivability problem you flagged. Fix is to make TARGETS an async-maintained overlay (like COMMUNITY) rather than a synchronous write, never a same-transaction direct pointer across file boundaries.
- to Complexity & Maintainability: Support DEPENDS_ON (FILE->FILE), but propose it come from the same derived-overlay job as my TARGETS shortcut rather than a separately-specified resolution path -- both are rollups of the same resolved CALLS/IMPORTS/INHERITS_FROM->SYMBOL edges, just at different granularity.
- to Cross-Language & Symbol Resolution: Your ALIAS_OF (SYMBOL->SYMBOL) is a required input to TARGETS/DEPENDS_ON resolution, not a separate concern -- the projection pass must walk ALIAS_OF* to canonical before materializing a shortcut, or re-export barrels produce shortcuts to the wrong node or duplicate edges per alias hop.
- to Incremental Update & Identity (re: hypothetical IN_METHOD/DECLARES merge): Against collapsing IN_METHOD into DECLARES even though both are intra-file and replace-safe either way: 'called inside' and 'declared inside' are different analytics questions, and merging them forces every call-graph query to post-filter by target label instead of pruning by edge type -- the same cost Storage & Query Performance argued against for Joern's generic AST/REF edges.
- to Standards & Interoperability: Support merging EXTENDS/IMPLEMENTS into INHERITS_FROM with a relation property -- it simplifies my TARGETS shortcut's inheritance leg to one source edge instead of two, at no analytics cost since 'relation' is still a filterable property.

**Concessions made:**
- Incremental Update's replace-survivability test applies to my own TARGETS proposal, not just MEMBER_OF -- conceded and revised to make TARGETS an async-maintained overlay rather than a synchronous cross-file write.
- Withdrawing DIR_CONTAINS/PATH_CHILD as my proposed rename for the filesystem edge; converging on HAS_ENTRY since it fully drops the confusable 'CONTAINS' substring rather than partially retaining it.
- Accepting Standards' INHERITS_FROM merge (EXTENDS+IMPLEMENTS with a relation property) as the inheritance source for my TARGETS shortcut, replacing my Round-1 assumption of two separate source edges.
- Accepting that ALIAS_OF (Cross-Language lens) must be resolved through before TARGETS/DEPENDS_ON materialize a shortcut -- this is now a dependency of my proposal, not an independent addition I can evaluate in isolation.

## Incremental Update & Identity -- Round 2

**Top priority:** Any derived edge that points directly from one file's :CPG node to another file's :CPG node — Analytics' TARGETS chief among them — must be built as an async, best-effort overlay recomputed out-of-band (like COMMUNITY), never written inside the per-file replace transaction, or it reopens exactly the load-time-relink fragility SYMBOL indirection exists to close.

## Convergence: CONTAINS rename is unanimous — help it land

Every lens that touched section 6 (Security, Complexity, Analytics, Ergonomics, Standards, Storage/Perf, Cross-Language, me) independently voted to rename our filesystem edge and leave Joern's `CONTAINS` meaning untouched. That's real consensus; the only leftover bikeshed is the replacement name (`HAS_ENTRY`/mine and Storage's, `DIR_ENTRY`, `DIR_CONTAINS`/`PATH_CHILD`, `HAS_CHILD`, `PARENT_OF`, `TREE_CONTAINS`/`PATH_CONTAINS`). From an identity standpoint every option is equally safe — this edge is mutated only on move/rename (GE-UC5), never touched by per-file :CPG replace, so nothing here is load-bearing for me. But I'll cast a tie-breaking vote against `TREE_CONTAINS`/`PATH_CONTAINS`/`DIR_CONTAINS`: Ergonomics' whole argument was that an agent must never see the substring "CONTAINS" and wonder if it's the code-containment relation. Keeping the word in the name defeats that purpose even if the prefix disambiguates. I'll converge with Standards/Ergonomics-adjacent naming and back **`HAS_ENTRY`** (already independently proposed by Storage/Perf) or `PARENT_OF` — either fully vacates "CONTAINS" as a substring. Let's close this in Round 3 rather than let five near-identical proposals sit unresolved.

## Pushback: Analytics' TARGETS shortcut reopens the exact problem D5 solved

Analytics wants `TARGETS: CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL`, calling it "derived, not authoritative." I take the motivation seriously — the 3-hop SYMBOL tax on PageRank/centrality is real — but as specified this is a direct :CPG-to-:CPG edge that can cross a file boundary, which is precisely the shape Security and I both rejected when we killed Joern's linked CALL edge. Consider the mechanics: file B's METHOD gets touched, its node is deleted+recreated (even if the id is stable, PR3 says the subgraph is replaced); every `TARGETS` edge written by file A's *last* resolution pass now points at a vertex that either no longer exists or exists as a fresh vertex FalkorDB treats as unrelated unless the write is a MERGE keyed on the same stable id. That's the identical MEMBER_OF hazard from my Round 1, just with a much higher edge count (every resolved call site, not just community-tagged nodes). Analytics' own citation — Joern's Shortcuts layer is explicitly *overlay/linker-created, and a frontend MUST NOT create it* (section 5's conformance table) — is the tell: Joern itself keeps this exact edge shape out of the incremental write path. My ask: **TARGETS ships, but only as an async overlay recomputed in its own pass** (same cadence/contract as COMMUNITY, carrying its own `computed_at`/status so staleness is visible per D21), never inside the atomic per-file replace transaction Analytics' own top priority worries about the query cost of. That preserves the query win without smuggling a cross-file authoritative edge back into the write-path SYMBOL was built to eliminate.

## Endorsement: ALIAS_OF is the model citizen

Cross-Language's `ALIAS_OF: SYMBOL -> SYMBOL` is the cleanest possible addition in this whole round — both endpoints are SYMBOL, so it's categorically exempt from every concern I raised about TARGETS. This is exactly my "SYMBOL boundary, not node-tier boundary" rule working as intended: alias/re-export chains live entirely in the non-:CPG, cross-file-safe layer. No caveats, full ADOPT.

## TAG/TAGGED_BY: attach to SYMBOL, not to CALL

Security's TAG/TAGGED_BY proposal is cheap and valuable, but I'd redirect the attachment point. Tagging a CALL node ("this call site is a sink") means recomputing and re-attaching the tag on every save of the calling file for no reason — sink-ness is a property of the *callee identity* (`fs.writeFile`, `subprocess.run`), not the call site. Attach `TAGGED_BY` to **SYMBOL** instead: it's set once, survives every caller's file being replaced, and every CALL pointing at that SYMBOL inherits the classification for free via the existing CALLS→SYMBOL hop. Same conclusion as ALIAS_OF: SYMBOL-anchored metadata is incrementally free; :CPG-node-anchored metadata on a per-save-regenerated node is not.

## Complexity's DEPENDS_ON sharpens my MEMBER_OF concern, doesn't replace it

`FILE -[:DEPENDS_ON]-> FILE` is safe specifically because FILE identity is stable (properties updated in place, not delete+recreate) — Complexity picked the one node type in the schema that doesn't have my problem. That's not an argument MEMBER_OF is fine; it's a contrast case. Until the MERGE-on-id write contract is confirmed, I'd restrict COMMUNITY/MEMBER_OF membership to FILE only for v1, and treat METHOD/TYPE_DECL membership as EXTEND-when-confirmed.

## Quick agreements, no new risk
Standards' `PARAM`→`METHOD_PARAMETER_IN` rename and `EXTENDS`/`IMPLEMENTS`→`INHERITS_FROM{relation}` merge: both identity-neutral, ADOPT. `META_DATA`: fine as a singleton, non-:CPG, always-MERGE node — flag explicitly that it must never carry a `file` property or participate in per-file replace. `UNKNOWN`: fine, behaves like FILE's error-status sibling, one per unparseable file. Ergonomics' removal of `CALL.resolved`/`IMPORT.resolved` bools in favor of edge-level status enums: no identity impact, support. Security's `DEFINES: PARAM -> SYMBOL` and Analytics' `DECLARES` extension to `IMPORT`: both fine, conditional only on whatever SYMBOL garbage-collection mechanism already exists for METHOD/TYPE_DECL being extended to cover PARAM's new SYMBOLs too — not a new problem, just wider coverage of an existing one.

**Proposed additions/changes:**
- [edge] TARGETS (revised: async overlay, not write-path edge) (cf. Joern CALL (edge, Shortcuts layer)) -- Analytics' proposed CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL shortcut is valuable for centrality/PageRank but must be computed and refreshed out-of-band like COMMUNITY, carrying its own computed_at/status, and never written inside the atomic per-file replace transaction — otherwise it reintroduces a cross-file authoritative edge that a same-node MERGE-on-id failure or a renamed/moved target silently orphans, exactly the fragility SYMBOL indirection exists to prevent.
- [edge] TAGGED_BY attaches to SYMBOL, not CALL/MEMBER (cf. Joern TAGGED_BY) -- Sink/source/sanitizer classification is a fact about the callee's identity (fs.writeFile is always dangerous), not about a specific call site that gets deleted and recreated on every save of its own file. Anchoring on SYMBOL makes the tag persist for free across every caller's incremental replace and lets every CALL inherit it via the existing CALLS->SYMBOL hop.
- [other] Restrict COMMUNITY/MEMBER_OF to FILE-only until MERGE-on-id write contract is confirmed -- FILE node identity is stable under in-place property updates (per Complexity's DEPENDS_ON reasoning), so MEMBER_OF -> FILE is safe today; MEMBER_OF -> METHOD/TYPE_DECL should stay provisional/EXTEND until the per-file replace transaction is documented as MERGE-keyed rather than DELETE+CREATE.

**Rebuttals:**
- to Graph Analytics & Path Tracing: TARGETS as specified is a direct :CPG-to-:CPG edge that can cross file boundaries and would be written during per-file replace — structurally the same MEMBER_OF/global-relink hazard I flagged in Round 1, and Joern's own conformance model (Shortcuts layer is overlay-only, frontend MUST NOT create it) confirms even Joern keeps this class of edge out of the incremental write path. Ship it as an async overlay like COMMUNITY, not a write-path edge.
- to Security & Taint Analysis: TAG/TAGGED_BY should attach to SYMBOL, not to CALL — sink/source classification is a property of the callee's identity, which is stable across every caller's file save, whereas a CALL node is deleted and recreated on every save of its own file for no benefit to the tag.
- to Code Complexity & Maintainability: DEPENDS_ON (FILE->FILE) is safe precisely because FILE identity persists via in-place property update rather than delete+recreate — this is the exception, not evidence that COMMUNITY/MEMBER_OF pointing at METHOD/TYPE_DECL is equally safe.

**Concessions made:**
- Standards' PARAM -> METHOD_PARAMETER_IN rename and the EXTENDS/IMPLEMENTS -> INHERITS_FROM{relation} merge are both identity-neutral; I have no basis to object and adopt both.
- Ergonomics' push to drop CALL.resolved/IMPORT.resolved bools in favor of edge-level status enums (and add IMPORTS.status) touches no identity concern of mine; full support.
- Cross-Language's ALIAS_OF (SYMBOL->SYMBOL) is unconditionally safe under my SYMBOL-boundary rule and I have zero reservations about it, unlike TARGETS.

## Agent / MCP Consumption Ergonomics -- Round 2

**Top priority:** Adopt Graph Analytics's TARGETS shortcut edge alongside SYMBOL — my Round 1 claim that SYMBOL indirection is purely an ergonomics win was wrong, since the 3-hop CALL→SYMBOL←DEFINES join it forces is exactly the kind of pattern an agent gets wrong cold, and a one-hop derived edge fixes that without touching D5.

## Where the debate changed my mind

**Graph Analytics's `TARGETS` edge is the single best idea in this round, and it exposes a gap in my own Round 1 reasoning.** I called SYMBOL indirection an "agent-ergonomics win, not just an incrementality win" — true for the status enum, false for query shape. `CALL-[:CALLS]->SYMBOL<-[:DEFINES]-METHOD` is a 3-hop pattern with a fan-out node in the middle, and "who calls this function" / "what's the blast radius of this change" are exactly the queries an agent will write cold and get wrong (forget the reverse `DEFINES` hop, or match `SYMBOL` as if it carried `file`/`range` properties it doesn't have). `TARGETS: CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL`, populated only when `status=resolved`, gives the agent a one-hop happy path while SYMBOL stays the identity source of truth for everything else. **ADOPT.** One requirement: the schema resource must document `TARGETS` as *derived, may lag one save-cycle behind CALLS.status* — an agent that doesn't know it's a projection will treat its absence as "unresolved" rather than "not yet recomputed," which is a D21 violation if left unstated.

## Where I'm revising my own position

**IN_METHOD needs to change, and Analytics is right about why.** I said in Round 1 "IN_METHOD is fine as-is." Analytics's point that module-level calls (route registration, decorators-as-calls, TS/Python top-level side effects) have no home under a METHOD-only target is a real correctness gap that becomes an agent-trust problem: an impact-of-change trace that silently drops top-level calls will look complete and won't be. I'm adopting Analytics's fix: broaden the target to `METHOD|MODULE` and rename to **`IN_SCOPE`** — keeping the name `IN_METHOD` once it can legitimately point at a `MODULE` node is worse ergonomics than renaming, because an agent pattern-matching on the name will assume the target label and write `(c:CALL)-[:IN_METHOD]->(m:METHOD)` with no `WHERE` guard, silently missing top-level calls.

**Standards's `INHERITS_FROM{relation}` merge over my own "two direct edges" position: I'm switching sides.** My Round 1 argument for keeping `EXTENDS`/`IMPLEMENTS` separate was "an agent wants one edge to traverse, not reconstructed dispatch resolution" — but that argument was against Joern's BINDING machinery, not against a two-value property. Standards's precedent is exactly right: I already endorsed `CALL.kind` folding call/new/decorator/await into one property instead of four edge types, on pure vocabulary-size grounds. Consistency requires the same move here. **ADOPT `INHERITS_FROM{relation: extends|implements}`** — one less edge type in the schema resource an agent has to learn, at the cost of one extra property check that's no harder than the `kind` check it already has to do for `CALL`.

## Where I'm pushing back

**Standards's `PARAM` → `METHOD_PARAMETER_IN` rename: REJECT.** This is alignment-for-its-own-sake, and it actively costs ergonomics rather than being free. The `_IN` suffix only means something in contrast to Joern's `METHOD_PARAMETER_OUT` — a type Standards themselves correctly omit as a legitimate non-need for TS/Python. Importing half of a paired naming convention with no pair in our schema will make an agent (or a human skimming the schema resource) wonder what distinguishes `_IN` from something that doesn't exist. `PARAM` says what it is; `METHOD_PARAMETER_IN` imports confusion for a Joern-trivia point. Keep `PARAM`.

**Answering Identity's direct question to me:** no, don't merge `IN_METHOD`/`IN_SCOPE` into `DECLARES`. They answer different questions an agent actually asks — "what does this scope lexically declare" vs. "what call sites live in this scope" — and a call inside a nested closure that is itself declared nowhere (an inline callback) is exactly the case Identity flagged where the two diverge. Merging would force every consumer to post-filter by target node label to recover the distinction the two edge names currently give for free — that's strictly worse for the vocabulary-size goal both of us care about.

**Endorsements, briefly:** Complexity's `METHOD.cyclomatic_complexity/max_nesting_depth/loc/visibility` — cheap properties, zero new labels, exactly the "compute at parse time, don't materialize AST nodes" pattern I want everywhere. Storage/Perf's rejection of `MODIFIER`/`METHOD_RETURN`/the `ANNOTATION` family/`TYPE_PARAMETER`/`TYPE_ARGUMENT`/`TYPE`/`NAMESPACE` — all co-signed; every one is a node type an agent would have to learn to filter out for zero query benefit over a string property. Security's `TAG`/`TAGGED_BY` and Cross-Language's `ALIAS_OF` are both fine at zero AM3 cost since neither needs a dedicated tool — they're filters an existing Cypher-escape-hatch tool already supports.

## Restated ruling on Section 6

Full convergence exists on renaming our filesystem edge; only the string varies (`HAS_CHILD` mine, `HAS_ENTRY` Identity+Storage/Perf, `PARENT_OF` Standards, `TREE_CONTAINS`/`PATH_CONTAINS` Security, `DIR_ENTRY` Complexity, `DIR_CONTAINS` Analytics). I'm dropping `HAS_CHILD` and converging on **`HAS_ENTRY`** (plurality pick) — "directory HAS_ENTRY file" reads clearly to an agent and there's no ergonomics reason to keep fragmenting the vote. `CONTAINS` stays reserved, unclaimed, for Joern's real meaning if/when CFG lands.

**Proposed additions/changes:**
- [edge] TARGETS (cf. Joern CALL (edge type, Shortcuts layer)) -- Adopting Graph Analytics's proposal: a materialized, derived shortcut from CALL|IMPORT|TYPE_DECL directly to the resolved METHOD|TYPE_DECL turns the 3-hop CALL->SYMBOL<-DEFINES join (a pattern an agent will get wrong cold) into a one-hop query, without weakening SYMBOL as the identity source of truth. Must be documented in the schema resource as derived/lagging to satisfy D21.
- [edge] IN_SCOPE (cf. Joern CONTAINS (reversed, partial analogue)) -- Renamed and broadened from the draft's IN_METHOD (CALL->METHOD only) to CALL->METHOD|MODULE, per Analytics's module-level-call gap. Keeping the old name once it can target MODULE would mislead an agent into assuming the target label matches the name.
- [edge] INHERITS_FROM (cf. Joern INHERITS_FROM) -- Switching from my Round 1 two-edge position to Standards's merged EXTENDS/IMPLEMENTS -> INHERITS_FROM{relation} for consistency with the CALL.kind precedent I already endorsed: fold a small closed enum into one edge type rather than growing the vocabulary an agent must learn from the schema resource.
- [edge] HAS_ENTRY (cf. Joern CONTAINS (collision - renamed away from)) -- Converging my Round 1 HAS_CHILD proposal onto the plurality name (also proposed by Identity and Storage/Perf) to stop fragmenting the vote on a rename everyone already agrees is needed.
- [other] reject METHOD_PARAMETER_IN rename, keep PARAM (cf. Joern METHOD_PARAMETER_IN) -- The _IN suffix only carries meaning paired against METHOD_PARAMETER_OUT, a type Standards themselves correctly omit as unneeded for TS/Python -- importing half of a Joern naming pair with no pair present actively confuses an agent skimming the schema, it doesn't help it.

**Rebuttals:**
- to Standards & Interoperability: Reject the PARAM -> METHOD_PARAMETER_IN rename: it imports the _IN half of a paired Joern convention (IN vs OUT) into a schema that deliberately has no OUT counterpart, which reads as confusing jargon rather than alignment value -- keep PARAM.
- to Standards & Interoperability: Support (switching from my own Round 1 stance) merging EXTENDS/IMPLEMENTS into INHERITS_FROM{relation} -- consistent with the CALL.kind precedent I already endorsed, and it shrinks the schema vocabulary an agent has to learn, which matters more to my lens than the extra WHERE clause costs it.
- to Graph Analytics & Path Tracing: Adopting TARGETS as proposed -- my Round 1 framing of SYMBOL indirection as strictly an ergonomics win missed that the 3-hop join it forces for call-graph traversal is itself an ergonomics hazard; TARGETS fixes that as a derived projection without reopening D5.
- to Incremental Update & Identity: Answering the question you raised for me directly: do not merge IN_METHOD/IN_SCOPE into DECLARES -- they answer different agent questions (lexical nesting vs. call-site containment, diverging exactly at inline callbacks not themselves declared), and merging would force every consumer to post-filter by target node label to recover a distinction the separate names currently give for free.

**Concessions made:**
- Conceded to Graph Analytics: SYMBOL indirection alone is not sufficient for agent query ergonomics on call-graph traversal -- the 3-hop CALL->SYMBOL<-DEFINES join is a real first-try-failure risk, which is why I now support TARGETS as a derived shortcut.
- Conceded to Analytics: IN_METHOD as drafted (CALL->METHOD only) has a real gap for module-level/top-level calls; I now support broadening its target and renaming to IN_SCOPE rather than defending the original name.
- Conceded to Standards: my Round 1 preference for EXTENDS/IMPLEMENTS as two separate edges was inconsistent with my own endorsement of CALL.kind folding four call shapes into one property -- I now support the INHERITS_FROM{relation} merge on vocabulary-size grounds.

## Cross-Language & Symbol Resolution -- Round 2

**Top priority:** Any materialized shortcut edge (Graph Analytics' TARGETS) or status-signaling change (Ergonomics' IMPORTS.status) must write through the exact same resolution pass that produces CALLS.status, using the exact same resolved/ambiguous/external/unresolved/dynamic vocabulary — two resolution write-paths that can drift is a cross-language correctness bug waiting to happen.

## CONTAINS rename: converge on HAS_ENTRY, drop my own weaker R1 suggestion

Six lenses independently proposed renaming the filesystem edge (`PARENT_DIR`/mine, `HAS_ENTRY`×2 [Incremental/Identity, Storage/Perf], `DIR_CONTAINS` [Analytics], `DIR_ENTRY` [Complexity], `HAS_CHILD` [Ergonomics], `PARENT_OF` [Standards], `TREE_CONTAINS`/`PATH_CONTAINS` [Security]). Unanimous on renaming; split on the name. I have no resolution-correctness stake here, so I'll spend that neutrality on building consensus rather than adding a ninth option: **HAS_ENTRY** already has two votes and reads correctly in both directions (`DIRECTORY -[:HAS_ENTRY]-> FILE`). I withdraw `PARENT_DIR` and second HAS_ENTRY. Security's argument for reserving bare `CONTAINS` for the eventual METHOD→CFG-node meaning is the right reason to do this, and Incremental/Identity's point that Joern has *no* DIRECTORY/FileSystem node at all means this isn't even a real alignment tradeoff — we're not giving up any Joern credit by renaming.

## Strong agreement: Ergonomics' single-locus-of-truth fix for resolution status

Ergonomics flagged that CALL.resolved (bool) + CALLS.status (enum) + IMPORT.resolved (bool) + no IMPORTS.status is three inconsistent places to check "did this resolve." This is exactly my Round 1 concern generalized — I asked for CALLS.status semantics to be pinned precisely *because* cross-language comparability depends on one enum, one place. Extending `status` to IMPORTS and dropping both bare bools is the correct fix and I fully adopt it. One addition: IMPORTS.status should use the *same five values* as CALLS.status (resolved/ambiguous/external/unresolved/dynamic), not a parallel import-specific vocabulary — TS barrel re-exports that can't be statically traced to a single origin file are the IMPORT-side analog of "ambiguous," and Python's `from .foo import *` with no `__all__` is the IMPORT-side analog of "unresolved." Reusing one enum across CALLS/IMPORTS is a cross-language ergonomics and correctness win at once.

## Convergence with Security on dynamic/ambiguous definitions — good sign, formalize it

Security independently arrived at documenting `status=dynamic` as "reflective/computed dispatch specifically" (their examples: eval, getattr, Function(), computed require) — this is nearly word-for-word my Round 1 proposed definition. Two lenses converging independently on the same semantics from different motivations (taint triage vs. cross-language comparability) is exactly the signal that this needs to be written into the schema as normative text, not left as implicit convention. I'm promoting this from a request to a concrete proposed addition below.

## Tension I need to flag: Graph Analytics' TARGETS vs. Incremental/Identity's SYMBOL boundary rule

Graph Analytics proposes `TARGETS: CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL`, a materialized cross-file shortcut bypassing SYMBOL, populated "in the same resolution pass that sets CALLS.status." Incremental/Identity's stated general rule is stricter: "anything that can legitimately point at another file's node must indirect through SYMBOL" — precisely because a direct edge to a node in another file's subgraph is exactly what gets orphaned on a DELETE+CREATE replace of the target file, independent of whether the *source* edge is "derived." I don't think these are actually incompatible, but the debate needs to say so explicitly: TARGETS is safe **only if** it is fully rebuildable and treated as disposable cache that gets recomputed (not merely left dangling and trusted) on *every* save of either endpoint's file — i.e., it inherits none of PR5's identity guarantees, and a stale/missing TARGETS edge must never be read as "this call doesn't resolve," only CALLS.status is authoritative for that. For my lens specifically: if TARGETS is ever computed by different code than CALLS.status (e.g., a separate "fast path" resolver that skips ALIAS_OF traversal for performance), the two will silently disagree on re-export chains — this is the one scenario I'd block the proposal over. My condition for supporting TARGETS: it must be a projection *of* CALLS.status/IMPORTS.status/EXTENDS-target, computed by literally the same resolver call, never a second resolution codepath.

## Endorsements, briefly

- Standards' `INHERITS_FROM` (merging EXTENDS/IMPLEMENTS with a `relation` property) — ADOPT, with one documented gap: Python's Protocol conformance is frequently *implicit* (structural/duck-typed, no explicit subclassing), so `relation=implements` only captures explicit declarations in both languages symmetrically. That's an honest, acceptable v1 limitation, not a flaw in the merge.
- Security's `DEFINES: PARAM -> SYMBOL` — ADOPT. This is also a symbol-resolution win, not just a taint one: without it, a Python `functools.wraps`-decorated function's params and a TS destructured-parameter pattern have no stable cross-reference point for "find all callers passing tainted or mistyped data into this param," which is squarely a cross-language resolution gap, not just a taint-analysis one.
- Standards' `PARAM` → `METHOD_PARAMETER_IN` rename — no objection; orthogonal to my concerns as long as PARAM/METHOD_PARAMETER_IN gets the SYMBOL edge above.

## Revision to my own position

Nothing in Round 1 was overturned. I'm dropping `PARENT_DIR` in favor of consensus on `HAS_ENTRY`, and upgrading the CALLS.status dynamic/ambiguous definitions from "should be pinned" to "here is the exact converged text," per the Security convergence above.

**Proposed additions/changes:**
- [status_value] CALLS.status / IMPORTS.status shared vocabulary (dynamic = reflective/computed dispatch the frontend cannot follow statically: eval, getattr()/__getattr__/__call__ overrides, Function(), computed member access obj[key](), computed require/import; ambiguous = multiple statically-plausible candidates: overload sets, duplicate/star imports, unresolved re-export fan-out) -- Independently converged on by this lens and Security in Round 1 from different motivations (cross-language comparability vs. taint triage) — that convergence is the signal to write it into the schema as normative text now rather than leave it as implicit per-frontend convention, which would let one language's frontend silently mean something different than the other's for the same status value.
- [property] IMPORTS.status reuses the same 5-value enum as CALLS.status (not a separate import-specific vocabulary) -- Endorsing and sharpening Ergonomics' IMPORTS.status proposal: a TS barrel re-export that can't be traced to one origin file is IMPORTS' 'ambiguous'; a Python `from .foo import *` with no __all__ is IMPORTS' 'unresolved'. One shared enum across CALLS and IMPORTS is what makes cross-language import-resolution queries comparable instead of requiring per-edge-type special-casing.
- [other] TARGETS (Graph Analytics' proposal) must be a pure projection of CALLS.status/IMPORTS.status/EXTENDS resolution, computed by the same resolver call, never a separate fast-path resolution codepath -- Prevents the one failure mode that would break cross-language resolution guarantees silently: if TARGETS skips ALIAS_OF traversal or re-export-chain resolution for performance while CALLS.status does not, the two signals disagree on exactly the barrel-file/re-export cases this lens's top priority is built around, and agents would have no way to detect the disagreement.
- [other] Documented gap: Python implicit Protocol/duck-typed conformance is not captured by INHERITS_FROM (cf. Joern INHERITS_FROM) -- Standards' INHERITS_FROM merge (EXTENDS/IMPLEMENTS -> one edge with a relation property) is symmetric and correct for explicit declarations in both languages, but Python structural typing often has no explicit subclassing to attach the edge to at all — this is an honest v1 limitation to record, not a defect in the merge, and it should not be used later to argue for reopening TYPE/TYPE_DECL usage-site machinery to 'fix' it.

**Rebuttals:**
- to Graph Analytics & Path Tracing: TARGETS is acceptable only as a pure projection computed in the same resolver pass as CALLS.status — if it ever gets its own resolution logic (e.g. skipping ALIAS_OF chains for speed), it will silently disagree with CALLS.status on exactly the re-export/barrel-file cases this lens exists to get right, and neither agents nor other lenses would have a way to detect the drift.
- to Incremental Update & Identity: Your SYMBOL-boundary rule ('anything that can point at another file's node must indirect through SYMBOL') is the correct general principle and I'm citing it to constrain, not reject, Analytics' TARGETS proposal: TARGETS can coexist with it only by being fully disposable/rebuildable cache that is never trusted over CALLS.status, never a parallel identity-bearing edge.
- to Ergonomics / Agent Consumption: Agreed on dropping CALL.resolved and IMPORT.resolved bools in favor of one status enum, with one addition: IMPORTS.status must reuse CALLS' exact five values (resolved/ambiguous/external/unresolved/dynamic) rather than inventing an import-specific set, or you've solved the bool-vs-enum inconsistency while reintroducing a cross-edge-type vocabulary inconsistency in its place.
- to Standards & Interoperability: INHERITS_FROM (merging EXTENDS/IMPLEMENTS with a relation property) is adopted, but flag for the record that it only models explicit conformance declarations — Python's duck-typed/implicit Protocol conformance has no edge to attach to in either your proposal or the current draft, and that's an acceptable gap, not a reason to grow TYPE_DECL further.

**Concessions made:**
- Withdrawing my own Round 1 CONTAINS-rename suggestion (PARENT_DIR) in favor of HAS_ENTRY, which two other lenses converged on independently — consensus-building here costs me nothing since I had no resolution-correctness stake in the name.
- Accepting that TARGETS (Graph Analytics' shortcut edge) can be compatible with D5/SYMBOL's incremental guarantees, which I was skeptical of on first read — conditional on it being a strictly derived projection of the same resolution pass, never an independent resolver.
- Standards' PARAM -> METHOD_PARAMETER_IN rename is orthogonal to my concerns and I have no objection, provided the DEFINES->SYMBOL edge Security requested is added to it (or its renamed successor) regardless of which name wins.

## Storage & Query Performance (Cypher/FalkorDB) -- Round 2

**Top priority:** Any new "shortcut" edge that bypasses SYMBOL for read-speed (TARGETS, DEPENDS_ON) must be classified as a periodically-recomputed overlay, never wired into the per-file replace hot path, or it quietly reintroduces the cross-file cascade cost D5/SYMBOL was built to eliminate.

## CONTAINS rename: converge, stop bikeshedding

Every lens agrees the filesystem edge must be renamed — I said `HAS_ENTRY`, Incremental Update & Identity independently landed on the identical `HAS_ENTRY`, Security wants `TREE_CONTAINS`/`PATH_CONTAINS`, Complexity wants `DIR_ENTRY`, Graph Analytics wants `DIR_CONTAINS`, Ergonomics wants `HAS_CHILD`, Standards wants `PARENT_OF`, Cross-Language wants `PARENT_DIR`. Eight-for-eight on "rename it," zero perf difference between any candidate string — a label costs the same regardless of spelling, this is pure bikeshedding from my seat. Since Identity landed on my exact token independently, I'll back `HAS_ENTRY` as plurality and ask the group to close it in Round 3 rather than let eight pet names survive to the end.

## Pushback: Graph Analytics' TARGETS needs a write-path qualifier, not a blanket ADOPT

TARGETS (CALL|IMPORT|TYPE_DECL → METHOD|TYPE_DECL, materialized on resolution) correctly diagnoses a real cost — the 3-hop CALL→SYMBOL←DEFINES pattern taxes centrality/PageRank runs. But calling it "derived, not authoritative" undersells a specific hazard: the CALL-side node is deleted+recreated every save of *its own* file (cheap, consistent with my 24.2ms number), but the METHOD/TYPE_DECL on the far end lives in a *different* file. PR5 keeps that target's id stable across most edits — except the one case SYMBOL indirection exists specifically to survive: a rename. When the target method is renamed, its old id is deleted and a new one created (PR5's own "rename → exactly 1 delete + 1 create"), and every TARGETS edge pointing at the old id now dangles across every *other* file that called it — precisely the whole-graph fan-out D5 was built to avoid, just relocated one hop downstream of SYMBOL instead of eliminated. Fixing that requires either a reverse-index sweep on rename (a cascade, which PR2's own numbers say is the expensive path — 68.4ms territory, not 24.2ms) or accepting silent staleness. My resolution: **TARGETS is fine, but only as a periodic overlay** — recomputed on its own cadence like COMMUNITY, explicitly allowed to be stale between runs, never assumed live by an agent the way CALLS.status is. That gets Analytics its fast monopartite traversal for whole-graph runs without smuggling a second live-edge-maintenance obligation into the per-file write path. Complexity's DEPENDS_ON (FILE→FILE) gets the identical treatment for the identical reason, and Complexity already framed it that way — good, I'm just making the rule explicit and general so it applies uniformly to any future shortcut edge, not just these two.

## Resolving Incremental/Identity's MERGE-vs-delete+recreate question from the perf side

Identity's flagged risk (does per-file replace MERGE-on-id or DELETE+CREATE, and does MEMBER_OF survive it) is the right question, and I can answer the perf half of it: the measured numbers in section 2 — 13x speedup from a *shared-label indexed delete* (3.1ms vs 40.3ms) — only make sense if the mechanism is DELETE-all-by-`{label:CPG, file:X}`-then-CREATE-all, not a per-node MERGE-on-id diff. MERGE requires a match-then-decide per node, which is strictly more work than an indexed bulk delete plus a fresh UNWIND insert. So I'd resolve Identity's concern not by mandating expensive MERGE semantics on the hot path, but by codifying the classification I just used for TARGETS/DEPENDS_ON: any edge landing on a :CPG node from *outside* that node's own file-replace transaction (MEMBER_OF today, TARGETS/DEPENDS_ON if adopted) is by definition an overlay edge, expected to go transiently stale between its own recompute runs, and never a correctness dependency for the write path itself. That's a cheaper, more honest contract than promising every inbound edge survives every save.

## Quick dispositions on the rest

**Complexity's METHOD.cyclomatic_complexity / max_nesting_depth / loc / visibility — ADOPT AS-IS**, unreservedly. Scalar properties computed once at parse time, zero new labels, zero query-planner impact, directly serves AM3 by keeping hotspot queries a single-label match.

**Ergonomics' ask to drop CALL.resolved/IMPORT.resolved in favor of edge-only status — concede.** I raised a relationship-index nice-to-have last round; on reflection `MATCH (c:CALL)-[r:CALLS]->(:SYMBOL) WHERE r.status='unresolved'` is still bounded by the CALL label scan (sparse tier, indexed) with one fixed-fanout hop per row — cheap with or without a dedicated edge-property index. Dropping the redundant bool costs me nothing.

**Standards' merge of EXTENDS/IMPLEMENTS into one INHERITS_FROM{relation} — no objection, and here's the distinction from my Round 1 stance on generic AST/REF:** DECLARES/HAS_PARAM/DEFINES/CALLS/IMPORTS are high-frequency, per-node-instance edges where type-specific adjacency stats matter to the planner. EXTENDS/IMPLEMENTS is 0–few edges per TYPE_DECL — collapsing two low-cardinality edge types into one with a property filter costs nothing measurable and helps AM3. Different edges, different tradeoff; I'm not reversing my position on the hot-path edges.

**Security's TAG/TAGGED_BY, Cross-Language's ALIAS_OF, Standards' META_DATA/UNKNOWN — no perf objection to any.** All are low-cardinality (classified nodes only, aliased symbols only, one META_DATA node total, UNKNOWN only on parse failure) — none stress label-index cardinality the way MODIFIER/TYPE/METHOD_RETURN would have.

**Proposed additions/changes:**
- [other] Overlay-edge classification rule -- Any edge landing on a :CPG node from outside that node's own per-file replace transaction (MEMBER_OF, and TARGETS/DEPENDS_ON if adopted) is classified as a periodic-recompute overlay edge, explicitly allowed to be transiently stale, and never a correctness dependency of the per-file write path. This resolves Identity's MERGE-vs-delete+recreate question without paying MERGE's per-node lookup cost on the hot path, and gives Graph Analytics' TARGETS/Complexity's DEPENDS_ON a concrete home that doesn't reintroduce the cross-file cascade SYMBOL eliminated.
- [edge] HAS_ENTRY (converge on this spelling) (cf. Joern CONTAINS (deliberately renamed away from)) -- Every lens independently agrees the filesystem edge must be renamed; HAS_ENTRY is the only name two lenses (this one and Incremental Update & Identity) landed on independently. Proposing it as the closing choice so Round 3 doesn't carry eight competing spellings forward.
- [edge] TARGETS (conditional adoption) (cf. Joern CALL (Joern's Shortcuts-layer edge, materialized by the linker)) -- Support Graph Analytics' goal (avoid a 3-hop SYMBOL detour on whole-graph centrality/PageRank runs) but only if TARGETS is recomputed on its own periodic cadence like COMMUNITY, never treated as live-maintained by the per-file save path — otherwise a renamed target method leaves dangling TARGETS edges across every other file that called it, reintroducing the exact whole-graph fan-out cost D5/SYMBOL was designed to remove.

**Rebuttals:**
- to Graph Analytics & Path Tracing: TARGETS as drafted ('derived, not authoritative... needs no transactional atomicity with the per-file write') glosses over what happens when the *target* method is renamed rather than the calling file being edited: the old id is deleted (PR5's 1-delete-1-create rule) and every TARGETS edge from other files now dangles until something re-sweeps them. That re-sweep is a cascade, and cascades are the 68.4ms-class expensive path this whole schema exists to avoid — TARGETS needs to be an explicitly periodic overlay, not a live shortcut, or it re-imports the exact problem SYMBOL indirection was built to solve.
- to Incremental Update & Identity: The 13x indexed-delete number (3.1ms vs 40.3ms, shared :CPG label scan) only makes sense as evidence for DELETE-all-by-file-then-CREATE-all, not MERGE-on-id — MERGE requires a per-node match-then-decide step that is strictly more expensive than a bulk indexed delete plus a fresh UNWIND insert. I'd resolve your MEMBER_OF question by codifying MEMBER_OF (and any future TARGETS/DEPENDS_ON) as an explicitly-stale-tolerant overlay edge rather than by asking the hot write path to pay for MERGE semantics it likely wasn't benchmarked with.
- to Complexity & Maintainability: Your DEPENDS_ON (FILE->FILE) proposal already correctly frames itself as 'computed and refreshed like COMMUNITY, not a structural-tier edge' — I'm formalizing that instinct into a general rule (see proposed_additions) so it applies uniformly to Graph Analytics' TARGETS too, which was proposed with weaker staleness guarantees than yours.

**Concessions made:**
- Concede to Agent/MCP Ergonomics: dropping CALL.resolved and IMPORT.resolved bools in favor of the edge-level status enum costs nothing on the read path — a CALL-label scan with a single fixed-fanout hop to check edge status is cheap with or without a dedicated relationship-property index, so my 'nice to have' index ask from Round 1 is not a blocking requirement for this change.
- Concede to Standards & Interoperability: merging EXTENDS/IMPLEMENTS into one INHERITS_FROM{relation} edge is fine and doesn't contradict my Round 1 argument against collapsing generic AST/REF — that argument applies to high-frequency, per-node-instance edges (DECLARES/HAS_PARAM/DEFINES/CALLS/IMPORTS) where type-specific adjacency stats matter; EXTENDS/IMPLEMENTS is 0-few edges per TYPE_DECL, low enough cardinality that the planner-pruning benefit of separate edge types is negligible.
- Concede the exact spelling of the renamed CONTAINS edge is not worth further defense from a performance seat now that two lenses independently converged on HAS_ENTRY — I'd rather the group close this than keep eight names alive into Round 3.

## Standards & Interoperability -- Round 2

**Top priority:** Converge the whole debate on ONE replacement name for the CONTAINS collision (HAS_ENTRY, not eight competing proposals) and resolve the EXTENDS/IMPLEMENTS-vs-INHERITS_FROM tension in favor of keeping two typed edges, since that concedes my own R1 proposal on its merits.

## Converge on one name: HAS_ENTRY

Seven lenses independently proposed renames for the filesystem edge: my own `PARENT_OF`, Security's `TREE_CONTAINS`/`PATH_CONTAINS`, Complexity's `DIR_ENTRY`, Analytics's `DIR_CONTAINS`, Identity's `HAS_ENTRY`, Ergonomics's `HAS_CHILD`, Storage's `HAS_ENTRY`, Cross-Language's `PARENT_DIR`. Unanimous on renaming, badly fragmented on what to. I'm withdrawing `PARENT_OF` and converging on **`HAS_ENTRY`** — it drew two independent votes (Identity, Storage) without coordination, which is the closest thing this debate has to an emergent consensus, and it also fully avoids the substring trap that `DIR_CONTAINS`/`TREE_CONTAINS`/`PATH_CONTAINS` still have (a skim-reader still sees "CONTAINS" in the name). `IN_METHOD` stays as-is — every lens that touched it agrees, no tension there.

## Conceding the EXTENDS/IMPLEMENTS merge — my own proposal doesn't survive scrutiny

Ergonomics explicitly rejected my R1 proposal to merge `EXTENDS`/`IMPLEMENTS` into a single Joern-aligned `INHERITS_FROM{relation}`, arguing an agent wants one edge type to traverse, not a property filter. On reflection, Storage's *own* general argument — used to defend keeping `DECLARES`/`HAS_PARAM`/`DEFINES` split rather than collapsing to Joern's generic `AST`/`REF` — cuts the same way here: typed-edge decomposition lets FalkorDB's planner prune by relationship type instead of post-filtering a property, and that's a genuine technical reason, not a preference. My original case for the merge was "fewer edge types plus alignment" — but AM3 is about *tool count*, not edge-type count in the schema an agent never has to enumerate by hand, and "alignment" alone is exactly the kind of justification my own brief says must yield to a concrete cost. I withdraw the merge. **Keep `EXTENDS`/`IMPLEMENTS` as two typed edges** — this is a considered `REJECT` of Joern's `INHERITS_FROM` shape for v1, on planner-pruning grounds, which is the bar I set for everyone else in Round 1 and now hold myself to.

## Strong support: ALIAS_OF is the debate's best alignment case yet

Cross-Language's `SYMBOL -[:ALIAS_OF]-> SYMBOL` for re-export/aliasing chains deserves top billing: `ALIAS_OF` is a genuine, *current* Joern edge (section 5's "recent additions"), not a Hidden/unspecced one like our `IMPORT`/`IMPORTS`. This is the textbook case my brief wants — same name, same shape, non-cosmetic cross-language need, zero SYMBOL-format compromise. **ADOPT AS-IS.**

## Extending my own REJECT concessions

Storage's cardinality argument against `MODIFIER`/operator desugaring (which I conceded in R1) applies with equal force to types I hadn't addressed: `METHOD_RETURN` (1:1-per-METHOD, exists only to give CFG return-flow an AST slot we've deferred), the `ANNOTATION` family (already covered by `CALL{kind:decorator}->SYMBOL`), `TYPE_PARAMETER`/`TYPE_ARGUMENT` (usage-site cardinality, same failure mode as expression tier), and `TYPE`-as-node (same). I extend my concession to cover all four: **REJECT for v1**, string-property equivalents, revisit only if generics-aware queries become load-bearing.

`NAMESPACE`/`NAMESPACE_BLOCK`: Identity, Storage, and Analytics converged independently on REJECT for structurally different but compatible reasons (cross-file merged node breaks per-file replace; TS/Python are already file-scoped). I have nothing to add except: this triangulation from three lenses on three different axes is strong evidence NAMESPACE is dead, not merely deferred.

`BINDING`/`BINDS`/`BINDS_TO`: Cross-Language's rejection (vtable resolution needs whole-hierarchy computation, same global-linker problem as Joern's `CALL` edge) is correct and consistent with D5's own reasoning. **REJECT**, no revisit — `CALLS.status=ambiguous` is the right permanent answer, not a stopgap.

## Endorsements without reservation

Security's `TAG`/`TAGGED_BY` pull-forward is a cheap, real Joern-named hook — support as `ADOPT AS-IS`, pulled into v1 scope. Analytics's `TARGETS` shortcut and Complexity's `DEPENDS_ON` are both legitimate `EXTEND`s with no literal Joern name to borrow, but both mirror Joern's own architectural pattern (a soft SYMBOL/string reference plus a linker-materialized shortcut edge in its Shortcuts layer) — that's alignment with Joern's *design pattern*, even without a name match, and worth saying explicitly so it doesn't read as an unprincipled addition.

Cross-Language's rebuttal to me — that Section 9's "align where names overlap" must stop at SYMBOL's format — restates a concession I already made in R1 in full; no daylight between us there.

**Proposed additions/changes:**
- [edge] HAS_ENTRY (cf. Joern CONTAINS (deliberately not used)) -- Supersedes my own R1 PARENT_OF proposal to converge the debate on one name for the section-6 rename, since Identity and Storage independently proposed HAS_ENTRY without coordination -- picking a shared name matters more here than which specific name wins.
- [edge] EXTENDS / IMPLEMENTS kept as two typed edges (INHERITS_FROM merge withdrawn) (cf. Joern INHERITS_FROM (rejected as v1 shape)) -- Withdraws my R1 proposal to merge these into a single Joern-named INHERITS_FROM+relation edge; Ergonomics's query-shape argument plus Storage's own typed-edge-decomposition-for-planner-pruning principle both cut against the merge, and alignment-for-its-own-sake is exactly the kind of justification my brief says must yield to a concrete cost.
- [edge] ALIAS_OF (cf. Joern ALIAS_OF) -- Cross-Language's proposal is the strongest alignment case in the debate: a genuine, current (non-Hidden) Joern edge that solves a real TS/Python re-export problem with no SYMBOL-format compromise. Full-throated ADOPT AS-IS support.
- [node] TAG (cf. Joern TAG) -- Supporting Security's pull-forward: cheap, Joern-named, generic annotation hook for source/sink/sanitizer classification metadata, at near-zero AM3 cost since it need not be a first-class MCP tool.
- [edge] TAGGED_BY (cf. Joern TAGGED_BY) -- Paired with TAG above; matches Joern's exact name for the exact same generic-annotation concept, pulled forward from deferred into v1 scope per Security's proposal.
- [other] Extended REJECT batch: METHOD_RETURN, ANNOTATION family, TYPE_PARAMETER/TYPE_ARGUMENT, TYPE-as-node (cf. Joern METHOD_RETURN, ANNOTATION/ANNOTATION_LITERAL/ANNOTATION_PARAMETER/ANNOTATION_PARAMETER_ASSIGN, TYPE_PARAMETER/TYPE_ARGUMENT, TYPE) -- Extends my R1 concession (MODIFIER/operator desugering) to cover these per Storage's cardinality argument -- each is a multiplicative per-node-or-per-usage-site tax that clears the bar for a non-cosmetic divergence from Joern.
- [other] NAMESPACE / NAMESPACE_BLOCK confirmed dead (cf. Joern NAMESPACE, NAMESPACE_BLOCK) -- Three lenses (Identity, Storage, Analytics) converged independently on REJECT via three different arguments (cross-file merge breaks per-file replace; TS/Python already file-scoped; structural dependency risk) -- strong triangulated evidence this is dead, not merely deferred.

**Rebuttals:**
- to Agent / MCP Consumption Ergonomics: Conceding: withdraw my R1 push to merge EXTENDS/IMPLEMENTS into a Joern-named INHERITS_FROM edge. Your query-shape argument, reinforced by Storage's own typed-edge-decomposition principle, is a concrete non-cosmetic reason to keep two edges -- exactly the bar I set for others in Round 1.
- to Storage & Query Performance (Cypher/FalkorDB): Agreed and extended: your cardinality argument against MODIFIER/operators (which I conceded in R1) applies equally to METHOD_RETURN, the ANNOTATION family, TYPE_PARAMETER/TYPE_ARGUMENT, and TYPE-as-node. All four clear the bar for REJECT beyond cosmetic preference.
- to Cross-Language & Symbol Resolution: Your rebuttal restates a concession I already made in full in Round 1 (SYMBOL.fqn's SCIP grammar is incompatible with Joern's FULL_NAME format, and alignment must stop at the boundary) -- no daylight between us there. Separately: ALIAS_OF is the strongest alignment win in this whole debate and I support it without reservation.
- to Graph Analytics & Path Tracing: Your DIR_CONTAINS proposal for the section-6 rename still contains the substring CONTAINS, which risks the exact skim-misreading section 6 warns about. Converge with Identity and Storage on HAS_ENTRY instead -- picking one name across the whole divergence doc matters more than which specific name wins.
- to Incremental Update & Identity: Your NAMESPACE rejection (cross-file merged node breaks per-file replace) reinforces rather than conflicts with my own R1 framing that Joern's FileSystem/NAMESPACE layers are overlay-only with no real equivalent to align to -- we reach REJECT by different roads with no tension to resolve.

**Concessions made:**
- Withdraw my R1 proposal to merge EXTENDS/IMPLEMENTS into a single Joern-named INHERITS_FROM{relation} edge -- Ergonomics's and Storage's converging technical arguments (query-shape, planner pruning by edge type) outweigh the vocabulary-reduction and alignment case I made for it.
- Extend my R1 concession on MODIFIER/operator-desugaring density to also cover METHOD_RETURN, the ANNOTATION family, TYPE_PARAMETER/TYPE_ARGUMENT, and TYPE-as-node -- all REJECT for v1, per Storage's cardinality argument, which clears the non-cosmetic bar my brief requires.
- Switch my section-6 rename proposal from PARENT_OF to HAS_ENTRY, converging with Identity and Storage rather than adding an eighth candidate name to a debate that already has seven.

---

# Round 3 -- final positions

## Security & Taint Analysis -- Round 3

**Top priority:** Lock in CALLS.status/IMPORTS.status (shared 5-value enum, dynamic/ambiguous precisely defined), SYMBOL-anchored TAG/TAGGED_BY, and ALIAS_OF as the permanent v1 foundation for pre-taint triage — these are the only load-bearing asks I have left, everything else in my Round 1/2 proposals either converged or is explicitly conceded below.

## Final dispositions

**CALLS edge with `status(resolved|ambiguous|external|unresolved|dynamic)`/`reason`/`confidence`/`resolvedBy` — ADOPT AS-IS.** Unchallenged across three rounds. This is my lens's entire pre-taint triage capability and it survived intact.

**IMPORTS.status — EXTEND, final form: identical 5-value enum to CALLS, not a separate vocabulary.** Converged with Ergonomics (who proposed adding status to IMPORTS) and Cross-Language (who insisted on the shared enum) by Round 2. Dynamic/computed imports (`require(computedPath)`, `importlib.import_module(name)`) are a real symmetric blind spot to dynamic calls and now have a home.

**`dynamic`/`ambiguous` normative definitions — ADOPT as schema text.** Cross-Language and I converged independently on identical wording (dynamic = runtime dispatch the frontend can't follow statically; ambiguous = multiple statically-plausible candidates). Two lenses, different motivations, same answer — this should go into the schema doc verbatim, not survive as tribal knowledge.

**TAG/TAGGED_BY — EXTEND (pull forward into v1).** Final attachment-point position: primary anchor is **SYMBOL** (not CALL, per Identity's correct Round 2 argument that sink/source classification is a fact about callee identity, stable across every caller's file-save cycle, and inherited for free through the existing CALLS→SYMBOL hop), secondary anchor MEMBER (local secrets), with per-call-site CALL tags reserved narrowly for sanitizer/verified-safe annotations. I fully adopted this refinement — it's strictly better than my Round 1 proposal and costs me nothing.

**ALIAS_OF (SYMBOL→SYMBOL) — ADOPT AS-IS, and load-bearing for TAG.** Without it a re-exported dangerous function (`export { exec as run }`) is invisible to a SYMBOL-anchored tag query. Cross-Language's proposal and my TAG ask are now explicitly interdependent, and both survived the debate unchanged.

**DEFINES: PARAM → SYMBOL — EXTEND, ADOPT.** No lens objected in three rounds; Cross-Language independently reinforced it as a resolution gap, not just a taint one.

**TARGETS (Analytics' shortcut) — conditional ADOPT, final constraint stack.** I endorse it for future data-flow composition, but only under the full constraint set the debate converged on: (1) async/periodic overlay, never a per-file-replace write (Identity, Storage, Complexity, Analytics itself all landed here after Analytics conceded its Round 1 draft had the MEMBER_OF bug); (2) materializes only for `status=resolved`, so agents never mistake TARGETS-absence for anything but "not applicable or not yet computed"; (3) — my own addition, seconded by Cross-Language — it must be a **pure projection of CALLS.status/IMPORTS.status/EXTENDS-resolution, computed by the same resolver call**, never an independent fast-path resolver. This last point is not cosmetic for my lens: if TARGETS skips ALIAS_OF traversal for speed while CALLS.status doesn't, the two signals silently disagree on exactly the re-export cases where a tagged dangerous SYMBOL is reached indirectly — and nothing detects the drift. This constraint stands even though Analytics/Storage never explicitly ruled on it; flagging it as **unresolved with those two lenses specifically**, not settled.

**FILE.status=error / UNKNOWN — EXTEND as coverage-gap signal.** My Round 2 extension of Standards' UNKNOWN proposal (queryable alongside CALL.status=unresolved under one triage mental model) drew no objection but also no explicit adoption from Standards or Ergonomics — I'll call this **unresolved, not settled**, since nobody confirmed the query surface actually unifies the two.

**Section 6 CONTAINS — final vote: HAS_ENTRY.** I withdrew my own TREE_CONTAINS/PATH_CONTAINS in Round 2 (my proposal partially retained the confusable substring, which Analytics and Ergonomics correctly flagged as self-defeating). HAS_ENTRY has the strongest independent plurality (Identity, Storage, Ergonomics, Cross-Language, Standards). I consider this fully settled.

**BINDING/BINDS/BINDS_TO — REJECT permanently**, not deferred. Cross-Language's argument (vtable resolution needs whole-hierarchy computation, the same global-linker problem D5 rejected) is correct and I have nothing to add.

**Future CFG/PDG-tier names (CONTROL_STRUCTURE, BLOCK, REACHING_DEF, CDG, DOMINATE, POST_DOMINATE, RETURN, IDENTIFIER, LITERAL, FIELD_IDENTIFIER, REF) — reserve Joern's exact names, no v1 action.** Unchanged since Round 1; nobody contested it.

## What I conceded and why

- Full CFG/PDG/REACHING_DEF/expression-tier deferral (Round 1, held throughout) — PR1/PR2's density argument is sound and none of my asks required reopening it.
- Joern's load-time-linked CALL edge mechanism — rejected outright, not just deferred; SYMBOL is the correct permanent answer, confirmed by Identity's SYMBOL-boundary rule which I adopted verbatim as the constraint for all future taint edges (intra-file tiers never need SYMBOL; anything crossing a file boundary must indirect through it or through TARGETS-as-overlay).
- TAG's attachment point moved from CALL (my Round 1 default) to SYMBOL-primary (Identity's Round 2 correction) — a real position change, not just a restatement.
- CALL.status=dynamic's precise meaning was my loose Round 1 ask; I deferred to Cross-Language's sharper, independently-converged wording rather than insist on my own phrasing.

## Unresolved tensions I will not paper over

1. **TARGETS' "pure projection, same resolver, no fast-path drift" constraint** was never explicitly accepted or rejected by Analytics or Storage — they specified *when* it's written (async overlay) but not whether it's *allowed to be computed by different logic* than CALLS.status. This matters specifically for re-export/ALIAS_OF correctness and should not be assumed settled.
2. **METHOD_PARAMETER_IN rename (Standards) vs. keep PARAM (Ergonomics)** — genuinely unresolved, opposing final positions from two lenses, and I have no stake in the outcome either way.
3. **EXTENDS/IMPLEMENTS as two edges vs. INHERITS_FROM{relation} merge** — Standards proposed the merge in Round 1, then withdrew it in Round 2 after Ergonomics' and its own planner-pruning argument; but Ergonomics *itself* flipped in Round 2 to support the merge. That leaves Standards (two edges) and Ergonomics (merged) on opposite final sides of the same question, unresolved. This indirectly affects TARGETS' inheritance leg (Analytics' Round 2 revision assumed the merge); if synthesis keeps two edges, TARGETS needs to read both.
4. **FILE.status=error/UNKNOWN as a unified triage surface with CALL.status** — proposed, uncontested, but never explicitly ratified by the lens that owns FILE/UNKNOWN (Standards) or the ergonomics of the triage query itself.

**Proposed additions/changes:**
- [property] IMPORTS.status (shared 5-value enum with CALLS.status) -- Final form of the Ergonomics/Cross-Language convergence: dynamic/computed imports are a symmetric blind spot to dynamic calls and need the identical resolved|ambiguous|external|unresolved|dynamic vocabulary, not a parallel one, or cross-language triage queries silently diverge.
- [edge] TAGGED_BY anchored primarily on SYMBOL (cf. Joern TAGGED_BY) -- Sink/source/sanitizer classification is a property of callee identity (fs.writeFile, subprocess.run), stable across every caller's incremental file replace; anchoring on the call site would require re-tagging on every save of the calling file for no benefit.
- [other] TARGETS must be a pure projection of the same resolver call that sets CALLS.status/IMPORTS.status, never an independent fast-path resolution codepath -- If TARGETS skips ALIAS_OF/re-export resolution for performance while CALLS.status does not, the two signals silently disagree on exactly the re-export cases my SYMBOL-anchored TAG classification depends on — and no agent or lens has a way to detect the drift. Flagged as unresolved with Analytics/Storage, not yet ratified.
- [status_value] CALLS.status=dynamic / IMPORTS.status=dynamic normative definition (reflective/computed dispatch the frontend cannot follow statically: eval, getattr/__getattr__/__call__, Function(), obj[key](), computed require/import) -- Written into the schema as normative cross-language text so a JS frontend and a Python frontend cannot silently disagree about which bucket a call or import falls into — a disagreement invisible to any agent query.

**Concessions made:**
- Full CFG/PDG/REACHING_DEF and expression-tier (IDENTIFIER/LITERAL/FIELD_IDENTIFIER/REF) deferral out of v1, accepted without reservation across all three rounds — PR1/PR2's density and speed arguments are sound and none of my asks required reopening them.
- Joern's global load-time CALL-edge linker is rejected outright as a mechanism, not merely deferred — adopted Identity & Incremental's SYMBOL-boundary rule verbatim as the permanent design constraint for every future taint/data-flow edge (intra-file tiers never need SYMBOL indirection; anything crossing a file boundary must go through SYMBOL or a properly-constrained overlay like TARGETS).
- TAG/TAGGED_BY's attachment point changed from my own Round 1 default (CALL-level) to SYMBOL-primary/MEMBER-secondary, adopting Identity & Incremental's Round 2 correction that sink/source classification is a callee-identity fact, not a call-site fact.
- Deferred to Cross-Language's precise dynamic/ambiguous wording rather than insist on my own looser Round 1 phrasing, since two independent motivations converging on identical text is stronger evidence than either alone.
- Accepted Storage & Performance's general overlay-edge classification rule (MEMBER_OF, TARGETS, DEPENDS_ON all periodic/stale-tolerant, never per-file-replace writes) as the umbrella that makes TARGETS safe to endorse at all.

## Code Complexity & Maintainability -- Round 3

**Top priority:** Lock in scalar complexity properties (cyclomatic_complexity/max_nesting_depth/loc/visibility on METHOD) as the permanent v1 answer for hotspot metrics, and close the two structural questions that determine whether my analytics stay cheap: HAS_ENTRY for the section-6 rename, and TARGETS/DEPENDS_ON/MEMBER_OF classified uniformly as stale-tolerant periodic overlays, never per-file-transaction writes.

## Final dispositions

**METHOD.cyclomatic_complexity, METHOD.max_nesting_depth, METHOD.loc, METHOD.visibility — EXTEND. Final, no Joern equivalent, standing behind this without reservation.** Every lens that touched these (Ergonomics, Storage/Perf) endorsed them outright as the "compute at parse time, store as scalar, don't materialize AST nodes" pattern, and nobody argued against them across three rounds. This is my single load-bearing ask and it survived the whole debate unchanged.

**CONTROL_STRUCTURE, BLOCK, MODIFIER, JUMP_TARGET, JUMP_LABEL, RETURN-as-node — REJECT for v1 (not forever).** Storage/Perf independently reached the identical conclusion via cardinality arguments (usage-site/per-keyword multiplication), which I cite as convergent evidence, not just agreement. Nothing here precludes a real CFG overlay adding these later (RK1 satisfied) — v1 hotspot queries simply shouldn't pay 7x density for a number a compiler pass hands over directly.

**TYPE_DECL.method_count / member_count as stored properties — REJECT, final.** Derivable via one-hop `DECLARES` fan-out count, index-backed and cheap. I extend this same reasoning to DIT/NOC (depth-of-inheritance-tree, number-of-children): both are recursive `INHERITS_FROM`/`EXTENDS`-traversal queries, not stored aggregates. No lens contested this.

**METHOD, TYPE_DECL, CALL — ADOPT AS-IS.** Names match Joern; worth formalizing as deliberate alignment for the differential-export oracle, at zero cost.

**DECLARES, SYMBOL indirection, IN_METHOD/IN_SCOPE — ADOPT.** I side with Analytics/Ergonomics's Round-2 broadening of IN_METHOD to `IN_SCOPE` (CALL -> METHOD|MODULE) to close the module-level-call gap — an impact-of-change or coupling trace that silently drops top-level route registrations/decorators-as-calls is a correctness hole for my lens too, not just Analytics's. SYMBOL indirection is what makes fan-in/dead-code queries (`MATCH (c:CALL)-[:CALLS]->(s:SYMBOL) WHERE s.fqn=...`) cheap and correct without a global relink — ADOPT AS-IS, final.

**EXTENDS / IMPLEMENTS vs INHERITS_FROM{relation} — final position: keep two typed edges, concede the merge.** I supported Standards's R1 merge proposal in Round 2 on DIT/NOC-traversal grounds (one recursive hop vs. unioning two edge types). Standards themselves withdrew it in Round 2 after Ergonomics's query-shape objection and their own planner-pruning argument (echoed by Storage). Practically, Cypher's `-[:EXTENDS|IMPLEMENTS*]->` variable-length pattern gets my DIT/NOC traversal for free without merging edge types, so my original motivation doesn't actually require the merge. **I concede and align with the plurality (Standards, Ergonomics, Storage): keep EXTENDS/IMPLEMENTS separate.** This was a real switch-then-switch-back in the debate; flagging it so synthesis doesn't read it as still contested — it settled.

**DEPENDS_ON (FILE -> FILE) — EXTEND, final, merged into one overlay job with TARGETS.** My Round 1 proposal for import-cycle detection. Analytics's Round 2 revision (one async projection pass materializing both TARGETS at the fine grain and DEPENDS_ON at the file-rollup grain) is the right shape and I adopt it — no duplicated resolution logic, one write-timing contract.

**TARGETS — support, conditional on the write-timing constraint I raised in Round 2 and that the room converged on.** My own pushback (a same-transaction cross-file write reopens exactly the MEMBER_OF hazard Identity flagged) was independently reached by Analytics itself, Identity, and Storage/Perf in Round 2 — four lenses landing on "async overlay, never per-file-transaction write" is the strongest convergence in this whole debate. Final: TARGETS ships, computed on its own cadence like COMMUNITY, carries its own staleness marker, never treated by an agent as authoritative over CALLS.status.

**MEMBER_OF / COMMUNITY — ADOPT the node/edge shape, with one unresolved granularity question I'm flagging, not papering over.** Storage/Perf's "overlay-edge classification rule" (any edge landing on a :CPG node from outside its own file's replace transaction is a stale-tolerant overlay, full stop) is the cleanest resolution of Identity's MERGE-vs-DELETE+CREATE question — it sidesteps needing an answer to the write-mechanism question at all. But Identity's Round 2 position was narrower: restrict MEMBER_OF to FILE-only targets until the contract is *confirmed*, not merely classified as tolerant of staleness. **This is a real, unresolved tension**, and it matters directly to my lens: I want COMMUNITY membership at METHOD/TYPE_DECL granularity for coupling/cohesion analysis (a FILE-level-only community is too coarse to detect a god-class's actual member cluster). I side with Storage's classification argument over Identity's restriction, but I flag this as genuinely open, not settled — synthesis should pick one, not assume convergence happened here.

**HAS_ENTRY — ADOPT, final, converged.** I proposed `DIR_ENTRY` in Round 1; withdrawing it. `HAS_ENTRY` is the plurality name (Identity, Storage/Perf independently, then Ergonomics, Standards, Cross-Language all converged in Round 2) and fully drops the confusable "CONTAINS" substring, unlike my own or Security/Analytics's proposals. `CONTAINS` stays reserved and unclaimed for Joern's METHOD-body-containment meaning if/when CFG lands (D23/RK1) — final, unanimous.

**NAMESPACE / NAMESPACE_BLOCK — REJECT, final.** I have nothing to add beyond noting the triangulation (Identity, Storage, Analytics reaching REJECT via three independent arguments) is strong evidence this is dead, not deferred.

**TAG/TAGGED_BY — ADOPT the pull-forward, with a boundary I've held since Round 2 and want stated as final, normative text:** generic key-value TAG is correct for classification metadata (source/sink/sanitizer marking per Security's use case); computed numeric metrics (cyclomatic_complexity, loc, etc.) must stay typed scalar properties, never TAG values, because range queries need an index-backed number. No lens ever proposed otherwise, but I want this written into the schema doc explicitly so a future contributor doesn't "simplify" by tagging complexity as a string.

## Concessions, explicit

1. Withdrew my own `DIR_ENTRY` rename proposal for `HAS_ENTRY` (Round 2) — pure convergence, no substantive stake.
2. Withdrew support for merging EXTENDS/IMPLEMENTS into `INHERITS_FROM{relation}` — my DIT/NOC motivation is satisfied by Cypher's multi-type variable-length pattern without the merge, and the planner-pruning argument (Storage, echoed via Standards's own reversal) outweighs it.
3. Accepted TYPE_DECL.method_count/member_count rejection, and extended it myself to DIT/NOC as stored aggregates — both derivable via traversal.
4. Accepted CALL.resolved/IMPORT.resolved bool removal in favor of edge-level status enums (Ergonomics) — orthogonal to my lens, no objection.
5. Accepted TARGETS/DEPENDS_ON as async overlays rather than transactional writes — this was originally my own R1 framing for DEPENDS_ON that the room correctly generalized to TARGETS too.

## Unresolved tensions I am flagging for synthesis, not claiming settled

- **MEMBER_OF/COMMUNITY granularity**: Storage's overlay-classification argument (stale-tolerant, fine at any :CPG target) vs. Identity's FILE-only restriction until MERGE-on-id is confirmed. My lens wants METHOD/TYPE_DECL-level COMMUNITY membership; this is not resolved by the debate as it stands.
- **CALLS.status="dynamic"/"ambiguous" precise definitions** (Security/Cross-Language convergence) are outside my lens's authority to ratify but I note they're relevant to a compound "complex + calls something unresolved" risk signal I raised in Round 2 as future work, not a v1 ask — flagging it exists but taking no position on its final wording.

**Proposed additions/changes:**
- [property] METHOD.cyclomatic_complexity -- Computed once at parse time (branches+1); gives hotspot queries a direct, index-backed signal without materializing CONTROL_STRUCTURE nodes. Final ask, unopposed across all three rounds.
- [property] METHOD.max_nesting_depth -- Distinct maintainability smell from raw branch count; same parse-time AST walk as cyclomatic_complexity, zero new labels.
- [property] METHOD.loc -- FILE already has loc; METHOD lacks the symmetric property, forcing every long-method query to derive it from range bounds instead of filtering an indexed scalar.
- [property] METHOD.visibility (cf. Joern MODIFIER (rejected as a node; captured as property instead)) -- Symmetric with MEMBER.visibility; needed to distinguish public-API complexity (a coupling risk for every caller) from private-helper complexity (a local concern).
- [edge] DEPENDS_ON (FILE -> FILE) -- Import-cycle detection needs a materialized file-level dependency graph, not a live per-pair traversal; merged in Round 2 with Analytics's TARGETS into one async overlay projection job to avoid duplicated resolution logic.
- [other] overlay-edge classification applied uniformly to MEMBER_OF/TARGETS/DEPENDS_ON (cf. Joern Joern's Shortcuts/overlay layers (linker-only, frontend MUST NOT create)) -- Resolves the write-timing hazard for any edge landing on a :CPG node from outside its own file's per-save transaction, without requiring a settled answer on MERGE-vs-DELETE+CREATE semantics for the hot path.
- [status_value] TAG values reserved for classification metadata only, never numeric complexity metrics (cf. Joern TAG/TAGGED_BY) -- Keeps range-queryable metrics (cyclomatic_complexity, loc) as indexed scalar properties rather than unindexed string tag values, a boundary no lens has contested but that should be written into the schema doc as normative text.

**Rebuttals:**
- to Incremental Update & Identity: Your MEMBER_OF-to-FILE-only restriction is a stricter, narrower fix than Storage's general overlay-classification rule, and the two haven't actually been reconciled in this debate — my lens needs METHOD/TYPE_DECL-granularity community membership for coupling analysis, so I'm flagging this as still open rather than assuming Storage's rule superseded your restriction.
- to Standards & Interoperability: Agreeing with your Round 2 withdrawal of the INHERITS_FROM merge — my own DIT/NOC motivation for it is satisfied by Cypher's -[:EXTENDS|IMPLEMENTS*]-> multi-type variable-length pattern, so the merge was never actually necessary for my lens's traversal needs.
- to Graph Analytics & Path Tracing: Fully endorsing your Round 2 self-correction on TARGETS' write timing — four lenses (yours, mine, Identity, Storage) converging independently on 'async overlay, not transactional write' in the same round is strong enough consensus that synthesis should treat it as settled, not merely proposed.

**Concessions made:**
- Withdrew my own DIR_ENTRY rename proposal for the section-6 CONTAINS collision in favor of the plurality name HAS_ENTRY.
- Withdrew support for merging EXTENDS/IMPLEMENTS into a single INHERITS_FROM{relation} edge after conceding Cypher's multi-type traversal syntax already gives my DIT/NOC use case what the merge would have, and the planner-pruning argument against merging low-level typed edges outweighs the vocabulary-size saving.
- Accepted TYPE_DECL.method_count/member_count as rejected stored properties (derivable via DECLARES fan-out), and independently extended the same reasoning to DIT/NOC metrics as recursive traversals rather than stored aggregates.
- Accepted dropping CALL.resolved/IMPORT.resolved bare booleans in favor of edge-level status enums (Ergonomics's proposal) as orthogonal to my lens with no objection.
- Accepted TARGETS and my own DEPENDS_ON being merged into one async overlay projection job rather than two separately-specified mechanisms.

## Graph Analytics & Path Tracing -- Round 3

**Top priority:** Ship TARGETS and DEPENDS_ON as one async, rebuildable projection job (never a per-file-save write) so whole-graph analytics gets one-hop traversal without reopening the cross-file fragility SYMBOL indirection exists to prevent.

## Final dispositions

**SYMBOL indirection (D5) — ADOPT AS-IS.** Non-negotiable per section 2; my whole Round 1 concern was never about rejecting it, only about the query-time tax it imposes on projections. That tax is now addressed by TARGETS, not by weakening SYMBOL.

**TARGETS — EXTEND (final, hardened form).** `CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL`, materialized only when the underlying resolution is `status=resolved`, resolved through `ALIAS_OF*` to canonical SYMBOL first, computed by an **async periodic overlay job** — the same contract as COMMUNITY — never inside the per-file replace transaction, and computed by the *same resolver call* that sets CALLS.status/IMPORTS.status so it structurally cannot drift from the authoritative signal (Cross-Language's condition, which I accept as binding). This converges Complexity's, Identity's, and Storage/Perf's independent hardening of my Round 1 proposal — I consider this fully resolved across the debate.

**DEPENDS_ON (FILE→FILE) — EXTEND**, produced by the same overlay job as TARGETS, not a separate resolution path. Gives cycle-detection a materialized file-level graph instead of a live per-pair traversal.

**HAS_ENTRY — ADOPT RENAMED, final.** Replaces the filesystem CONTAINS. This is the one item where every lens converged completely; I withdrew my own `DIR_CONTAINS` in Round 2 in favor of it. `CONTAINS` itself stays reserved and unused in v1, free for a future Joern-aligned `METHOD -> CFG_NODE` meaning if D23 lands — I'd `ADOPT AS-IS` that meaning at that time, not before.

**IN_METHOD → IN_SCOPE — ADOPT RENAMED + EXTEND.** Broadened target from `METHOD` to `METHOD|MODULE` to cover top-level calls. Ergonomics independently landed here too; I consider it settled. I continue to oppose folding this into DECLARES — "declared inside" and "called inside" diverge exactly at inline callbacks, and merging forces every call-graph query to post-filter by target label instead of pruning by edge type.

**DECLARES extended to include IMPORT — EXTEND.** Cheap, avoids a new edge name, fixes a real neighbourhood-loading gap.

**COMMUNITY/MEMBER_OF — ADOPT AS-IS + EXTEND properties** (`projection`/`edge_basis`, `level`). Identity's proposal to restrict MEMBER_OF to FILE-only pending a MERGE-on-id confirmation is reasonable caution, but I think Storage/Perf's general "overlay-edge classification rule" (any edge landing on a :CPG node from outside its own file's replace transaction is a stale-tolerant overlay, full stop) already covers MEMBER_OF the same way it covers TARGETS/DEPENDS_ON — so I'd let MEMBER_OF target METHOD/TYPE_DECL under that same contract rather than restrict to FILE-only. This is a mild, not fully resolved, disagreement with Identity's more conservative stance — flagging it rather than pretending consensus.

**ALIAS_OF (SYMBOL→SYMBOL) — ADOPT AS-IS.** Cross-Language's proposal is a required input to TARGETS/DEPENDS_ON resolution, not a separate concern — I fold it in as a hard dependency.

**NAMESPACE/NAMESPACE_BLOCK — REJECT**, confirmed by triangulation (Identity, Storage, Analytics reached REJECT via three independent arguments — cross-file merge breaks per-file replace, TS/Python already file-scoped, structural risk).

**DOMINATE/POST_DOMINATE/CDG/REACHING_DEF — deferred with D23/RK1, but ADOPT AS-IS reserved.** Standard compiler-theory names; no reason to rename when they ship.

**EXTENDS/IMPLEMENTS vs INHERITS_FROM{relation} — final position: support the merge**, unresolved against Standards. See rebuttal.

**BINDING/BINDS/BINDS_TO — REJECT**, agreeing with Cross-Language: vtable-style resolution requires whole-hierarchy computation, the same global-linker problem D5 rejected for CALL.

**TYPE/TYPE_PARAMETER/TYPE_ARGUMENT/METHOD_RETURN/ANNOTATION family/MODIFIER — REJECT for v1**, deferring to Storage/Perf's cardinality argument; not my lens's core territory but I have no basis to object.

## Concessions across the debate
- Conceded to Incremental Update: my Round 1 TARGETS design (synchronous, same-transaction write) had the identical cross-file-orphaning risk as MEMBER_OF; revised to async overlay.
- Conceded to Cross-Language: TARGETS must be a pure projection of the same resolver pass, never an independent fast-path resolver.
- Withdrew my own `DIR_CONTAINS`/`PATH_CHILD` naming proposal in favor of `HAS_ENTRY`.
- Accepted Standards' `INHERITS_FROM` source unification for my TARGETS inheritance leg (moot now given the unresolved merge question, but my TARGETS spec still reads from whichever edge shape wins).

## Unresolved for synthesis
1. EXTENDS/IMPLEMENTS as two edges (Standards' final, Ergonomics-echoed-then-Standards-reversed) vs. merged `INHERITS_FROM{relation}` (Ergonomics' final, my final) — genuinely unresolved, needs a synthesis ruling.
2. Whether MEMBER_OF may target METHOD/TYPE_DECL now under the overlay-tolerant contract (my reading) or must stay FILE-only pending explicit MERGE-on-id confirmation (Identity's more conservative final ask) — a real, small disagreement, not settled by argument.

**Proposed additions/changes:**
- [edge] TARGETS (cf. Joern CALL (edge type, Shortcuts layer)) -- FINAL: CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL, materialized only for status=resolved, walking ALIAS_OF* to canonical SYMBOL first. Computed by an async periodic overlay job (same cadence/contract as COMMUNITY), NEVER written inside the per-file replace transaction, and computed by literally the same resolver call that sets CALLS.status/IMPORTS.status (Cross-Language's constraint) so it can never silently disagree with the authoritative signal. Schema resource must document it as derived/may-lag-one-cycle. This is the converged, hardened version of my Round 1 proposal after conceding the MEMBER_OF-shaped fragility Incremental Update flagged.
- [edge] DEPENDS_ON -- FILE->FILE rollup of the same resolved edge set, produced by the identical async overlay job as TARGETS (one job, two materializations) rather than a second resolution mechanism. Gives cycle-detection a materialized file-level graph instead of a per-pair live traversal.
- [edge] HAS_ENTRY (cf. Joern CONTAINS (deliberately not reused)) -- FINAL, converged name (8/8 lenses voted to rename; HAS_ENTRY drew independent, uncoordinated votes from Identity and Storage/Perf) for the filesystem DIRECTORY->DIRECTORY|FILE edge, resolving the section 6 collision. CONTAINS stays unclaimed for a future Joern-aligned METHOD->CFG-node meaning if D23's CFG layer lands.
- [edge] IN_SCOPE (cf. Joern CONTAINS (reversed, partial analogue)) -- FINAL: renamed and broadened from the draft's IN_METHOD (CALL->METHOD only) to CALL->METHOD|MODULE, so top-level/module-scope calls (route registration, decorator-as-call, module init) aren't analytics dead-ends. Ergonomics independently adopted this in Round 2; treating it as settled.
- [property] COMMUNITY.projection / COMMUNITY.level -- Records which edge set a community-detection run used and reserves room for hierarchical/multi-resolution results, at near-zero schema cost.
- [edge] DECLARES (extend target set to include IMPORT) (cf. Joern AST (partial analogue)) -- Gives IMPORT a real edge back to its MODULE instead of only a .file property, making file-scoped neighbourhood loading and import-graph projection a traversal rather than a property scan.

**Rebuttals:**
- to Standards & Interoperability: UNRESOLVED, flagging plainly: you withdrew the EXTENDS/IMPLEMENTS -> INHERITS_FROM merge in Round 2 on planner-pruning grounds. I disagree and am keeping my Round 2 support for the merge as my final position: a single recursive INHERITS_FROM edge is what a DIT/NOC-style impact-of-change traversal (MATCH (t)-[:INHERITS_FROM*]->(a)) actually wants, and Cypher's [:EXTENDS|IMPLEMENTS*] union-pattern syntax makes the planner-pruning cost you cite marginal for an edge type that's 0-few per TYPE_DECL (Storage/Perf's own cardinality argument undercuts their case here, not just mine). This is a real, unresolved disagreement for synthesis to adjudicate, not something I'm papering over.
- to Incremental Update & Identity: Fully accepting your replace-survivability test and the resulting revision: TARGETS ships only as an async overlay, never a synchronous cross-file write. No remaining disagreement here.
- to Cross-Language & Symbol Resolution: Accepting your hardening of TARGETS as a pure projection of the same resolver call that sets CALLS.status/IMPORTS.status, with mandatory ALIAS_OF* resolution first. This is now load-bearing in my final proposal, not an optional nicety.

## Incremental Update & Identity -- Round 3

**Top priority:** Ratify the overlay-edge classification rule (any edge landing on a :CPG node from outside that node's own per-file replace transaction — MEMBER_OF, TARGETS, DEPENDS_ON — is a periodic, stale-tolerant, non-authoritative overlay, never a write-path dependency) as the single general answer to the MERGE-vs-DELETE+CREATE question I raised in Round 1, since Storage's perf evidence now makes DELETE+CREATE the far more likely mechanism.

## Final dispositions

**SYMBOL indirection (D5) — EXTEND, no Joern equivalent, load-bearing, non-negotiable.** Stands unchanged through three rounds; no lens challenged the mechanism, only argued about what should ride on top of it (TARGETS, ALIAS_OF, TAGGED_BY).

**Joern's CALL edge (node→METHOD via load-time METHOD_FULL_NAME linking) — REJECT.** Structurally incompatible with per-file replace. Security independently rejected the same mechanism; converged, final.

**BINDING / BINDS / BINDS_TO, NAMESPACE / NAMESPACE_BLOCK, SOURCE_FILE — REJECT, final.** Three lenses (me, Storage, Analytics) converged on NAMESPACE from three different angles; Cross-Language and Standards independently converged on rejecting BINDING as the same global-linker problem as Joern's CALL. SOURCE_FILE was my Round 1 rejection (redundant with the `file` property FILE's own indexed-delete benchmark depends on) and no lens contested it.

**Section 6 CONTAINS collision — ADOPT RENAMED, `HAS_ENTRY`, final and unanimous.** Every one of eight lenses independently proposed a rename; `HAS_ENTRY` drew two unprompted, uncoordinated votes (me, Storage) and became the plurality pick every other lens converged onto by Round 2. `CONTAINS` stays reserved, unclaimed in v1, for Joern's real METHOD→CFG-node meaning if D23's CFG layer ships. `IN_METHOD` — I now adopt Ergonomics/Analytics's broadened, renamed `IN_SCOPE` (`CALL -> METHOD|MODULE`): identity-neutral, since MODULE is still one-per-file and co-replaced with CALL exactly like METHOD was.

**TARGETS and DEPENDS_ON — EXTEND, conditional, final: async overlay only, never a per-file-transaction write.** This is the one place the debate actually moved me. My Round 1 flag (does the write contract survive a cross-file pointer?) got sharpened by Storage's Round 2 perf argument in a way I hadn't considered: the 13x indexed-delete benchmark (3.1ms vs 40.3ms shared-label scan) is evidence *for* DELETE-all+CREATE-all, not MERGE-on-id, because MERGE requires a per-node match-then-decide step that's strictly more expensive. That resolves my own open question, but in the direction that makes any live cross-file edge dangerous, not safe. The fix isn't to demand expensive MERGE semantics on the hot path — it's to demote every such edge (MEMBER_OF, TARGETS, DEPENDS_ON) to an explicitly-stale-tolerant overlay, recomputed on its own cadence, never read as live by an agent. Analytics conceded this for TARGETS in Round 2; Complexity already framed DEPENDS_ON this way from the start; Storage generalized it into a named rule I'm adopting verbatim. **Resolved, not a lingering tension.**

**MEMBER_OF — ADOPT AS-IS, now unrestricted, given the overlay rule.** I proposed restricting it to FILE-only in Round 2 pending the MERGE-vs-DELETE+CREATE answer. With the overlay-edge classification rule now converged (Storage, Analytics, Complexity, me), that hedge is unnecessary: MEMBER_OF -> METHOD/TYPE_DECL is fine as long as it's documented as recomputed per COMMUNITY run, exactly like COMMUNITY itself already is. I withdraw the FILE-only restriction.

**ALIAS_OF (SYMBOL->SYMBOL) — ADOPT AS-IS, zero reservations.** Categorically exempt from every concern I raised all debate — both endpoints are SYMBOL, so it can never be orphaned by a per-file :CPG replace. The cleanest addition in the whole debate.

**TAGGED_BY anchor — ADOPT my own Round 2 proposal (SYMBOL/MEMBER primary, CALL secondary), converged with Security.** Sink/source classification is a fact about callee identity, not a call site regenerated every save.

**DEFINES: PARAM -> SYMBOL — ADOPT**, identity-neutral, conditional only on extending whatever SYMBOL GC/lifecycle mechanism already exists for METHOD/TYPE_DECL to cover PARAM too — not a new problem, just wider coverage of an existing one.

**CALL identity ordinal, parent-scope-relative — stands as a required golden-file test**, not resolved by prose alone: two identical calls in one method, then an unrelated statement inserted above, must produce 0 id changes.

## Genuinely unresolved — flagging plainly, not papering over

1. **EXTENDS/IMPLEMENTS vs. `INHERITS_FROM{relation}` merge.** Standards proposed it, Ergonomics rejected it in Round 1, Standards withdrew it in Round 2 citing that rejection — but Ergonomics itself flipped to support the merge in Round 2 for CALL.kind-consistency reasons, and Storage said it has no perf objection either way. The lens positions as they stand at end of Round 2 do not agree with each other. My lens has no identity stake — both shapes are TYPE_DECL -> SYMBOL, equally replace-safe — so I won't break the tie, but synthesis should not read this as settled.
2. **PARAM vs. `METHOD_PARAMETER_IN`.** Standards proposed the rename; Ergonomics rejected it (importing half of a Joern IN/OUT pair with no OUT). Never re-litigated. Identity-neutral either way; unresolved as a naming question only.

## Concessions across the debate
- Withdrew my own `PARENT_DIR`-adjacent instinct nowhere stated but implicitly my Round 1 lean toward yet another name — converged on `HAS_ENTRY` instead of adding a ninth candidate.
- Withdrew the MEMBER_OF FILE-only restriction once the overlay-edge classification rule was established.
- Accepted Standards' `PARAM`/`INHERITS_FROM` proposals as identity-neutral without weighing in on their naming merits, deferring to Ergonomics/Standards on pure vocabulary calls.
- Accepted Ergonomics' `IN_METHOD` -> `IN_SCOPE` broadening as identity-neutral.
- Conceded Storage's DELETE+CREATE read of the write contract over my own hoped-for MERGE-on-id answer — and adjusted my ask (overlay classification) rather than insisting on a more expensive write path.

**Proposed additions/changes:**
- [edge] HAS_ENTRY (cf. Joern CONTAINS) -- Final, unanimous rename of the filesystem-nesting edge (DIRECTORY -> DIRECTORY|FILE) to resolve the section 6 collision. Mutated only on move/rename (GE-UC5), never touched by per-file :CPG replace, so the rename is free. CONTAINS stays reserved and unclaimed for Joern's real METHOD->CFG_NODE meaning if CFG ships.
- [edge] IN_SCOPE (cf. Joern CONTAINS (reversed, partial analogue)) -- Adopting Ergonomics/Analytics's broadened rename of IN_METHOD to target METHOD|MODULE, covering top-level side-effecting calls. Identity-neutral: MODULE remains one-per-file and co-replaced with CALL exactly as METHOD was.
- [other] Overlay-edge classification rule -- Any edge landing on a :CPG node from outside that node's own per-file replace transaction (MEMBER_OF, TARGETS, DEPENDS_ON) is classified as a periodic-recompute, stale-tolerant overlay edge, never a correctness dependency of the write path. This is the final resolution of my Round 1 top priority, arrived at jointly with Storage & Query Performance once perf evidence made DELETE+CREATE (not MERGE-on-id) the likely per-file replace mechanism.
- [edge] TARGETS (cf. Joern CALL (edge type, Shortcuts layer)) -- EXTEND, conditional: materialized CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL shortcut is acceptable only as an async overlay under the classification rule above, since it crosses file boundaries and a renamed/deleted target would otherwise dangle silently, corrupting centrality/PageRank results while still looking valid.
- [edge] DEPENDS_ON -- FILE -> FILE rollup, same overlay treatment as TARGETS, produced by the same projection pass per Analytics's unification proposal.
- [edge] ALIAS_OF (cf. Joern ALIAS_OF) -- ADOPT AS-IS, unconditionally safe: both endpoints are SYMBOL, categorically exempt from every replace-survivability concern raised this debate.
- [edge] MEMBER_OF -- ADOPT AS-IS, unrestricted (withdrawing my Round 2 FILE-only hedge): safe once documented as recomputed per COMMUNITY algorithm run, i.e. already governed by the overlay-edge classification rule.
- [other] CALL identity ordinal (parent-scope-relative) -- Required golden-file test, not resolved by id_rule prose: duplicate calls within one method must be disambiguated by an ordinal scoped to the parent METHOD's qualifiedScopePath, or PR5's insert-above guarantee silently breaks.
- [node] SYMBOL -- EXTEND, final: no Joern equivalent is possible without inheriting its global load-time linker, which is structurally incompatible with per-file incremental replace. Load-bearing, not stylistic.
- [other] Joern's CALL edge / BINDING / BINDS_TO / NAMESPACE / SOURCE_FILE (cf. Joern CALL, BINDING, BINDS, BINDS_TO, NAMESPACE, NAMESPACE_BLOCK, SOURCE_FILE) -- REJECT, final and converged across multiple lenses: each requires global/cross-file mutation (whole-graph relink, cross-file merged nodes, or duplicating the indexed `file` property into an edge) incompatible with PR2/PR3/D5.

**Rebuttals:**
- to Standards & Interoperability: Your Round 2 withdrawal of the INHERITS_FROM merge, citing Ergonomics' rejection, is citing Ergonomics' Round 1 position — Ergonomics flipped to support the merge in Round 2. The two lenses' final positions on this specific point disagree with each other, not with me; I have no identity stake either way (both shapes are TYPE_DECL -> SYMBOL, equally replace-safe) but flagging this so synthesis doesn't read it as settled.
- to Storage & Query Performance: Your Round 2 reading of the 13x indexed-delete benchmark as evidence for DELETE-all+CREATE-all rather than MERGE-on-id resolves my Round 1 open question, in the direction that makes every cross-file live edge dangerous rather than safe. I've adopted your overlay-edge classification rule as the general fix rather than continuing to ask for MERGE semantics on the hot path.
- to Graph Analytics & Path Tracing: Your Round 2 concession that TARGETS needs async-overlay treatment fully resolves my Round 1 objection. Final ask: TARGETS must also be a pure projection of CALLS.status/IMPORTS.status/EXTENDS resolution (per Cross-Language's Round 2 condition), computed by the same resolver call, so a stale overlay and a live status enum can never silently disagree.
- to Security & Taint Analysis: Your Round 2 TAGGED_BY-on-SYMBOL refinement matches my own Round 2 proposal exactly — converged, no remaining daylight. Confirming final: TAG/TAGGED_BY anchored on SYMBOL/MEMBER survives every caller's file replace for free via the existing CALLS->SYMBOL hop.

**Concessions made:**
- Withdrew the MEMBER_OF FILE-only restriction I proposed in Round 2, once the overlay-edge classification rule (Storage, Analytics, Complexity, me) made it unnecessary.
- Conceded Storage's Round 2 read of the per-file replace write contract as DELETE-all+CREATE-all rather than MERGE-on-id, based on the 13x indexed-delete benchmark, and adjusted my ask accordingly (overlay classification instead of mandating MERGE semantics).
- Adopted Ergonomics/Analytics's IN_METHOD -> IN_SCOPE rename and target broadening (METHOD|MODULE) as identity-neutral, having deferred the direction/naming call to ergonomics in Round 1.
- Converged on HAS_ENTRY for the section 6 rename rather than defending any alternative spelling, since the substantive point (free CONTAINS for a future Joern-aligned meaning) was unanimous by Round 1 and only the string needed picking.
- Deferred the PARAM vs METHOD_PARAMETER_IN and EXTENDS/IMPLEMENTS vs INHERITS_FROM naming disputes entirely to Standards/Ergonomics as identity-neutral, rather than casting a tie-breaking vote on either.
- Accepted Cross-Language's ALIAS_OF and Security's DEFINES:PARAM->SYMBOL without reservation, both being either categorically safe (SYMBOL-to-SYMBOL) or a straightforward widening of an existing, already-accepted mechanism.

## Agent / MCP Consumption Ergonomics -- Round 3

**Top priority:** Lock the final agent-facing vocabulary now: HAS_ENTRY, IN_SCOPE, TARGETS-as-async-overlay, INHERITS_FROM{relation}, edge-only resolution status (CALLS.status + IMPORTS.status, no bare bools) — a small, single-pattern schema an agent can learn cold from one schema resource, with the CONTAINS collision fully closed.

placeholder

## Cross-Language & Symbol Resolution -- Round 3

**Top priority:** SYMBOL identity (SCIP descriptor grammar) plus ALIAS_OF for re-export chains, and a single normative resolution-status vocabulary shared verbatim by CALLS and IMPORTS, are the two things every other lens's cross-file query correctness ultimately depends on — both are now converged and should ship exactly as specified below, unchanged from Round 2.

## Final dispositions

**SYMBOL {fqn, kind, language} with SCIP descriptor grammar — ADOPT AS-IS (D5), final, no hedging.** This is the one place the debate confirmed a real, structural incompatibility with Joern (Standards, Identity, and I all independently reached this): Joern's `FULL_NAME` is a load-time-linker display string with no package/manager/version concept, and adopting its shape would regress real SCIP interoperability we already have. Section 9's "align where names overlap" stops at this boundary — unanimous by Round 3, nobody pushed back after Round 1.

**ALIAS_OF: SYMBOL -> SYMBOL — ADOPT AS-IS, final.** Went from my Round 1 proposal to the debate's single strongest alignment case (Standards Round 2: "a genuine, current Joern edge, not Hidden/unspecced... zero SYMBOL-format compromise"). Security needs it for TAG propagation through barrels; Analytics/Complexity need it as a mandatory input to TARGETS/DEPENDS_ON resolution. Fully converged, no dissent anywhere in the debate.

**CALLS.status / IMPORTS.status shared 5-value enum with normative dynamic/ambiguous definitions — EXTEND, final.** IMPORTS.status must reuse CALLS' exact vocabulary (not a parallel set) — I said this in Round 2 and no lens contested it; Ergonomics' bool-removal proposal only works cross-language if this holds. The dynamic/ambiguous definitions Security and I converged on independently (dynamic = runtime dispatch the frontend cannot follow statically; ambiguous = multiple statically-plausible static candidates) should go into the schema doc as normative text, not implicit convention.

**DEFINES extended to PARAM — ADOPT (Security's proposal), final.** This is a resolution-completeness fix, not just a taint one: without it, tainted-parameter tracing and simple "find all callers passing X into this param" queries have no stable cross-file anchor.

**METHOD.generator (bool), TYPE_DECL.structural (bool) — EXTEND, final, uncontested.** Both cleared the whole debate with zero pushback and independently validated Complexity's own orthogonal-boolean pattern.

**HAS_ENTRY for the section 6 CONTAINS rename — ADOPT RENAMED, final.** I withdrew my own `PARENT_DIR` in Round 2 to converge; by Round 3 this has plurality across six-plus lenses. `IN_METHOD`/`IN_SCOPE` broadening (Analytics/Ergonomics' CALL->METHOD|MODULE rename): not my lens's core concern, but I have no objection and note it's converged elsewhere.

**REJECT, final, unchanged since Round 1:** METHOD_REF, TYPE_REF, REF, BINDING/BINDS/BINDS_TO (vtable resolution requires the same whole-hierarchy computation D5 rejected Joern's CALL edge for — Standards agreed explicitly, no dissent), TYPE/TYPE_PARAMETER/TYPE_ARGUMENT, CLOSURE_BINDING (all expression/generics-tier, correctly deferred per PR1/D23), NAMESPACE/NAMESPACE_BLOCK (three lenses triangulated REJECT independently by Round 2 — I have nothing to add, it's dead).

**TARGETS (Analytics' shortcut) — conditional EXTEND, final condition unchanged from Round 2: it must be a pure projection computed by the identical resolver call that produces CALLS.status/IMPORTS.status, walking ALIAS_OF* to canonical before materializing, and recomputed as an async overlay (converged with Identity/Storage/Complexity by Round 2) — never a second resolution codepath.** This is the one place I'd block adoption outright if the constraint is dropped: a fast-path resolver that skips ALIAS_OF for speed would silently disagree with CALLS.status on exactly the re-export cases my lens exists to get right, with no agent-visible signal of the drift.

**reprolang (section 8) — ADOPT as base conformance target, final, with the concession restated:** it's language-agnostic and won't catch TS/Python-specific identity bugs (decorator-wrapped identity, name-mangled Python attributes, destructured imports, barrel re-exports) — a small hand-written TS+Python golden fixture set is required alongside it, not instead of it.

## Concessions made across the debate
- Withdrew `PARENT_DIR` in favor of `HAS_ENTRY` (Round 2) — no resolution-correctness stake in the name.
- Conceded reprolang alone is insufficient (Round 1, restated above) — needs hand-written per-language fixtures.
- Conceded Joern's jssrc2cpg/pysrc2cpg suites are mine-by-hand only, not machine-reusable (Round 1).
- Conceded TARGETS *can* be compatible with D5/SYMBOL (Round 2) — I was initially skeptical, now support it conditionally.
- Conceded INHERITS_FROM/Python-Protocol gap is an honest v1 limitation, not grounds to reopen TYPE_DECL machinery.

## Unresolved tensions — flagging plainly for synthesis
1. **PARAM → METHOD_PARAMETER_IN rename: genuinely unresolved.** Standards proposed it (Round 1) and never withdrew it; Ergonomics explicitly REJECTed it (Round 2, "imports half of a paired convention with no pair present"). I have no stake beyond wanting whichever name carries the DEFINES→SYMBOL edge — synthesis must pick one, the debate did not converge.
2. **EXTENDS/IMPLEMENTS vs INHERITS_FROM: appears settled but by unanimous *withdrawal*, not by a vote I cast** — Standards withdrew its own merge proposal in Round 2 after Ergonomics' and Storage's planner-pruning argument. I stayed neutral throughout (deferred to Analytics/Standards per Round 1) and have no independent basis to reopen it; noting it as settled-by-default rather than settled-by-my-argument.
3. **TARGETS' actual write-timing mechanism is agreed in principle (async overlay) but not yet specified as an implementable contract** — "computed_at/status like COMMUNITY" is repeated by four lenses but no one has written the actual rebuild-trigger semantics (on every save of either endpoint's file? on a timer? on read staleness threshold?). This is real follow-up work, not a resolved design.

**Proposed additions/changes:**
- [node] SYMBOL (SCIP descriptor grammar) -- Final: ADOPT AS-IS per D5. No Joern equivalent is possible without inheriting its load-time linker; SCIP's descriptor grammar is the only design that survives cross-package re-export chains and per-file incremental replace simultaneously.
- [edge] ALIAS_OF (cf. Joern ALIAS_OF) -- Final: ADOPT AS-IS. Genuine current Joern edge, models TS barrel/re-export and Python __init__.py re-export chains as a graph traversal instead of a string property, required input to TAG propagation and TARGETS/DEPENDS_ON resolution.
- [property] CALLS.status / IMPORTS.status shared enum + normative dynamic/ambiguous definitions -- Final: EXTEND. Two lenses converged independently on identical semantics from different motivations (cross-language comparability vs taint triage) -- must be written as normative schema text so TS and Python frontends can't silently disagree on which bucket a call/import falls into.
- [edge] DEFINES (extended to PARAM) (cf. Joern REF / PARAMETER_LINK (partial analogy)) -- Final: ADOPT (Security's proposal). Parameters need the same stable cross-reference identity as methods/types/members for both taint propagation and ordinary caller-argument resolution queries.
- [property] METHOD.generator (bool) -- Final: EXTEND, uncontested. Orthogonal to async/kind, composes across TS and Python generator/async-generator forms without enum explosion.
- [property] TYPE_DECL.structural (bool) -- Final: EXTEND, uncontested. Distinguishes structural (interface/Protocol/TypedDict) from nominal (class/dataclass/enum) type declarations with one cross-language predicate.
- [edge] HAS_ENTRY (renamed filesystem CONTAINS) (cf. Joern CONTAINS (deliberately not reused)) -- Final: ADOPT RENAMED. Converged plurality name across six-plus lenses; frees CONTAINS for Joern's real METHOD->CFG-node meaning if D23's CFG layer ships.
- [other] TARGETS must be a pure projection of the same resolver call as CALLS.status, never an independent fast-path resolver (cf. Joern CALL (edge, Shortcuts layer)) -- Final condition for conditional EXTEND. Prevents the one failure mode that would silently break cross-language resolution guarantees: a second resolution codepath disagreeing with CALLS.status on re-export/barrel cases with no agent-visible signal.
- [other] reprolang + hand-written TS/Python golden fixtures as combined conformance target -- Final: ADOPT reprolang as base (language-neutral resolver logic: forward-def, duplicates, cross-file linking) plus required supplementary fixtures for decorator-wrapped identity, name-mangled Python attributes, destructured imports, and barrel re-exports that reprolang cannot exercise by design.

**Rebuttals:**
- to Standards & Interoperability: The PARAM -> METHOD_PARAMETER_IN rename was never withdrawn and directly conflicts with Ergonomics' explicit Round 2 REJECT -- this is unresolved, not settled by your Round 1 proposal standing unchallenged until now. Synthesis needs to pick one; I have no independent stake beyond insisting the DEFINES->SYMBOL edge attaches regardless of which name wins.
- to Graph Analytics & Path Tracing: TARGETS is acceptable in final form only under the constraint restated above: computed by literally the same resolver call as CALLS.status, walking ALIAS_OF* first. Your Round 2 revision (async overlay) satisfies the write-timing half of my condition but I want it on record that the resolution-logic-sharing half is equally load-bearing and distinct from staleness tolerance.
- to Agent / MCP Consumption Ergonomics: Your removal of CALL.resolved/IMPORT.resolved bools is adopted, final, on the condition (never contested) that IMPORTS.status reuses CALLS' identical five-value vocabulary rather than a parallel set -- this was never in dispute after Round 2 and I'm restating it as settled.

**Concessions made:**
- SYMBOL.fqn's SCIP grammar is genuinely incompatible with Joern's FULL_NAME format -- conceded in Round 1, never revisited, stands as load-bearing.
- reprolang alone is insufficient conformance coverage for TS/Python-specific identity bugs -- conceded Round 1, a hand-written golden fixture set is required alongside it.
- Withdrew my own PARENT_DIR proposal for the CONTAINS rename in favor of consensus on HAS_ENTRY (Round 2) -- no resolution-correctness stake in the specific string.
- Conceded TARGETS can be made compatible with D5/SYMBOL's incremental guarantees (Round 2) after initial skepticism, conditional on it being a strictly derived projection of the same resolver, never an independent resolution codepath.
- Conceded the INHERITS_FROM vs EXTENDS/IMPLEMENTS question is outside my lens's core concern and deferred to Analytics/Standards throughout -- noting in Round 3 that it settled by Standards' own withdrawal, not by any argument I made.
- Conceded Python's implicit/duck-typed Protocol conformance has no edge to attach to under INHERITS_FROM or the current draft -- an honest v1 limitation, not grounds to reopen TYPE_DECL/TYPE usage-site machinery.

## Storage & Query Performance (Cypher/FalkorDB) -- Round 3

**Top priority:** Codify the "overlay edge" classification (MEMBER_OF, TARGETS, DEPENDS_ON — anything landing on a :CPG node from outside that node's own per-file replace transaction) as a permanent, non-negotiable architectural rule, not a debate-round nicety, and lock HAS_ENTRY as the final name for the section 6 rename so no implementation ever writes code against a still-contested name.

## Final dispositions, by category

**Section 6 — CONTAINS collision: RULING, final.** Rename the filesystem edge (`DIRECTORY -> DIRECTORY|FILE`) to **`HAS_ENTRY`**. Two lenses (mine, Identity & Incremental) proposed this independently without coordination in Round 1; by Round 2 every lens that touched section 6 had converged on renaming, and by Round 2 end HAS_ENTRY had plurality across Identity, Storage, and was seconded by Analytics, Ergonomics, Cross-Language, and Standards. `CONTAINS` stays permanently reserved, unclaimed, for Joern's real `METHOD -> CFG_NODE` meaning if D23's CFG layer ever ships. `IN_METHOD` → **ADOPT RENAMED to `IN_SCOPE`, target broadened to `METHOD|MODULE`** (Analytics' module-level-call gap, Ergonomics' rename argument) — zero perf cost either way, no objection.

**Per-token/per-usage-site Joern nodes — REJECT, final, no revisit path proposed:** `MODIFIER`, `METHOD_RETURN`, `ANNOTATION`/`ANNOTATION_LITERAL`/`ANNOTATION_PARAMETER`/`ANNOTATION_PARAMETER_ASSIGN`, `TYPE_PARAMETER`/`TYPE_ARGUMENT`, `TYPE`-as-usage-node, `NAMESPACE`/`NAMESPACE_BLOCK`. All are multiplicative taxes on the 450-node/file budget for zero query benefit a string property or existing edge doesn't already give (`return_type_text`, `type_text`, `CALL{kind:decorator}->SYMBOL`, `DECLARES` fan-out). NAMESPACE additionally converged as dead via three independent arguments (mine: cross-file merge breaks per-file replace consistency; Identity: same; Analytics: TS/Python already file-scoped) — strongest triangulation in the whole debate.

**Expression/CFG-tier nodes — REJECT for v1, names reserved, not gone:** `IDENTIFIER`, `LITERAL`, `FIELD_IDENTIFIER`, `LOCAL`, `METHOD_REF`, `TYPE_REF`, `BLOCK`, `CONTROL_STRUCTURE`, `RETURN`, `JUMP_TARGET`, `JUMP_LABEL`, `ARRAY_INITIALIZER`. Same for CFG/PDG edges: `CFG`, `CDG`, `DOMINATE`, `POST_DOMINATE`, `REACHING_DEF`, `ARGUMENT`, `RECEIVER`, `CONDITION`, `*_BODY`/`FOR_*`/`JUMP_ARGUMENT`, `EVAL_TYPE`. D23 defers these; PR1's measured 7x density gap is decisive and no lens argued to pull any of them into v1.

**Joern's linker-created `CALL` edge and `BINDING`/`BINDS`/`BINDS_TO` — REJECT, final, mechanism-level, not naming.** Both require global load-time relinking/whole-hierarchy computation, structurally incompatible with D5/PR2. `CALLS.status=ambiguous` (already adopted) is the permanent substitute, not a stopgap.

**`SOURCE_FILE` — REJECT, final.** We already get file-scoping via a `file` property under the shared `:CPG` label index — that property is precisely the mechanism the measured 13x indexed-delete speedup (3.1ms vs 40.3ms) depends on. Trading it for an edge would directly undercut our own benchmark story.

**Draft's typed-edge decomposition (`DECLARES`/`HAS_PARAM`/`DEFINES`/`CALLS`/`IMPORTS`/`EXTENDS`/`IMPLEMENTS`) — ADOPT AS-IS, final.** REJECT collapsing to Joern's generic `AST`/`REF`. Relationship-type-specific adjacency lets FalkorDB's planner prune by edge type instead of every traversal post-filtering by target label — this is a real technical cost difference for these high-frequency, per-node-instance edges, not a style preference.

**`EXTENDS`/`IMPLEMENTS` vs `INHERITS_FROM{relation}` — final: keep two typed edges.** I want this on record as a case where I was neutral on pure perf grounds (0–few edges per TYPE_DECL, negligible planner-pruning benefit either way) but the debate correctly settled it on ergonomics grounds (Ergonomics' query-shape argument, which Standards itself came to accept and withdrew its own merge proposal over). No perf objection to that outcome.

**`SYMBOL`, `TAG`/`TAGGED_BY`, `ALIAS_OF`, `META_DATA`, `UNKNOWN`, `DIRECTORY`/`FILE`, `COMMUNITY` — ADOPT/EXTEND as converged, final, no perf objection.** All are low-cardinality (one alias per symbol, one META_DATA total, UNKNOWN only on parse failure, tags only on classified nodes) — none stress label-index cardinality the way the rejected batch above would have.

**`TARGETS`/`DEPENDS_ON` — conditional EXTEND, final: overlay-only, never write-path.** This is my one substantive Round 2→3 contribution I want the synthesis to treat as load-bearing: any edge crossing a file boundary outside its own file's replace transaction must be classified as a periodic-recompute overlay (COMMUNITY's contract — its own `computed_at`/status, explicitly stale-tolerant, never a correctness dependency). Both Graph Analytics and Identity independently arrived at the same fix after I (and Identity, and Storage in parallel) pointed out the rename-orphaning hazard — this is now unanimous, not contested.

## Genuinely unresolved tensions — flagging honestly, not papering over

1. **Whether per-file replace is MERGE-on-id or DELETE+CREATE was never empirically confirmed by an implementation source** — only inferred from the 13x indexed-delete benchmark shape (which strongly implies bulk delete+recreate, not per-node MERGE). This is a real open question for whoever writes `DiffGraph.replace()`, not settled by argument in this debate. The overlay-edge rule above is designed to make the answer not matter for correctness, but the answer still matters for whether MEMBER_OF-as-currently-drafted needs a rewrite.
2. **TAG/TAGGED_BY attachment point (SYMBOL-primary per Identity vs SYMBOL+MEMBER-primary/CALL-secondary per Security)** is a minor unresolved detail between two other lenses; I have no perf stake and didn't weigh in either round.
3. **Cross-Language's condition that TARGETS must be computed by the *same resolver call* as CALLS.status (never a separate fast-path)** is a real constraint I didn't originate but now endorse fully — it and my overlay-timing rule are complementary, not competing, but neither lens explicitly merged the two into one written contract, and the synthesis should.

## Concessions made across the debate
- Conceded a relationship-property index on `CALLS.status` is a nice-to-have, not a blocker — a CALL-label scan with one fixed-fanout hop is cheap regardless (Round 2, to Ergonomics).
- Conceded `EXTENDS`/`IMPLEMENTS` vs `INHERITS_FROM` is not decided by perf and deferred to the ergonomics argument.
- Conceded TYPE-as-usage-node might become a real EXTEND if generics-aware queries become load-bearing later — not a v1 need.
- Conceded the exact spelling of the CONTAINS rename was never mine to win — only that fragmentation had to stop.


**Proposed additions/changes:**
- [edge] HAS_ENTRY (cf. Joern CONTAINS (deliberately not used)) -- Final converged rename of the v1 draft's filesystem-nesting CONTAINS edge (DIRECTORY -> DIRECTORY|FILE), resolving the section 6 collision. Reserves CONTAINS for Joern's actual METHOD->CFG_NODE meaning if D23's CFG layer ships. Chosen because it independently drew votes from two lenses without coordination and fully drops the confusable 'CONTAINS' substring, unlike DIR_CONTAINS/TREE_CONTAINS/PATH_CONTAINS.
- [other] Overlay-edge classification rule (permanent architectural contract) (cf. Joern Shortcuts layer (overlay/linker-only, frontend MUST NOT create)) -- Any edge landing on a :CPG node from outside that node's own per-file replace transaction (MEMBER_OF, TARGETS, DEPENDS_ON) is a periodic-recompute overlay: its own computed_at/status, explicitly stale-tolerant, never a correctness dependency of the per-file write path. This is what makes TARGETS/DEPENDS_ON compatible with D5/SYMBOL's incremental guarantees instead of reopening the whole-graph-relink problem SYMBOL was built to eliminate -- converged on independently by Storage, Identity, and Graph Analytics by Round 2, now final.
- [edge] TARGETS (cf. Joern CALL (edge type, Shortcuts layer)) -- Conditional EXTEND, final: materialized CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL shortcut for centrality/PageRank/impact-of-change, acceptable ONLY as an overlay-classified edge per the rule above, and only as a pure projection of the same resolver call that sets CALLS.status (Cross-Language's added constraint, which I endorse as complementary to the timing rule).
- [node] SOURCE_FILE (Joern edge, rejected as a node-equivalent concept for us) (cf. Joern SOURCE_FILE) -- REJECT, final. Our file property under the shared :CPG label index already gives file-scoping, and is precisely the mechanism the measured 13x indexed-delete speedup (3.1ms vs 40.3ms) depends on. An edge would undercut that benchmark story for no compensating benefit.
- [node] MODIFIER / METHOD_RETURN / ANNOTATION family / TYPE_PARAMETER / TYPE_ARGUMENT / TYPE-as-usage-node / NAMESPACE / NAMESPACE_BLOCK (cf. Joern MODIFIER, METHOD_RETURN, ANNOTATION, ANNOTATION_LITERAL, ANNOTATION_PARAMETER, ANNOTATION_PARAMETER_ASSIGN, TYPE_PARAMETER, TYPE_ARGUMENT, TYPE, NAMESPACE, NAMESPACE_BLOCK) -- REJECT, final, no revisit path. Each is a per-token or per-usage-site multiplicative tax on the 450-node/300-line-file budget with zero query benefit a scalar property or existing edge doesn't already provide. NAMESPACE additionally confirmed dead by triangulated independent arguments from three lenses.

**Concessions made:**
- Relationship-property index on CALLS.status downgraded from ask to nice-to-have — a CALL-label scan with one fixed-fanout hop to check edge status is cheap with or without a dedicated index.
- No perf-based objection to keeping EXTENDS/IMPLEMENTS as two typed edges rather than merging into INHERITS_FROM{relation} — conceded this is an ergonomics call, not a performance one, since cardinality is 0-few edges per TYPE_DECL either way.
- Conceded TYPE-as-usage-node could become a legitimate future EXTEND if generics-aware queries become load-bearing — not arguing it's permanently dead, only that it fails the v1 density budget.
- Conceded the exact replacement string for the CONTAINS rename was never a performance question — my stake was only that the rename happen and that the debate stop fragmenting across eight candidate names.

## Standards & Interoperability -- Round 3

**Top priority:** Close the debate with an explicit, honest ledger — every Joern type given one final verdict — and surface two things that convergence-by-exhaustion must not paper over: the EXTENDS/IMPLEMENTS merge oscillation (Ergonomics and I passed each other going opposite directions between R1 and R2) and the still-never-confirmed MERGE-on-id vs DELETE+CREATE write contract that half the derived-edge proposals silently depend on.

## Final ledger

**ADOPT AS-IS** (Joern name and shape, no changes): `TYPE_DECL`, `METHOD`, `MEMBER`, `CALL` (node), `UNKNOWN`, `META_DATA`, `ALIAS_OF`, `TAG`, `TAGGED_BY`. `IMPORT`/`IMPORTS` — cite precisely as "matches Joern's actual (Hidden) implementation," never "matches the published spec."

**ADOPT RENAMED**: `CALLS` (from Joern's edge `CALL`, to kill the node/edge label ambiguity Joern itself has). Filesystem `CONTAINS` → **`HAS_ENTRY`** (the debate's one unanimous rename, converged independently by Identity and Storage; `CONTAINS` stays reserved, unclaimed, for `METHOD -[:CONTAINS]-> BLOCK|CONTROL_STRUCTURE|CALL|RETURN` if/when CFG lands — ADOPT AS-IS at that time). `IN_METHOD` → **`IN_SCOPE`**, broadened to `CALL -> METHOD|MODULE` (Analytics' module-level-call gap, Ergonomics' rename argument — not my core territory but I'll sign it, no Joern name to lose here either way). **`EXTENDS`/`IMPLEMENTS` → `INHERITS_FROM{relation: extends|implements}`** — see oscillation note below; this is my final call, reverting to my R1 position.

**REJECT for v1, PARAM stays PARAM**: I withdraw my own `PARAM → METHOD_PARAMETER_IN` rename. Ergonomics' R2 counter is a real, non-cosmetic argument, not vibes: `_IN` only signals anything against a `_OUT` we correctly omit, so importing half a Joern pair imports confusion, not alignment credit. This is exactly the bar I set for everyone else in R1 — I hold myself to it. `METHOD_PARAMETER_OUT` stays a legitimate omission (no by-ref out-params in TS/Python), not a rename.

**REJECT (confirmed, extending my own R1/R2 concessions)**: `MODIFIER`, the 74 `<operator>.*` CALL desugaring, `METHOD_RETURN`, the `ANNOTATION` family (4 types), `TYPE_PARAMETER`/`TYPE_ARGUMENT`, `TYPE`-as-node, `NAMESPACE`/`NAMESPACE_BLOCK` (triangulated dead by three independent lenses), `BINDING`/`BINDS`/`BINDS_TO`, `PARAMETER_LINK` (no referent without OUT-params), `RECEIVER`/`ARGUMENT` edges (folded into CALL properties), `SOURCE_FILE` edge (redundant with the `.file` property the 13x indexed-delete benchmark depends on), `KEY_VALUE_PAIR`, `TAG_NODE_PAIR` (edge properties on `TAGGED_BY` suffice in a property graph), `FINDING` (taint-overlay, RK1-adjacent, deferred with CFG/PDG), `IS_CALL_FOR_IMPORT`/`CAPTURE`/`CAPTURED_BY` (Hidden, not even published spec, no need). Expression/CFG-tier types (`CONTROL_STRUCTURE`, `BLOCK`, `RETURN`, `JUMP_TARGET`, `JUMP_LABEL`, `IDENTIFIER`, `LITERAL`, `FIELD_IDENTIFIER`, `LOCAL`, `METHOD_REF`, `TYPE_REF`, `REF`, `ARRAY_INITIALIZER`, `COMMENT`, `EVAL_TYPE`, `CDG`, `CFG`, `DOMINATE`, `POST_DOMINATE`, `REACHING_DEF`, the `*_BODY`/`FOR_*`/`JUMP_ARGUMENT` family): REJECT for v1, **reserve Joern's exact names** for whenever those tiers ship — no rename buys anything there.

**EXTEND** (no Joern equivalent, filling a real gap, not a divergence from anything): `SYMBOL` (load-bearing, not cosmetic — stated plainly against my own brief since R1), `DIRECTORY`, `MODULE`, `COMMUNITY`/`MEMBER_OF`, `TARGETS` (conditional: async overlay only, pure projection of the same resolver that sets `CALLS.status`/`IMPORTS.status`, never a second resolution codepath — Cross-Language's condition, which I adopt as final), `DEPENDS_ON` (same overlay job as `TARGETS`), `DEFINES` broadened to `PARAM`, `DECLARES` broadened to `IMPORT`, `IMPORTS.status`/`CALLS.status` shared five-value enum with the dynamic/ambiguous definitions this round converged on verbatim.

## Concessions, explicit

I concede: the `PARAM` rename (above). Full extension of my `MODIFIER`-density concession to `METHOD_RETURN`/`ANNOTATION`/`TYPE_PARAMETER`/`TYPE_ARGUMENT`/`TYPE`. `NAMESPACE`/`NAMESPACE_BLOCK` dead. `BINDING`/`BINDS`/`BINDS_TO` dead permanently, not just deferred. `SYMBOL`'s SCIP-format and its whole mechanism have no Joern equivalent and cannot without inheriting a global load-time linker — this is load-bearing, stated against my own brief, and I'm not softening it in R3 either.

## Unresolved — flagging honestly, not papering over

**The EXTENDS/IMPLEMENTS merge oscillated.** I proposed `INHERITS_FROM{relation}` in R1; Ergonomics rejected it; I conceded and withdrew it in R2 citing Storage's typed-edge-decomposition principle — but I misapplied that principle: Storage's own R2 text explicitly says the planner-pruning argument applies to *high-frequency* edges (`DECLARES`/`CALLS`/etc.), not to `EXTENDS`/`IMPLEMENTS` (0–few per `TYPE_DECL`), and gave it "no objection." Meanwhile Ergonomics flipped the *other* way in the same round, now endorsing the merge on their own `CALL.kind` precedent. We passed each other. My R3 final call reinstates the merge — but synthesis should know this was two lenses independently reversing, not a settled convergence, and should double-check it isn't reversed again.

**The MERGE-on-id vs DELETE+CREATE per-file replace write contract was never actually confirmed** — Identity raised it as the sharpest open question in R1; Storage offered an *inference* from benchmark numbers in R2 (the 13x indexed-delete figure "only makes sense" as evidence for bulk delete+recreate), not a confirmed spec fact. Every "ship it as an async, stale-tolerant overlay" resolution (`MEMBER_OF`, `TARGETS`, `DEPENDS_ON`) is a workaround for not knowing this, not a proof it's safe. This is the single biggest real unknown in the whole debate.

**No Type System lens ever appeared**, despite `TYPE_ARGUMENT`/`TYPE_PARAMETER`/`BINDS`/`EVAL_TYPE` being squarely its territory (Analytics said so explicitly in R1). My REJECTs there are the consensus of adjacent lenses, not a considered type-system judgment — flag as provisional.

**Proposed additions/changes:**
- [edge] HAS_ENTRY (cf. Joern CONTAINS (deliberately not reused)) -- Final converged rename of the filesystem DIRECTORY->DIRECTORY|FILE edge, resolving the section 6 collision by fully vacating the CONTAINS name (unlike DIR_CONTAINS/TREE_CONTAINS variants) so it stays free for Joern's real METHOD->CFG-node meaning if CFG ships.
- [edge] INHERITS_FROM (cf. Joern INHERITS_FROM) -- Final call, reinstated after R2 whiplash: merge EXTENDS/IMPLEMENTS into one edge with a relation property. Storage's planner-pruning objection (used to reject this in my R2) explicitly does not apply to this low-cardinality (0-few per TYPE_DECL) edge type by Storage's own R2 text, and Ergonomics independently re-endorsed the merge on CALL.kind-precedent grounds in the same round.
- [edge] CALLS (cf. Joern CALL (edge)) -- Deliberate rename from Joern's edge-label CALL to avoid the node/edge ambiguity Joern itself carries (CALL is both a node type and an edge type), a concrete parsing-clarity reason rather than cosmetic preference.
- [node] SYMBOL -- No Joern equivalent is possible without inheriting Joern's global load-time linker over METHOD_FULL_NAME, which is structurally incompatible with per-file incremental replace (PR2/PR3). Standing concession: this divergence is load-bearing, not stylistic, held across all three rounds.
- [other] PARAM stays PARAM (rename withdrawn) (cf. Joern METHOD_PARAMETER_IN) -- Withdrawing my own R1/R2 rename proposal: the _IN suffix only means something contrasted with METHOD_PARAMETER_OUT, which we correctly omit (no by-ref out-params in TS/Python) -- importing half a Joern naming pair imports confusion, not alignment value.

**Rebuttals:**
- to Agent / MCP Consumption Ergonomics: Conceding the PARAM->METHOD_PARAMETER_IN rename outright: your R2 argument (importing half a Joern IN/OUT pair with no OUT present imports confusion, not alignment) clears the bar my own brief sets for every divergence. Final: PARAM stays PARAM.
- to Agent / MCP Consumption Ergonomics: On EXTENDS/IMPLEMENTS: noting that we swapped positions across rounds (I withdrew the merge in R2 as you were independently re-endorsing it). My final call reinstates INHERITS_FROM{relation}, since Storage's planner-pruning argument -- which I leaned on to reject it -- explicitly does not apply to this low-cardinality edge by Storage's own words.
- to Storage & Query Performance (Cypher/FalkorDB): I misapplied your typed-edge-decomposition principle to EXTENDS/IMPLEMENTS in R2 -- your own text scoped that argument to high-frequency edges and said 'no objection' to this merge specifically. Correcting course in R3: reinstating INHERITS_FROM{relation} as my final position.
- to Incremental Update & Identity: Your MERGE-on-id-vs-DELETE+CREATE question was never actually answered in this debate -- only worked around by classifying every cross-file derived edge as a stale-tolerant overlay. I'm flagging this explicitly as unresolved rather than letting the overlay pattern's convergence imply the underlying question got settled.

**Concessions made:**
- Withdrawing the PARAM -> METHOD_PARAMETER_IN rename permanently: importing half of Joern's IN/OUT naming pair with no OUT counterpart present confuses rather than aligns.
- Extending the MODIFIER-density concession to cover METHOD_RETURN, the full ANNOTATION node family, TYPE_PARAMETER/TYPE_ARGUMENT, and TYPE-as-node -- all REJECT for v1 on cardinality grounds.
- NAMESPACE/NAMESPACE_BLOCK confirmed dead, not merely deferred, per triangulated independent rejections from three other lenses.
- BINDING/BINDS/BINDS_TO rejected permanently, not just for v1 -- the vtable-resolution mechanism requires the same whole-hierarchy global-linker computation D5 already rejected for CALL edges.
- SYMBOL's SCIP-format identity and its non-Joern resolution mechanism remain conceded as load-bearing divergences, not cosmetic ones, held from R1 through R3 without softening.
