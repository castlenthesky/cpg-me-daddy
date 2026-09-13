# v1 CPG schema — specification and Joern divergence record

- status: approved
- approved_by: visionary
- approved_on: 2026-09-12
- unit: M0.0 (60-delivery.yaml)

**Authority.** This document is the single source of truth for the graph vocabulary: every node
label, every edge type, the id rule, the status enums, and the Joern divergence record. It
supersedes, in the parts noted at each site: planning `README.md` design rules 1, 2 (in part) and 3
(in part); `10-graph-engine.yaml`'s `v1_schema` block (now a pointer here); and the legacy
`src/types/cpg.ts` / `src/types/nodes.ts` prototype, which is reference-only and was never a recorded
decision (SF4). The machine-readable definition this document narrates lives in
`packages/engine/src/schema/` — one source, so `bun run test:schema`, the golden serializer (M0.6+)
and the `cpg://schema` MCP resource (M2) can never drift from what a human signed off on here.

**Provenance chain.** Eight-lens AI ontology debate (`research/R6-ontology-debate-transcript.md`,
3 rounds) → synthesis (`research/R6-ontology-debate-synthesis.md`) → visionary sign-off on its six
open items, 2026-09-11 → this document, which transcribes that approved schema into a spec with one
deliberate, reasoned addition (§4, `INHERITS_FROM`) and closes the alignment decision (§1) the
synthesis's own research left as R6's open item.

**Amendment protocol.** Changes follow `40-research.yaml`'s amendment style: `was:` / `now:` / `why:`,
appended to §14, never a silent edit. A change to a shipped label, edge type, required property or
enum value set also bumps `packages/engine/src/schema/schema.ts`'s `CPG_SCHEMA.version` — see §8.

---

## §1. The alignment decision

**Decision: option (b).** Align node and edge names to Joern where they overlap, keep the
sparse-tier and SCIP divergences, and document every divergence with a specific, non-cosmetic
reason. Rejected: (a) adopt Joern's CPG spec wholesale; (c) define our own schema referencing Joern
only informally.

The defence: we ship 11 of Joern's 68 published names (39 concrete nodes + 29 edges in the vendored
`packages/engine/test/support/joern-cpg-schema.json`) unchanged or lightly renamed, and account for
the other 57 in writing (§10), because the parts of Joern's CPG that are portable are the
**vocabulary** and the parts that are not are the **mechanisms** — and the mechanisms are precisely
what this project cannot adopt. Joern resolves `CALL`, `INHERITS_FROM` and `BINDS_TO` with a global
load-time linker walking `METHOD_FULL_NAME` across the entire graph; that requires whole-graph
relinking, which is structurally incompatible with a 24 ms single-file replace under concurrent
readers (Security, Identity, Cross-Language and Standards reached this independently). Joern's node
set is also dense by design — one node per modifier keyword, per type reference, per usage site —
which is a multiplicative tax on a measured ~450-node budget per 300-line file for query benefits a
string property already provides. That is PR1, and PR1 is the product. So (a) is out on structural
grounds, not taste. But (c) throws away real value for nothing: `TYPE_DECL`, `METHOD`, `MEMBER`,
`CALL`, `TAG`, `UNKNOWN`, `META_DATA`, `ALIAS_OF`, `TAGGED_BY`, `INHERITS_FROM` already mean what Joern
means, a Joern-literate user or agent reads our schema correctly for free, and a differential-export
oracle against `joern-export` stays available as a correctness check that needs only name agreement.
Every rename in §4/§5 clears a specific bar or it does not ship — `CALLS` clears it (Joern overloads
`CALL` as both node and edge label, a real Cypher parsing hazard); `HAS_ENTRY` clears it (our
filesystem edge collided with Joern's near-opposite `CONTAINS`, actively misleading, worse than no
alignment at all); `PARAM` stayed `PARAM` because renaming to `METHOD_PARAMETER_IN` would import half
of a paired IN/OUT convention with no OUT present — confusion wearing alignment's clothes, and the
lens that proposed it withdrew the proposal.

**The `decision_inputs_pending` questions this unit was blocked on (`60-delivery.yaml` `OI1`) — all
three were already answered by the corpus; none needed further research:**

1. *Is Joern's spec portable outside its Scala/overflowdb engine?* Split, and that split is the
   basis for option (b). The **data model** is portable — `joern-cpg-schema.json` is machine-readable
   and engine-independent. The **semantics** are not: the linker-created `CALL` edge, `BINDING`/
   `BINDS`/`BINDS_TO` vtable dispatch, and the Shortcuts layer a frontend must not create are engine
   behaviours, not schema.
2. *Does alignment buy anything concrete?* Yes, but bounded: a differential-export oracle needing
   only name agreement; Joern-literate readability; Joern's `jssrc2cpg`/`pysrc2cpg` test suites as a
   hand-mined (not machine-reusable) catalogue of TS/Python edge cases. Not: importable queries
   (CPGQL is Scala, not Cypher), reusable analyses, or an importer/exporter.
3. *Does a published conformance suite exist?* **No** — none for Joern's CPG spec. **SCIP ships one**
   (`scip test`'s assertion DSL, the 12-scenario language-agnostic `reprolang` corpus, a pinned
   real-world nightly benchmark matrix) — see §11. This was M0.0's own "highest-value find," and it
   points at SCIP, not Joern.

`60-delivery.yaml`'s `OI1` is resolved accordingly (see §14).

---

## §2. Scope, tiers and layers

v1 covers the **structural tier**: filesystem (`DIRECTORY`, `FILE`), module/type/method/param/member
declarations, calls, imports, the `SYMBOL` identity layer, the analytics overlay (`COMMUNITY`,
`TARGETS`, `DEPENDS_ON`, `MEMBER_OF`), a generic tag/triage mechanism (`TAG`, `UNKNOWN`), and
`META_DATA`. Sparse by design (PR1): one node per thing a developer or agent would name, no nodes for
syntax; positions are properties for navigation, never identity.

Deferred, not designed away: the **expression tier** (`IDENTIFIER`/`LITERAL`/`FIELD_IDENTIFIER`/`REF`)
and the **CFG/remaining-PDG tiers** (`BLOCK`/`CONTROL_STRUCTURE`/`RETURN`, `CDG`/`DOMINATE`).
Their Joern names are reserved unchanged for when these tiers ship (§9b) — RK1 requires the v1 schema
not preclude adding taint analysis later, and reserved-name discipline is how that promise stays
concrete rather than aspirational.

**Amended 2026-09-12:** `REACHING_DEF` was pulled forward out of the deferred PDG tier as sparse
structural-tier data flow — `MEMBER|PARAM -> CALL`, intra-file, no expression-tier nodes required
(D10/D23 amendment, DL13). See §4 and §5.

---

## §3. Node label catalogue

