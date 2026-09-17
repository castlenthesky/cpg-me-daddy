import { describe, expect, it } from 'vitest';
import {
  applyGraphDelta,
  edgeResolution,
  nodeLocation,
  nodeResolution,
  type GraphDelta,
  type GraphPayload,
} from './index';

const empty: GraphPayload = { nodes: [], edges: [] };

function payload(nodeIds: string[], edges: Array<[string, string]>): GraphPayload {
  return {
    nodes: nodeIds.map((id) => ({ id, type: 'file' })),
    edges: edges.map(([source, target]) => ({ source, target, type: 'HAS_ENTRY' })),
  };
}

function delta(partial: Partial<GraphDelta>): GraphDelta {
  return { addedNodes: [], addedEdges: [], removedNodeIds: [], ...partial };
}

describe('applyGraphDelta', () => {
  it('adds nodes and edges', () => {
    const next = applyGraphDelta(empty, delta({ addedNodes: [{ id: 'a', type: 'file' }] }));
    expect(next.nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('drops edges touching a removed node without the producer enumerating them', () => {
    // This is the contract that lets GraphDelta omit removedEdgeIds entirely.
    const before = payload(['dir', 'a', 'b'], [
      ['dir', 'a'],
      ['dir', 'b'],
    ]);
    const next = applyGraphDelta(before, delta({ removedNodeIds: ['a'] }));

    expect(next.nodes.map((n) => n.id)).toEqual(['dir', 'b']);
    expect(next.edges).toEqual([{ source: 'dir', target: 'b', type: 'HAS_ENTRY' }]);
  });

  it('drops an edge whose SOURCE was removed, not just its target', () => {
    const before = payload(['a', 'b'], [['a', 'b']]);
    expect(applyGraphDelta(before, delta({ removedNodeIds: ['a'] })).edges).toEqual([]);
  });

  it('does not mutate its arguments', () => {
    const before = payload(['a'], []);
    const snapshot = JSON.stringify(before);
    applyGraphDelta(before, delta({ addedNodes: [{ id: 'b', type: 'file' }], removedNodeIds: ['a'] }));
    expect(JSON.stringify(before)).toEqual(snapshot);
  });

  // CHARACTERIZATION TEST — asserts the hazard, not an aspiration.
  //
  // This is the delta-protocol shape of the historical reconciler bug: two
  // producers disagreed about a node's identity, real files kept looking
  // "missing", and duplicates accumulated on every reconciliation pass. Here
  // the merge is a plain concat, so re-adding an id WITHOUT removing it first
  // silently duplicates. Any producer emitting updates must pair the add with
  // a removal. If we ever make the merge dedup by id, this test should fail
  // loudly rather than the change landing unnoticed.
  it('DUPLICATES a re-added node id when the producer omits the removal', () => {
    const before = payload(['a'], []);
    const next = applyGraphDelta(before, delta({ addedNodes: [{ id: 'a', type: 'file', name: 'updated' }] }));

    expect(next.nodes).toHaveLength(2);
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'a']);
  });

  it('an update expressed as remove-then-add yields exactly one node', () => {
    const before = payload(['a'], []);
    const next = applyGraphDelta(
      before,
      delta({ removedNodeIds: ['a'], addedNodes: [{ id: 'a', type: 'file', name: 'updated' }] }),
    );

    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.name).toEqual('updated');
  });
});

describe('nodeLocation', () => {
  const range = { startRow: 1, startColumn: 0, endRow: 3, endColumn: 1 };

  it('reads a well-formed location', () => {
    const got = nodeLocation({ id: 'a', type: 'METHOD', data: { location: { filePath: '/x.ts', range } } });
    expect(got).toEqual({ filePath: '/x.ts', range });
  });

  it('carries nameRange when present, since range alone lands the caret one token short', () => {
    const nameRange = { startRow: 1, startColumn: 9, endRow: 1, endColumn: 12 };
    const got = nodeLocation({ id: 'a', type: 'METHOD', data: { location: { filePath: '/x.ts', range, nameRange } } });
    expect(got?.nameRange).toEqual(nameRange);
  });

  it.each([
    ['no data at all', { id: 'a', type: 'directory' }],
    ['no location key', { id: 'a', type: 'file', data: {} }],
    ['location is null', { id: 'a', type: 'file', data: { location: null } }],
    ['filePath is not a string', { id: 'a', type: 'file', data: { location: { filePath: 7, range } } }],
    ['range is malformed', { id: 'a', type: 'file', data: { location: { filePath: '/x.ts', range: { startRow: 1 } } } }],
  ])('returns undefined rather than throwing: %s', (_label, node) => {
    expect(nodeLocation(node as never)).toBeUndefined();
  });
});

describe('resolution accessors', () => {
  it('reads resolution off a node, which is how an ABSENT edge explains itself', () => {
    // The interesting cases have no edge at all — a builtin, or a reference
    // nothing could resolve. Edge-only provenance cannot describe those.
    const got = nodeResolution({
      id: 'call:1',
      type: 'CALL',
      data: { resolution: { status: 'external', resolvedBy: 'python-path', reason: 'stdlib' } },
    });
    expect(got).toEqual({ status: 'external', resolvedBy: 'python-path', reason: 'stdlib' });
  });

  it('reads resolution off an edge', () => {
    const got = edgeResolution({
      source: 'a',
      target: 'b',
      data: { resolution: { status: 'resolved', resolvedBy: 'lsp', confidence: 0.9 } },
    });
    expect(got).toEqual({ status: 'resolved', resolvedBy: 'lsp', confidence: 0.9 });
  });

  it('requires both status and resolvedBy, so provenance is never half-recorded', () => {
    expect(edgeResolution({ source: 'a', target: 'b', data: { resolution: { status: 'resolved' } } })).toBeUndefined();
    expect(edgeResolution({ source: 'a', target: 'b', data: { resolution: { resolvedBy: 'lsp' } } })).toBeUndefined();
  });

  it('accepts a status string this package has never heard of', () => {
    // Deliberate: a producer emitting a new status must degrade to "unknown
    // status", not fail to typecheck across a package boundary.
    expect(edgeResolution({ source: 'a', target: 'b', data: { resolution: { status: 'speculative', resolvedBy: 'x' } } }))
      .toEqual({ status: 'speculative', resolvedBy: 'x' });
  });
});
