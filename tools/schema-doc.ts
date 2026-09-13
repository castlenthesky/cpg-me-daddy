/**
 * Generates the divergence table inside `50-schema.md` from `CPG_SCHEMA`
 * itself, rather than it being maintained twice. Run as
 * `bun run tools/schema-doc.ts` to regenerate; `spec-doc.test.ts` asserts
 * the checked-in file is current, so drift fails `test:schema`.
 *
 * The rejection table (every Joern node/edge name we did NOT adopt) is data
 * here too, `REJECTED_JOERN_NODES`/`REJECTED_JOERN_EDGES`, transcribed from
 * `research/R6-ontology-debate-synthesis.md`'s "Rejected from Joern"
 * section. `joern.test.ts` asserts the two tables together account for
 * every one of the 68 names (39 concrete nodes + 29 edges) in the vendored
 * `joern-cpg-schema.json` exactly once — turning the alignment decision
 * into an executable claim, not an assertion.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CPG_SCHEMA } from "../packages/engine/src/schema/index.ts";
import type { EdgeTypeSpec, NodeLabelSpec } from "../packages/engine/src/schema/index.ts";

export const SPEC_PATH =
  ".agent/knowledge/planning-sessions/2026-09-11.project-outline/50-schema.md";

const BEGIN_MARKER = "<!-- BEGIN GENERATED: schema-doc -->";
const END_MARKER = "<!-- END GENERATED: schema-doc -->";

export interface RejectedName {
  readonly name: string;
  readonly group: string;
  readonly reason: string;
}

/**
 * Every Joern node name this project did NOT ship, grouped by the reasoning
 * that rejected it (R6's "Rejected from Joern" section groups several
 * convergently, since independent lenses reached the same conclusion).
 */
export const REJECTED_JOERN_NODES: readonly RejectedName[] = [
  // Per-token / per-usage-site cardinality — a multiplicative tax on the
  // ~450-node/300-line-file budget for zero query benefit a string property
  // doesn't already provide.
  {
    name: "MODIFIER",
    group: "per-token cardinality",
    reason: "fold into MEMBER.visibility / METHOD.exported/async booleans",
  },
  {
    name: "METHOD_RETURN",
    group: "per-token cardinality",
    reason:
      "1:1 with every METHOD, exists only for deferred CFG return-flow — fold into return_type_text",
  },
  {
    name: "ANNOTATION",
    group: "per-token cardinality",
    reason: "already handled as CALL{kind:decorator} -> SYMBOL",
  },
  {
    name: "ANNOTATION_LITERAL",
    group: "per-token cardinality",
    reason: "part of the ANNOTATION family, same fold",
  },
  {
    name: "ANNOTATION_PARAMETER",
    group: "per-token cardinality",
    reason: "part of the ANNOTATION family, same fold",
  },
  {
    name: "ANNOTATION_PARAMETER_ASSIGN",
    group: "per-token cardinality",
    reason: "part of the ANNOTATION family, same fold",
  },
  // Structural incompatibility with per-file incremental replace — triangulated
  // three ways (Identity, Storage, Analytics), the strongest convergence in the debate.
  {
    name: "NAMESPACE",
    group: "structural incompatibility",
    reason:
      "cross-file-merged vertex; TS/Python module scoping is file-scoped and covered by MODULE + DIRECTORY",
  },
  {
    name: "NAMESPACE_BLOCK",
    group: "structural incompatibility",
    reason: "superseded by MODULE — see MODULE's EXTEND rationale",
  },
  {
    name: "TYPE",
    group: "structural incompatibility",
    reason: "one node per type reference is exactly the expression-tier density PR1 rejects",
  },
  {
    name: "BINDING",
    group: "Joern's linker mechanism, rejected as a mechanism",
    reason: "vtable-style polymorphic dispatch requiring whole-type-hierarchy computation",
  },
  // Config/finding/misc, no identified need — visionary decision 2026-09-11.
  {
    name: "CONFIG_FILE",
    group: "no identified need",
    reason: "not addressed by the ontology debate; add later only if a concrete need surfaces",
  },
  // Expression/CFG/PDG tier — deferred with D23/RK1, Joern's exact names reserved unchanged.
  { name: "CONTROL_STRUCTURE", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "BLOCK", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "RETURN", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "JUMP_TARGET", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "JUMP_LABEL", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "IDENTIFIER", group: "deferred tier, names reserved", reason: "expression tier" },
  { name: "LITERAL", group: "deferred tier, names reserved", reason: "expression tier" },
  { name: "FIELD_IDENTIFIER", group: "deferred tier, names reserved", reason: "expression tier" },
  { name: "LOCAL", group: "deferred tier, names reserved", reason: "expression/PDG tier" },
  { name: "METHOD_REF", group: "deferred tier, names reserved", reason: "expression tier" },
  { name: "TYPE_REF", group: "deferred tier, names reserved", reason: "expression tier" },
  { name: "ARRAY_INITIALIZER", group: "deferred tier, names reserved", reason: "expression tier" },
  {
    name: "COMMENT",
    group: "deferred tier, names reserved",
    reason: "not addressed; low priority",
  },
  {
    name: "KEY_VALUE_PAIR",
    group: "deferred tier, names reserved",
    reason: "edge/node properties already serve this in a property graph",
  },
  {
    name: "TAG_NODE_PAIR",
    group: "deferred tier, names reserved",
    reason: "edge properties on TAGGED_BY suffice in a property graph",
  },
  {
    name: "FINDING",
    group: "deferred tier, names reserved",
    reason: "taint-overlay territory, deferred alongside CFG/PDG",
  },
  // v2 candidate — a Type System lens, not a permanent rejection.
  {
    name: "TYPE_PARAMETER",
    group: "v2 candidate (V2.1)",
    reason: "generics folded into type_text for v1; tracked in 60-delivery.yaml v2_backlog",
  },
  {
    name: "TYPE_ARGUMENT",
    group: "v2 candidate (V2.1)",
    reason: "generics folded into type_text for v1; tracked in 60-delivery.yaml v2_backlog",
  },
  // Unused without its counterpart.
  {
    name: "METHOD_PARAMETER_OUT",
    group: "unused without its counterpart",
    reason: "no by-ref out-params in TS/Python — a legitimate omission, not a gap",
  },
];

