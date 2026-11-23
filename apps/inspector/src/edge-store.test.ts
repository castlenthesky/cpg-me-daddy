// The edge store (BMO-35 line 2, "edge store"; the archive's edgesByKey + rebuildLinks + pushLinks,
// 21754b4:packages/graph-visualizer/src/visualizer.ts:19-21, :383-437, :629-637). One edge per
// (source, target, type); links are rebuilt from the set, never appended (the archive's
// append-vs-rebuild gotcha); an edge dies with either endpoint; a link's width is
// linkWidthForSizes of its endpoints, (a + b) / 2 * 0.2.

import type { GraphEdge } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { EdgeStore, edgeKey, visibleLinks, type LinkBuffers } from './edge-store';

const edge = (source: string, target: string, type?: string): GraphEdge =>
  type === undefined ? { source, target } : { source, target, type };

/** An index lookup over fixed ids, standing in for the buffer store. */
function indexer(...ids: string[]): (id: string) => number | undefined {
  const at = new Map(ids.map((id, index) => [id, index]));
  return (id) => at.get(id);
}

const pairs = (buffers: LinkBuffers): number[] => Array.from(buffers.links);

describe('edgeKey', () => {
  it('is equal for the same source, target and type, and differs when any of them does', () => {
    expect(edgeKey(edge('a', 'b', 'CALLS'))).toBe(edgeKey(edge('a', 'b', 'CALLS')));
    expect(edgeKey(edge('a', 'b', 'CALLS'))).not.toBe(edgeKey(edge('a', 'b', 'IMPORTS')));
    expect(edgeKey(edge('a', 'b', 'CALLS'))).not.toBe(edgeKey(edge('b', 'a', 'CALLS')));
    expect(edgeKey(edge('a', 'b'))).not.toBe(edgeKey(edge('a', 'b', 'CALLS')));
  });

  it('keeps ids apart that only concatenate alike (the archive joined them with NUL bytes)', () => {
    expect(edgeKey(edge('a', 'bc', 'X'))).not.toBe(edgeKey(edge('ab', 'c', 'X')));
    expect(edgeKey(edge('a', 'b', 'cX'))).not.toBe(edgeKey(edge('a', 'bc', 'X')));
  });
});

