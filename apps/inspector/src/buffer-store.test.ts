// The buffer store (BMO-35 line 2, "buffer store"; the archive's per-point state in
// 21754b4:packages/graph-visualizer/src/visualizer.ts:79-125, :532-671). Hand-built layouts keep
// every number derivable: delta jitter is (random() - 0.5) * 2 * LINK_DISTANCE (20) on x then y,
// a seeded size is 0.88 x the parent's (floor 4), an unlocatable parent means the space centre
// (2048, 2048) and 0.88 x ROOT_POINT_SIZE (20) = 17.6. Sizes are float32, hence toBeCloseTo.

import type { GraphEdge, GraphNode, GraphPayload } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { BufferStore, deltaParents } from './buffer-store';
import { DEFAULT_PARENT_TABLE, type LayoutResult, type ParentTable } from './layout';
import { REGISTRY_NODE_COLORS } from './node-types';

const GREY = [0.6, 0.6, 0.6, 1];
const FILE_RGBA = [77 / 255, 179 / 255, 1, 1];
const DIRECTORY_RGBA = [1, 153 / 255, 51 / 255, 1];
// Stop-list 186 (U6a.3-3 part 2): MODULE is registered, #B5CEA8.
const MODULE_RGBA = [181 / 255, 206 / 255, 168 / 255, 1];
const VIRTUAL_ROOT = String.fromCharCode(0) + 'inspector/virtual-root';

