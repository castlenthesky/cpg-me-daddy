import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyGraphDelta,
  nodeSpec,
  toWorkspacePath,
  type GraphDelta,
  type GraphNode,
  type GraphPayload,
  type PropertyOwner,
} from './index';

// Small id alphabet so removals and re-adds actually collide with existing ids.
const id: fc.Arbitrary<string> = fc.constantFrom('a', 'b', 'c', 'd', 'e');
const nodeLabel = fc.constantFrom('FILE', 'DIRECTORY', 'METHOD', 'SYMBOL', 'x-unknown');
// FILE filesystem keys, FILE code keys, and one key the schema does not declare.
const dataKey = fc.constantFrom('path', 'content_hash', 'language', 'interface_hash', 'loc', 'zz');
const data = fc.dictionary(dataKey, fc.integer({ min: 0, max: 3 }), { maxKeys: 4 });
const node: fc.Arbitrary<GraphNode> = fc.record(
  { id, type: nodeLabel, name: fc.constantFrom('n1', 'n2'), data },
  { requiredKeys: ['id', 'type'] },
);
const edge = fc.record({ source: id, target: id });
const producer = fc.constantFrom<PropertyOwner>('filesystem', 'code');
const file = toWorkspacePath('/w', '/w/a.ts');

const payload: fc.Arbitrary<GraphPayload> = fc.record({
  seq: fc.integer({ min: -1, max: 5 }),
  nodes: fc.array(node, { maxLength: 8 }),
  edges: fc.array(edge, { maxLength: 8 }),
});
/** A payload whose node ids are unique (the invariant M-UNIQ starts from). */
const uniquePayload = payload.map((p) => ({
  ...p,
  nodes: p.nodes.filter((n, i) => p.nodes.findIndex((m) => m.id === n.id) === i),
}));
const deltaAt = (seqOf: (p: GraphPayload) => number) => (p: GraphPayload) =>
  fc.record({
    seq: fc.constant(seqOf(p)),
    file: fc.constant(file),
    revision_id: fc.constant('r'),
    producer,
    addedNodes: fc.array(node, { maxLength: 4 }),
    addedEdges: fc.array(edge, { maxLength: 4 }),
    removedNodeIds: fc.array(id, { maxLength: 4 }),
  });
/** Pairs (payload, delta) whose seq is exactly payload.seq + 1, so the body is evaluated. */
const pair = payload.chain((p) => fc.tuple(fc.constant(p), deltaAt((q) => q.seq + 1)(p)));
const uniquePair = uniquePayload.chain((p) =>
  fc.tuple(fc.constant(p), deltaAt((q) => q.seq + 1)(p)),
);

/** Independent oracle for the owner of `key` on `label` (D2/D3), built from the schema registry. */
function ownerOf(label: string, key: string): PropertyOwner | undefined {
  const spec = nodeSpec(label);
  if (spec === undefined) return undefined;
  const declared = spec.properties.find((p) => p.name === key);
  if (declared !== undefined) return declared.owner;
  return spec.ownership === 'filesystem' ? 'filesystem' : 'code';
}

// Throws on any non-applied outcome so a property cannot pass vacuously on two rejections.
const step = (
  p: GraphPayload,
  prod: PropertyOwner,
  d: Record<string, unknown>,
  name?: string,
): GraphPayload => {
  const out = unwrap(p, {
    seq: p.seq + 1,
    file,
    revision_id: 'r',
    producer: prod,
    addedNodes: [{ id: 'f', type: 'FILE', ...(name === undefined ? {} : { name }), data: d }],
    addedEdges: [],
    removedNodeIds: [],
  });
  if (out === undefined) throw new Error('step: delta was not applied');
  return out;
};

function unwrap(p: GraphPayload, d: GraphDelta): GraphPayload | undefined {
  const r = applyGraphDelta(p, d);
  return r.outcome === 'applied' ? r.payload : undefined;
}