describe('EdgeStore', () => {
  it('holds one edge per key, while two types between one pair stay two edges', () => {
    const store = new EdgeStore();
    store.replace([
      edge('a', 'b', 'HAS_ENTRY'),
      edge('a', 'b', 'HAS_ENTRY'),
      edge('a', 'b', 'CALLS'),
    ]);
    expect(store.size).toBe(2);
    expect(pairs(store.build(indexer('a', 'b'), [20, 10]))).toEqual([0, 1, 0, 1]);
  });

  it('draws a→bc and ab→c as two links', () => {
    const store = new EdgeStore();
    store.replace([edge('a', 'bc', 'X'), edge('ab', 'c', 'X')]);
    expect(pairs(store.build(indexer('a', 'bc', 'ab', 'c'), [1, 1, 1, 1]))).toEqual([0, 1, 2, 3]);
  });

  it('builds links in insertion order, with widths from the endpoint sizes and the source edges', () => {
    const store = new EdgeStore();
    const bc = edge('b', 'c', 'X');
    const ab = edge('a', 'b', 'Y');
    store.replace([bc, ab]);
    const built = store.build(indexer('a', 'b', 'c'), [20, 10, 4]);
    expect(built.links).toEqual(Float32Array.from([1, 2, 0, 1]));
    expect(built.linkWidths).toEqual(
      Float32Array.from([((10 + 4) / 2) * 0.2, ((20 + 10) / 2) * 0.2]),
    );
    expect(built.linkEdges).toHaveLength(2);
    expect(built.linkEdges[0]).toBe(bc);
    expect(built.linkEdges[1]).toBe(ab);
  });

  it('draws a self-loop as a pair on one point', () => {
    const store = new EdgeStore();
    store.replace([edge('a', 'a', 'CALLS')]);
    expect(pairs(store.build(indexer('a'), [8]))).toEqual([0, 0]);
  });

  it('skips an edge whose endpoint has no index, keeps it, and draws it once the endpoint arrives', () => {
    const store = new EdgeStore();
    store.replace([edge('a', 'z', 'CALLS'), edge('a', 'b', 'HAS_ENTRY')]);
    expect(store.size).toBe(2);
    expect(pairs(store.build(indexer('a', 'b'), [1, 1]))).toEqual([0, 1]);
    expect(pairs(store.build(indexer('a', 'b', 'z'), [1, 1, 1]))).toEqual([0, 2, 0, 1]);
  });

  it('replace discards the previous set', () => {
    const store = new EdgeStore();
    store.replace([edge('a', 'b', 'X'), edge('b', 'c', 'X')]);
    store.replace([edge('c', 'a', 'X')]);
    expect(store.size).toBe(1);
    expect(pairs(store.build(indexer('a', 'b', 'c'), [1, 1, 1]))).toEqual([2, 0]);
  });

  it('apply drops every edge touching a removed id, as source or as target', () => {
    const store = new EdgeStore();
    store.replace([edge('a', 'b', 'X'), edge('b', 'c', 'X'), edge('a', 'c', 'X')]);
    store.apply(['b'], []);
    expect(store.size).toBe(1);
    expect(pairs(store.build(indexer('a', 'b', 'c'), [1, 1, 1]))).toEqual([0, 2]);
  });

  it('apply appends new edges and never duplicates one it already holds', () => {
    const store = new EdgeStore();
    store.replace([edge('a', 'b', 'X'), edge('b', 'c', 'X')]);
    const delta = [edge('a', 'b', 'X'), edge('c', 'a', 'Y')];
    store.apply([], delta);
    store.apply([], delta);
    expect(store.size).toBe(3);
    // a→b keeps its first position; c→a is appended once.
    expect(pairs(store.build(indexer('a', 'b', 'c'), [1, 1, 1]))).toEqual([0, 1, 1, 2, 2, 0]);
  });

  it('apply removes before it adds, so an edge re-added with its removed endpoint survives', () => {
    const store = new EdgeStore();
    store.replace([edge('a', 'b', 'X'), edge('b', 'c', 'X')]);
    store.apply(['b'], [edge('a', 'b', 'X')]);
    expect(store.size).toBe(1);
    expect(pairs(store.build(indexer('a', 'b', 'c'), [1, 1, 1]))).toEqual([0, 1]);
  });
});

describe('visibleLinks', () => {
  const entry = edge('a', 'b', 'HAS_ENTRY');
  const calls = edge('b', 'c', 'CALLS');
  const untyped = edge('c', 'a');
  function built(): LinkBuffers {
    const store = new EdgeStore();
    store.replace([entry, calls, untyped]);
    return store.build(indexer('a', 'b', 'c'), [20, 10, 4]);
  }

  it('is every link while nothing is hidden', () => {
    const all = built();
    const visible = visibleLinks(all, new Set());
    expect(visible.links).toEqual(all.links);
    expect(visible.linkWidths).toEqual(all.linkWidths);
    expect(visible.linkEdges).toEqual(all.linkEdges);
  });

  it('drops a hidden relationship type, keeping pairs, widths and edges parallel', () => {
    const all = built();
    const visible = visibleLinks(all, new Set(['HAS_ENTRY']));
    expect(Array.from(visible.links)).toEqual([1, 2, 2, 0]);
    expect(visible.linkWidths).toEqual(
      Float32Array.from([((10 + 4) / 2) * 0.2, ((4 + 20) / 2) * 0.2]),
    );
    expect(visible.linkEdges).toEqual([calls, untyped]);
    expect(Array.from(all.links)).toEqual([0, 1, 1, 2, 2, 0]);
  });

  it("hides untyped edges under the '' bucket and nothing else", () => {
    const visible = visibleLinks(built(), new Set(['']));
    expect(visible.linkEdges).toEqual([entry, calls]);
    expect(Array.from(visible.links)).toEqual([0, 1, 1, 2]);
  });
});