interface Point {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

function layoutOf(points: readonly Point[]): LayoutResult {
  return {
    positions: Float32Array.from(points.flatMap((p) => [p.x, p.y])),
    colors: Float32Array.from(points.flatMap((_, i) => [i / 10, 0.25, 0.5, 1])),
    links: new Float32Array(0),
    types: points.map((p) => p.type),
    ids: points.map((p) => p.id),
    sizes: Float32Array.from(points.map((p) => p.size)),
    linkWidths: new Float32Array(0),
  };
}

const node = (id: string, type = 'FILE', name?: string): GraphNode =>
  name === undefined ? { id, type } : { id, type, name };
const edge = (source: string, target: string, type?: string): GraphEdge =>
  type === undefined ? { source, target } : { source, target, type };
const payloadOf = (nodes: GraphNode[]): GraphPayload => ({ seq: 0, nodes, edges: [] });

const D = node('d', 'DIRECTORY');
const F = node('f', 'FILE', 'f.ts');
const G = node('g', 'FILE', 'g.ts');
const U = node('u', 'FILE');

/** d (100, 200) size 20; f (300, 400) size 9; g (500, 600) size 9. The payload also holds an unplaced u. */
function loaded(): BufferStore {
  const store = new BufferStore();
  store.load(
    layoutOf([
      { id: 'd', type: 'DIRECTORY', x: 100, y: 200, size: 20 },
      { id: 'f', type: 'FILE', x: 300, y: 400, size: 9 },
      { id: 'g', type: 'FILE', x: 500, y: 600, size: 9 },
    ]),
    payloadOf([D, F, G, U]),
  );
  return store;
}

/** Hands out `values` in order and throws once they run out. */
function scripted(...values: number[]): () => number {
  let next = 0;
  return () => {
    const value = values[next];
    next += 1;
    if (value === undefined) throw new Error('scripted random exhausted');
    return value;
  };
}

const always =
  (value: number): (() => number) =>
  () =>
    value;

const xy = (store: BufferStore, index: number): number[] =>
  Array.from(store.positions.subarray(index * 2, index * 2 + 2));
const rgba = (store: BufferStore, index: number): number[] =>
  Array.from(store.colors.subarray(index * 4, index * 4 + 4));
const f32 = (values: readonly number[]): number[] => Array.from(Float32Array.from(values));
const add = (...addedNodes: GraphNode[]) => ({ addedNodes, removedNodeIds: [] });
const remove = (...removedNodeIds: string[]) => ({ addedNodes: [], removedNodeIds });

// Sprint 33 (BMO-100): deltaParents reads the layout's parent table. The first four cases are
// reworked from the HAS_ENTRY + DEFINES signature; the off-table types replace CALLS, now a row.
describe('deltaParents', () => {
  const T = DEFAULT_PARENT_TABLE;

  it('takes the first hierarchy edge, ahead of an earlier fallback or other edge', () => {
    const edges = [
      edge('p', 'x', 'CALLS'),
      edge('q', 'x', 'DEFINES'),
      edge('r', 'x', 'HAS_ENTRY'),
      edge('s', 'x', 'HAS_ENTRY'),
    ];
    expect(deltaParents(edges, T).get('x')).toBe('r');
  });

  it('falls back to the first fallback-type edge, never to the first edge of any type', () => {
    const edges = [
      edge('p', 'x', 'REACHING_DEF'),
      edge('q', 'x', 'DEFINES'),
      edge('t', 'x', 'DEFINES'),
    ];
    expect(deltaParents(edges, T).get('x')).toBe('q');
  });

  it('gives no parent without a hierarchy or fallback edge', () => {
    const edges = [edge('p', 'x', 'REACHING_DEF'), edge('p', 'x'), edge('p', 'x', 'CONTAINS')];
    expect(deltaParents(edges, T).size).toBe(0);
  });

  it("honours a custom table's rows and ends, per child", () => {
    const edges = [
      edge('a', 'x', 'HAS_ENTRY'),
      edge('b', 'x', 'CONTAINS'),
      edge('c', 'y', 'REF'),
      edge('z', 'd', 'OWNS'),
      edge('k', 'j', 'BACK'),
    ];
    // Round two (review 6): a fallback row whose parent is the target.
    const custom: ParentTable = {
      hierarchy: [
        { type: 'CONTAINS', parent: 'source' },
        { type: 'OWNS', parent: 'target' },
      ],
      fallback: [
        { type: 'REF', parent: 'source' },
        { type: 'BACK', parent: 'target' },
      ],
    };
    expect(Object.fromEntries(deltaParents(edges, custom))).toEqual({
      x: 'b',
      y: 'c',
      z: 'd',
      k: 'j',
    });
  });

  it("reads each default row's parent end: SOURCE_FILE and IN_SCOPE point at the parent", () => {
    const edges = [
      edge('d', 'f', 'HAS_ENTRY'),
      edge('m', 't', 'DECLARES'),
      edge('u', 'p', 'HAS_PARAM'),
      edge('m2', 'f2', 'SOURCE_FILE'),
      edge('c', 'u2', 'IN_SCOPE'),
      edge('t3', 's1', 'DEFINES'),
      edge('i', 's2', 'IMPORTS'),
      edge('c3', 's3', 'CALLS'),
      edge('t4', 's4', 'INHERITS_FROM'),
    ];
    expect(Object.fromEntries(deltaParents(edges, T))).toEqual({
      f: 'd',
      t: 'm',
      p: 'u',
      m2: 'f2',
      c: 'u2',
      s1: 't3',
      s2: 'i',
      s3: 'c3',
      s4: 't4',
    });
  });

  it('takes rows in table order, whatever order the delta lists the edges in', () => {
    // x has an edge of all nine rows, z of DECLARES and the three after it, w of the last three
    // fallbacks; each listed last row first, from a distinct anchor.
    const edges = [
      edge('a9', 'x', 'INHERITS_FROM'),
      edge('a8', 'x', 'CALLS'),
      edge('a7', 'x', 'IMPORTS'),
      edge('a6', 'x', 'DEFINES'),
      edge('x', 'a5', 'IN_SCOPE'),
      edge('x', 'a4', 'SOURCE_FILE'),
      edge('a3', 'x', 'HAS_PARAM'),
      edge('a2', 'x', 'DECLARES'),
      edge('a1', 'x', 'HAS_ENTRY'),
      edge('z', 'b5', 'IN_SCOPE'),
      edge('z', 'b4', 'SOURCE_FILE'),
      edge('b3', 'z', 'HAS_PARAM'),
      edge('b2', 'z', 'DECLARES'),
      edge('c4', 'w', 'INHERITS_FROM'),
      edge('c3', 'w', 'CALLS'),
      edge('c2', 'w', 'IMPORTS'),
      // Round two (review 3): each pair is listed later row first.
      edge('d6', 'v', 'DEFINES'),
      edge('v', 'd5', 'IN_SCOPE'),
      edge('q', 'e5', 'IN_SCOPE'),
      edge('q', 'e4', 'SOURCE_FILE'),
      edge('r', 'g4', 'SOURCE_FILE'),
      edge('g3', 'r', 'HAS_PARAM'),
      edge('h9', 'o', 'INHERITS_FROM'),
      edge('h8', 'o', 'CALLS'),
      edge('i7', 'y', 'IMPORTS'),
      edge('i6', 'y', 'DEFINES'),
    ];
    expect(Object.fromEntries(deltaParents(edges, T))).toEqual({
      x: 'a1',
      z: 'b2',
      w: 'c2',
      v: 'd5',
      q: 'e4',
      r: 'g3',
      o: 'h8',
      y: 'i6',
    });
  });

  // Round two (review 7): no cycle check, so a loop and a self-loop keep their parents.
  it('maps a parent loop and a self-loop as listed', () => {
    const edges = [
      edge('a', 'b', 'HAS_ENTRY'),
      edge('b', 'a', 'DEFINES'),
      edge('z', 'z', 'SOURCE_FILE'),
    ];
    expect(Object.fromEntries(deltaParents(edges, T))).toEqual({ b: 'a', a: 'b', z: 'z' });
  });
});

describe('BufferStore.load', () => {
  it('holds the layout points and resolves each to its payload node', () => {
    const store = loaded();
    expect(store.length).toBe(3);
    expect(Array.from(store.positions)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(Array.from(store.sizes)).toEqual([20, 9, 9]);
    expect(Array.from(store.colors)).toEqual(
      f32([0, 0.25, 0.5, 1, 0.1, 0.25, 0.5, 1, 0.2, 0.25, 0.5, 1]),
    );
    expect(store.nodeAt(1)).toBe(F);
    expect(store.node('g')).toBe(G);
    expect(store.liveIndex('g')).toBe(2);
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'FILE', 'FILE']);
    expect(store.nodeAt(3)).toBeUndefined();
    expect(store.nodeAt(-1)).toBeUndefined();
  });

  it('knows a payload node the layout did not place, without giving it a point', () => {
    const store = loaded();
    expect(store.node('u')).toBe(U);
    expect(store.liveIndex('u')).toBeUndefined();
  });

  it('gives the synthetic root a point but no node, no live index and no live type', () => {
    const store = new BufferStore();
    store.load(
      layoutOf([
        { id: VIRTUAL_ROOT, type: '__root__', x: 2048, y: 2048, size: 20 },
        { id: 'a', type: 'FILE', x: 1, y: 1, size: 17.6 },
      ]),
      payloadOf([node('a')]),
    );
    expect(store.length).toBe(2);
    expect(store.nodeAt(0)).toBeUndefined();
    expect(store.liveIndex(VIRTUAL_ROOT)).toBeUndefined();
    expect(store.liveTypes()).toEqual(['FILE']);
  });

  it('returns copies from its getters', () => {
    const store = loaded();
    store.positions[0] = -1;
    store.colors[0] = -1;
    store.sizes[0] = -1;
    expect(store.positions[0]).toBe(100);
    expect(store.colors[0]).toBe(0);
    expect(store.sizes[0]).toBe(20);
  });

  it('a second load replaces the first', () => {
    const store = loaded();
    const x = node('x');
    store.load(layoutOf([{ id: 'x', type: 'FILE', x: 7, y: 8, size: 20 }]), payloadOf([x]));
    expect(store.length).toBe(1);
    expect(Array.from(store.positions)).toEqual([7, 8]);
    expect(store.nodeAt(0)).toBe(x);
    expect(store.node('f')).toBeUndefined();
    expect(store.liveIndex('f')).toBeUndefined();
  });
});

