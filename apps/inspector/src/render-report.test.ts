// The counts render-reconciliation compares (C-EXT I-10; owner decision 12a; 08-verification §3.1:
// `renderedNodeCount === payload.nodes.length`). Duplicate ids must FAIL that comparison, never be
// absorbed, so a duplicate counts once as rendered and its id is reported dropped. Edges are counted
// as the renderer keys them, (source, target, type), with the repeats reported as duplicateEdges.
// The drawn side is a fake here; graph-app.test.ts drives the real visualizer through the page.

import type { GraphEdge, GraphNode, GraphPayload } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { DROPPED_SAMPLE_CAP, renderReport, type DrawnGraph } from './render-report';

const node = (id: string): GraphNode => ({ id, type: 'FILE' });
const edge = (source: string, target: string, type?: string): GraphEdge =>
  type === undefined ? { source, target } : { source, target, type };
const payload = (nodes: readonly GraphNode[], edges: readonly GraphEdge[] = []): GraphPayload => ({
  seq: 4,
  nodes,
  edges,
});

function drawn(ids: readonly string[], edgeCount = 0): DrawnGraph {
  const set = new Set(ids);
  return { isDrawn: (id) => set.has(id), edgeCount };
}

describe('renderReport', () => {
  it('reports a fully drawn payload as reconciled', () => {
    const p = payload(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b', 'HAS_ENTRY'), edge('a', 'c', 'HAS_ENTRY')],
    );
    expect(renderReport(p, drawn(['a', 'b', 'c'], 2), 3.5)).toStrictEqual({
      payloadNodeCount: 3,
      renderedNodeCount: 3,
      renderedEdgeCount: 2,
      duplicateEdges: 0,
      droppedNodeIds: [],
      frameMs: 3.5,
    });
  });

  it('reports the empty payload as zeros', () => {
    expect(renderReport(payload([]), drawn([]), 0)).toStrictEqual({
      payloadNodeCount: 0,
      renderedNodeCount: 0,
      renderedEdgeCount: 0,
      duplicateEdges: 0,
      droppedNodeIds: [],
      frameMs: 0,
    });
  });

  it('counts an undrawn node as dropped (an unplaced parent-cycle, stop-list 46)', () => {
    const report = renderReport(payload([node('a'), node('b'), node('c')]), drawn(['a', 'b']), 1);
    expect(report.payloadNodeCount).toBe(3);
    expect(report.renderedNodeCount).toBe(2);
    expect(report.droppedNodeIds).toEqual(['c']);
  });

  it('fails reconciliation on a duplicate id: one point, the id dropped once (I-10)', () => {
    const report = renderReport(
      payload([node('a'), node('b'), node('a'), node('a')]),
      drawn(['a', 'b']),
      1,
    );
    expect(report.payloadNodeCount).toBe(4);
    expect(report.renderedNodeCount).toBe(2);
    expect(report.droppedNodeIds).toEqual(['a']);
  });

  it('lists an undrawn duplicate once and counts it nowhere as rendered', () => {
    const report = renderReport(payload([node('c'), node('c'), node('d')]), drawn(['d']), 1);
    expect(report.renderedNodeCount).toBe(1);
    expect(report.droppedNodeIds).toEqual(['c']);
  });

  it('lists dropped ids in payload order, not sorted', () => {
    const report = renderReport(
      payload([node('z'), node('k'), node('y'), node('a')]),
      drawn(['k']),
      1,
    );
    expect(report.droppedNodeIds).toEqual(['z', 'y', 'a']);
  });

  it('caps the dropped sample at DROPPED_SAMPLE_CAP = 50, keeping the first in payload order', () => {
    expect(DROPPED_SAMPLE_CAP).toBe(50);
    const ids = Array.from({ length: 60 }, (_, i) => `n${i}`);
    const report = renderReport(payload(ids.map(node)), drawn([]), 1);
    expect(report.payloadNodeCount).toBe(60);
    expect(report.renderedNodeCount).toBe(0);
    expect(report.droppedNodeIds).toEqual(ids.slice(0, 50));
  });

  // Round two (review a4): the cap trims the sample only; every later entry is still counted.
  it('keeps counting rendered nodes after the sample is full', () => {
    const undrawn = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const report = renderReport(payload([...undrawn, 'a', 'b'].map(node)), drawn(['a', 'b']), 1);
    expect(report.payloadNodeCount).toBe(62);
    expect(report.renderedNodeCount).toBe(2);
    expect(report.droppedNodeIds).toEqual(undrawn.slice(0, 50));
  });

  it('caps a sample made only of duplicates', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `n${i}`);
    const report = renderReport(payload([...ids, ...ids].map(node)), drawn(ids), 1);
    expect(report.renderedNodeCount).toBe(60);
    expect(report.droppedNodeIds).toEqual(ids.slice(0, 50));
  });

  it('keeps all 50 when exactly 50 are dropped, and counts duplicates past the cap', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `n${i}`);
    expect(renderReport(payload(ids.map(node)), drawn([]), 1).droppedNodeIds).toEqual(ids);
    const dup = renderReport(payload([...ids, ...ids].map(node)), drawn(ids), 1);
    expect(dup.renderedNodeCount).toBe(50);
    expect(dup.droppedNodeIds).toEqual(ids);
  });

  it('takes renderedEdgeCount from what was drawn, never from the payload', () => {
    const p = payload(
      [node('a'), node('b')],
      [edge('a', 'b', 'IMPORTS'), edge('a', 'ghost', 'IMPORTS')],
    );
    expect(renderReport(p, drawn(['a', 'b'], 1), 1).renderedEdgeCount).toBe(1);
    expect(renderReport(p, drawn(['a', 'b'], 7), 1).renderedEdgeCount).toBe(7);
  });

  it('counts payload edges repeating an earlier (source, target, type) as duplicateEdges (12a)', () => {
    const edges = [
      edge('a', 'b', 'IMPORTS'),
      edge('a', 'b', 'IMPORTS'),
      edge('a', 'b', 'CALLS'),
      edge('b', 'a', 'IMPORTS'),
      edge('a', 'b'),
      edge('a', 'b'),
      edge('a', 'b', 'IMPORTS'),
    ];
    expect(
      renderReport(payload([node('a'), node('b')], edges), drawn(['a', 'b'], 4), 1).duplicateEdges,
    ).toBe(3);
  });

  it('keys edges without a separator collision: a→bc and ab→c are two edges', () => {
    const edges = [
      edge('a', 'bc', 'T'),
      edge('ab', 'c', 'T'),
      edge('a:b', 'c', 'T'),
      edge('a', 'b:c', 'T'),
    ];
    expect(renderReport(payload([]), drawn([]), 1).duplicateEdges).toBe(0);
    expect(renderReport(payload([], edges), drawn([]), 1).duplicateEdges).toBe(0);
  });

  it('counts a duplicate of an undrawn (dangling) edge too', () => {
    const edges = [edge('a', 'ghost', 'IMPORTS'), edge('a', 'ghost', 'IMPORTS')];
    expect(renderReport(payload([node('a')], edges), drawn(['a'], 0), 1).duplicateEdges).toBe(1);
  });

  it('asks the drawn side only about payload ids', () => {
    const asked: string[] = [];
    const spy: DrawnGraph = {
      isDrawn: (id) => {
        asked.push(id);
        return true;
      },
      edgeCount: 0,
    };
    renderReport(payload([node('a'), node('b')], [edge('a', 'x', 'T')]), spy, 1);
    expect(asked.filter((id) => id !== 'a' && id !== 'b')).toEqual([]);
  });
});