Fourteen labels. Full property tables, ownership class and write mechanism live in
`packages/engine/src/schema/nodes.ts` — this section narrates what a reader needs that the code
comments don't repeat.

- **`DIRECTORY`**, **`FILE`** — filesystem tier. Never `:CPG`. `FILE.path` / `DIRECTORY.path` are
  their own identity; `merge-on-key`, mutated in place on save, not deleted and recreated.
- **`MODULE`** — one per file for TS/Py; nested namespaces/declared modules become nested `MODULE`.
  Supersedes the rejected `NAMESPACE_BLOCK` (§10).
- **`TYPE_DECL`** — `class | interface | enum | type_alias | protocol | dataclass`. Gains
  `structural` (bool, R6 addition).
- **`METHOD`** — `function | method | constructor | getter | setter | lambda_named`. Free functions
  and methods share the label; the `DECLARES` edge disambiguates. Gains `cyclomatic_complexity`,
  `max_nesting_depth`, `loc`, `visibility`, `generator` (R6 additions).
- **`PARAM`** — kept our own name over Joern's `METHOD_PARAMETER_IN` (§10's node table entry).
  IN-only; no `METHOD_PARAMETER_OUT` equivalent (legitimate omission, §10).
- **`MEMBER`** — class field / dataclass attribute / module-level constant.
- **`CALL`** — a call/new/decorator/await site. Args, receiver and literals fold into properties,
  never child nodes (design rule 3). **Id obligation:** `CALL` ordinals are parent-scope-relative,
  not file-relative, so two identical calls in one method still satisfy "insert above → 0 id
  changes" (§6) — this must land as a golden-file test case in M0.3/M0.6, not stay prose.
- **`IMPORT`** — one per import statement. Matches Joern's *implementation* (`Hidden.scala`), not its
  published spec — cite it that way, never as "matches the Joern spec" (§9c). The `resolved` boolean
  this project once carried here is dropped; resolution status lives on the `IMPORTS` edge (§7).
- **`SYMBOL`** — load-bearing, non-negotiable (§11). Not `:CPG`, no `file` property — that is what
  makes a per-file replace safe by construction (D5).
- **`COMMUNITY`** — one community-detection result. Gains `projection`/`edge_basis`/`level` (R6
  additions). Written only by the async analytics overlay job (§8).