describe('BufferStore.applyDelta removals', () => {
  it('tombstones a removed node at its index', () => {
    const store = loaded();
    store.applyDelta(remove('f'), new Map(), scripted());
    expect(store.length).toBe(3);
    expect(Array.from(store.positions)).toEqual([100, 200, NaN, NaN, 500, 600]);
    expect(store.nodeAt(1)).toBeUndefined();
    expect(store.node('f')).toBeUndefined();
    expect(store.liveIndex('f')).toBeUndefined();
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'FILE']);
  });

  it('ignores an id it does not hold, and forgets a removed node that had no point', () => {
    const store = loaded();
    store.applyDelta(remove('nope', 'u'), new Map(), scripted());
    expect(Array.from(store.positions)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(store.node('u')).toBeUndefined();
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'FILE', 'FILE']);
  });
});

describe('BufferStore.applyDelta additions', () => {
  it('appends a new node beside its parent, x drawn before y', () => {
    const store = loaded();
    const h = node('h');
    store.applyDelta(add(h), new Map([['h', 'f']]), scripted(0.75, 0.25));
    expect(store.length).toBe(4);
    expect(xy(store, 3)).toEqual([310, 390]);
    expect(store.sizes[3]).toBeCloseTo(9 * 0.88, 5);
    expect(rgba(store, 3)).toEqual(f32(FILE_RGBA));
    expect(store.nodeAt(3)).toBe(h);
    expect(store.liveIndex('h')).toBe(3);
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'FILE', 'FILE', 'FILE']);
  });

  it('reaches the full jitter window of one link distance either way', () => {
    const store = loaded();
    store.applyDelta(add(node('h')), new Map([['h', 'f']]), scripted(0, 0.999));
    expect(store.positions[6]).toBe(280);
    expect(store.positions[7]).toBeCloseTo(419.96, 3);
  });

  it('colours a registered type from the registry and an unregistered one grey', () => {
    const store = loaded();
    // Round two (review 2): MODULE is registered now; PARAM is not.
    store.applyDelta(add(node('m', 'PARAM'), node('e', 'DIRECTORY')), new Map(), always(0.5));
    expect(rgba(store, 3)).toEqual(f32(GREY));
    expect(rgba(store, 4)).toEqual(f32(DIRECTORY_RGBA));
  });

  it('seeds a node with no parent, or an unknown one, at the centre one level below the root', () => {
    const store = loaded();
    store.applyDelta(
      add(node('h'), node('i')),
      new Map([['i', 'nope']]),
      scripted(0.75, 0.25, 0.25, 0.75),
    );
    expect(xy(store, 3)).toEqual([2058, 2038]);
    expect(xy(store, 4)).toEqual([2038, 2058]);
    expect(store.sizes[3]).toBeCloseTo(17.6, 5);
    expect(store.sizes[4]).toBeCloseTo(17.6, 5);
  });

  it('seeds beside a parent added earlier in the same delta', () => {
    const store = loaded();
    store.applyDelta(
      add(node('h', 'DIRECTORY'), node('k')),
      new Map([['k', 'h']]),
      scripted(0.75, 0.25, 0.5, 0.75),
    );
    expect(xy(store, 3)).toEqual([2058, 2038]);
    expect(xy(store, 4)).toEqual([2058, 2048]);
    expect(store.sizes[3]).toBeCloseTo(17.6, 5);
    expect(store.sizes[4]).toBeCloseTo(17.6 * 0.88, 4);
  });

  // Sprint 33 (controller decision 85): a new point starts beside its parent whatever order the
  // delta lists them in. Every draw is 0.75, so each point sits (+10, +10) from its parent.
  it('seeds a node beside a parent the same delta lists after it', () => {
    const store = loaded();
    store.applyDelta(
      add(node('k'), node('h', 'DIRECTORY')),
      new Map([
        ['k', 'h'],
        ['h', 'f'],
      ]),
      always(0.75),
    );
    const at = (id: string): number[] => xy(store, store.liveIndex(id) ?? -1);
    expect([at('h'), at('k')]).toEqual([
      [310, 410],
      [320, 420],
    ]);
    expect(store.sizes[store.liveIndex('k') ?? -1]).toBeCloseTo(9 * 0.88 * 0.88, 4);
  });

  it('seeds a chain listed child first, each beside its parent', () => {
    const store = loaded();
    store.applyDelta(
      add(node('c3'), node('c2'), node('c1')),
      new Map([
        ['c3', 'c2'],
        ['c2', 'c1'],
        ['c1', 'f'],
      ]),
      always(0.75),
    );
    const at = (id: string): number[] => xy(store, store.liveIndex(id) ?? -1);
    expect([at('c1'), at('c2'), at('c3')]).toEqual([
      [310, 410],
      [320, 420],
      [330, 430],
    ]);
  });

  // Post-implementation (sabotage survivor: the last duplicate taken as the awaited parent). A child
  // waits for the first node with its parent's id; a later duplicate still refreshes in its place.
  it('waits for the first of a duplicated parent id, and keeps the later one as the node', () => {
    const store = loaded();
    const first = node('x', 'FILE', 'first');
    const later = node('x', 'DIRECTORY', 'later');
    store.applyDelta(
      add(node('c'), first, later),
      new Map([
        ['c', 'x'],
        ['x', 'f'],
      ]),
      always(0.75),
    );
    const at = (id: string): number[] => xy(store, store.liveIndex(id) ?? -1);
    expect([at('x'), at('c')]).toEqual([
      [310, 410],
      [320, 420],
    ]);
    expect(store.node('x')).toBe(later);
    expect(rgba(store, store.liveIndex('x') ?? -1)).toEqual(f32(DIRECTORY_RGBA));
  });

  // Round two (review 4): the chain's top has a parent no one can locate.
  it('seeds a chain listed child first beside its parents when its top is unlocatable', () => {
    const store = loaded();
    store.applyDelta(
      add(node('k'), node('h')),
      new Map([
        ['k', 'h'],
        ['h', 'nope'],
      ]),
      always(0.75),
    );
    const at = (id: string): number[] => xy(store, store.liveIndex(id) ?? -1);
    expect([at('h'), at('k')]).toEqual([
      [2058, 2058],
      [2068, 2068],
    ]);
    expect(store.sizes[store.liveIndex('k') ?? -1]).toBeCloseTo(17.6 * 0.88, 4);
  });

  // Round two (review 5): a three-node loop as well.
  it('seeds a parent loop inside one delta, and a node that is its own parent, at the centre', () => {
    const store = loaded();
    store.applyDelta(
      add(node('a'), node('b'), node('z'), node('c1'), node('c2'), node('c3')),
      new Map([
        ['a', 'b'],
        ['b', 'a'],
        ['z', 'z'],
        ['c1', 'c2'],
        ['c2', 'c3'],
        ['c3', 'c1'],
      ]),
      always(0.5),
    );
    const at = (id: string): number[] => xy(store, store.liveIndex(id) ?? -1);
    expect(['a', 'b', 'z', 'c1', 'c2', 'c3'].map(at)).toEqual(
      Array.from({ length: 6 }, () => [2048, 2048]),
    );
  });

  it('treats a parent removed in the same delta as not locatable', () => {
    const store = loaded();
    store.applyDelta(
      { addedNodes: [node('h')], removedNodeIds: ['f'] },
      new Map([['h', 'f']]),
      scripted(0.75, 0.25),
    );
    expect(xy(store, 3)).toEqual([2058, 2038]);
    expect(store.sizes[3]).toBeCloseTo(17.6, 5);
  });

  // round two (review a2): childPointSize floors at 4, so a size-4 parent has a size-4 child.
  it('floors a seeded size at 4 under a smallest parent', () => {
    const store = new BufferStore();
    store.load(
      layoutOf([{ id: 'p', type: 'FILE', x: 10, y: 10, size: 4 }]),
      payloadOf([node('p')]),
    );
    store.applyDelta(add(node('c')), new Map([['c', 'p']]), always(0.5));
    expect(xy(store, 1)).toEqual([10, 10]);
    expect(store.sizes[1]).toBe(4);
  });

  // round two (review a3): the archive kept a tombstoned parent's size (visualizer.ts:582-583).
  it('treats a parent tombstoned by an earlier delta as not locatable', () => {
    const store = loaded();
    store.applyDelta(remove('f'), new Map(), scripted());
    store.applyDelta(add(node('h')), new Map([['h', 'f']]), scripted(0.75, 0.25));
    expect(xy(store, 3)).toEqual([2058, 2038]);
    expect(store.sizes[3]).toBeCloseTo(17.6, 5);
  });

  it('restores a tombstoned id at its old index, seeded beside its parent', () => {
    const store = loaded();
    store.applyDelta(remove('f'), new Map(), scripted());
    // round two (review a1): remove-then-add may change the type, so type and colour are restored too.
    const again = node('f', 'DIRECTORY', 'f2');
    store.applyDelta(add(again), new Map([['f', 'd']]), scripted(0.25, 0.75));
    expect(store.length).toBe(3);
    expect(xy(store, 1)).toEqual([90, 210]);
    expect(store.sizes[1]).toBeCloseTo(17.6, 5);
    expect(rgba(store, 1)).toEqual(f32(DIRECTORY_RGBA));
    expect(store.nodeAt(1)).toBe(again);
    expect(store.liveIndex('f')).toBe(1);
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'DIRECTORY', 'FILE']);
  });

  // Reworked for controller decision 111 (sprint 34): an id one delta removes and re-adds keeps its
  // live point, position and size, draws no random number, and takes the new node and type, so a
  // save's code points stay where they are; an id the delta removes and does not re-add still goes.
  it('keeps the live point of an id one delta removes and re-adds; a removed id it does not re-add goes', () => {
    const store = loaded();
    const again = node('f', 'MODULE', 'f2.ts');
    store.applyDelta(
      { addedNodes: [again], removedNodeIds: ['g', 'f'] },
      new Map([['f', 'd']]),
      scripted(),
    );
    expect(store.length).toBe(3);
    expect(xy(store, 1)).toEqual([300, 400]);
    expect(store.sizes[1]).toBe(9);
    expect(rgba(store, 1)).toEqual(f32(MODULE_RGBA));
    expect(store.nodeAt(1)).toBe(again);
    expect(store.liveIndex('f')).toBe(1);
    expect([xy(store, 2), store.liveIndex('g'), store.node('g')]).toEqual([
      [NaN, NaN],
      undefined,
      undefined,
    ]);
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'MODULE']);
  });

  // Decision 111 is about live points: an id already gone is seeded afresh beside its parent.
  it('an id removed by an earlier delta, then removed and re-added by one, is seeded beside its parent', () => {
    const store = loaded();
    store.applyDelta(remove('f'), new Map(), scripted());
    const again = node('f', 'FILE', 'f2.ts');
    store.applyDelta(
      { addedNodes: [again], removedNodeIds: ['f'] },
      new Map([['f', 'd']]),
      scripted(0.25, 0.75),
    );
    expect(xy(store, 1)).toEqual([90, 210]);
    expect(store.nodeAt(1)).toBe(again);
  });

  it('keeps the point, position and size of a re-added live id and updates its node', () => {
    const store = loaded();
    // round two (review a1): a new type and colour are taken, and no random number is drawn
    // (scripted() throws on the first draw).
    const again = node('f', 'MODULE', 'f2.ts');
    store.applyDelta(add(again), new Map([['f', 'd']]), scripted());
    expect(store.length).toBe(3);
    expect(xy(store, 1)).toEqual([300, 400]);
    expect(store.sizes[1]).toBe(9);
    expect(rgba(store, 1)).toEqual(f32(MODULE_RGBA));
    expect(store.nodeAt(1)).toBe(again);
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'MODULE', 'FILE']);
  });
});

