# CPG Ontology Debate — Synthesis of Final Decisions

Session date: 2026-09-11. Source: `R6-ontology-debate-transcript.md` (8 lenses × 3 rounds), read in full.
**Update, same day:** the visionary read this document and decided all six items in **Next Steps** — this is
now the approved working v1 schema, not merely a synthesis.

**Provenance note.** The transcript was reconstructed directly from the orchestrating workflow's run
journal after its own finishing step failed repeatedly (the prompt carrying the transcript inline was too
large and kept being interrupted). All 24 debate results completed successfully and are reproduced
unaltered. One exception: the Agent/MCP Ergonomics lens's Round 3 result is a placeholder in the journal
(`statement_markdown: "placeholder"`) — only its `top_priority` line survived. That line explicitly
reaffirms the same final positions its Round 2 statement already argued in full (HAS_ENTRY, IN_SCOPE,
TARGETS-as-async-overlay, INHERITS_FROM{relation}, edge-only resolution status), so this synthesis treats
Ergonomics' Round 2 statement as its authoritative final position — nothing substantive is missing.

## Executive summary

Eight lenses (Security, Complexity, Graph Analytics, Incremental Update & Identity, Agent Ergonomics,
Cross-Language, Storage/Performance, Standards & Interoperability), each independently armed with the
current v1 draft schema and the corrected canonical Joern CPG spec (39 concrete node types, 30 edge
types), spent three rounds converging on a concrete ontology. The debate resolved cleanly in most places:
the section-6 `CONTAINS` naming collision closed unanimously on `HAS_ENTRY`; the sparse structural tier
and SYMBOL indirection were reaffirmed as load-bearing rather than merely convenient; a materialized
`TARGETS`/`DEPENDS_ON` overlay pair was designed, hardened across three rounds, to give analytics one-hop
traversal without reopening the cross-file fragility SYMBOL exists to prevent; and a long batch of Joern's
per-token and per-usage-site node types (`MODIFIER`, `METHOD_RETURN`, the `ANNOTATION` family,
`TYPE_PARAMETER`/`TYPE_ARGUMENT`, `TYPE`-as-node, `NAMESPACE`/`NAMESPACE_BLOCK`) were rejected on
convergent, independently-derived grounds. Because all eight lenses wrote their final Round 3 positions
simultaneously (none could see another's Round 3 while writing its own), several lenses flagged tensions
as "unresolved" that later Round 3 text from *other* lenses actually settled — this synthesis reconciles
those by reading all eight final positions together, which no single lens could do. One genuine
disagreement was not resolved by the debate itself (EXTENDS/IMPLEMENTS vs. a merged INHERITS_FROM) — it is
called out plainly below with a synthesis recommendation, and the visionary has since decided it: merge,
into `INHERITS_FROM{relation}`.

---

## Node type table

| Name | Verdict | Joern equivalent | Rationale |
|---|---|---|---|
| `DIRECTORY` | EXTEND | none | Joern's FileSystem layer is overlay-only and has no directory-tree node at all (Identity, Standards) — this fills a real gap, not a divergence. |
| `FILE` | ADOPT AS-IS | `FILE` | Unchanged; carries `content_hash`/`interface_hash`/`status`/`version` per the pre-existing v1 draft, untouched by the debate. |
| `MODULE` | EXTEND | none (supersedes rejected `NAMESPACE_BLOCK`) | `NAMESPACE`/`NAMESPACE_BLOCK` rejected by triangulation (Identity, Storage, Analytics — three independent arguments); `MODULE` is the file-scoped replacement, one-per-file, no cross-file merge. |
| `TYPE_DECL` | ADOPT AS-IS | `TYPE_DECL` | Unchallenged all three rounds. Gains `structural` (bool) — see properties below. |
| `METHOD` | ADOPT AS-IS | `METHOD` | Unchallenged. Gains `cyclomatic_complexity`, `max_nesting_depth`, `loc`, `visibility`, `generator` (bool) — see properties below. |
| `PARAM` | ADOPT (name kept, rename rejected) | `METHOD_PARAMETER_IN` (rejected as name) | Standards proposed renaming to Joern's `METHOD_PARAMETER_IN`; Ergonomics rejected it (importing half a Joern IN/OUT pair with no OUT present imports confusion, not alignment) and Standards explicitly withdrew the rename in Round 3. **Resolved: keep `PARAM`.** `METHOD_PARAMETER_OUT` is a legitimate omission (no by-ref out-params in TS/Python), not a gap. |
| `MEMBER` | ADOPT AS-IS | `MEMBER` | Unchallenged. |
| `CALL` | ADOPT AS-IS | `CALL` (node) | Unchallenged. Folds args/receiver/kind into properties, never child nodes — reaffirmed throughout. Identity flagged as a required test (not a schema change): CALL ids need a parent-scope-relative ordinal so PR5's "insert-above → 0 id changes" guarantee holds for duplicate calls in one method. |
| `IMPORT` | ADOPT (matches Joern's actual, unpublished implementation) | `IMPORT` (Hidden, not in the published spec) | Cite precisely as "matches Joern's implementation," never "matches the Joern spec" — Joern's own `Hidden.scala` states this node is deliberately excluded from the published standard. |
| `SYMBOL` | EXTEND — load-bearing, non-negotiable | none | Confirmed independently by Security, Identity, and Standards: Joern's `CALL` edge is created by a global load-time linker over `METHOD_FULL_NAME`, which requires whole-graph relinking and is structurally incompatible with per-file incremental replace. SCIP's descriptor grammar for `SYMBOL.fqn` is also confirmed incompatible with Joern's `FULL_NAME` string format — adopting Joern's shape here would sacrifice real SCIP interoperability. Not a stylistic choice. |
| `COMMUNITY` | EXTEND | none | Gains `projection`/`edge_basis` (which edge set a run used) and `level` (room for hierarchical/multi-resolution detection) — both uncontested additions from Graph Analytics. |
| `TAG` | ADOPT AS-IS | `TAG` | Pulled forward from deferred into v1 scope (Security's proposal, Standards/Complexity endorsed) — generic key-value classification hook for source/sink/sanitizer marking, at near-zero MCP tool-budget cost since it needs no dedicated tool. |
| `UNKNOWN` | ADOPT AS-IS | `UNKNOWN` | Standards' proposal: escape hatch for unparseable content, paired with existing `status=error`, near-zero cost since agents rarely query it directly. **Triage unification — decided 2026-09-11:** `UNKNOWN` nodes and `FILE{status:error}` are tagged with a shared `needs_triage` `TAG` (via `TAGGED_BY`), the same mechanism already adopted for source/sink/sanitizer marking, so one query surfaces failed-to-parse files, unparseable fragments, and `CALLS.status=unresolved`/`IMPORTS.status=unresolved` together. No new mechanism required. |
| `META_DATA` | ADOPT AS-IS | `META_DATA` | Standards' proposal: one node per graph carrying schema/overlay version, serving D21's "state is always explicit" principle. Must never carry a `file` property or participate in per-file replace (Identity's caveat). |
| **REJECT, final** | `MODIFIER`, `METHOD_RETURN`, `ANNOTATION`/`ANNOTATION_LITERAL`/`ANNOTATION_PARAMETER`/`ANNOTATION_PARAMETER_ASSIGN`, `TYPE` (as node), `NAMESPACE`, `NAMESPACE_BLOCK`, `BINDING` | — | See **Rejected from Joern** below for reasoning per type. |
| **REJECT for v1, v2 candidate — decided 2026-09-11** | `TYPE_PARAMETER`, `TYPE_ARGUMENT` (and, if pulled in alongside, `BINDS`/`EVAL_TYPE` as edges — see edge table) | Joern's own names, unchanged | v1 folds these into a `type_text` string property (queryable only by substring, not graph traversal) — the same per-usage-site density argument that rejects the rest of this row applies today. **Explicitly flagged as a planned v2 feature, not a permanent rejection**: visionary decision 2026-09-11, deferred pending a dedicated Type System lens pass and a concrete agent workflow that needs generics-aware graph queries (e.g. "every instantiation of `Repository<T>` with `T=Order`"). Tracked in `60-delivery.yaml`'s `v2_backlog`. |
| **REJECT, final — decided 2026-09-11** | `CONFIG_FILE` | — | Visionary decision: no identified need, same reasoning as the rest of this row; revisit only if a concrete need surfaces. |
| **REJECT for v1, names reserved** | `CONTROL_STRUCTURE`, `BLOCK`, `RETURN`, `JUMP_TARGET`, `JUMP_LABEL`, `IDENTIFIER`, `LITERAL`, `FIELD_IDENTIFIER`, `LOCAL`, `METHOD_REF`, `TYPE_REF`, `ARRAY_INITIALIZER`, `COMMENT`, `KEY_VALUE_PAIR`, `TAG_NODE_PAIR`, `FINDING` | — | Expression/CFG/PDG tier, deferred with D23/RK1. PR1's measured ~7x density gap is decisive; no lens argued to pull any of these into v1. Joern's exact names are reserved for when these tiers ship — no rename buys anything there. |
| **Not applicable** | `AST_NODE`, `CALL_REPR`, `CFG_NODE`, `DECLARATION`, `EXPRESSION` (Joern's 5 abstract base types) | — | Scala type-hierarchy scaffolding with no Cypher shape. Our shared `:CPG` label already gives the "match anything code-related" query these would otherwise serve (Ergonomics, uncontested). |
| **REJECT, final — decided 2026-09-11** | `CLOSURE_BINDING`, `DEPENDENCY`, `TEMPLATE_DOM` (all Hidden, not in the published Joern spec) | — | No lens raised these during the debate. Visionary decision: reject now on the same grounds as the rest of this row (no identified need); add later if a concrete need surfaces. Note `DEPENDENCY` is unrelated to the `DEPENDS_ON` edge, which stays adopted — see edge table. |

---

## Edge type table

| Name | Verdict | Joern equivalent | Rationale |
|---|---|---|---|
| **`HAS_ENTRY`** (was `CONTAINS`) | ADOPT RENAMED — unanimous, final | `CONTAINS` (deliberately not reused) | **This resolves the section-6 collision explicitly.** Our `DIRECTORY -> DIRECTORY\|FILE` filesystem-nesting edge used the same name as Joern's `CONTAINS` (`METHOD -> CFG_NODE`, near-opposite meaning). All eight lenses independently proposed a rename (eight different spellings surfaced); `HAS_ENTRY` drew two uncoordinated Round 1 votes (Identity, Storage) and became the converged plurality by Round 2, seconded by Analytics, Ergonomics, Cross-Language, and Standards by Round 3. It is mutated only on move/rename (never touched by per-file `:CPG` replace), so the rename cost nothing. `CONTAINS` itself stays **permanently reserved and unclaimed** for Joern's real `METHOD -[:CONTAINS]-> BLOCK\|CONTROL_STRUCTURE\|CALL\|RETURN` meaning, to be adopted as-is if/when the CFG tier ships. |
| `DECLARES` | ADOPT, extended | `AST` (partial analogue, rejected as too generic) | Lexical nesting: `MODULE\|TYPE_DECL\|METHOD -> TYPE_DECL\|METHOD\|MEMBER`. Extended by Graph Analytics' Round 1 proposal to also cover `IMPORT` (previously reachable only via a `.file` property scan, now a real edge back to its containing `MODULE`). Storage/Perf's typed-edge-decomposition argument against collapsing to Joern's generic `AST`/`REF` was accepted unanimously — relationship-type-specific adjacency lets FalkorDB's planner prune by edge type instead of every traversal post-filtering by target label. |
| `HAS_PARAM` | ADOPT AS-IS | — (Joern uses `AST` + `PARAMETER_LINK`) | `METHOD -> PARAM`. Unchallenged. |
| `DEFINES` | ADOPT, extended to `PARAM` | `REF`/`PARAMETER_LINK` (partial analogue, rejected as too generic) | `MODULE\|TYPE_DECL\|METHOD\|MEMBER\|PARAM -> SYMBOL`. Security's Round 1 proposal to extend the domain to `PARAM` (parameters need the same stable cross-reference identity as methods/types for future taint propagation) was independently reinforced by Cross-Language as a resolution-completeness fix, not just a taint one — adopted uncontested. Conditional only on extending whatever SYMBOL GC/lifecycle mechanism already covers METHOD/TYPE_DECL to cover PARAM too (an implementation detail, not a design dispute). |
| `CALLS` (was Joern's bare `CALL` edge) | ADOPT RENAMED, final | `CALL` (edge) | Deliberately renamed to avoid the node/edge label ambiguity Joern itself carries (`CALL` is both a node type and an edge type) — a concrete parsing-clarity reason, not cosmetic preference (Standards). Carries `status(resolved\|ambiguous\|external\|unresolved\|dynamic)`, `reason`, `confidence`, `resolvedBy` — unchallenged across all three rounds, Security's core triage tool. `resolved`/`ambiguous`/`dynamic`/`external`/`unresolved` get normative cross-language definitions — see **ID rule and status enum** below. |
| `IN_SCOPE` (was `IN_METHOD`) | ADOPT RENAMED + EXTENDED, final | `CONTAINS` (reversed, partial analogue) | `CALL -> METHOD\|MODULE`, broadened from `METHOD`-only. Graph Analytics flagged that module-level/top-level calls (route registration, decorator-as-call, module init) had no home under the original `IN_METHOD`; Ergonomics independently converged on the same fix and the rename (keeping the old name once it can target `MODULE` would mislead an agent about the target label). Multiple lenses explicitly declined to merge this into `DECLARES` — "declared inside" and "called inside" diverge exactly at inline callbacks not themselves declared, and merging would force every call-graph query to post-filter by target label instead of pruning by edge type. |
| `IMPORTS` | ADOPT, extended | — (Joern's `IMPORTS` is Hidden, unpublished) | `IMPORT -> SYMBOL`. Gains `status`, reusing the **identical** 5-value enum as `CALLS.status` — not a parallel vocabulary. This closes a real inconsistency Ergonomics flagged (two competing resolution-signaling patterns: a bare `resolved` bool on `CALL`/`IMPORT` nodes vs. a rich enum on `CALLS`). `CALL.resolved` and `IMPORT.resolved` bare booleans are **dropped** — one signal, one place, per the whole debate's unanimous convergence. |
| **`INHERITS_FROM`** (merged, was `EXTENDS`/`IMPLEMENTS`) | ADOPT MERGED — decided | `INHERITS_FROM` | `TYPE_DECL -> TYPE_DECL\|IDENTIFIER` (or equivalent) `{relation: extends\|implements}`. Visionary sign-off 2026-09-11, per the synthesis recommendation below: merge, don't keep two typed edges. |
| `MEMBER_OF` | ADOPT AS-IS, unrestricted | none | `FILE\|METHOD\|TYPE_DECL -> COMMUNITY`. Identity's Round 2 hedge (restrict to FILE-only pending confirmation of the per-file replace write contract) was **explicitly withdrawn by Identity itself in Round 3**, once the overlay-edge classification rule (below) made the restriction unnecessary. Two other lenses (Complexity, Analytics) flagged this as still-open in their own Round 3 text, but that is a simultaneity artifact — they were responding to Identity's Round 2 position and could not see Identity's Round 3 update, written at the same time. **Resolved: unrestricted**, governed by the overlay-edge rule. |
| `ALIAS_OF` | ADOPT AS-IS, final | `ALIAS_OF` (a genuine, current Joern edge — not Hidden) | `SYMBOL -> SYMBOL`. The debate's strongest alignment case (Standards: "a genuine, current Joern edge, not Hidden/unspecced... zero SYMBOL-format compromise"). Models TS barrel/re-export and Python `__init__.py` re-export chains as a graph traversal instead of a string property on `IMPORT.alias`. Required input to Security's SYMBOL-anchored `TAGGED_BY` (a re-exported dangerous function must stay tagged) and to `TARGETS`/`DEPENDS_ON` resolution. Zero dissent anywhere in the debate. |
| `TAGGED_BY` | ADOPT AS-IS, final | `TAGGED_BY` | Primary anchor **`SYMBOL`** (not `CALL` — Identity's Round 2 correction, adopted by Security: sink/source classification is a fact about callee identity, stable across every caller's file-save cycle, and inherited for free via the existing `CALLS -> SYMBOL` hop), secondary anchor `MEMBER` (local secrets), `CALL`-level tags reserved narrowly for per-call-site sanitizer/verified-safe annotations. **Extended use, decided 2026-09-11:** also the mechanism for the unified triage surface — see `TAG` node and `UNKNOWN` node above. |
| `TARGETS` | EXTEND, conditional — final, hardened | `CALL` (edge type, Joern's Shortcuts layer — linker-only, frontend MUST NOT create) | `CALL\|IMPORT\|TYPE_DECL -> METHOD\|TYPE_DECL`, materialized only when the underlying resolution is `status=resolved`, resolved through `ALIAS_OF*` to the canonical `SYMBOL` first. This started as Graph Analytics' Round 1 fix for the 3-hop `CALL->SYMBOL<-DEFINES` tax on centrality/PageRank/impact-of-change traversal, and was hardened across two full rounds after Identity flagged that a synchronous, cross-file write has the identical replace-survivability hazard as the original `MEMBER_OF` concern (a renamed target method orphans every inbound `TARGETS` edge from other files, silently corrupting centrality results while still looking valid). **Final, converged constraints, all mandatory:** (1) computed by an **async periodic overlay job**, the same contract as `COMMUNITY`, **never** written inside the per-file replace transaction; (2) must be a **pure projection of the same resolver call** that sets `CALLS.status`/`IMPORTS.status` — never an independent fast-path resolver (Cross-Language's condition; explicitly ratified by both Analytics and Storage in their own Round 3 text, resolving what Security's Round 3 had separately flagged as still-open with those two lenses — another simultaneity artifact, now resolved). Governed by the overlay-edge classification rule below. **Rebuild trigger — decided 2026-09-11:** periodic tick, same cadence/contract as `COMMUNITY` (`computed_at`/`status` on the job's output, not per-save), plus a manual "refresh now" escape hatch (an MCP tool or CLI command) for an agent that needs current data before the next tick. Rejected: recompute on every save of either endpoint's file — same unbounded-cascade risk class M1.4/M1.5 are built to prevent for interface hashes. |
| `DEPENDS_ON` | EXTEND, final | none | `FILE -> FILE`, a file-granularity rollup produced by the **same** async overlay job as `TARGETS` (one job, two materializations — Complexity's Round 1 proposal, unified with `TARGETS` by Analytics in Round 2), not a second resolution mechanism. Gives import-cycle detection a materialized file-level graph instead of a live per-pair traversal. **Rebuild trigger: same periodic + `computed_at` + manual-refresh contract as `TARGETS` above** — one job, one trigger policy, two materializations. |
| **REJECT, final** | `CALL` (Joern's linker-created edge), `BINDING`, `BINDS`, `BINDS_TO`, `NAMESPACE`/`NAMESPACE_BLOCK` (as edges/nodes), `SOURCE_FILE`, `PARAMETER_LINK`, `RECEIVER`, `ARGUMENT` | — | See **Rejected from Joern** below. |
| `REACHING_DEF` | ADOPT, sparse endpoints — amended 2026-09-12 | `REACHING_DEF` | **Pulled into v1** as structural-tier data flow: `MEMBER\|PARAM -> CALL` with required `variable` property. Aligns with D10 ("structural-tier data flow") and supersedes the blanket PDG deferral for this edge alone. Joern's expression-tier endpoints (`IDENTIFIER`/`LITERAL`/`LOCAL`) stay rejected (PR1); CFG/`CDG`/`DOMINATE` remain deferred. Intra-file, file-owned — no SYMBOL indirection. |
| **REJECT for v1, names reserved** | `CFG`, `CDG`, `DOMINATE`, `POST_DOMINATE`, `CONDITION`, `EVAL_TYPE`, `CATCH_BODY`/`DO_BODY`/`FALSE_BODY`/`FINALLY_BODY`/`FOR_BODY`/`FOR_INIT`/`FOR_UPDATE`/`TRUE_BODY`/`TRY_BODY`, `JUMP_ARGUMENT` | — | CFG and remaining PDG (beyond sparse `REACHING_DEF`), deferred with D23/RK1. Standard compiler-theory names reserved unchanged for when these ship. |
| **Not addressed** | `TAG_NODE_PAIR`, `IS_CALL_FOR_IMPORT`, `CAPTURE`, `CAPTURED_BY` | REJECT (implied, see below) | `TAG_NODE_PAIR` — Standards explicitly rejected it (edge properties on `TAGGED_BY` suffice in a property graph). `IS_CALL_FOR_IMPORT`/`CAPTURE`/`CAPTURED_BY` — Standards explicitly rejected these as Hidden, not even in Joern's published spec, no need identified. |

---

## Rejected from Joern

Grouped by the reasoning that rejected them, since several converged on the same argument from different
lenses independently — that convergence is itself evidence the reasoning is sound, not merely one lens's
preference.

**Per-token / per-usage-site cardinality (Storage/Perf's core argument, independently reached by others):**
`MODIFIER` (one node per modifier keyword — fold into `MEMBER.visibility`/`METHOD.exported`/`async`
booleans), `METHOD_RETURN` (1:1 with every METHOD, exists only to give deferred CFG return-flow an AST
slot — fold into a `return_type_text` string property), the `ANNOTATION` family (four node types for what
the v1 draft already handles as `CALL{kind:decorator} -> SYMBOL`), `TYPE_PARAMETER`/`TYPE_ARGUMENT`
(usage-site cardinality, same failure mode as the expression tier — fold into a `type_text` string
property), `TYPE`-as-node (one node per type *reference* is exactly the expression-tier density PR1 opts
out of — `type_text` again). Each is a multiplicative tax on the measured ~450-node/300-line-file budget
for zero query benefit a string property or existing edge doesn't already provide.

**Structural incompatibility with per-file incremental replace (D5's core argument, triangulated three
ways):** `NAMESPACE`/`NAMESPACE_BLOCK` — Identity: a cross-file merged node requires touching a vertex
shared across files outside the one being replaced; Storage: the same structural conflict independently
derived; Analytics: TS/Python module scoping is already file-scoped and fully covered by `MODULE` +
`DIRECTORY`, so it buys nothing even setting incrementality aside. Three lenses, three different arguments,
one conclusion — the strongest triangulation in the whole debate, and Standards, who initially proposed
nothing here, confirmed it as "dead, not deferred."

**Joern's own linker mechanism, rejected as a mechanism, not a name:** Joern's `CALL` edge (created by a
global load-time linker walking `METHOD_FULL_NAME` across the entire graph at load time) and
`BINDING`/`BINDS`/`BINDS_TO` (Joern's vtable-style polymorphic dispatch resolution, requiring whole-type-
hierarchy computation) were rejected by Security, Identity, Cross-Language, and Standards independently, on
the same structural ground: both require whole-graph relinking, which is incompatible with a 24ms
single-file replace under concurrent readers. `SYMBOL` indirection and `CALLS.status=ambiguous` are the
permanent substitutes, not stopgaps — no lens proposed revisiting this even for a later milestone.

**Redundant with an existing, benchmark-load-bearing property:** `SOURCE_FILE` (edge) — the v1 draft
already tags `file` as a property on every `:CPG` node under the shared label, which is precisely the
indexed-delete mechanism the benchmark measured a 13x speedup on (3.1ms vs. 40.3ms). Trading that property
for an edge would directly undercut the schema's own incrementality claim (Identity, Storage).

**Unused without its counterpart:** `PARAMETER_LINK` — no referent without `METHOD_PARAMETER_OUT`, which is
correctly omitted (Standards).

**Folded into existing CALL properties:** `RECEIVER`, `ARGUMENT` (edges) — args and receiver are already
CALL properties in the v1 draft, not child nodes; adopting these edges would reintroduce exactly the
density PR1 rejects (Storage).

**Config/finding/misc, no identified need:** `CONFIG_FILE` — not addressed by the debate (see the node
table's explicit gap flag). `KEY_VALUE_PAIR`, `TAG_NODE_PAIR` — edge/node properties already serve this in
a property graph (Standards). `FINDING` — taint-overlay territory, deferred alongside CFG/PDG, not gone
(Standards, consistent with RK1). `IS_CALL_FOR_IMPORT`, `CAPTURE`, `CAPTURED_BY` — confirmed Hidden in
Joern's own source, not even part of the published spec Joern itself asks others to align to (Standards).

---

## Unresolved — the one real tension, and the several false ones

### RESOLVED 2026-09-11: `EXTENDS`/`IMPLEMENTS` as two edges, or merged into `INHERITS_FROM{relation}`

**Decision: merge into `INHERITS_FROM{relation: extends|implements}`.** The visionary confirmed the synthesis
recommendation below. Reasoning kept for the record — the debate itself never converged, only the
reconstructed reading of all eight final positions did:

This is the one place three full rounds did not produce a stable answer, and it is worth being precise
about *why*, because the confusion itself is instructive. Standards proposed the Joern-aligned merge in
Round 1; Ergonomics rejected it ("an agent wants one edge to traverse, not a property filter"); Standards
conceded and withdrew in Round 2, citing Storage's typed-edge-decomposition principle — but **misapplied**
it, since Storage's own Round 2 text scoped that argument to *high-frequency* edges (`DECLARES`/`CALLS`/
etc.), not to a 0-few-per-`TYPE_DECL` edge like this one, and said explicitly it had "no objection" to this
specific merge. Meanwhile Ergonomics **independently reversed itself the same round**, now endorsing the
merge on the strength of its own `CALL.kind` precedent (four call shapes already fold into one property; a
two-value `relation` property is the identical move). The two lenses passed each other going opposite
directions. Standards reinstated the merge in Round 3, explicitly flagging the oscillation rather than
hiding it.

**Reconstructed final tally, read across all eight simultaneous Round 3 texts:**
- **For the merge** (`INHERITS_FROM{relation: extends|implements}`): Standards (final), Graph Analytics
  (final, explicitly flagged as unresolved against Standards — not knowing Standards had already reinstated
  the merge), Agent Ergonomics (Round 2 final position, reaffirmed by its Round 3 `top_priority` line).
- **For keeping two typed edges**: Complexity (final — but its own stated reason to prefer two, DIT/NOC
  traversal, is satisfied *either way* by Cypher's `-[:EXTENDS|IMPLEMENTS*]->` union-pattern syntax, so it
  aligned with what it believed was "the plurality," citing Ergonomics and Standards as keep-two — both of
  which had actually already reversed to support the merge by the time Complexity wrote this), Storage/Perf
  (final — explicitly "neutral on pure perf grounds," deferring to what it believed was Ergonomics'
  standing query-shape objection, not registering that Ergonomics had reversed that objection in Round 2).
- **Neutral, no stake either way**: Security, Incremental Update & Identity, Cross-Language.

Three of the five substantive votes, once corrected for stale cross-references, favor the merge; the two
"keep two" votes were each cast citing a position the cited lens had already abandoned. **Synthesis
recommendation (not settled by the debate itself): merge into `INHERITS_FROM{relation: extends|implements}`.**
Reasoning: the lens whose entire brief is agent-query ergonomics reversed its own initial objection with a
self-consistent argument (not mere deference); Storage/Perf has stated zero performance objection either
way (cardinality is 0-few edges per `TYPE_DECL`); Complexity's own motivation for two edges is satisfied
regardless of which shape ships; and the merge aligns with Joern's own `INHERITS_FROM` name, which costs
nothing given the low cardinality. **Signed off by the visionary 2026-09-11 — confirmed as the decision, not
merely a recommendation.**

### Resolved by reading all eight final positions together (not resolved by any single lens)

Because Round 3 was written simultaneously by all eight lenses, several flagged tensions that a later
lens's own Round 3 text had already closed — none could see the others' final round while writing their
own. Reading all eight together resolves these:

- **`MEMBER_OF`/`COMMUNITY` granularity.** Complexity and Graph Analytics each flagged, in their own Round 3
  text, an open disagreement with "Identity's restriction to FILE-only." Identity's *own* Round 3 text,
  written the same round, explicitly withdraws that restriction once the overlay-edge classification rule
  (below) made it unnecessary. **Resolved: `MEMBER_OF` targets `FILE`/`METHOD`/`TYPE_DECL` unrestricted,**
  governed by the overlay rule.
- **`TARGETS` as a pure projection of the same resolver call.** Security's Round 3 flagged this constraint
  as "unresolved with Analytics/Storage specifically." Both Graph Analytics' and Storage's own Round 3 text,
  written the same round, explicitly ratify the constraint as binding. **Resolved: ratified by all three.**
- **`PARAM` vs. `METHOD_PARAMETER_IN`.** Cross-Language's Round 3 flagged this as "genuinely unresolved,
  Standards never withdrew it." Standards' own Round 3 text, written the same round, explicitly withdraws
  the rename. **Resolved: keep `PARAM`,** per the node table above.

### Real, but not a disagreement — open engineering work, not an unresolved debate question

- **Whether per-file replace is `MERGE`-on-id or `DELETE`+`CREATE` was never empirically confirmed by an
  implementation source** — only inferred from the benchmark's 13x indexed-delete number, which several
  lenses read (reasonably) as evidence for bulk delete+recreate. The overlay-edge classification rule below
  is designed specifically so the answer doesn't matter for *correctness* — but the answer still matters for
  whoever writes `DiffGraph.replace()`, and should be confirmed, not assumed, when that code is built.
- **`TARGETS`' rebuild-trigger semantics** ("computed_at/status like COMMUNITY" is repeated by four lenses,
  but nobody wrote the actual trigger: on every save of either endpoint's file? on a timer? on a staleness
  threshold read?) — real follow-up engineering work, not a design disagreement.
- **`FILE.status=error`/`UNKNOWN` as one unified triage surface with `CALL.status=unresolved`** — Security's
  proposal drew no objection but also no explicit ratification from Standards (who owns `UNKNOWN`) or
  Ergonomics (whose Round 3 is the placeholder). Minor, low-risk, worth a one-line confirmation before
  building the triage tool around it.
- **Python's implicit/duck-typed `Protocol` conformance has no edge to attach to** under `EXTENDS`/
  `IMPLEMENTS` or a merged `INHERITS_FROM` — an honest, acknowledged v1 limitation (Cross-Language), not a
  reason to reopen `TYPE`/`TYPE_DECL` usage-site machinery.
- **No Type System lens was included in this debate**, despite `TYPE_PARAMETER`/`TYPE_ARGUMENT`/`BINDS`/
  `EVAL_TYPE` being squarely its territory (Graph Analytics noted this explicitly in Round 1). The REJECT
  verdicts on these types are the converged judgment of adjacent lenses, not a considered type-system
  review — Standards flagged this itself as "provisional." Worth a dedicated pass if generics-aware queries
  become load-bearing later.

---

## ID rule and status enum

No lens raised an objection to PR5's id rule (`path:kind:qualifiedScopePath[:ordinal|:bodyHash]`, no file
content hash) or to D21/PR8's status enum (`ready`/`indexing`/`stale`/`error` on every `:CPG` and `FILE`
node). Both stand **confirmed, not merely unchallenged** — several lenses actively relied on them as
constraints in their own arguments (e.g., Identity's whole framing is "does this survive
`DiffGraph.replace(file)`," which presupposes the id rule as given). One concrete addition, not a
conflict: Identity's flagged requirement that CALL identity needs a parent-scope-relative ordinal (not a
file-relative one) so that PR5's "insert-above → 0 id changes" guarantee holds when two identical calls
exist in one method — this should become an explicit golden-file test case (two identical calls, then an
unrelated statement inserted above), not just prose in the id-rule doc.

The resolution-status vocabulary gains normative, cross-language-binding definitions, converged on
independently by Security and Cross-Language from different motivations (taint triage vs. cross-language
comparability — two lenses landing on identical wording from different angles is exactly the kind of
convergence worth writing down as spec text, not leaving as implicit convention):

- **`resolved`** — target found and unambiguous.
- **`ambiguous`** — multiple statically-plausible candidates exist (overload sets, duplicate/star imports,
  unresolved re-export fan-out).
- **`external`** — target resolves to a dependency outside the indexed workspace.
- **`unresolved`** — no static candidate found.
- **`dynamic`** — target determined by a runtime dispatch mechanism the frontend cannot follow statically
  (`eval`, `getattr`/`__getattr__`/`__call__` overrides, `Function()`, computed member access `obj[key]()`,
  computed `require`/dynamic `import`).

This exact five-value enum is now shared, unmodified, by both `CALLS.status` and `IMPORTS.status` — not a
parallel per-edge-type vocabulary, per Ergonomics' original bool-vs-enum consolidation and Cross-Language's
insistence on one shared set.

---

## Test-spec recommendation

The debate had access to the finding that no conformance suite exists for Joern's own CPG spec, but SCIP
ships a genuinely reusable one: `scip test`'s plain-text assertion DSL, a 12-scenario language-agnostic
`reprolang` conformance corpus, and a pinned real-world nightly benchmark matrix. Cross-Language engaged
with this directly across all three rounds and its position held unchanged: **adopt `reprolang` as the base
conformance target for resolver *logic*** (forward-definition, duplicate-symbol handling, cross-file/
cross-document linking — genuinely language-neutral concerns that map directly onto this project's
SYMBOL-resolution guarantees), **but it is not sufficient on its own** — it is synthetic and will not
exercise TS/Python-specific failure modes (decorator-wrapped functions changing effective identity,
destructured imports, Python name-mangled `_Class__attr`, re-export barrels). A small, hand-written TS +
Python golden fixture set is required **alongside** `reprolang`, not instead of it, specifically targeting
those language-specific cases. No lens disputed this framing at any point; it should be adopted as stated.

---

## Next steps — visionary sign-off, RESOLVED 2026-09-11

This document was a synthesis of an eight-lens AI debate, not an approved schema, until this session. The
visionary read the six open items below directly and decided all six; the schema is now approved pending
nothing further from this debate.

1. **`EXTENDS`/`IMPLEMENTS` vs. `INHERITS_FROM{relation}` merge — DECIDED: merge.** Adopt
   `INHERITS_FROM{relation: extends|implements}`, per the synthesis recommendation. See the resolved section
   above and the edge table.
2. **Write-mechanism for per-file replace — DECIDED: split by node class, not one global choice.**
   File-owned structural nodes (`MODULE`/`TYPE_DECL`/`METHOD`/`PARAM`/`MEMBER`/`CALL`/`IMPORT`, everything
   tagged with one file's path) are `DELETE`+`CREATE` on every save — safe because nothing outside that file
   ever writes to them, and it's what the 13x indexed-delete benchmark actually measured. `SYMBOL` nodes are
   `MERGE`-on-`fqn` (upsert) — they're the cross-file-shared identity anchor other files' edges point into
   (`CALLS -> SYMBOL`, `DEFINES -> SYMBOL`); deleting and recreating one on every save of the file that
   defines it would force touching every inbound edge from every other referencing file, which is exactly
   the whole-graph-relinking problem `SYMBOL` indirection exists to avoid. Matches the shape already sketched
   in `60-delivery.yaml` M1.2 (`delete -> nodes -> edges -> SYMBOL merge -> ...`) — now confirmed as the
   deliberate design, not an implementation detail to revisit.
3. **`TARGETS`/`DEPENDS_ON` rebuild-trigger contract — DECIDED: periodic + `computed_at`, plus manual
   refresh.** Same cadence/contract as `COMMUNITY` — a periodic tick recomputes both (one job, two
   materializations), each carrying `computed_at`/`status` so a reader knows how fresh it is. A manual
   "refresh now" escape hatch (MCP tool or CLI command) exists for an agent that needs current data before
   the next tick. Rejected: recompute on every save of either endpoint's file — same unbounded-cascade risk
   class M1.4/M1.5 exist to prevent for interface hashes. See the edge table for both rows.
4. **The four Joern node types this debate never addressed — DECIDED: REJECT all four.** `CONFIG_FILE`,
   `CLOSURE_BINDING`, `DEPENDENCY`, `TEMPLATE_DOM` — no identified need, same reasoning as the rest of the
   per-token/Hidden-schema REJECT batch. Add later only if a concrete need surfaces. (Note: `DEPENDENCY` the
   Joern node is unrelated to `DEPENDS_ON` the edge, which stays adopted.)
5. **Dedicated Type System pass on `TYPE_PARAMETER`/`TYPE_ARGUMENT`/`BINDS`/`EVAL_TYPE` — DECIDED: defer to
   v2, tracked explicitly.** v1 keeps folding generic type info into a `type_text` string property
   (substring-queryable only, no graph traversal over generic instantiations). This is a deliberate,
   documented deferral, not a silent drop — see the node table's "REJECT for v1, v2 candidate" row and
   `60-delivery.yaml`'s `v2_backlog`. Revisit with a dedicated Type System lens pass once a concrete agent
   workflow needs generics-aware graph queries.
6. **`FILE.status=error`/`UNKNOWN` as one triage surface with `CALL.status=unresolved` — DECIDED: unify via
   `TAG`.** `UNKNOWN` nodes and `FILE{status:error}` get a shared `needs_triage` `TAG` via `TAGGED_BY` — the
   generic classification mechanism already adopted for source/sink/sanitizer marking, so no new mechanism
   is needed. One query now surfaces failed-to-parse files, unparseable fragments, and unresolved
   calls/imports together.

Everything else in the node and edge tables above — including the section-6 `CONTAINS`/`HAS_ENTRY` rename,
the `SYMBOL`/SCIP-descriptor identity model, the `TARGETS`/`DEPENDS_ON` overlay design, the full REJECT
batch of Joern's per-token and cross-file-merged node types, and the shared `CALLS.status`/`IMPORTS.status`
vocabulary — reflects genuine, argued convergence across all eight lenses and three rounds, not a coin flip
or a majority vote. With all six items above now decided, this document is the working v1 schema.
