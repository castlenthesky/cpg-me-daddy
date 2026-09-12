/**
 * The 13 v1 edge types (M0.0), transcribed from
 * `research/R6-ontology-debate-synthesis.md`'s edge type table, with one
 * deliberate, reasoned divergence from its literal text: `INHERITS_FROM`
 * points at `SYMBOL`, not `TYPE_DECL` — see its entry below.
 */
import { INHERITS_RELATION, RESOLUTION_STATUS } from "./enums";
import type { EdgeTypeSpec } from "./types";

export const EDGE_TYPES = [
  {
    type: "HAS_ENTRY",
    from: ["DIRECTORY"],
    to: ["DIRECTORY", "FILE"],
    ownership: "filesystem",
    write: "move-rename-only",
    properties: [],
    joern: {
      verdict: "adopt_renamed",
      joernName: "CONTAINS",
      divergenceClass: "name-only",
      rationale:
        "Was CONTAINS. Our filesystem-nesting edge used the same name as Joern's CONTAINS " +
        "(METHOD -> CFG_NODE, near-opposite meaning) — a genuine collision, unanimous across all eight " +
        "lenses. Mutated only on move/rename, never touched by per-file :CPG replace, so the rename cost " +
        "nothing. CONTAINS itself stays permanently reserved and unclaimed for Joern's real meaning, to be " +
        "adopted as-is if/when the CFG tier ships.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.2",
    doc: "Filesystem nesting only. Code nesting uses DECLARES; file membership is the `file` property.",
  },
  {
    type: "DECLARES",
    from: ["MODULE", "TYPE_DECL", "METHOD"],
    to: ["TYPE_DECL", "METHOD", "MEMBER", "IMPORT"],
    ownership: "file-owned",
    write: "delete-create",
    properties: [],
    joern: {
      verdict: "extend",
      joernName: "AST",
      divergenceClass: "semantic",
      rationale:
        "Joern's AST edge is too generic to adopt directly (Storage/Perf's typed-edge-decomposition " +
        "argument, accepted unanimously: relationship-type-specific adjacency lets FalkorDB's planner " +
        "prune by edge type instead of every traversal post-filtering by target label). Extended to also " +
        "cover IMPORT (previously reachable only via a `.file` property scan, now a real edge back to its " +
        "containing MODULE) — Graph Analytics' Round 1 proposal.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.6",
    doc: "Lexical nesting. Extended in M0.7 to MODULE -> IMPORT.",
  },
  {
    type: "HAS_PARAM",
    from: ["METHOD"],
    to: ["PARAM"],
    ownership: "file-owned",
    write: "delete-create",
    properties: [],
    joern: {
      verdict: "extend",
      divergenceClass: "semantic",
      rationale:
        "Joern uses AST + PARAMETER_LINK for this; PARAMETER_LINK is unused without its rejected " +
        "counterpart METHOD_PARAMETER_OUT. Unchallenged as its own edge across all three rounds.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.6",
    doc: "",
  },
  {
    type: "DEFINES",
    from: ["MODULE", "TYPE_DECL", "METHOD", "MEMBER", "PARAM"],
    to: ["SYMBOL"],
    ownership: "file-owned",
    write: "delete-create",
    properties: [],
    joern: {
      verdict: "extend",
      joernName: "REF",
      divergenceClass: "semantic",
      rationale:
        "Joern's REF/PARAMETER_LINK are partial analogues, rejected as too generic. Extended to PARAM: " +
        "Security's Round 1 proposal (parameters need the same stable cross-reference identity as " +
        "methods/types for future taint propagation), independently reinforced by Cross-Language as a " +
        "resolution-completeness fix. Conditional on the SYMBOL GC/lifecycle mechanism covering PARAM too.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.10",
    doc: "",
  },
  {
    type: "CALLS",
    from: ["CALL"],
    to: ["SYMBOL"],
    ownership: "file-owned",
    write: "delete-create",
    properties: [
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: RESOLUTION_STATUS,
        golden: "include",
        doc: "Shared vocabulary with IMPORTS.status — not a parallel enum.",
      },
      { name: "reason", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "confidence", type: "float", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "resolvedBy", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
    ],
    joern: {
      verdict: "adopt_renamed",
      joernName: "CALL",
      divergenceClass: "name-only",
      rationale:
        "Deliberately renamed to avoid the node/edge label ambiguity Joern itself carries (CALL is both a " +
        "node type and an edge type) — a concrete parsing-clarity reason, not cosmetic preference " +
        "(Standards). Security's core triage tool. The bare CALL.resolved boolean this project once had is " +
        "dropped in favour of this status enum.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.10",
    doc: "CALL site to the SYMBOL it resolves to. R2: unresolved rate = one GROUP BY over `status`.",
  },
  {
    type: "IN_SCOPE",
    from: ["CALL"],
    to: ["METHOD", "MODULE"],
    ownership: "file-owned",
    write: "delete-create",
    properties: [],
    joern: {
      verdict: "adopt_renamed",
      joernName: "CONTAINS",
      divergenceClass: "semantic",
      rationale:
        "Was IN_METHOD, METHOD-only. Module-level/top-level calls (route registration, decorator-as-call, " +
        "module init) had no home under that shape; broadened to MODULE and renamed so the old name " +
        "targeting MODULE would not mislead an agent about the target label. Deliberately not merged into " +
        "DECLARES: 'declared inside' and 'called inside' diverge exactly at inline callbacks not themselves " +
        "declared.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.7",
    doc: "Which method or module body contains the call. Enables callers_of without a CFG.",
  },
  {
    type: "IMPORTS",
    from: ["IMPORT"],
    to: ["SYMBOL"],
    ownership: "file-owned",
    write: "delete-create",
    properties: [
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: RESOLUTION_STATUS,
        golden: "include",
        doc: "Identical enum object to CALLS.status.",
      },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "IMPORTS",
      divergenceClass: "none",
      hidden: true,
      rationale:
        "Per imported name. Module-level wildcard/namespace imports point at the MODULE's SYMBOL. Gains " +
        "`status`, closing a real inconsistency (two competing resolution-signaling patterns: a bare " +
        "`resolved` bool on CALL/IMPORT nodes vs. a rich enum on CALLS). The bare booleans are dropped.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.10",
    doc: "",
  },
  {
    type: "INHERITS_FROM",
    from: ["TYPE_DECL"],
    to: ["SYMBOL"],
    ownership: "file-owned",
    write: "delete-create",
    properties: [
      {
        name: "relation",
        type: "string",
        cardinality: "one",
        enumValues: INHERITS_RELATION,
        golden: "include",
        doc: "",
      },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "INHERITS_FROM",
      divergenceClass: "semantic",
      rationale:
        "Merges the former EXTENDS/IMPLEMENTS into one edge with a relation property (R6 Next Steps #1, " +
        "DL6, visionary sign-off 2026-09-11). DELIBERATE DIVERGENCE FROM R6'S LITERAL TEXT: R6's edge table " +
        "hedges the endpoint as `TYPE_DECL -> TYPE_DECL|IDENTIFIER (or equivalent)`, a direct :CPG->:CPG " +
        "cross-file edge. That is exactly the shape SYMBOL indirection (D5, design rule 2) exists to " +
        "prevent — a per-file replace of the parent class's file would delete a node other files' edges " +
        "point into — and it contradicts GE-FR7/GE-UC3, which compute the interface-change cascade by " +
        "traversing inheritance edges into changed SYMBOLs, not into TYPE_DECL nodes directly. Pinned to " +
        "TYPE_DECL -> SYMBOL instead, matching the endpoint EXTENDS/IMPLEMENTS already had. The one-hop " +
        "TYPE_DECL -> TYPE_DECL traversal that motivated the direct form is already provided by the " +
        "TARGETS overlay edge, whose own row lists TYPE_DECL as both source and target.",
      source: "R6 edge table; M0.0 planning decision, user-confirmed",
    },
    firstWrittenIn: "M0.10",
    doc:
      "Python's implicit/duck-typed Protocol conformance has no edge to attach to here — an honest, " +
      "acknowledged v1 limitation (Cross-Language), not a reason to reopen TYPE_DECL usage-site machinery.",
  },
  {
    type: "MEMBER_OF",
    from: ["FILE", "METHOD", "TYPE_DECL"],
    to: ["COMMUNITY"],
    ownership: "overlay",
    write: "overlay-job",
    properties: [{ name: "run_id", type: "string", cardinality: "one", golden: "redact", doc: "" }],
    joern: {
      verdict: "extend",
      divergenceClass: "gap-fill",
      rationale:
        "No Joern equivalent. Unrestricted target set (FILE/METHOD/TYPE_DECL), governed by the overlay-edge " +
        "classification rule: any edge landing on a :CPG node from outside that node's own per-file replace " +
        "transaction is a periodic-recompute overlay, never a correctness dependency of the write path.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M4",
    doc: "",
  },
  {
    type: "ALIAS_OF",
    from: ["SYMBOL"],
    to: ["SYMBOL"],
    ownership: "identity",
    write: "merge-on-key",
    properties: [],
    joern: {
      verdict: "adopt_as_is",
      joernName: "ALIAS_OF",
      divergenceClass: "semantic",
      rationale:
        "The debate's strongest alignment case — a genuine, current Joern edge, not Hidden/unspecced, zero " +
        "SYMBOL-format compromise. Applied to our SYMBOL model rather than Joern's TYPE_DECL/TYPE model: " +
        "models TS barrel/re-export and Python __init__.py re-export chains as a graph traversal instead of " +
        "a string property on IMPORT.alias. Required input to TAGGED_BY (a re-exported dangerous function " +
        "must stay tagged) and to TARGETS resolution.",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.10",
    doc: "",
  },
  {
    type: "TAGGED_BY",
    from: ["SYMBOL", "MEMBER", "CALL"],
    to: ["TAG"],
    ownership: "identity",
    write: "merge-on-key",
    properties: [],
    joern: {
      verdict: "adopt_as_is",
      joernName: "TAGGED_BY",
      divergenceClass: "semantic",
      rationale:
        "Primary anchor SYMBOL, not CALL (Identity's correction, adopted by Security: sink/source " +
        "classification is a fact about callee identity, stable across every caller's file-save cycle, and " +
        "inherited for free via the existing CALLS -> SYMBOL hop). Secondary anchor MEMBER (local secrets); " +
        "CALL-level tags reserved narrowly for per-call-site sanitizer/verified-safe annotations. Also the " +
        "mechanism for the unified triage surface (see UNKNOWN/TAG).",
      source: "R6 edge table",
    },
    firstWrittenIn: "M0.6",
    doc: "",
  },
  {
    type: "TARGETS",
    from: ["CALL", "IMPORT", "TYPE_DECL"],
    to: ["METHOD", "TYPE_DECL"],
    ownership: "overlay",
    write: "overlay-job",
    properties: [
      { name: "computed_at", type: "string", cardinality: "one", golden: "redact", doc: "" },
      { name: "run_id", type: "string", cardinality: "one", golden: "redact", doc: "" },
    ],
    joern: {
      verdict: "extend",
      joernName: "CALL",
      divergenceClass: "semantic",
      rationale:
        "Joern's Shortcuts-layer CALL edge is linker-created and its frontend MUST NOT create it. Ours is a " +
        "one-hop shortcut past the CALL -> SYMBOL <- DEFINES tax on centrality/PageRank/impact-of-change " +
        "traversal, materialized ONLY when the underlying resolution is status=resolved, resolved through " +
        "ALIAS_OF* to the canonical SYMBOL first. Mandatory constraints: computed by an async periodic " +
        "overlay job, the same contract as COMMUNITY, never written inside the per-file replace " +
        "transaction; and must be a pure projection of the same resolver call that sets " +
        "CALLS.status/IMPORTS.status — never an independent fast-path resolver. Rebuild trigger: periodic " +
        "tick + computed_at, same as COMMUNITY, plus a manual refresh escape hatch. Rejected: recompute on " +
        "every save of either endpoint's file.",
      source: "R6 edge table; R6 Next Steps #3, DL8",
    },
    firstWrittenIn: "M4",
    doc: "",
  },
  {
    type: "DEPENDS_ON",
    from: ["FILE"],
    to: ["FILE"],
    ownership: "overlay",
    write: "overlay-job",
    properties: [
      { name: "computed_at", type: "string", cardinality: "one", golden: "redact", doc: "" },
      { name: "run_id", type: "string", cardinality: "one", golden: "redact", doc: "" },
    ],
    joern: {
      verdict: "extend",
      divergenceClass: "gap-fill",
      rationale:
        "A file-granularity rollup produced by the same async overlay job as TARGETS (one job, two " +
        "materializations), not a second resolution mechanism. Gives import-cycle detection a materialized " +
        "file-level graph instead of a live per-pair traversal. Same periodic + computed_at + " +
        "manual-refresh rebuild contract as TARGETS.",
      source: "R6 edge table; R6 Next Steps #3, DL8",
    },
    firstWrittenIn: "M4",
    doc: "",
  },
] as const satisfies readonly EdgeTypeSpec[];

export type EdgeType = (typeof EDGE_TYPES)[number]["type"];
