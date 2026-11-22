import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyGraphDelta, type GraphDelta, type GraphPayload } from './index';

// Small id alphabet so removals and re-adds actually collide with existing ids.
const id = fc.constantFrom('a', 'b', 'c', 'd', 'e');
const node = fc.record({ id, type: fc.constant('file') });
const edge = fc.record({ source: id, target: id });
const payload: fc.Arbitrary<GraphPayload> = fc.record({
  nodes: fc.array(node, { maxLength: 8 }),
  edges: fc.array(edge, { maxLength: 8 }),
});
const delta: fc.Arbitrary<GraphDelta> = fc.record({
  addedNodes: fc.array(node, { maxLength: 4 }),
  addedEdges: fc.array(edge, { maxLength: 4 }),
  removedNodeIds: fc.array(id, { maxLength: 4 }),
});

describe('applyGraphDelta properties', () => {
  it('never leaves a surviving original node or edge touching a removed id', () => {
    fc.assert(
      fc.property(payload, delta, (p, d) => {
        const removed = new Set(d.removedNodeIds);
        const out = applyGraphDelta(p, d);
        const survivors = out.nodes.slice(0, out.nodes.length - d.addedNodes.length);
        const survivingEdges = out.edges.slice(0, out.edges.length - d.addedEdges.length);
        expect(survivors.every((n) => !removed.has(n.id))).toBe(true);
        expect(survivingEdges.every((e) => !removed.has(e.source) && !removed.has(e.target))).toBe(
          true,
        );
      }),
    );
  });

  it('ends with exactly the added nodes and edges, in order', () => {
    fc.assert(
      fc.property(payload, delta, (p, d) => {
        const out = applyGraphDelta(p, d);
        expect(out.nodes.slice(out.nodes.length - d.addedNodes.length)).toEqual(d.addedNodes);
        expect(out.edges.slice(out.edges.length - d.addedEdges.length)).toEqual(d.addedEdges);
      }),
    );
  });

  it('is pure: arguments are not mutated', () => {
    fc.assert(
      fc.property(payload, delta, (p, d) => {
        const before = JSON.stringify([p, d]);
        applyGraphDelta(p, d);
        expect(JSON.stringify([p, d])).toBe(before);
      }),
    );
  });

  it('an empty delta is the identity', () => {
    fc.assert(
      fc.property(payload, (p) => {
        expect(applyGraphDelta(p, { addedNodes: [], addedEdges: [], removedNodeIds: [] })).toEqual(
          p,
        );
      }),
    );
  });
});
