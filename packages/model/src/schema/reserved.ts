/**
 * Edge types reserved by name AND shape but not admitted (DQ-09). Nothing may emit one before its
 * `admittedAt` unit; admission MOVES the entry into `EDGE_TYPES` (edges.ts), adds `firstWrittenIn`
 * and bumps `CPG_SCHEMA.version`. This is the only non-test source file allowed to name a reserved
 * type (the no-emitter scan in reserved.test.ts enforces that).
 *
 * The hand-maintained `reserved_edges` block in docs/outline/04-schema.yaml documents the rationale;
 * a test ties its type/shape/producer/admitted_at/decision to this data.
 */
import { EVAL_TYPE_RELATION } from './enums';
import { ownedBy } from './owner';
import type { ReservedEdgeSpec } from './types';

// REAL: data only.
export const RESERVED_EDGES = [
  {
    type: 'EVAL_TYPE',
    from: ['CALL'],
    to: ['SYMBOL'],
    ownership: 'file-owned',
    write: 'delete-create',
    properties: ownedBy('code', [
      {
        name: 'relation',
        type: 'string',
        cardinality: 'one',
        enumValues: EVAL_TYPE_RELATION,
        golden: 'include',
        doc: 'How the call relates to the target type: the type of its receiver.',
      },
    ]),
    producer: 'none-yet',
    admittedAt: 'U8',
    decision: 'DQ-09',
    doc: 'Receiver-typed call -> the SYMBOL of the receiver type. Cross-file answer for a receiver (C-RESOLVE rule 18).',
  },
] as const satisfies readonly ReservedEdgeSpec[];

const RESERVED_BY_TYPE = new Map<string, ReservedEdgeSpec>(RESERVED_EDGES.map((e) => [e.type, e]));

/** The reserved (not admitted) edge type names. Disjoint from `EdgeType`. */
export type ReservedEdgeType = (typeof RESERVED_EDGES)[number]['type'];

/**
 * The reservation for a type, or `undefined` when it is not reserved (admitted or unknown).
 * Case-sensitive. Backed by a module-level Map built from RESERVED_EDGES, mirroring
 * `EDGE_BY_TYPE` / `edgeSpec` in schema.ts.
 */
export function reservedEdgeSpec(type: string): ReservedEdgeSpec | undefined {
  return RESERVED_BY_TYPE.get(type);
}
