/**
 * The 14 v1 node labels (M0.0), transcribed from
 * `research/R6-ontology-debate-synthesis.md`'s node type table — the
 * eight-lens ontology debate the visionary signed off on 2026-09-11.
 *
 * `REJECT`ed and deferred Joern types do not appear here at all; they are
 * accounted for in the written spec's rejection table and cross-checked
 * against the vendored Joern schema by `test/unit/schema/joern.test.ts`.
 */
import { CALL_KIND, METHOD_KIND, NODE_STATUS, TYPE_DECL_KIND } from "./enums";
import type { NodeLabelSpec } from "./types";

export const NODE_LABELS = [
  {
    label: "DIRECTORY",
    cpgCoLabel: false,
    hasFileProperty: false,
    ownership: "filesystem",
    write: "merge-on-key",
    key: ["path"],
    properties: [
      {
        name: "path",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "Workspace-relative path.",
      },
      { name: "name", type: "string", cardinality: "one", golden: "include", doc: "Basename." },
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: NODE_STATUS,
        golden: "include",
        doc: "Lifecycle status (D21/PR8).",
      },
    ],
    joern: {
      verdict: "extend",
      divergenceClass: "gap-fill",
      rationale:
        "Joern's FileSystem layer is overlay-only and has no directory-tree node at all " +
        "(Identity, Standards) — this fills a real gap, not a divergence.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.2",
    doc: "One node per workspace directory. Never :CPG — filesystem tier, not code.",
  },
  {
    label: "FILE",
    cpgCoLabel: false,
    hasFileProperty: false,
    ownership: "filesystem",
    write: "merge-on-key",
    key: ["path"],
    properties: [
      {
        name: "path",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "Workspace-relative path.",
      },
      { name: "name", type: "string", cardinality: "one", golden: "include", doc: "Basename." },
      {
        name: "language",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "Grammar id (F4).",
      },
      {
        name: "content_hash",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "SHA-256 of file bytes. Source of truth for staleness (PR3).",
      },
      {
        name: "interface_hash",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "Hash of the exported-declaration surface. Gates cascades (GE-FR6).",
      },
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: NODE_STATUS,
        golden: "include",
        doc: "Lifecycle status; brackets the per-file replace transaction (GE-FR11).",
      },
      {
        name: "version",
        type: "int",
        cardinality: "one",
        golden: "redact",
        doc: "Monotonic per-file version, bumped every replace.",
      },
      { name: "indexed_at", type: "string", cardinality: "zeroOrOne", golden: "redact", doc: "" },
      { name: "loc", type: "int", cardinality: "zeroOrOne", golden: "include", doc: "" },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "FILE",
      divergenceClass: "none",
      rationale:
        "Unchanged; carries content_hash/interface_hash/status/version untouched by the debate.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.2",
    doc: "One node per indexed file. Never :CPG — id is `file:<path>`, stable across saves.",
  },
  {
    label: "MODULE",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "name", type: "string", cardinality: "one", golden: "include", doc: "" },
      {
        name: "file",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "Owning FILE.path.",
      },
      {
        name: "range",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "Navigation only, never identity (PR1).",
      },
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: NODE_STATUS,
        golden: "include",
        doc: "",
      },
    ],
    joern: {
      verdict: "extend",
      divergenceClass: "gap-fill",
      rationale:
        "Supersedes rejected NAMESPACE_BLOCK, which required a cross-file-merged vertex — structurally " +
        "incompatible with per-file replace (Identity, Storage) and unneeded once TS/Python module scoping " +
        "is covered by MODULE + DIRECTORY (Analytics). One per file; namespaces/declared modules in TS " +
        "become nested MODULE.",
      source: "R6 node table; rejection group 'structural incompatibility'",
    },
    firstWrittenIn: "M0.6",
    doc: "The file-scoped module/namespace root. Free functions and top-level statements hang off this.",
  },
  {
    label: "TYPE_DECL",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "name", type: "string", cardinality: "one", golden: "include", doc: "" },
      {
        name: "kind",
        type: "string",
        cardinality: "one",
        enumValues: TYPE_DECL_KIND,
        golden: "include",
        doc: "",
      },
      { name: "file", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "range", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "exported", type: "bool", cardinality: "one", golden: "include", doc: "" },
      {
        name: "docstring_head",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "",
      },
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: NODE_STATUS,
        golden: "include",
        doc: "",
      },
      {
        name: "structural",
        type: "bool",
        cardinality: "one",
        golden: "include",
        doc: "R6 addition (Complexity/Standards, uncontested).",
      },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "TYPE_DECL",
      divergenceClass: "none",
      rationale: "Unchallenged all three rounds. Gains `structural` (bool).",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.6",
    doc: "class | interface | enum | type_alias | protocol | dataclass.",
  },
  {
    label: "METHOD",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "name", type: "string", cardinality: "one", golden: "include", doc: "" },
      {
        name: "kind",
        type: "string",
        cardinality: "one",
        enumValues: METHOD_KIND,
        golden: "include",
        doc: "",
      },
      { name: "signature", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "params_count", type: "int", cardinality: "one", golden: "include", doc: "" },
      { name: "file", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "range", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "exported", type: "bool", cardinality: "one", golden: "include", doc: "" },
      { name: "async", type: "bool", cardinality: "one", golden: "include", doc: "" },
      {
        name: "docstring_head",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "",
      },
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: NODE_STATUS,
        golden: "include",
        doc: "",
      },
      {
        name: "cyclomatic_complexity",
        type: "int",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition (Complexity).",
      },
      {
        name: "max_nesting_depth",
        type: "int",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition.",
      },
      {
        name: "loc",
        type: "int",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition.",
      },
      {
        name: "visibility",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition.",
      },
      {
        name: "generator",
        type: "bool",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition.",
      },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "METHOD",
      divergenceClass: "none",
      rationale:
        "Unchallenged. Gains cyclomatic_complexity, max_nesting_depth, loc, visibility, generator (bool). " +
        "Free functions and methods share the label; the parent DECLARES edge disambiguates.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.6",
    doc: "function | method | constructor | getter | setter | lambda_named.",
  },
  {
    label: "PARAM",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "name", type: "string", cardinality: "one", golden: "include", doc: "" },
      {
        name: "ordinal",
        type: "int",
        cardinality: "one",
        golden: "include",
        doc: "Position within its METHOD's parameter list.",
      },
      { name: "type_text", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "default", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "file", type: "string", cardinality: "one", golden: "include", doc: "" },
    ],
    joern: {
      verdict: "adopt_renamed",
      joernName: "METHOD_PARAMETER_IN",
      divergenceClass: "name-only",
      rationale:
        "Standards proposed renaming to Joern's METHOD_PARAMETER_IN; Ergonomics rejected it (importing " +
        "half a Joern IN/OUT pair with no OUT present imports confusion, not alignment) and Standards " +
        "withdrew the rename in Round 3. Kept our pre-existing PARAM. METHOD_PARAMETER_OUT is a legitimate " +
        "omission — no by-ref out-params in TS/Python — not a gap.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.6",
    doc: "A formal parameter. IN-only; there is no METHOD_PARAMETER_OUT equivalent.",
  },
  {
    label: "MEMBER",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "name", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "type_text", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "file", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "range", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "visibility", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "MEMBER",
      divergenceClass: "none",
      rationale: "Unchallenged.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.6",
    doc: "Class field / dataclass attribute / module-level constant.",
  },
  {
    label: "CALL",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "callee_name", type: "string", cardinality: "one", golden: "include", doc: "" },
      {
        name: "receiver_text",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "",
      },
      { name: "args_count", type: "int", cardinality: "one", golden: "include", doc: "" },
      { name: "file", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "range", type: "string", cardinality: "one", golden: "include", doc: "" },
      {
        name: "kind",
        type: "string",
        cardinality: "one",
        enumValues: CALL_KIND,
        golden: "include",
        doc: "",
      },
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: NODE_STATUS,
        golden: "include",
        doc: "",
      },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "CALL",
      divergenceClass: "none",
      rationale:
        "Unchallenged. Folds args/receiver/kind into properties, never child nodes — the CALLS *edge* is " +
        "separately renamed from Joern's edge-typed CALL to avoid the node/edge label collision Joern " +
        "itself carries; that rename is recorded on the CALLS edge, not here. CALL ids need a " +
        "parent-scope-relative ordinal (not file-relative) so PR5's 'insert-above -> 0 id changes' holds " +
        "for duplicate calls in one method (R6, required golden test case — see M0.3/M0.6).",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.7",
    doc: "A call/new/decorator/await site. Args, receiver and literals fold into properties (design rule 3).",
  },
  {
    label: "IMPORT",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "source_text", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "imported_names", type: "string[]", cardinality: "list", golden: "include", doc: "" },
      { name: "alias", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "is_type_only", type: "bool", cardinality: "one", golden: "include", doc: "" },
      { name: "file", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "range", type: "string", cardinality: "one", golden: "include", doc: "" },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "IMPORT",
      divergenceClass: "none",
      hidden: true,
      rationale:
        "Cite precisely as 'matches Joern's implementation,' never 'matches the Joern spec' — IMPORT is " +
        "not present in the published spec (verified against the vendored joern-cpg-schema.json).",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.7",
    doc:
      "One per import statement. The bare `resolved` boolean this node once carried is dropped (R6) — " +
      "resolution status lives on the IMPORTS edge.",
  },
  {
    label: "SYMBOL",
    cpgCoLabel: false,
    hasFileProperty: false,
    ownership: "identity",
    write: "merge-on-key",
    key: ["fqn"],
    properties: [
      {
        name: "fqn",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "SCIP descriptor grammar, e.g. `src/users.ts`/UserService#findById(). UNIQUE constraint.",
      },
      {
        name: "scheme",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "SCIP scheme.",
      },
      {
        name: "manager",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "SCIP package manager.",
      },
      {
        name: "package",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "SCIP package name.",
      },
      {
        name: "version",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "SCIP package version.",
      },
      { name: "kind", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "language", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
    ],
    joern: {
      verdict: "extend",
      divergenceClass: "structural-incompatibility",
      rationale:
        "Joern resolves calls with a global load-time linker over METHOD_FULL_NAME, which requires " +
        "whole-graph relinking and is structurally incompatible with per-file incremental replace. SCIP's " +
        "descriptor grammar for SYMBOL.fqn is also incompatible with Joern's FULL_NAME string format — " +
        "adopting Joern's shape here would sacrifice real SCIP interoperability. Not a stylistic choice; " +
        "confirmed independently by Security, Identity and Standards. Load-bearing, non-negotiable.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.10",
    doc: "Cross-file identity anchor. Not :CPG and has no `file` — a per-file delete cannot touch it (D5).",
  },
  {
    label: "COMMUNITY",
    cpgCoLabel: false,
    hasFileProperty: false,
    ownership: "overlay",
    write: "overlay-job",
    key: ["id"],
    properties: [
      { name: "algorithm", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "run_id", type: "string", cardinality: "one", golden: "redact", doc: "" },
      { name: "size", type: "int", cardinality: "one", golden: "include", doc: "" },
      { name: "cohesion", type: "float", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "computed_at", type: "string", cardinality: "one", golden: "redact", doc: "" },
      {
        name: "label_hint",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "A deterministic string (e.g. top-3 member names), not an LLM label (D15).",
      },
      {
        name: "projection",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition.",
      },
      {
        name: "edge_basis",
        type: "string",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition.",
      },
      {
        name: "level",
        type: "int",
        cardinality: "zeroOrOne",
        golden: "include",
        doc: "R6 addition: room for hierarchical/multi-resolution detection.",
      },
    ],
    joern: {
      verdict: "extend",
      divergenceClass: "gap-fill",
      rationale:
        "No Joern equivalent. Gains projection/edge_basis (which edge set a run used) and level — both " +
        "uncontested additions from Graph Analytics.",
      source: "R6 node table",
    },
    firstWrittenIn: "M4",
    doc: "One community-detection result. Written only by the async analytics overlay job.",
  },
  {
    label: "TAG",
    cpgCoLabel: false,
    hasFileProperty: false,
    ownership: "identity",
    write: "merge-on-key",
    key: ["name"],
    properties: [
      {
        name: "name",
        type: "string",
        cardinality: "one",
        golden: "include",
        doc: "e.g. `needs_triage`, `source`, `sink`.",
      },
      { name: "value", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "TAG",
      divergenceClass: "none",
      rationale:
        "Pulled forward from deferred into v1 scope (Security's proposal, Standards/Complexity endorsed) " +
        "— generic key-value classification hook for source/sink/sanitizer marking and the unified " +
        "needs_triage triage surface, at near-zero MCP tool-budget cost since it needs no dedicated tool. " +
        "MERGE-on-name: a small, shared vocabulary, never file-scoped.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.6",
    doc:
      "Generic classification hook. TAG values are classification metadata only — numeric metrics stay " +
      "typed scalar properties elsewhere, since range queries need an index-backed number.",
  },
  {
    label: "UNKNOWN",
    cpgCoLabel: true,
    hasFileProperty: true,
    ownership: "file-owned",
    write: "delete-create",
    key: ["id"],
    properties: [
      { name: "reason", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      { name: "file", type: "string", cardinality: "one", golden: "include", doc: "" },
      { name: "range", type: "string", cardinality: "zeroOrOne", golden: "include", doc: "" },
      {
        name: "status",
        type: "string",
        cardinality: "one",
        enumValues: NODE_STATUS,
        golden: "include",
        doc: "",
      },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "UNKNOWN",
      divergenceClass: "none",
      rationale:
        "Escape hatch for unparseable content, paired with FILE{status:error}. Triage unification: UNKNOWN " +
        "nodes and FILE{status:error} share a needs_triage TAG via TAGGED_BY, the same mechanism already " +
        "adopted for source/sink/sanitizer marking, so one query surfaces failed-to-parse files, " +
        "unparseable fragments, and CALLS/IMPORTS status=unresolved together.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.6",
    doc: "An unparseable region of an otherwise-parsed file.",
  },
  {
    label: "META_DATA",
    cpgCoLabel: false,
    hasFileProperty: false,
    ownership: "graph-singleton",
    write: "merge-on-key",
    key: [],
    properties: [
      {
        name: "schema_version",
        type: "int",
        cardinality: "one",
        golden: "include",
        doc: "GE-FR18: mismatch on start -> full rebuild. See CPG_SCHEMA.version.",
      },
      { name: "engine_version", type: "string", cardinality: "one", golden: "redact", doc: "" },
      { name: "overlays", type: "string[]", cardinality: "list", golden: "include", doc: "" },
      { name: "created_at", type: "string", cardinality: "one", golden: "redact", doc: "" },
    ],
    joern: {
      verdict: "adopt_as_is",
      joernName: "META_DATA",
      divergenceClass: "none",
      rationale:
        "One node per graph carrying schema/overlay version, serving D21's 'state is always explicit' " +
        "principle. Must never carry a `file` property or participate in per-file replace.",
      source: "R6 node table",
    },
    firstWrittenIn: "M0.4",
    doc: "The single graph-wide metadata node. Not :CPG; never touched by a per-file replace.",
  },
] as const satisfies readonly NodeLabelSpec[];

export type NodeLabel = (typeof NODE_LABELS)[number]["label"];