describe('BufferStore.syncLive', () => {
  it('copies finite live positions into the base', () => {
    const store = loaded();
    store.syncLive([1, 2, 3, 4, 5, 6]);
    expect(Array.from(store.positions)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps the base wherever either live coordinate is not finite', () => {
    const store = loaded();
    store.syncLive([NaN, NaN, 7, NaN, 5, 6]);
    expect(Array.from(store.positions)).toEqual([100, 200, 300, 400, 5, 6]);
    // round two (review a4): NaN on x alone, and infinities, are not finite either.
    store.syncLive([NaN, 8, Infinity, 6, 1, -Infinity]);
    expect(Array.from(store.positions)).toEqual([100, 200, 300, 400, 5, 6]);
  });

  it('never lifts a tombstone', () => {
    const store = loaded();
    store.applyDelta(remove('f'), new Map(), scripted());
    store.syncLive([1, 2, 3, 4, 5, 6]);
    expect(Array.from(store.positions)).toEqual([1, 2, NaN, NaN, 5, 6]);
  });

  it('accepts a live array shorter than the store', () => {
    const store = loaded();
    store.syncLive([1, 2]);
    expect(Array.from(store.positions)).toEqual([1, 2, 300, 400, 500, 600]);
  });
});

describe('BufferStore.masked', () => {
  it('puts NaN on every point of a hidden type and leaves the base alone', () => {
    const store = loaded();
    expect(Array.from(store.masked(new Set(['FILE'])))).toEqual([100, 200, NaN, NaN, NaN, NaN]);
    expect(Array.from(store.positions)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(Array.from(store.masked(new Set()))).toEqual([100, 200, 300, 400, 500, 600]);
  });
});

// U3.1.1 part 3 (controller decision 32): a theme's node colours.
describe('BufferStore.recolour', () => {
  const THEME = {
    // Round two (review a3): `red` is no colour a point can be drawn in, so CALL takes the default.
    nodeColors: { FILE: '#336699', DIRECTORY: '#000000', CALL: 'red' },
    defaultNodeColor: '#ff0000',
  };
  const BLUE = f32([0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
  const BLACK = [0, 0, 0, 1];
  const RED = [1, 0, 0, 1];

  it('recolours every point by its type, moving and resizing nothing', () => {
    const store = loaded();
    store.recolour(THEME);
    expect(Array.from(store.colors)).toEqual([...BLACK, ...BLUE, ...BLUE]);
    expect(Array.from(store.positions)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(Array.from(store.sizes)).toEqual([20, 9, 9]);
    expect(store.liveTypes()).toEqual(['DIRECTORY', 'FILE', 'FILE']);
  });

  it("colours a delta's added, re-added and retyped nodes the same way", () => {
    const store = loaded();
    store.recolour(THEME);
    store.applyDelta(remove('g'), new Map(), always(0.5));
    store.applyDelta(
      add(node('n'), node('m', 'MODULE'), node('g', 'DIRECTORY'), node('f', 'CALL')),
      new Map(),
      always(0.5),
    );
    expect([0, 1, 2, 3, 4].map((index) => rgba(store, index))).toEqual([
      BLACK,
      RED,
      BLACK,
      BLUE,
      RED,
    ]);
    store.recolour({ nodeColors: { CALL: 'red', MODULE: '' }, defaultNodeColor: 'x' });
    expect([1, 4].map((index) => rgba(store, index))).toEqual([f32(GREY), f32(GREY)]);
  });

  // Round two (review b2).
  it("a load after a recolour still takes its layout's colours", () => {
    const store = loaded();
    store.recolour(THEME);
    store.load(layoutOf([{ id: 'x', type: 'FILE', x: 7, y: 8, size: 20 }]), payloadOf([node('x')]));
    expect(Array.from(store.colors)).toEqual([0, 0.25, 0.5, 1]);
  });

  it('takes the latest colours, and the registry ones again when handed them', () => {
    const store = loaded();
    store.recolour(THEME);
    store.recolour(REGISTRY_NODE_COLORS);
    expect(rgba(store, 0)).toEqual(f32(DIRECTORY_RGBA));
    store.applyDelta(add(node('n'), node('m', 'PARAM')), new Map(), always(0.5));
    expect([rgba(store, 3), rgba(store, 4)]).toEqual([f32(FILE_RGBA), f32(GREY)]);
  });
});