- **`TAG`** — generic classification hook (`needs_triage`, `source`, `sink`, `sanitizer`). Values are
  classification metadata only; numeric metrics stay typed scalar properties elsewhere, since range
  queries need an index-backed number (Complexity's boundary rule, written here by name per R6).
- **`UNKNOWN`** — an unparseable region of an otherwise-parsed file. Unified with `FILE{status:error}`
  into one triage surface via a shared `needs_triage` `TAG` through `TAGGED_BY` (R6 Next Steps #6).
- **`META_DATA`** — one node per graph, carrying `schema_version`/`engine_version`/`overlays`. Never
  `:CPG`, never carries `file`, never touched by a per-file replace.

---

## §4. Edge type catalogue

Fourteen edge types. Endpoint label sets, properties, ownership and write mechanism live in
`packages/engine/src/schema/edges.ts`.

- **`HAS_ENTRY`** (was `CONTAINS`) — `DIRECTORY -> DIRECTORY|FILE`. Renamed to resolve the
  section-6 collision with Joern's real, near-opposite-meaning `CONTAINS`. `CONTAINS` itself stays
  **permanently reserved and unclaimed**, to be adopted as-is if/when the CFG tier ships.
- **`DECLARES`** — `MODULE|TYPE_DECL|METHOD -> TYPE_DECL|METHOD|MEMBER|IMPORT` (extended to `IMPORT`
  in M0.7). Lexical nesting; Joern's `AST` is too generic to adopt directly.
- **`HAS_PARAM`** — `METHOD -> PARAM`.
- **`DEFINES`** — `MODULE|TYPE_DECL|METHOD|MEMBER|PARAM -> SYMBOL` (extended to `PARAM`).
- **`CALLS`** (was Joern's edge-typed `CALL`) — `CALL -> SYMBOL`, carrying the shared resolution
  status enum (§7). Renamed to avoid the node/edge label ambiguity Joern's own `CALL` carries.
- **`IN_SCOPE`** (was `IN_METHOD`) — `CALL -> METHOD|MODULE`, broadened to cover module-level/
  top-level calls (route registration, decorator-as-call, module init) that had no home under the
  old, `METHOD`-only shape.
- **`IMPORTS`** — `IMPORT -> SYMBOL`, carrying the identical status enum object as `CALLS.status` —
  not a parallel vocabulary. The bare `resolved` booleans this project once had on `CALL`/`IMPORT`
  nodes are dropped in favour of this one signal.
- **`INHERITS_FROM`** (merged `EXTENDS`+`IMPLEMENTS`, R6 Next Steps #1) —
  **`TYPE_DECL -> SYMBOL {relation: extends|implements}`.**

  **Deliberate divergence from R6's literal text, decided during this unit's planning and confirmed
  by the visionary.** R6's edge table writes the endpoint as `TYPE_DECL -> TYPE_DECL|IDENTIFIER (or
  equivalent)` — a direct `:CPG`→`:CPG` cross-file edge. That is exactly the shape SYMBOL indirection
  (D5, design rule 2) exists to prevent: a per-file replace of the parent class's file would delete a
  node other files' edges point into. It also contradicts `GE-FR7`/`GE-UC3`, which compute the
  interface-change cascade by traversing inheritance edges **into changed SYMBOLs**, not into
  `TYPE_DECL` nodes directly. Pinned to `TYPE_DECL -> SYMBOL` instead — the endpoint `EXTENDS`/
  `IMPLEMENTS` already had before the merge. The one-hop `TYPE_DECL -> TYPE_DECL` traversal R6's
  literal form wanted for DIT/NOC-style queries is already provided by the `TARGETS` overlay edge,
  whose own row lists `TYPE_DECL` as both source and target — so nothing is lost, and per-file
  replace safety is kept.

  Acknowledged v1 limitation (Cross-Language): Python's implicit/duck-typed `Protocol` conformance
  has no edge to attach to here. Not a reason to reopen `TYPE_DECL` usage-site machinery.
- **`MEMBER_OF`** — `FILE|METHOD|TYPE_DECL -> COMMUNITY`, unrestricted. Overlay-owned (§8).
- **`ALIAS_OF`** — `SYMBOL -> SYMBOL`. The strongest alignment case: a genuine, current Joern edge,
  not Hidden/unspecced. Models TS barrel/re-export and Python `__init__.py` re-export chains as a
  graph traversal instead of a string property on `IMPORT.alias`.
- **`TAGGED_BY`** — primary anchor `SYMBOL` (not `CALL`): sink/source classification is a fact about
  callee identity, stable across every caller's file-save cycle, inherited for free via the existing
  `CALLS -> SYMBOL` hop. Secondary anchor `MEMBER` (local secrets); `CALL`-level tags reserved
  narrowly for per-call-site sanitizer/verified-safe annotations.
- **`TARGETS`** — `CALL|IMPORT|TYPE_DECL -> METHOD|TYPE_DECL`, materialized only when the underlying
  resolution is `status=resolved`, resolved through `ALIAS_OF*` to the canonical `SYMBOL` first.
  **Mandatory, non-negotiable constraints** (R6, hardened across two rounds): (1) written by an
  **async periodic overlay job**, the same contract as `COMMUNITY`, **never** inside the per-file
  replace transaction; (2) must be a **pure projection of the same resolver call** that sets
  `CALLS.status`/`IMPORTS.status` — never an independent fast-path resolver.
- **`DEPENDS_ON`** — `FILE -> FILE`, a file-granularity rollup from the **same** overlay job as
  `TARGETS` (one job, two materializations), giving import-cycle detection a materialized file-level
  graph instead of a live per-pair traversal.
- **`REACHING_DEF`** (amended 2026-09-12, DL13) — `MEMBER|PARAM -> CALL {variable}`. Sparse
  structural-tier data flow, pulled forward out of the deferred PDG tier for this edge alone: a
  `MEMBER`/`PARAM` definition reaches a `CALL` that uses that binding (e.g. as an argument). Endpoints
  are file-owned `:CPG` nodes, both intra-file, so no `SYMBOL` indirection is required. Not full PDG —
  no `CDG`, no `DOMINATE`, no expression-tier hops (`IDENTIFIER`/`LITERAL`/`LOCAL` stay rejected, PR1).

**Rebuild trigger for `TARGETS`/`DEPENDS_ON` (R6 Next Steps #3, decided):** periodic tick +
`computed_at`/`status`, same cadence/contract as `COMMUNITY`, plus a manual "refresh now" escape hatch
(an MCP tool or CLI command). Rejected: recompute on every save of either endpoint's file — the same
unbounded-cascade risk class M1.4/M1.5 exist to prevent for interface hashes.

---

## §5. Divergence table

Generated from `packages/engine/src/schema/` by `tools/schema-doc.ts`. Regenerate with
`bun run tools/schema-doc.ts`; `spec-doc.test.ts` fails `test:schema` if this region drifts from the
schema module.

<!-- BEGIN GENERATED: schema-doc -->

### Divergence table (generated from `packages/engine/src/schema/`)

| Name | Kind | Verdict | Joern name | Divergence class | Reason | Source |
| --- | --- | --- | --- | --- | --- | --- |
| `CALL` | node | `adopt_as_is` | CALL | `none` | Unchallenged. Folds args/receiver/kind into properties, never child nodes — the CALLS *edge* is separately renamed from Joern's edge-typed CALL to avoid the node/edge label collision Joern itself carries; that rename is recorded on the CALLS edge, not here. CALL ids need a parent-scope-relative ordinal (not file-relative) so PR5's 'insert-above -> 0 id changes' holds for duplicate calls in one method (R6, required golden test case — see M0.3/M0.6). | R6 node table |
| `COMMUNITY` | node | `extend` | — | `gap-fill` | No Joern equivalent. Gains projection/edge_basis (which edge set a run used) and level — both uncontested additions from Graph Analytics. | R6 node table |
| `DIRECTORY` | node | `extend` | — | `gap-fill` | Joern's FileSystem layer is overlay-only and has no directory-tree node at all (Identity, Standards) — this fills a real gap, not a divergence. | R6 node table |
| `FILE` | node | `adopt_as_is` | FILE | `none` | Unchanged; carries content_hash/interface_hash/status/version untouched by the debate. | R6 node table |
| `IMPORT` | node | `adopt_as_is` | IMPORT | `none` | Cite precisely as 'matches Joern's implementation,' never 'matches the Joern spec' — IMPORT is not present in the published spec (verified against the vendored joern-cpg-schema.json). | R6 node table |
| `MEMBER` | node | `adopt_as_is` | MEMBER | `none` | Unchallenged. | R6 node table |
| `META_DATA` | node | `adopt_as_is` | META_DATA | `none` | One node per graph carrying schema/overlay version, serving D21's 'state is always explicit' principle. Must never carry a `file` property or participate in per-file replace. | R6 node table |
| `METHOD` | node | `adopt_as_is` | METHOD | `none` | Unchallenged. Gains cyclomatic_complexity, max_nesting_depth, loc, visibility, generator (bool). Free functions and methods share the label; the parent DECLARES edge disambiguates. | R6 node table |
| `MODULE` | node | `extend` | — | `gap-fill` | Supersedes rejected NAMESPACE_BLOCK, which required a cross-file-merged vertex — structurally incompatible with per-file replace (Identity, Storage) and unneeded once TS/Python module scoping is covered by MODULE + DIRECTORY (Analytics). One per file; namespaces/declared modules in TS become nested MODULE. | R6 node table; rejection group 'structural incompatibility' |
| `PARAM` | node | `adopt_renamed` | METHOD_PARAMETER_IN | `name-only` | Standards proposed renaming to Joern's METHOD_PARAMETER_IN; Ergonomics rejected it (importing half a Joern IN/OUT pair with no OUT present imports confusion, not alignment) and Standards withdrew the rename in Round 3. Kept our pre-existing PARAM. METHOD_PARAMETER_OUT is a legitimate omission — no by-ref out-params in TS/Python — not a gap. | R6 node table |
| `SYMBOL` | node | `extend` | — | `structural-incompatibility` | Joern resolves calls with a global load-time linker over METHOD_FULL_NAME, which requires whole-graph relinking and is structurally incompatible with per-file incremental replace. SCIP's descriptor grammar for SYMBOL.fqn is also incompatible with Joern's FULL_NAME string format — adopting Joern's shape here would sacrifice real SCIP interoperability. Not a stylistic choice; confirmed independently by Security, Identity and Standards. Load-bearing, non-negotiable. | R6 node table |
| `TAG` | node | `adopt_as_is` | TAG | `none` | Pulled forward from deferred into v1 scope (Security's proposal, Standards/Complexity endorsed) — generic key-value classification hook for source/sink/sanitizer marking and the unified needs_triage triage surface, at near-zero MCP tool-budget cost since it needs no dedicated tool. MERGE-on-name: a small, shared vocabulary, never file-scoped. | R6 node table |
| `TYPE_DECL` | node | `adopt_as_is` | TYPE_DECL | `none` | Unchallenged all three rounds. Gains `structural` (bool). | R6 node table |
| `UNKNOWN` | node | `adopt_as_is` | UNKNOWN | `none` | Escape hatch for unparseable content, paired with FILE{status:error}. Triage unification: UNKNOWN nodes and FILE{status:error} share a needs_triage TAG via TAGGED_BY, the same mechanism already adopted for source/sink/sanitizer marking, so one query surfaces failed-to-parse files, unparseable fragments, and CALLS/IMPORTS status=unresolved together. | R6 node table |
| `ALIAS_OF` | edge | `adopt_as_is` | ALIAS_OF | `semantic` | The debate's strongest alignment case — a genuine, current Joern edge, not Hidden/unspecced, zero SYMBOL-format compromise. Applied to our SYMBOL model rather than Joern's TYPE_DECL/TYPE model: models TS barrel/re-export and Python __init__.py re-export chains as a graph traversal instead of a string property on IMPORT.alias. Required input to TAGGED_BY (a re-exported dangerous function must stay tagged) and to TARGETS resolution. | R6 edge table |
| `CALLS` | edge | `adopt_renamed` | CALL | `name-only` | Deliberately renamed to avoid the node/edge label ambiguity Joern itself carries (CALL is both a node type and an edge type) — a concrete parsing-clarity reason, not cosmetic preference (Standards). Security's core triage tool. The bare CALL.resolved boolean this project once had is dropped in favour of this status enum. | R6 edge table |
| `DECLARES` | edge | `extend` | AST | `semantic` | Joern's AST edge is too generic to adopt directly (Storage/Perf's typed-edge-decomposition argument, accepted unanimously: relationship-type-specific adjacency lets FalkorDB's planner prune by edge type instead of every traversal post-filtering by target label). Extended to also cover IMPORT (previously reachable only via a `.file` property scan, now a real edge back to its containing MODULE) — Graph Analytics' Round 1 proposal. | R6 edge table |
| `DEFINES` | edge | `extend` | REF | `semantic` | Joern's REF/PARAMETER_LINK are partial analogues, rejected as too generic. Extended to PARAM: Security's Round 1 proposal (parameters need the same stable cross-reference identity as methods/types for future taint propagation), independently reinforced by Cross-Language as a resolution-completeness fix. Conditional on the SYMBOL GC/lifecycle mechanism covering PARAM too. | R6 edge table |
| `DEPENDS_ON` | edge | `extend` | — | `gap-fill` | A file-granularity rollup produced by the same async overlay job as TARGETS (one job, two materializations), not a second resolution mechanism. Gives import-cycle detection a materialized file-level graph instead of a live per-pair traversal. Same periodic + computed_at + manual-refresh rebuild contract as TARGETS. | R6 edge table; R6 Next Steps #3, DL8 |
| `HAS_ENTRY` | edge | `adopt_renamed` | CONTAINS | `name-only` | Was CONTAINS. Our filesystem-nesting edge used the same name as Joern's CONTAINS (METHOD -> CFG_NODE, near-opposite meaning) — a genuine collision, unanimous across all eight lenses. Mutated only on move/rename, never touched by per-file :CPG replace, so the rename cost nothing. CONTAINS itself stays permanently reserved and unclaimed for Joern's real meaning, to be adopted as-is if/when the CFG tier ships. | R6 edge table |
| `HAS_PARAM` | edge | `extend` | — | `semantic` | Joern uses AST + PARAMETER_LINK for this; PARAMETER_LINK is unused without its rejected counterpart METHOD_PARAMETER_OUT. Unchallenged as its own edge across all three rounds. | R6 edge table |
| `IMPORTS` | edge | `adopt_as_is` | IMPORTS | `none` | Per imported name. Module-level wildcard/namespace imports point at the MODULE's SYMBOL. Gains `status`, closing a real inconsistency (two competing resolution-signaling patterns: a bare `resolved` bool on CALL/IMPORT nodes vs. a rich enum on CALLS). The bare booleans are dropped. | R6 edge table |
| `INHERITS_FROM` | edge | `adopt_as_is` | INHERITS_FROM | `semantic` | Merges the former EXTENDS/IMPLEMENTS into one edge with a relation property (R6 Next Steps #1, DL6, visionary sign-off 2026-09-11). DELIBERATE DIVERGENCE FROM R6'S LITERAL TEXT: R6's edge table hedges the endpoint as `TYPE_DECL -> TYPE_DECL\|IDENTIFIER (or equivalent)`, a direct :CPG->:CPG cross-file edge. That is exactly the shape SYMBOL indirection (D5, design rule 2) exists to prevent — a per-file replace of the parent class's file would delete a node other files' edges point into — and it contradicts GE-FR7/GE-UC3, which compute the interface-change cascade by traversing inheritance edges into changed SYMBOLs, not into TYPE_DECL nodes directly. Pinned to TYPE_DECL -> SYMBOL instead, matching the endpoint EXTENDS/IMPLEMENTS already had. The one-hop TYPE_DECL -> TYPE_DECL traversal that motivated the direct form is already provided by the TARGETS overlay edge, whose own row lists TYPE_DECL as both source and target. | R6 edge table; M0.0 planning decision, user-confirmed |
| `IN_SCOPE` | edge | `adopt_renamed` | CONTAINS | `semantic` | Was IN_METHOD, METHOD-only. Module-level/top-level calls (route registration, decorator-as-call, module init) had no home under that shape; broadened to MODULE and renamed so the old name targeting MODULE would not mislead an agent about the target label. Deliberately not merged into DECLARES: 'declared inside' and 'called inside' diverge exactly at inline callbacks not themselves declared. | R6 edge table |
| `MEMBER_OF` | edge | `extend` | — | `gap-fill` | No Joern equivalent. Unrestricted target set (FILE/METHOD/TYPE_DECL), governed by the overlay-edge classification rule: any edge landing on a :CPG node from outside that node's own per-file replace transaction is a periodic-recompute overlay, never a correctness dependency of the write path. | R6 edge table |
| `REACHING_DEF` | edge | `extend` | REACHING_DEF | `semantic` | Pulled into v1 as sparse structural-tier data flow (visionary amendment 2026-09-12), aligning with D10's 'structural-tier data flow' and superseding the blanket PDG deferral in D23/R6 for this edge alone. Joern's REACHING_DEF spans expression-tier nodes (IDENTIFIER/LITERAL/LOCAL); ours keeps PR1 sparsity by endpointing at MEMBER\|PARAM (definitions) and CALL (use sites). CFG, CDG, DOMINATE, and expression-tier nodes remain deferred. Intra-file only — both endpoints are file-owned :CPG nodes, so no SYMBOL indirection is required. | Joern PDG; visionary amendment 2026-09-12 (hello-world CPG golden) |
| `TAGGED_BY` | edge | `adopt_as_is` | TAGGED_BY | `semantic` | Primary anchor SYMBOL, not CALL (Identity's correction, adopted by Security: sink/source classification is a fact about callee identity, stable across every caller's file-save cycle, and inherited for free via the existing CALLS -> SYMBOL hop). Secondary anchor MEMBER (local secrets); CALL-level tags reserved narrowly for per-call-site sanitizer/verified-safe annotations. Also the mechanism for the unified triage surface (see UNKNOWN/TAG). | R6 edge table |
| `TARGETS` | edge | `extend` | CALL | `semantic` | Joern's Shortcuts-layer CALL edge is linker-created and its frontend MUST NOT create it. Ours is a one-hop shortcut past the CALL -> SYMBOL <- DEFINES tax on centrality/PageRank/impact-of-change traversal, materialized ONLY when the underlying resolution is status=resolved, resolved through ALIAS_OF* to the canonical SYMBOL first. Mandatory constraints: computed by an async periodic overlay job, the same contract as COMMUNITY, never written inside the per-file replace transaction; and must be a pure projection of the same resolver call that sets CALLS.status/IMPORTS.status — never an independent fast-path resolver. Rebuild trigger: periodic tick + computed_at, same as COMMUNITY, plus a manual refresh escape hatch. Rejected: recompute on every save of either endpoint's file. | R6 edge table; R6 Next Steps #3, DL8 |

### Rejected from Joern (generated from `tools/schema-doc.ts`)

| Name | Kind | Group | Reason |
| --- | --- | --- | --- |
| `MODIFIER` | node | per-token cardinality | fold into MEMBER.visibility / METHOD.exported/async booleans |
| `METHOD_RETURN` | node | per-token cardinality | 1:1 with every METHOD, exists only for deferred CFG return-flow — fold into return_type_text |
| `ANNOTATION` | node | per-token cardinality | already handled as CALL{kind:decorator} -> SYMBOL |
| `ANNOTATION_LITERAL` | node | per-token cardinality | part of the ANNOTATION family, same fold |
| `ANNOTATION_PARAMETER` | node | per-token cardinality | part of the ANNOTATION family, same fold |
| `ANNOTATION_PARAMETER_ASSIGN` | node | per-token cardinality | part of the ANNOTATION family, same fold |
| `NAMESPACE` | node | structural incompatibility | cross-file-merged vertex; TS/Python module scoping is file-scoped and covered by MODULE + DIRECTORY |
| `NAMESPACE_BLOCK` | node | structural incompatibility | superseded by MODULE — see MODULE's EXTEND rationale |
| `TYPE` | node | structural incompatibility | one node per type reference is exactly the expression-tier density PR1 rejects |
| `BINDING` | node | Joern's linker mechanism, rejected as a mechanism | vtable-style polymorphic dispatch requiring whole-type-hierarchy computation |
| `CONFIG_FILE` | node | no identified need | not addressed by the ontology debate; add later only if a concrete need surfaces |
| `CONTROL_STRUCTURE` | node | deferred tier, names reserved | CFG tier |
| `BLOCK` | node | deferred tier, names reserved | CFG tier |
| `RETURN` | node | deferred tier, names reserved | CFG tier |
| `JUMP_TARGET` | node | deferred tier, names reserved | CFG tier |
| `JUMP_LABEL` | node | deferred tier, names reserved | CFG tier |
| `IDENTIFIER` | node | deferred tier, names reserved | expression tier |
| `LITERAL` | node | deferred tier, names reserved | expression tier |
| `FIELD_IDENTIFIER` | node | deferred tier, names reserved | expression tier |
| `LOCAL` | node | deferred tier, names reserved | expression/PDG tier |
| `METHOD_REF` | node | deferred tier, names reserved | expression tier |
| `TYPE_REF` | node | deferred tier, names reserved | expression tier |
| `ARRAY_INITIALIZER` | node | deferred tier, names reserved | expression tier |
| `COMMENT` | node | deferred tier, names reserved | not addressed; low priority |
| `KEY_VALUE_PAIR` | node | deferred tier, names reserved | edge/node properties already serve this in a property graph |
| `TAG_NODE_PAIR` | node | deferred tier, names reserved | edge properties on TAGGED_BY suffice in a property graph |
| `FINDING` | node | deferred tier, names reserved | taint-overlay territory, deferred alongside CFG/PDG |
| `TYPE_PARAMETER` | node | v2 candidate (V2.1) | generics folded into type_text for v1; tracked in 60-delivery.yaml v2_backlog |
| `TYPE_ARGUMENT` | node | v2 candidate (V2.1) | generics folded into type_text for v1; tracked in 60-delivery.yaml v2_backlog |
| `METHOD_PARAMETER_OUT` | node | unused without its counterpart | no by-ref out-params in TS/Python — a legitimate omission, not a gap |
| `BINDS` | edge | Joern's linker mechanism, rejected as a mechanism | vtable-style polymorphic dispatch resolution |
| `BINDS_TO` | edge | Joern's linker mechanism, rejected as a mechanism | vtable-style polymorphic dispatch resolution |
| `ARGUMENT` | edge | folded into existing CALL properties | args are already CALL properties, not child nodes (PR1) |
| `RECEIVER` | edge | folded into existing CALL properties | receiver is already a CALL property, not a child node (PR1) |
| `SOURCE_FILE` | edge | redundant with an existing, benchmark-load-bearing property | `file` is a property on every :CPG node — the 13x indexed-delete speedup depends on it staying a property, not an edge |
| `PARAMETER_LINK` | edge | unused without its counterpart | no referent without METHOD_PARAMETER_OUT, correctly omitted |
| `CFG` | edge | deferred tier, names reserved | CFG tier |
| `CDG` | edge | deferred tier, names reserved | PDG tier |
| `DOMINATE` | edge | deferred tier, names reserved | CFG tier |
| `POST_DOMINATE` | edge | deferred tier, names reserved | CFG tier |
| `CONDITION` | edge | deferred tier, names reserved | CFG tier |
| `EVAL_TYPE` | edge | deferred tier, names reserved | v2 type-system tier alongside TYPE_PARAMETER/TYPE_ARGUMENT/BINDS |
| `CATCH_BODY` | edge | deferred tier, names reserved | CFG tier |
| `DO_BODY` | edge | deferred tier, names reserved | CFG tier |
| `FALSE_BODY` | edge | deferred tier, names reserved | CFG tier |
| `FINALLY_BODY` | edge | deferred tier, names reserved | CFG tier |
| `FOR_BODY` | edge | deferred tier, names reserved | CFG tier |
| `FOR_INIT` | edge | deferred tier, names reserved | CFG tier |
| `FOR_UPDATE` | edge | deferred tier, names reserved | CFG tier |
| `TRUE_BODY` | edge | deferred tier, names reserved | CFG tier |
| `TRY_BODY` | edge | deferred tier, names reserved | CFG tier |

<!-- END GENERATED: schema-doc -->

---

## §6. The id rule

`path:kind:qualifiedScopePath[:ordinal|:bodyHash]` (AM1/D31, R4/R2 — supersedes planning README
design rule 1's `${fileHash}:...` formula). **No file content hash in the id** — that would change
every id in a file on every save, defeating stable identity and breaking inbound cross-file edges.
Content hash and interface hash live on `FILE` as properties instead.

What is never in an id: no file content hash, no line/column range, no property values (Identity's
Round 1 constraint) — only path, kind, and lexical scope path.

Worked examples:

| Label | Id |
| --- | --- |
| `FILE` | `file:src/users.ts` |
| `MODULE` | `file:src/users.ts:MODULE:$root` |
| `TYPE_DECL` | `file:src/users.ts:TYPE_DECL:UserService` |
| `METHOD` | `file:src/users.ts:METHOD:UserService.findById` |
| `CALL` | `file:src/users.ts:CALL:UserService.findById:0` (parent-scope-relative ordinal — see below) |
| `SYMBOL` | `` src/users.ts`UserService#findById(). `` (SCIP descriptor, not this id rule — §11) |

**Confirmed obligation, not yet built:** `CALL` ids use a **parent-scope-relative** ordinal — the
ordinal counts calls within the enclosing `METHOD`/`MODULE`, not within the whole file — so that
inserting an unrelated statement above two identical calls in one method changes neither call's id.
This is PR5's "insert-above → 0 id changes" guarantee and must become an explicit golden-file test
case (two identical calls, then an unrelated statement inserted above) when M0.3/M0.6 ship, not stay
prose here.

---

## §7. Status and resolution enums

**Node lifecycle** (D21/PR8, `status: agreed` since before this unit): every `:CPG` node and `FILE`
carries `status ∈ {ready, indexing, stale, error}`; `FILE` also carries a monotonic `version`.
Dependents marked by an over-budget cascade carry `status: stale` and `stale_reason: <file id>`.

**Resolution status** — shared, unmodified, by both `CALLS.status` and `IMPORTS.status` (not a
parallel vocabulary, per Ergonomics' bool-vs-enum consolidation and Cross-Language's insistence on
one shared set). Normative, cross-language-binding definitions:

- **`resolved`** — target found and unambiguous.
- **`ambiguous`** — multiple statically-plausible candidates exist (overload sets, duplicate/star
  imports, unresolved re-export fan-out).
- **`external`** — target resolves to a dependency outside the indexed workspace.
- **`unresolved`** — no static candidate found.
- **`dynamic`** — target determined by a runtime dispatch mechanism the frontend cannot follow
  statically (`eval`, `getattr`/`__getattr__`/`__call__` overrides, `Function()`, computed member
  access `obj[key]()`, computed `require`/dynamic `import`).

The bare `resolved` booleans this project once carried on `CALL`/`IMPORT` nodes are dropped — one
signal, one place.

---

## §8. Ownership and write mechanism

Decided by R6 Next Steps #2 (DL7); tabulated here per label/edge because that tabulation is what
makes the rule checkable (`packages/engine/src/schema/validate.ts`'s overlay-in-replace check, and
its live counterpart in `test/support/schema-conformance.ts`).

| Class | Members | Write mechanism |
| --- | --- | --- |
| **File-owned** | `MODULE`, `TYPE_DECL`, `METHOD`, `PARAM`, `MEMBER`, `CALL`, `IMPORT`, `UNKNOWN` + their intra-file edges (`DECLARES`, `HAS_PARAM`, `DEFINES`, `CALLS`, `IN_SCOPE`, `IMPORTS`, `INHERITS_FROM`) | `DELETE` + `CREATE` on every save — safe because nothing outside that file ever writes to them, and it is what the 13x indexed-delete benchmark measured. |
| **Identity** | `SYMBOL`, `ALIAS_OF`, `TAG`, `TAGGED_BY` | `MERGE`-on-key (`fqn` for `SYMBOL`, `name` for `TAG`) — the cross-file-shared anchor other files' edges point into; deleting and recreating on every save of the defining file would force touching every inbound edge from every referencing file, exactly the whole-graph-relinking problem SYMBOL indirection exists to avoid. |
| **Overlay** | `COMMUNITY`, `MEMBER_OF`, `TARGETS`, `DEPENDS_ON` | Written only by the async periodic overlay job; own `computed_at`/`status`; never inside a per-file replace transaction (the overlay-edge classification rule). |
| **Filesystem** | `DIRECTORY`, `FILE`, `HAS_ENTRY` | `MERGE`-on-path; mutated on move/rename or content-hash change, never deleted and recreated on an ordinary save. |
| **Graph-singleton** | `META_DATA` | `MERGE`-on-graph (no `file`, key `[]`); updated in place, never per-file replaced. |

**Overlay-edge classification rule**, quoted for reference: any edge landing on a `:CPG` node from
outside that node's own per-file replace transaction (`MEMBER_OF`, `TARGETS`, `DEPENDS_ON`) is a
periodic-recompute overlay — its own `computed_at`/`status`, explicitly stale-tolerant, never a
correctness dependency of the per-file write path.

**Schema version.** `packages/engine/src/schema/schema.ts`'s `CPG_SCHEMA.version` is `2` as of
2026-09-12 (bumped from `1` by the M0.0d REACHING_DEF amendment, DL13; originally bumped from the
placeholder `0` by this unit, sourced into `SCHEMA_VERSION` so there is one number, not two).
The graph is a cache (design rule 7) — there is no migration path, only rebuild: any change to a
label, edge type, required property or enum value set bumps the version; on start the daemon reads
`META_DATA.schema_version` and, on mismatch, drops and re-indexes (GE-FR18, GE-UC1's "no `.cpg/data`
or a schema-version mismatch" trigger). M0.4a owns the read-compare logic (schema-bootstrap split,
DL14); the rebuild-on-mismatch action itself is left to M0.4a's caller, not performed inside
bootstrap.

---

## §9. Reserved names

Three distinct tiers, kept apart deliberately:

**(a) Permanently reserved and unclaimed.** `CONTAINS` — Joern's real
`METHOD -[:CONTAINS]-> BLOCK|CONTROL_STRUCTURE|CALL|RETURN` meaning, to be adopted as-is if/when the
CFG tier ships. Never reused for anything else in the meantime, even though our own `HAS_ENTRY` and
`IN_SCOPE` are both edges R6 describes as loosely analogous to it.

**(b) Deferred-tier reserved, Joern spelling unchanged.** The full CFG/PDG/expression-tier node and
edge names in §10's "deferred tier, names reserved" rows. RK1 requires the v1 schema not preclude
adding these later; reserving the exact Joern spelling now is how that promise stays concrete.

**(c) v2 candidates, not rejected.** `TYPE_PARAMETER`, `TYPE_ARGUMENT` (and, if pulled in alongside,
`BINDS`/`EVAL_TYPE` as edges). v1 folds generics into a `type_text` string property (substring-
queryable only). Tracked explicitly as `60-delivery.yaml`'s `v2_backlog` item `V2.1`. No Type System
lens participated in the R6 debate — the REJECT verdicts on these are the converged judgment of
adjacent lenses, not a considered type-system review (Standards flagged this itself as
"provisional"). Revisit with a dedicated Type System lens pass once a concrete agent workflow needs
generics-aware graph queries.

Also worth naming precisely: `IMPORT` (node) and `IMPORTS` (edge) are not in Joern's *published*
spec — verified absent from the vendored `joern-cpg-schema.json` — though R6's debate materials
describe them as present in Joern's actual implementation (`Hidden.scala`). Cite them as "matching
Joern's implementation," never "matching the Joern spec." (See §13 for a caveat on how strongly this
document can stand behind that specific attribution.)

---

## §10. Rejected from Joern, with reasons

Every one of the 39 concrete node names and 29 edge names in the vendored
`packages/engine/test/support/joern-cpg-schema.json` that this project did **not** adopt appears
below, grouped by the reasoning that rejected it — several groups converged from independent lenses,
which is itself evidence the reasoning is sound, not merely one lens's preference. `joern.test.ts`
asserts this table plus §5's divergence table together account for all 68 names, each exactly once.

<!-- The actual rows are generated into §5's region by tools/schema-doc.ts, immediately below the
     divergence table, under its own "Rejected from Joern" heading — kept as one generated region so
     the two tables can never drift out of sync with each other or with the schema module. -->

**Per-token / per-usage-site cardinality** (Storage/Perf's core argument, independently reached by
others): `MODIFIER`, `METHOD_RETURN`, the `ANNOTATION` family (four types) — each a multiplicative
tax on the ~450-node/300-line-file budget for zero query benefit a string property or existing edge
doesn't already provide.

**Structural incompatibility with per-file incremental replace** (triangulated three ways —
Identity, Storage, Analytics, the strongest convergence in the whole debate): `NAMESPACE`/
`NAMESPACE_BLOCK`, `TYPE` (as node).

**Joern's own linker mechanism, rejected as a mechanism, not a name** (Security, Identity,
Cross-Language, Standards independently): `BINDING`, `BINDS`, `BINDS_TO` — Joern's vtable-style
polymorphic dispatch resolution, requiring whole-type-hierarchy computation, structurally
incompatible with a 24ms single-file replace under concurrent readers.

**Redundant with an existing, benchmark-load-bearing property:** `SOURCE_FILE` — `file` is already a
property on every `:CPG` node, precisely the indexed-delete mechanism the benchmark measured a 13x
speedup on (3.1ms vs. 40.3ms). Trading that property for an edge would undercut the schema's own
incrementality claim.

**Unused without its counterpart:** `PARAMETER_LINK` (no referent without `METHOD_PARAMETER_OUT`,
correctly omitted), `METHOD_PARAMETER_OUT` itself (no by-ref out-params in TS/Python — a legitimate
omission, not a gap).

**Folded into existing CALL properties:** `RECEIVER`, `ARGUMENT` — already CALL properties in the v1
draft, not child nodes; adopting these would reintroduce exactly the density PR1 rejects.

**Config/finding/misc, no identified need:** `CONFIG_FILE` — visionary decision 2026-09-11, same
reasoning as the rest of this row; revisit only if a concrete need surfaces. `KEY_VALUE_PAIR`,
`TAG_NODE_PAIR` — edge/node properties already serve this in a property graph. `FINDING` —
taint-overlay territory, deferred alongside CFG/PDG, not gone.

**Expression/CFG/remaining-PDG tier, deferred, names reserved (§9b):** `CONTROL_STRUCTURE`, `BLOCK`,
`RETURN`, `JUMP_TARGET`, `JUMP_LABEL`, `IDENTIFIER`, `LITERAL`, `FIELD_IDENTIFIER`, `LOCAL`,
`METHOD_REF`, `TYPE_REF`, `ARRAY_INITIALIZER`, `COMMENT`; edges `CFG`, `CDG`, `DOMINATE`,
`POST_DOMINATE`, `CONDITION`, `EVAL_TYPE`, `CATCH_BODY`/`DO_BODY`/`FALSE_BODY`/`FINALLY_BODY`/
`FOR_BODY`/`FOR_INIT`/`FOR_UPDATE`/`TRUE_BODY`/`TRY_BODY`. (`REACHING_DEF` moved to adopted, §4/§5 —
amended 2026-09-12, DL13.)

**v2 candidate, not rejected (§9c):** `TYPE_PARAMETER`, `TYPE_ARGUMENT`.

**Not applicable — Scala type-hierarchy scaffolding with no Cypher shape** (uncontested, Ergonomics):
`AST_NODE`, `CALL_REPR`, `CFG_NODE`, `DECLARATION`, `EXPRESSION` — Joern's five abstract base types.
Our shared `:CPG` label already gives the "match anything code-related" query these would otherwise
serve. (These five are excluded from the 39/29 exhaustiveness count — they are the abstract entries
the vendored schema itself marks `isAbstract`, not concrete shipped-or-rejected types.)

---

## §11. Relationship to SCIP

`SYMBOL.fqn` uses the SCIP descriptor grammar (AM5/D34, R2), with `scheme`/`manager`/`package`/
`version` stored as separate properties, not folded into the descriptor string. This is the one
place "align names with Joern" is explicitly overruled, and the reason is structural, not stylistic:
Joern's `FULL_NAME` (e.g. `Test0.ts::program:Greeter:foo`) is a load-time-linker display string with
no package/manager/version concept and no defined cross-project resolution semantics. Adopting
Joern's shape here would sacrifice real SCIP interoperability for nominal Joern alignment — confirmed
independently by Security, Identity and Standards. `SYMBOL` is therefore `EXTEND`, load-bearing,
non-negotiable (§3, §5).

**Conformance target (R6 "Test-spec recommendation"):** no conformance suite exists for Joern's CPG
spec. SCIP ships one: `scip test`'s plain-text assertion DSL, a 12-scenario language-agnostic
`reprolang` corpus, and a pinned real-world nightly benchmark matrix. Adopt `reprolang` as the base
conformance target for resolver **logic** (forward-definition, duplicate-symbol handling, cross-file/
cross-document linking) in M0.12 — genuinely language-neutral concerns that map directly onto this
project's SYMBOL-resolution guarantees — **plus** a hand-written TS + Python golden fixture set
**alongside** it, not instead of it, targeting what `reprolang` cannot exercise by design:
decorator-wrapped functions changing effective identity, destructured imports, Python name-mangled
`_Class__attr`, re-export barrels. Joern's own `jssrc2cpg`/`pysrc2cpg` suites are conceded
hand-mineable (Scala/ScalaTest/flatgraph) but not machine-reusable.

---

## §12. Conformance and test obligations (handed to M0.0's own gate and to later units)

- `test:schema`'s DB-free half (`packages/engine/src/schema/validate.ts`) must reject: an undeclared
  label or edge type; a missing or undeclared property; a value outside a declared enum; a `:CPG`
  co-label mismatch either direction; a `file` property present or absent against
  `hasFileProperty`; an edge endpoint label outside its declared `from`/`to` set; an overlay-owned
  node/edge written inside a per-file replace transaction; a node's `file` disagreeing with the
  replace's own file.
- `test:schema`'s live half (`packages/engine/test/support/schema-conformance.ts`) asks the same
  questions of a running graph, accounting for FalkorDB's sticky label/relationship-type registry —
  see that file's header for the verification performed against this project's own harness.
- M0.3's golden-file suite must include the two-identical-calls-plus-insert-above case (§6).
- M0.12's golden oracle harness adopts `reprolang` plus hand-written TS/Python goldens (§11), not
  Joern's own test suites.

---

## §13. Known limitations, honestly stated

- Python's implicit/duck-typed `Protocol` conformance has no edge to attach to under `INHERITS_FROM`
  (§4). Acknowledged, not a reason to reopen `TYPE_DECL` usage-site machinery.
- No Type System lens participated in the R6 debate (§9c). The `TYPE_PARAMETER`/`TYPE_ARGUMENT`
  REJECT-for-v1 verdicts are the converged judgment of adjacent lenses, not a considered type-system
  review.
- **A discrepancy in R6's own edge count.** R6's synthesis states Joern has "30 edge types"; the
  vendored `joern-cpg-schema.json` has 29. The extra name R6's transcript cites, `JUMP_ARGUMENT`, is
  **not** present in the vendored artifact. Treated here as reserved-but-unverified, not claimed as a
  Joern name we know to exist — this document's exhaustiveness claim in §10 is scoped to the 68 names
  actually in the vendored JSON, not to R6's prose count.
- **The `Hidden.scala` attribution is weaker than R6's prose suggests.** R6's debate transcript
  repeatedly cites section numbers ("section 5", "section 6", "section 8", "section 9") of a debate
  briefing document that was never committed to this corpus — those citations resolve to nothing a
  reader here can open. What this document can actually stand behind is the negative fact checkable
  against the vendored artifact: `IMPORT`, `IMPORTS`, `CLOSURE_BINDING`, `DEPENDENCY`, `TEMPLATE_DOM`,
  `IS_CALL_FOR_IMPORT`, `CAPTURE`, `CAPTURED_BY` do not appear in `joern-cpg-schema.json`. This
  document therefore says "not present in the published spec (verified against the vendored
  `joern-cpg-schema.json`)" rather than the stronger, unverifiable "Joern's `Hidden.scala`
  deliberately excludes it" — per R6's own standing instruction for `IMPORT`/`IMPORTS` specifically,
  now applied consistently to the rest of that claim class.