describe('applyGraphDelta properties', () => {
  it('M-SEQ: the outcome is a trichotomy on delta.seq vs payload.seq', () => {
    fc.assert(
      fc.property(
        payload,
        fc.oneof(fc.integer({ min: -4, max: 9 }), fc.constantFrom(Number.NaN, 1.5, Infinity)),
        (p, seq) => {
          const r = applyGraphDelta(p, {
            seq,
            file,
            revision_id: 'r',
            producer: 'code',
            addedNodes: [],
            addedEdges: [],
            removedNodeIds: [],
          });
          const expected =
            seq <= p.seq
              ? { outcome: 'already-applied', sameReference: true }
              : seq === p.seq + 1
                ? { outcome: 'applied' }
                : { outcome: 'gap', expected: p.seq + 1, got: seq };
          const actual =
            r.outcome === 'already-applied'
              ? { outcome: r.outcome, sameReference: r.payload === p }
              : r.outcome === 'gap'
                ? { outcome: r.outcome, expected: r.expected, got: r.got }
                : { outcome: r.outcome };
          expect(actual).toEqual(expected);
        },
      ),
    );
  });

  it('M-ATOM: no outcome mutates either argument, and gap/malformed return no payload', () => {
    const scenario = fc
      .tuple(payload, fc.integer({ min: -2, max: 2 }), producer)
      .chain(([p, offset, prod]) =>
        fc.tuple(fc.constant(p), deltaAt((q) => q.seq + 1 + offset)(p), fc.constant(prod)),
      );
    fc.assert(
      fc.property(scenario, ([p, d0, prod]) => {
        const d = { ...d0, producer: prod };
        const before = JSON.stringify([p, d]);
        const r = applyGraphDelta(p, d);
        expect(JSON.stringify([p, d])).toBe(before);
        expect(r.outcome === 'gap' || r.outcome === 'malformed' ? 'payload' in r : false).toBe(
          false,
        );
      }),
      { numRuns: 300 },
    );
  });

  it('M-UNIQ: unique ids in, applied, unique ids out (the L-01 duplicate cannot recur)', () => {
    fc.assert(
      fc.property(uniquePair, ([p, d]) => {
        const out = unwrap(p, d);
        fc.pre(out !== undefined);
        const ids = (out?.nodes ?? []).map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      { numRuns: 500 },
    );
  });

  it('M-OWN: after a re-add, the producer tier keys come from incoming, the rest from existing', () => {
    fc.assert(
      fc.property(node, node, producer, (existing, incoming0, prod) => {
        // Same id and same known type so the re-add is a merge candidate.
        const incoming: GraphNode = { ...incoming0, id: existing.id, type: existing.type };
        const spec = nodeSpec(existing.type);
        fc.pre(spec !== undefined);
        // D7: re-adding a non-merge-on-key label from its home tier is malformed (covered by M-MAL).
        // Keep merge-on-key labels, and cross-tier re-adds of any label (D8: nothing changes).
        const home = spec.ownership === 'filesystem' ? 'filesystem' : 'code';
        fc.pre(spec.write === 'merge-on-key' || prod !== home);
        const r = applyGraphDelta(
          { seq: 0, nodes: [existing], edges: [] },
          {
            seq: 1,
            file,
            revision_id: 'r',
            producer: prod,
            addedNodes: [incoming],
            addedEdges: [],
            removedNodeIds: [],
          },
        );
        // Same id, same known type, no edges, and the preconditions above: never malformed.
        expect(r.outcome).toBe('applied');
        if (r.outcome !== 'applied') return;
        const out = r.payload.nodes[0]?.data ?? {};
        const keys = new Set([
          ...Object.keys(existing.data ?? {}),
          ...Object.keys(incoming.data ?? {}),
        ]);
        for (const key of keys) {
          const src = ownerOf(existing.type, key) === prod ? incoming : existing;
          const want = (src.data ?? {})[key];
          // Absent in the source tier => absent in the result (a tier can retract its own key).
          expect(key in out ? out[key] : undefined).toBe(want);
        }
        // GraphNode.name follows the label's `name` property owner (D1).
        const nameSrc = ownerOf(existing.type, 'name') === prod ? incoming : existing;
        expect(r.payload.nodes[0]?.name).toBe(nameSrc.name);
        // D6 strict: a tier that omits name retracts the key, it is not left as `name: undefined`.
        expect('name' in (r.payload.nodes[0] ?? {})).toBe(nameSrc.name !== undefined);
      }),
      { numRuns: 500 },
    );
  });

  it('M-COMMUTE: for an existing FILE, filesystem-then-code equals code-then-filesystem', () => {
    const fileData = fc.dictionary(
      fc.constantFrom('path', 'content_hash', 'language', 'interface_hash', 'loc', 'version'),
      fc.integer({ min: 0, max: 3 }),
    );
    fc.assert(
      fc.property(
        fileData,
        fileData,
        fileData,
        fc.option(fc.constantFrom('n1', 'n2'), { nil: undefined }),
        (base, fsData, codeData, fsName) => {
          const start: GraphPayload = {
            seq: 0,
            nodes: [{ id: 'f', type: 'FILE', data: base }],
            edges: [],
          };
          const a = step(step(start, 'filesystem', fsData, fsName), 'code', codeData);
          const b = step(step(start, 'code', codeData), 'filesystem', fsData, fsName);
          expect(a.nodes[0]?.data).toEqual(b.nodes[0]?.data);
          // FILE.name is filesystem-owned, so it commutes too.
          expect(a.nodes[0]?.name).toBe(b.nodes[0]?.name);
          expect(a.nodes[0]?.name).toBe(fsName);
        },
      ),
    );
  });

  it('M-REM: removed ids do not survive from the input, and no pre-existing edge touches one', () => {
    fc.assert(
      fc.property(pair, ([p, d0]) => {
        // No re-adds, so any surviving removed id would be a bug.
        const d = { ...d0, addedNodes: [], addedEdges: [] };
        const out = unwrap(p, d);
        expect(out).toBeDefined();
        const removed = new Set(d.removedNodeIds);
        expect(out?.nodes.some((n) => removed.has(n.id))).toBe(false);
        expect(out?.edges.some((e) => removed.has(e.source) || removed.has(e.target))).toBe(false);
        // and nothing else is lost
        expect(out?.nodes).toEqual(p.nodes.filter((n) => !removed.has(n.id)));
        expect(out?.edges).toEqual(
          p.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)),
        );
      }),
    );
  });

  it('M-ORDER: survivors keep order, merged-in-place nodes keep their index, new ids append in delta order', () => {
    fc.assert(
      fc.property(uniquePair, ([p, d]) => {
        const out = unwrap(p, d);
        fc.pre(out !== undefined);
        const removed = new Set(d.removedNodeIds);
        const survivors = p.nodes.filter((n) => !removed.has(n.id)).map((n) => n.id);
        const newIds: string[] = [];
        for (const n of d.addedNodes) {
          if (!survivors.includes(n.id) && !newIds.includes(n.id)) newIds.push(n.id);
        }
        expect((out?.nodes ?? []).map((n) => n.id)).toEqual([...survivors, ...newIds]);
        expect(out?.edges.slice(out.edges.length - d.addedEdges.length)).toEqual(d.addedEdges);
      }),
      { numRuns: 500 },
    );
  });

  it('M-MAL: malformed exactly when a delete-create/same-home-tier re-add or a type conflict exists', () => {
    fc.assert(
      fc.property(uniquePair, ([p, d]) => {
        const removed = new Set(d.removedNodeIds);
        const live = new Map(p.nodes.filter((n) => !removed.has(n.id)).map((n) => [n.id, n.type]));
        const expected: Array<{ code: string; nodeId: string }> = [];
        for (const n of d.addedNodes) {
          const existingType = live.get(n.id);
          if (existingType !== undefined) {
            const spec = nodeSpec(n.type);
            if (existingType !== n.type) {
              expected.push({ code: 'type-conflict', nodeId: n.id });
            } else if (spec !== undefined && spec.write !== 'merge-on-key') {
              const home = spec.ownership === 'filesystem' ? 'filesystem' : 'code';
              if (d.producer === home)
                expected.push({ code: 'readd-without-removal', nodeId: n.id });
            }
          }
          if (!live.has(n.id)) live.set(n.id, n.type);
        }
        const r = applyGraphDelta(p, d);
        expect(r.outcome === 'applied' ? [] : r.outcome === 'malformed' ? r.defects : r).toEqual(
          expected,
        );
      }),
      { numRuns: 500 },
    );
  });

  it('M-UNKNOWN: an unknown label never yields a defect other than type-conflict', () => {
    fc.assert(
      fc.property(pair, ([p, d]) => {
        const r = applyGraphDelta(
          { ...p, nodes: p.nodes.map((n) => ({ ...n, type: 'x-unknown' })) },
          { ...d, addedNodes: d.addedNodes.map((n) => ({ ...n, type: 'x-unknown' })) },
        );
        expect(r.outcome).toBe('applied');
      }),
    );
  });

  it('an empty delta applies with nodes and edges deep-equal to the input and seq + 1', () => {
    fc.assert(
      fc.property(payload, (p) => {
        const r = applyGraphDelta(p, {
          seq: p.seq + 1,
          file,
          revision_id: 'r',
          producer: 'code',
          addedNodes: [],
          addedEdges: [],
          removedNodeIds: [],
        });
        expect(r).toEqual({ outcome: 'applied', payload: { ...p, seq: p.seq + 1 } });
      }),
    );
  });
});
