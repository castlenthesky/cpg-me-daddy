// graphDigest (C-SINK Q5, INV-15): order-independent, content-sensitive, self-describing.

import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from './index';
import { graphDigest } from './index';

const n = (id: string, data?: Record<string, unknown>, name?: string): GraphNode => ({
  id,
  type: 'METHOD',
  ...(name === undefined ? {} : { name }),
  ...(data === undefined ? {} : { data }),
});
const e = (source: string, target: string, type = 'CALLS'): GraphEdge => ({ source, target, type });

describe('graphDigest', () => {
  const nodes = [n('a', { x: 1, y: 'two' }), n('b')];
  const edges = [e('a', 'b'), e('b', 'a')];
  const base = graphDigest({ nodes, edges });

  it('is spelled fnv1a32:<8 hex>', () => {
    expect(base).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
  });

  it('ignores node order, edge order and data key order', () => {
    const reordered = [n('b'), n('a', { y: 'two', x: 1 })];
    expect(graphDigest({ nodes: reordered, edges: edges.toReversed() })).toBe(base);
  });

  it.each([
    ['a data value', { nodes: [n('a', { x: 2, y: 'two' }), n('b')], edges }],
    ['a data key', { nodes: [n('a', { x: 1, z: 'two' }), n('b')], edges }],
    ['a node type', { nodes: [{ ...n('a', { x: 1, y: 'two' }), type: 'CALL' }, n('b')], edges }],
    ['a node name', { nodes: [n('a', { x: 1, y: 'two' }, 'shown'), n('b')], edges }],
    ['an edge type', { nodes, edges: [e('a', 'b', 'IMPORTS'), e('b', 'a')] }],
    ['an edge direction', { nodes, edges: [e('a', 'b'), e('a', 'b')] }],
    ['a missing edge', { nodes, edges: [e('a', 'b')] }],
    ['an edge data value', { nodes, edges: [{ ...e('a', 'b'), data: { w: 1 } }, e('b', 'a')] }],
    ['a missing node', { nodes: [n('b')], edges }],
  ])('changes when %s changes', (_label, graph) => {
    expect(graphDigest(graph)).not.toBe(base);
  });

  it('tells a value from its string spelling and the empty graph from a one-node graph', () => {
    expect(graphDigest({ nodes: [n('a', { x: 1 })], edges: [] })).not.toBe(
      graphDigest({ nodes: [n('a', { x: '1' })], edges: [] }),
    );
    expect(graphDigest({ nodes: [], edges: [] })).not.toBe(
      graphDigest({ nodes: [n('a')], edges: [] }),
    );
  });
});