- `CLOSURE_BINDING`, `DEPENDENCY`, `TEMPLATE_DOM`, `IS_CALL_FOR_IMPORT`, `CAPTURE`, `CAPTURED_BY` sit
  outside both §5 and §10's exhaustiveness accounting entirely — they are not in the vendored
  published-spec JSON at all, so the 68-name contract does not cover them. Rejected anyway (visionary
  decision 2026-09-11, `60-delivery.yaml` `DL9`): no identified need; add later only if one surfaces.
  Note `DEPENDENCY` (the Joern node) is unrelated to `DEPENDS_ON` (our edge, §4), which stays adopted.

---

## §14. Supersession record

Amendments follow `was:` / `now:` / `why:`, per `40-research.yaml`'s convention.

- **README design rule 1** (id formula).
  was: `${fileHash}:${kind}:${scopePath}:${ordinal}`.
  now: `path:kind:qualifiedScopePath[:ordinal|:bodyHash]`, no file content hash (§6).
  why: a content hash in the id would change every id in a file on every save, defeating stable
  identity and breaking inbound cross-file edges (AM1/D31). The rest of rule 1 — the shared `:CPG`
  label, indexes on `CPG.id`/`CPG.file` — stands, untouched.
- **README design rule 2** (SYMBOL indirection).
  was: store `resolved:false` + `calleeName` on the CALL for unresolved dynamic calls.
  now: the bare `resolved` boolean is dropped; resolution status lives on the `CALLS`/`IMPORTS`
  edges as the shared five-value enum (§7).
  why: two competing resolution-signaling patterns (a bare bool vs. a rich enum) was a real
  inconsistency (Ergonomics); one signal, one place. Everything else in rule 2 — SYMBOL indirection
  itself, no bare-name SYMBOLs for unresolved calls, bounded GC per save, the `UNIQUE SYMBOL.fqn`
  constraint as a tripwire — stands, untouched.
