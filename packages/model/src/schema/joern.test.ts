/**
 * Exhaustiveness gate for the Joern alignment decision (VD-37). Every one of the 39 concrete node
 * names and 29 edge names in the vendored Joern CPG spec (packages/model/test/fixtures/) must be
 * accounted for exactly once: cited as the Joern analogue of one of our labels or edge types, or
 * listed as rejected. The reason for each verdict lives in docs/outline/04-schema.yaml. This file
 * holds only the names, so a label added, dropped or renamed without its Joern entry fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { EDGE_TYPES, NODE_LABELS } from '../index';

/** Our node label -> the Joern node it adopts or renames (04-schema.yaml `joern_name`). */
const NODE_CITATIONS: Readonly<Record<string, string>> = {
  FILE: 'FILE',
  TYPE_DECL: 'TYPE_DECL',
  METHOD: 'METHOD',
  PARAM: 'METHOD_PARAMETER_IN',
  MEMBER: 'MEMBER',
  CALL: 'CALL',
  IMPORT: 'IMPORT',
  TAG: 'TAG',
  UNKNOWN: 'UNKNOWN',
  META_DATA: 'META_DATA',
};

/** Our edge type -> the Joern edge it adopts, renames or extends (04-schema.yaml `joern_name`). */
const EDGE_CITATIONS: Readonly<Record<string, string>> = {
  HAS_ENTRY: 'CONTAINS',
  DECLARES: 'AST',
  DEFINES: 'REF',
  CALLS: 'CALL',
  IN_SCOPE: 'CONTAINS',
  IMPORTS: 'IMPORTS',
  INHERITS_FROM: 'INHERITS_FROM',
  ALIAS_OF: 'ALIAS_OF',
  TAGGED_BY: 'TAGGED_BY',
  TARGETS: 'CALL',
  REACHING_DEF: 'REACHING_DEF',
  SOURCE_FILE: 'SOURCE_FILE',
};

/** Joern nodes we do not ship: rejected, or reserved for a deferred tier. */
const REJECTED_JOERN_NODES = [
  'MODIFIER',
  'METHOD_RETURN',
  'ANNOTATION',
  'ANNOTATION_LITERAL',
  'ANNOTATION_PARAMETER',
  'ANNOTATION_PARAMETER_ASSIGN',
  'NAMESPACE',
  'NAMESPACE_BLOCK',
  'TYPE',
  'BINDING',
  'CONFIG_FILE',
  'CONTROL_STRUCTURE',
  'BLOCK',
  'RETURN',
  'JUMP_TARGET',
  'JUMP_LABEL',
  'IDENTIFIER',
  'LITERAL',
  'FIELD_IDENTIFIER',
  'LOCAL',
  'METHOD_REF',
  'TYPE_REF',
  'ARRAY_INITIALIZER',
  'COMMENT',
  'KEY_VALUE_PAIR',
  'TAG_NODE_PAIR',
  'FINDING',
  'TYPE_PARAMETER',
  'TYPE_ARGUMENT',
  'METHOD_PARAMETER_OUT',
];

/** Joern edges we do not ship: rejected, or reserved for a deferred tier. */
const REJECTED_JOERN_EDGES = [
  'BINDS',
  'BINDS_TO',
  'ARGUMENT',
  'RECEIVER',
  'PARAMETER_LINK',
  'CFG',
  'CDG',
  'DOMINATE',
  'POST_DOMINATE',
  'CONDITION',
  'EVAL_TYPE',
  'CATCH_BODY',
  'DO_BODY',
  'FALSE_BODY',
  'FINALLY_BODY',
  'FOR_BODY',
  'FOR_INIT',
  'FOR_UPDATE',
  'TRUE_BODY',
  'TRY_BODY',
];

interface JoernSchemaEntry {
  name: string;
  isAbstract?: boolean;
}
interface JoernSchema {
  nodes: JoernSchemaEntry[];
  edges: JoernSchemaEntry[];
}

const joernSchema: JoernSchema = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'joern-cpg-schema.json'), 'utf8'),
);

const CONCRETE_JOERN_NODES = new Set(
  joernSchema.nodes.filter((n) => !n.isAbstract).map((n) => n.name),
);
const JOERN_EDGES = new Set(joernSchema.edges.map((e) => e.name));