/** As `REJECTED_JOERN_NODES`, for edges. */
export const REJECTED_JOERN_EDGES: readonly RejectedName[] = [
  {
    name: "BINDS",
    group: "Joern's linker mechanism, rejected as a mechanism",
    reason: "vtable-style polymorphic dispatch resolution",
  },
  {
    name: "BINDS_TO",
    group: "Joern's linker mechanism, rejected as a mechanism",
    reason: "vtable-style polymorphic dispatch resolution",
  },
  {
    name: "ARGUMENT",
    group: "folded into existing CALL properties",
    reason: "args are already CALL properties, not child nodes (PR1)",
  },
  {
    name: "RECEIVER",
    group: "folded into existing CALL properties",
    reason: "receiver is already a CALL property, not a child node (PR1)",
  },
  {
    name: "PARAMETER_LINK",
    group: "unused without its counterpart",
    reason: "no referent without METHOD_PARAMETER_OUT, correctly omitted",
  },
  { name: "CFG", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "CDG", group: "deferred tier, names reserved", reason: "PDG tier" },
  { name: "DOMINATE", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "POST_DOMINATE", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "CONDITION", group: "deferred tier, names reserved", reason: "CFG tier" },
  {
    name: "EVAL_TYPE",
    group: "deferred tier, names reserved",
    reason: "v2 type-system tier alongside TYPE_PARAMETER/TYPE_ARGUMENT/BINDS",
  },
  { name: "CATCH_BODY", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "DO_BODY", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "FALSE_BODY", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "FINALLY_BODY", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "FOR_BODY", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "FOR_INIT", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "FOR_UPDATE", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "TRUE_BODY", group: "deferred tier, names reserved", reason: "CFG tier" },
  { name: "TRY_BODY", group: "deferred tier, names reserved", reason: "CFG tier" },
];

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderNodeRow(n: NodeLabelSpec): string {
  const joernName = n.joern.joernName ?? "—";
  return `| \`${n.label}\` | node | \`${n.joern.verdict}\` | ${joernName} | \`${n.joern.divergenceClass}\` | ${mdEscape(n.joern.rationale)} | ${n.joern.source} |`;
}

function renderEdgeRow(e: EdgeTypeSpec): string {
  const joernName = e.joern.joernName ?? "—";
  return `| \`${e.type}\` | edge | \`${e.joern.verdict}\` | ${joernName} | \`${e.joern.divergenceClass}\` | ${mdEscape(e.joern.rationale)} | ${e.joern.source} |`;
}

function renderDivergenceTable(): string {
  const header =
    "| Name | Kind | Verdict | Joern name | Divergence class | Reason | Source |\n" +
    "| --- | --- | --- | --- | --- | --- | --- |";
  const nodeRows = CPG_SCHEMA.nodes
    .toSorted((a, b) => (a.label < b.label ? -1 : 1))
    .map(renderNodeRow);
  const edgeRows = CPG_SCHEMA.edges
    .toSorted((a, b) => (a.type < b.type ? -1 : 1))
    .map(renderEdgeRow);
  return [header, ...nodeRows, ...edgeRows].join("\n");
}

function renderRejectionTable(): string {
  const header = "| Name | Kind | Group | Reason |\n| --- | --- | --- | --- |";
  const nodeRows = REJECTED_JOERN_NODES.map(
    (r) => `| \`${r.name}\` | node | ${r.group} | ${mdEscape(r.reason)} |`,
  );
  const edgeRows = REJECTED_JOERN_EDGES.map(
    (r) => `| \`${r.name}\` | edge | ${r.group} | ${mdEscape(r.reason)} |`,
  );
  return [header, ...nodeRows, ...edgeRows].join("\n");
}

/** The full generated region: divergence table + rejection table. Pure — no file I/O. */
export function generatedSchemaDoc(): string {
  return [
    "### Divergence table (generated from `packages/engine/src/schema/`)",
    "",
    renderDivergenceTable(),
    "",
    "### Rejected from Joern (generated from `tools/schema-doc.ts`)",
    "",
    renderRejectionTable(),
  ].join("\n");
}

/** Splices `generatedSchemaDoc()` between the markers in `existing`. Pure — no file I/O. */
export function withGeneratedSection(existing: string): string {
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${SPEC_PATH} is missing the ${BEGIN_MARKER}/${END_MARKER} region`);
  }
  const before = existing.slice(0, begin + BEGIN_MARKER.length);
  const after = existing.slice(end);
  return `${before}\n\n${generatedSchemaDoc()}\n\n${after}`;
}

function main(): void {
  const path = join(process.cwd(), SPEC_PATH);
  const existing = readFileSync(path, "utf8");
  const updated = withGeneratedSection(existing);
  writeFileSync(path, updated);
  process.stdout.write(`Regenerated the schema divergence/rejection tables in ${SPEC_PATH}.\n`);
}

// tools/*.ts scripts run standalone via `bun run tools/schema-doc.ts`; guard so
// that importing this module for its pure functions (spec-doc.test.ts,
// joern.test.ts) never touches the filesystem.
if (require.main === module) {
  main();
}