- **README design rule 3** (two-tier schema).
  was: structural tier listed as FILE, NAMESPACE_BLOCK, TYPE_DECL, METHOD, PARAM, METHOD_RETURN,
  MEMBER, LOCAL, BLOCK, CONTROL_STRUCTURE, RETURN, CALL, SYMBOL; "drop SOURCE_FILE/CONTAINS edges."
  now: the fourteen-label catalogue in §3; `NAMESPACE_BLOCK`→`MODULE`, `METHOD_RETURN`/`LOCAL`/
  `BLOCK`/`CONTROL_STRUCTURE`/`RETURN` deferred (§9b); `IMPORT`/`TAG`/`UNKNOWN`/`META_DATA` added.
  `SOURCE_FILE` is indeed dropped; `CONTAINS` was **renamed** to `HAS_ENTRY`, not dropped — the
  filesystem-nesting edge it named is kept (§4).
  why: the R6 ontology debate (research/R6-ontology-debate-synthesis.md), signed off 2026-09-11. The
  tier *principle* (sparse structural tier by default, expression tier opt-in, the measured ~7x
  density gap) stands, untouched — only the enumerated vocabulary moved.
- **`10-graph-engine.yaml` `v1_schema` block.**
  was: a `status: draft` node/edge table using `CONTAINS`, `IN_METHOD`, `EXTENDS`/`IMPLEMENTS`,
  `CALL.resolved`/`IMPORT.resolved` booleans; never ratified.
  now: a supersession stub pointing here.
  why: never agreed (still `draft`); superseded in full by the R6-approved schema this document
  transcribes. `CONTAINS`→`HAS_ENTRY`, `IN_METHOD`→`IN_SCOPE`, `EXTENDS`+`IMPLEMENTS`→
  `INHERITS_FROM{relation}`, the bare resolved booleans dropped, five node labels and four edge types
  added (`TAG`, `UNKNOWN`, `META_DATA`, plus `DIRECTORY`/`COMMUNITY` already present; `ALIAS_OF`,
  `TAGGED_BY`, `TARGETS`, `DEPENDS_ON`).
- **`60-delivery.yaml` `OI1`.**
  was: `status: open`, "Research in flight."
  now: `status: resolved` — option (b), per §1.
  why: the research had already landed as R6 before this unit started; only the status line was
  stale. M0.0 was transcription, formalization and gate-building, not research.