describe('vendored Joern schema', () => {
  test('has exactly 39 concrete nodes and 29 edges (68 names)', () => {
    expect(CONCRETE_JOERN_NODES.size).toBe(39);
    expect(JOERN_EDGES.size).toBe(29);
  });
});

describe('the citation tables describe the shipped schema', () => {
  test('every citing label and edge type is one the schema ships', () => {
    const labels = new Set<string>(NODE_LABELS.map((n) => n.label));
    const types = new Set<string>(EDGE_TYPES.map((e) => e.type));
    expect(Object.keys(NODE_CITATIONS).filter((l) => !labels.has(l))).toEqual([]);
    expect(Object.keys(EDGE_CITATIONS).filter((t) => !types.has(t))).toEqual([]);
  });

  test('the schema ships no rejected Joern name as a label or edge type', () => {
    expect(NODE_LABELS.filter((n) => REJECTED_JOERN_NODES.includes(n.label))).toEqual([]);
    expect(EDGE_TYPES.filter((e) => REJECTED_JOERN_EDGES.includes(e.type))).toEqual([]);
  });
});

describe('node exhaustiveness', () => {
  const cited = new Set(Object.values(NODE_CITATIONS));
  // IMPORT is cited as our IMPORT node's Joern analogue, but IMPORT is not in
  // the published spec (it lives only in Joern's Hidden.scala) — it never
  // appears in the vendored concrete-node set, so it consumes nothing here.
  const consumed = [...cited].filter((n) => CONCRETE_JOERN_NODES.has(n));
  const rejected = REJECTED_JOERN_NODES;

  test('every REJECTED_JOERN_NODES entry names a real, concrete Joern node', () => {
    expect(rejected.filter((name) => !CONCRETE_JOERN_NODES.has(name))).toEqual([]);
  });

  test('no name is both cited (adopted/renamed) and rejected', () => {
    const overlap = consumed.filter((n) => rejected.includes(n));
    expect(overlap).toEqual([]);
  });

  test('no name is rejected twice', () => {
    expect(new Set(rejected).size).toBe(rejected.length);
  });

  test('every concrete Joern node is accounted for exactly once', () => {
    const accounted = new Set([...consumed, ...rejected]);
    const missing = [...CONCRETE_JOERN_NODES].filter((n) => !accounted.has(n));
    expect(missing).toEqual([]);
    expect(accounted.size).toBe(CONCRETE_JOERN_NODES.size);
  });
});

describe('edge exhaustiveness', () => {
  const cited = new Set(Object.values(EDGE_CITATIONS));
  // IMPORTS is cited as our IMPORTS edge's Joern analogue but is unpublished
  // (Hidden.scala) — not in the vendored edge set, consumes nothing here.
  const consumed = [...cited].filter((n) => JOERN_EDGES.has(n));
  const rejected = REJECTED_JOERN_EDGES;

  test('every REJECTED_JOERN_EDGES entry names a real Joern edge', () => {
    expect(rejected.filter((name) => !JOERN_EDGES.has(name))).toEqual([]);
  });

  test('no name is both cited (adopted/renamed) and rejected', () => {
    const overlap = consumed.filter((n) => rejected.includes(n));
    expect(overlap).toEqual([]);
  });

  test('no name is rejected twice', () => {
    expect(new Set(rejected).size).toBe(rejected.length);
  });

  test('every Joern edge is accounted for exactly once', () => {
    const accounted = new Set([...consumed, ...rejected]);
    const missing = [...JOERN_EDGES].filter((n) => !accounted.has(n));
    expect(missing).toEqual([]);
    expect(accounted.size).toBe(JOERN_EDGES.size);
  });
});

describe('the two unpublished citations are exactly IMPORT/IMPORTS', () => {
  test('every cited Joern name absent from the vendored spec is IMPORT or IMPORTS', () => {
    const allCited = new Set([...Object.values(NODE_CITATIONS), ...Object.values(EDGE_CITATIONS)]);
    const unpublished = [...allCited].filter(
      (n) => !CONCRETE_JOERN_NODES.has(n) && !JOERN_EDGES.has(n),
    );
    expect(new Set(unpublished)).toEqual(new Set(['IMPORT', 'IMPORTS']));
    expect(unpublished).toHaveLength(2);
  });
});
