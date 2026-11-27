// The seeded radial layout (BMO-35 line 1). Every expected number is derived by hand from the
// archive's documented constants (21754b4:packages/graph-visualizer/src/layout.ts): space 4096,
// centre 2048, ring step 20, arc floor 12 per node, radius jitter +-10%, angle jitter +-30% of a
// node's slice, outermost ring clamped to 2048*0.9/1.1, sizes 20 x0.88 per depth floored at 4,
// link width = mean endpoint size x 0.2. Positions are float32, so comparisons carry a tolerance.

import type { GraphEdge, GraphNode, GraphPayload } from '@cpg/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PARENT_TABLE,
  LINK_DISTANCE,
  ROOT_POINT_SIZE,
  SPACE_SIZE,
  childPointSize,
  layoutPayload,
  linkWidthForSizes,
  type LayoutResult,
  type ParentEnd,
  type ParentTable,
} from './layout';

const C = 2048;
const PI = Math.PI;
const EPS = 1e-3;
const MAX_RADIUS = (2048 * 0.9) / 1.1;
const GREY = [0.6, 0.6, 0.6, 1];
const FILE_RGBA = [77 / 255, 179 / 255, 1, 1];
const DIRECTORY_RGBA = [1, 153 / 255, 51 / 255, 1];

const node = (id: string, type = 'FILE'): GraphNode => ({ id, type });
const edge = (source: string, target: string, type?: string): GraphEdge =>
  type === undefined ? { source, target } : { source, target, type };
const entry = (source: string, target: string): GraphEdge => edge(source, target, 'HAS_ENTRY');
const rule = (type: string, parent: ParentEnd = 'source') => ({ type, parent });
const table = (hierarchy: string[], fallback: string[] = []): ParentTable => ({
  hierarchy: hierarchy.map((type) => rule(type)),
  fallback: fallback.map((type) => rule(type)),
});
const payload = (nodes: GraphNode[], edges: GraphEdge[] = []): GraphPayload => ({
  seq: 0,
  nodes,
  edges,
});

/** A root directory holding n files. */
function star(n: number): GraphPayload {
  const leaves = Array.from({ length: n }, (_, i) => node(`f${i}`));
  return payload(
    [node('root', 'DIRECTORY'), ...leaves],
    leaves.map((l) => entry('root', l.id)),
  );
}

/** R holds A (three files) and B (one file): A's subtree weighs 3, B's weighs 1. */
function weighted(extra: GraphEdge[] = []): GraphPayload {
  return payload(
    [
      node('R', 'DIRECTORY'),
      node('A', 'DIRECTORY'),
      node('a1'),
      node('a2'),
      node('a3'),
      node('B', 'DIRECTORY'),
      node('b1'),
    ],
    [
      entry('R', 'A'),
      entry('R', 'B'),
      entry('A', 'a1'),
      entry('A', 'a2'),
      entry('A', 'a3'),
      entry('B', 'b1'),
      ...extra,
    ],
  );
}

/** A repository-shaped payload: nested directories, files, symbols, calls, one dangling edge. */
function repoLike(): GraphPayload {
  const nodes: GraphNode[] = [node('.', 'DIRECTORY')];
  const edges: GraphEdge[] = [];
  for (let d = 0; d < 5; d++) {
    const dir = `d${d}`;
    nodes.push(node(dir, 'DIRECTORY'));
    edges.push(entry('.', dir));
    for (let f = 0; f < 8; f++) {
      const file = `${dir}/f${f}.py`;
      nodes.push(node(file));
      edges.push(entry(dir, file));
      if (f % 3 === 0) {
        nodes.push(node(`sym:${file}`, 'SYMBOL'));
        edges.push(edge(file, `sym:${file}`, 'DEFINES'));
      }
    }
  }
  edges.push(edge('d0/f0.py', 'sym:d1/f3.py', 'CALLS'));
  edges.push(edge('d2/f1.py', 'd3/f2.py'));
  edges.push(edge('d4/f7.py', 'nowhere', 'CALLS'));
  return payload(nodes, edges);
}

const bytes = (a: Float32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
/** The raw bytes of every Float32Array in a result (each must be a Float32Array to have them). */
const buffers = (r: LayoutResult): Record<string, Uint8Array> => ({
  positions: bytes(r.positions),
  colors: bytes(r.colors),
  links: bytes(r.links),
  sizes: bytes(r.sizes),
  linkWidths: bytes(r.linkWidths),
});

function indexOf(result: LayoutResult, id: string): number {
  const i = result.ids.indexOf(id);
  if (i < 0) throw new Error(`${id} was not placed`);
  return i;
}

/** Distance from the centre and angle in [0, 2pi) of the point at index i. */
function polar(result: LayoutResult, i: number): { r: number; t: number } {
  const dx = (result.positions[2 * i] ?? Number.NaN) - C;
  const dy = (result.positions[2 * i + 1] ?? Number.NaN) - C;
  const t = Math.atan2(dy, dx);
  return { r: Math.hypot(dx, dy), t: t < 0 ? t + 2 * PI : t };
}

/**
 * Where the point for `id` falls outside a radius window or an angle window (angles in units of
 * pi): one line per violation, so a test asserts the list is empty and a failure names the point.
 */
function misplaced(
  result: LayoutResult,
  id: string,
  r: readonly [number, number],
  t: readonly [number, number] = [0, 2],
): string[] {
  const p = polar(result, indexOf(result, id));
  const out: string[] = [];
  if (p.r < r[0] - EPS || p.r > r[1] + EPS)
    out.push(`${id}: radius ${p.r} not in [${r[0]}, ${r[1]}]`);
  const a = p.t / PI;
  if (a < t[0] - EPS || a > t[1] + EPS) out.push(`${id}: angle ${a}pi not in [${t[0]}, ${t[1]}]pi`);
  return out;
}

const ring = (radius: number): readonly [number, number] => [radius * 0.9, radius * 1.1];
const rgbaAt = (result: LayoutResult, i: number): number[] =>
  Array.from(result.colors.subarray(4 * i, 4 * i + 4));
const f32 = (xs: readonly number[]): number[] => xs.map((x) => Math.fround(x));
/** Largest elementwise difference; NaN (so never below a bound) when the lengths differ. */
const maxError = (xs: readonly number[], ys: readonly number[]): number =>
  xs.length === ys.length
    ? Math.max(0, ...xs.map((x, i) => Math.abs(x - (ys[i] ?? Number.NaN))))
    : Number.NaN;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constants', () => {
  it('keep the archive values', () => {
    expect(SPACE_SIZE).toBe(4096);
    expect(LINK_DISTANCE).toBe(20);
    expect(ROOT_POINT_SIZE).toBe(20);
  });

  // Sprint 33 (BMO-100, controller decision 103): reworked from "HAS_ENTRY, and adopt on DEFINES".
  // Every fallback row points at a SYMBOL (packages/model/src/schema/edges.ts), so its source is
  // the parent (the PR names this; decision 103 lists the fallbacks without an end).
  it("place by BMO-100's parent table, in its order", () => {
    expect(DEFAULT_PARENT_TABLE).toEqual({
      hierarchy: [
        rule('HAS_ENTRY'),
        rule('DECLARES'),
        rule('HAS_PARAM'),
        rule('SOURCE_FILE', 'target'),
        rule('IN_SCOPE', 'target'),
      ],
      fallback: [rule('DEFINES'), rule('IMPORTS'), rule('CALLS'), rule('INHERITS_FROM')],
    });
  });
});

describe('the seed (BMO-35 line 1: two renders, same payload, same seed, identical buffers)', () => {
  it('gives byte-identical Float32Array buffers and equal ids and types', () => {
    const p = repoLike();
    const a = layoutPayload(p, { seed: 7 });
    const b = layoutPayload(p, { seed: 7 });
    expect(buffers(a)).toEqual(buffers(b));
    expect(Object.values(buffers(a)).map((x) => x.length)).not.toContain(0);
    for (const x of [a.positions, a.colors, a.links, a.sizes, a.linkWidths]) {
      expect(x).toBeInstanceOf(Float32Array);
    }
    expect(a.ids).toEqual(b.ids);
    expect(a.types).toEqual(b.types);
    expect(a.positions.length).toBeGreaterThan(100);
  });

  it('carries no state between calls: interleaved layouts do not disturb each other', () => {
    const p = repoLike();
    const first = layoutPayload(p, { seed: 11 });
    layoutPayload(star(9), { seed: 11 });
    layoutPayload(p, { seed: 12 });
    const again = layoutPayload(p, { seed: 11 });
    expect(bytes(again.positions)).toEqual(bytes(first.positions));
  });

  it('never calls Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    layoutPayload(repoLike(), { seed: 3 });
    layoutPayload(payload([node('x'), node('y')]), { seed: 3 });
    expect(random).not.toHaveBeenCalled();
  });

  it('reads a frozen payload without writing to it', () => {
    const p = repoLike();
    const frozen: GraphPayload = Object.freeze({
      seq: 0,
      nodes: Object.freeze(p.nodes.map((n) => Object.freeze({ ...n }))),
      edges: Object.freeze(p.edges.map((e) => Object.freeze({ ...e }))),
    });
    expect(bytes(layoutPayload(frozen, { seed: 5 }).positions)).toEqual(
      bytes(layoutPayload(p, { seed: 5 }).positions),
    );
  });

  it('a different seed moves (nearly) every non-root point', () => {
    const p = repoLike();
    const a = layoutPayload(p, { seed: 1 });
    const b = layoutPayload(p, { seed: 2 });
    let moved = 0;
    for (let i = 1; i < a.ids.length; i++) {
      if (a.positions[2 * i] !== b.positions[2 * i]) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(Math.floor(0.9 * (a.ids.length - 1)));
  });

  it('the seed moves positions only', () => {
    const p = repoLike();
    const a = layoutPayload(p, { seed: 1 });
    const b = layoutPayload(p, { seed: 2 });
    const { positions: pa, ...restA } = buffers(a);
    const { positions: pb, ...restB } = buffers(b);
    expect(restA).toEqual(restB);
    expect(pa).not.toEqual(pb);
    expect(a.ids).toEqual(b.ids);
    expect(a.types).toEqual(b.types);
  });

  it('seed 0 still jitters: leaves of one ring do not share a radius', () => {
    const result = layoutPayload(star(16), { seed: 0 });
    const radii = new Set(result.ids.slice(1).map((_, k) => polar(result, k + 1).r.toFixed(3)));
    expect(radii.size).toBeGreaterThan(8);
  });
});

describe('placement', () => {
  it('puts a single root exactly on the centre with the root size', () => {
    for (const seed of [0, 1, 99, 0xffffffff]) {
      const result = layoutPayload(weighted(), { seed });
      expect(result.ids[0]).toBe('R');
      expect(Array.from(result.positions.subarray(0, 2))).toEqual([C, C]);
      expect(result.sizes[0]).toBe(20);
    }
  });

  it('places depth-first, children in payload edge order', () => {
    expect(layoutPayload(weighted(), { seed: 1 }).ids).toEqual([
      'R',
      'A',
      'a1',
      'a2',
      'a3',
      'B',
      'b1',
    ]);
  });

  it('emits one entry per point in every per-point buffer and one width per link', () => {
    const result = layoutPayload(weighted(), { seed: 1 });
    expect(result.ids).toHaveLength(7);
    expect(result.types).toEqual([
      'DIRECTORY',
      'DIRECTORY',
      'FILE',
      'FILE',
      'FILE',
      'DIRECTORY',
      'FILE',
    ]);
    expect(result.positions).toHaveLength(14);
    expect(result.colors).toHaveLength(28);
    expect(result.sizes).toHaveLength(7);
    expect(result.linkWidths).toHaveLength(result.links.length / 2);
  });

  it('a ring holding few nodes sits one ring step (20) out', () => {
    for (const seed of [1, 2, 3]) {
      const result = layoutPayload(star(3), { seed });
      expect(['f0', 'f1', 'f2'].flatMap((id) => misplaced(result, id, ring(20)))).toEqual([]);
    }
  });

  it('a crowded ring widens to fit 12 units of arc per node', () => {
    const r = (16 * 12) / (2 * PI);
    for (const seed of [1, 2, 3]) {
      const result = layoutPayload(star(16), { seed });
      expect(
        Array.from({ length: 16 }, (_, i) => misplaced(result, `f${i}`, ring(r))).flat(),
      ).toEqual([]);
    }
  });

  it('each deeper ring is at least one ring step beyond the last', () => {
    for (const seed of [1, 2, 3]) {
      const result = layoutPayload(weighted(), { seed });
      expect(['A', 'B'].flatMap((id) => misplaced(result, id, ring(20)))).toEqual([]);
      expect(['a1', 'a2', 'a3', 'b1'].flatMap((id) => misplaced(result, id, ring(40)))).toEqual([]);
    }
  });

  it('splits each slice among children by leaf count, jittering within 30% of a slice', () => {
    // R's circle splits 3:1. A = [0, 1.5pi], B = [1.5pi, 2pi]; A's span splits 1:1:1.
    for (let seed = 0; seed < 50; seed++) {
      const result = layoutPayload(weighted(), { seed });
      expect(misplaced(result, 'A', ring(20), [0.3, 1.2])).toEqual([]);
      expect(misplaced(result, 'B', ring(20), [1.6, 1.9])).toEqual([]);
      expect(misplaced(result, 'a1', ring(40), [0.1, 0.4])).toEqual([]);
      expect(misplaced(result, 'a2', ring(40), [0.6, 0.9])).toEqual([]);
      expect(misplaced(result, 'a3', ring(40), [1.1, 1.4])).toEqual([]);
      expect(misplaced(result, 'b1', ring(40), [1.6, 1.9])).toEqual([]);
    }
  });

  it('clamps the outermost ring so a jittered point stays inside 90% of the half-space', () => {
    // 2000 leaves want 2000*12/2pi = 3819.7; the clamp scales that ring down to 2048*0.9/1.1.
    for (const seed of [1, 2]) {
      const result = layoutPayload(star(2000), { seed });
      for (let i = 1; i < result.ids.length; i++) {
        const { r } = polar(result, i);
        expect(r).toBeGreaterThanOrEqual(0.9 * MAX_RADIUS - EPS);
        expect(r).toBeLessThanOrEqual(2048 * 0.9 + EPS);
      }
    }
  });

  it('scales every ring by the same clamp factor', () => {
    // root -> hub -> 2000 leaves: radii [0, 20, 3819.7] scale by MAX_RADIUS / 3819.7.
    const leaves = Array.from({ length: 2000 }, (_, i) => node(`f${i}`));
    const p = payload(
      [node('root', 'DIRECTORY'), node('hub', 'DIRECTORY'), ...leaves],
      [entry('root', 'hub'), ...leaves.map((l) => entry('hub', l.id))],
    );
    const scale = MAX_RADIUS / ((2000 * 12) / (2 * PI));
    expect(misplaced(layoutPayload(p, { seed: 4 }), 'hub', ring(20 * scale))).toEqual([]);
    expect(misplaced(layoutPayload(p, { seed: 4 }), 'f1999', ring(MAX_RADIUS))).toEqual([]);
  });
});

describe('the hierarchy', () => {
  it('does not treat CONTAINS as a hierarchy edge by default (reserved for Joern)', () => {
    const p = payload([node('R', 'DIRECTORY'), node('A')], [edge('R', 'A', 'CONTAINS')]);
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toHaveLength(3);
    expect(result.ids.slice(1)).toEqual(['R', 'A']);
  });

  // Sprint 33 rework: DECLARES is a default row now, and a table row's end is read from the table.
  it("follows the rows of the table it is given, each row's parent end included", () => {
    const p = payload([node('M', 'MODULE'), node('f', 'METHOD')], [edge('M', 'f', 'DECLARES')]);
    expect(layoutPayload(p, { seed: 1 }).ids).toEqual(['M', 'f']);
    expect(layoutPayload(p, { seed: 1, parentTable: table(['HAS_ENTRY']) }).ids).toHaveLength(3);
    const owns = payload([node('M', 'MODULE'), node('f', 'METHOD')], [edge('f', 'M', 'OWNS')]);
    const byTarget = { hierarchy: [rule('OWNS', 'target')], fallback: [] };
    expect(layoutPayload(owns, { seed: 1, parentTable: byTarget }).ids).toEqual(['M', 'f']);
  });

  it("keeps a node's first hierarchy parent", () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('A', 'DIRECTORY'), node('B', 'DIRECTORY'), node('x')],
      [entry('R', 'A'), entry('R', 'B'), entry('A', 'x'), entry('B', 'x')],
    );
    for (const seed of [1, 2, 3]) {
      const result = layoutPayload(p, { seed });
      expect(result.ids).toEqual(['R', 'A', 'x', 'B']);
      expect(misplaced(result, 'x', ring(40), [0.2, 0.8])).toEqual([]);
    }
  });

  it('adopts a parentless node beside the node that DEFINES it', () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('F'), node('S', 'SYMBOL')],
      [entry('R', 'F'), edge('F', 'S', 'DEFINES')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toEqual(['R', 'F', 'S']);
    expect(misplaced(result, 'S', ring(40))).toEqual([]);
  });

  it('adopts along a chain of fallback edges in payload order', () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('F'), node('S1', 'SYMBOL'), node('S2', 'SYMBOL')],
      [entry('R', 'F'), edge('F', 'S1', 'DEFINES'), edge('S1', 'S2', 'DEFINES')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toEqual(['R', 'F', 'S1', 'S2']);
    expect(misplaced(result, 'S2', ring(60))).toEqual([]);
  });

  it('lets a hierarchy parent win over a fallback edge', () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('F'), node('G')],
      [entry('R', 'F'), entry('R', 'G'), edge('F', 'G', 'DEFINES')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toEqual(['R', 'F', 'G']);
    expect(misplaced(result, 'G', ring(20))).toEqual([]);
  });

  it("adopts along the table's fallback rows only", () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('F'), node('S', 'SYMBOL')],
      [entry('R', 'F'), edge('F', 'S', 'DEFINES')],
    );
    const none = layoutPayload(p, { seed: 1, parentTable: table(['HAS_ENTRY']) });
    expect(none.ids).toHaveLength(4);
    expect(none.ids.slice(1)).toEqual(['R', 'F', 'S']);
    const calls = payload(
      [node('R', 'DIRECTORY'), node('F'), node('S', 'SYMBOL')],
      [entry('R', 'F'), edge('F', 'S', 'REF')],
    );
    const viaRef = layoutPayload(calls, { seed: 1, parentTable: table(['HAS_ENTRY'], ['REF']) });
    expect(viaRef.ids).toEqual(['R', 'F', 'S']);
  });

  it('never adopts along a fallback edge that would close a cycle', () => {
    const p = payload(
      [node('P', 'DIRECTORY'), node('Q')],
      [entry('P', 'Q'), edge('Q', 'P', 'DEFINES')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toEqual(['P', 'Q']);
    expect(Array.from(result.positions.subarray(0, 2))).toEqual([C, C]);
  });

  it('when every node has a parent (a cycle), treats every node as its own root', () => {
    const p = payload(
      [node('P', 'DIRECTORY'), node('Q', 'DIRECTORY'), node('S')],
      [entry('P', 'Q'), entry('Q', 'P'), entry('P', 'S')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toHaveLength(4);
    expect(result.ids.slice(1)).toEqual(['P', 'Q', 'S']);
    expect(['P', 'Q', 'S'].flatMap((id) => misplaced(result, id, ring(20)))).toEqual([]);
    expect(Array.from(result.links)).toEqual([0, 1, 0, 2, 0, 3]);
  });
});

const twoRoots = (): GraphPayload => payload([node('x'), node('y', 'DIRECTORY')]);

describe('several roots', () => {
  it('hangs them off a synthetic centre point: grey, root-sized, on the centre', () => {
    const result = layoutPayload(twoRoots(), { seed: 1 });
    expect(result.ids).toHaveLength(3);
    expect(result.ids.slice(1)).toEqual(['x', 'y']);
    expect(Array.from(result.positions.subarray(0, 2))).toEqual([C, C]);
    expect(rgbaAt(result, 0)).toEqual(f32(GREY));
    expect(result.sizes[0]).toBe(20);
    expect(result.sizes[1]).toBeCloseTo(17.6, 4);
    expect(result.sizes[2]).toBeCloseTo(17.6, 4);
    expect(['x', 'y'].flatMap((id) => misplaced(result, id, ring(20)))).toEqual([]);
    expect(Array.from(result.links)).toEqual([0, 1, 0, 2]);
  });

  it('never gives the synthetic point a real id, nor the reserved __root__', () => {
    const result = layoutPayload(twoRoots(), { seed: 1 });
    const synthetic = result.ids[0] ?? '';
    expect(['x', 'y']).not.toContain(synthetic);
    // C-MODEL I-3: no real id contains U+0000, so this id can never collide with one.
    expect(synthetic).toContain('\u0000');
    expect(result.ids).not.toContain('__root__');
  });
});

describe('sizes and colours', () => {
  it('shrinks each child to 0.88 of its parent, never below 4', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `n${i}`);
    const p = payload(
      ids.map((id) => node(id, 'DIRECTORY')),
      ids.slice(1).map((id, i) => entry(`n${i}`, id)),
    );
    const sizes = Array.from(layoutPayload(p, { seed: 1 }).sizes);
    const expected = [
      20, 17.6, 15.488, 13.62944, 11.9939072, 10.554638336, 9.28808173568, 8.1735119273984,
      7.192690496110592, 6.329567636577321, 5.570019520188043, 4.901617177765478, 4.313423116433621,
      4, 4,
    ];
    expect(sizes).toHaveLength(15);
    expect(maxError(sizes, expected)).toBeLessThan(1e-4);
  });

  it('childPointSize and linkWidthForSizes follow the same rules', () => {
    expect(childPointSize(20)).toBeCloseTo(17.6, 10);
    expect(childPointSize(100)).toBeCloseTo(88, 10);
    expect(childPointSize(4.2)).toBe(4);
    expect(childPointSize(4)).toBe(4);
    expect(linkWidthForSizes(20, 17.6)).toBeCloseTo(3.76, 10);
    expect(linkWidthForSizes(4, 4)).toBeCloseTo(0.8, 10);
  });

  it('colours a point by its type from the registry, grey when unregistered', () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('f'), node('w', 'WIDGET'), node('c', 'constructor')],
      [entry('R', 'f'), entry('R', 'w'), entry('R', 'c')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(rgbaAt(result, indexOf(result, 'R'))).toEqual(f32(DIRECTORY_RGBA));
    expect(rgbaAt(result, indexOf(result, 'f'))).toEqual(f32(FILE_RGBA));
    expect(rgbaAt(result, indexOf(result, 'w'))).toEqual(f32(GREY));
    expect(rgbaAt(result, indexOf(result, 'c'))).toEqual(f32(GREY));
    expect(result.types).toEqual(['DIRECTORY', 'FILE', 'WIDGET', 'constructor']);
  });
});

describe('links', () => {
  it('lists tree links in placement order, then every other edge in payload order', () => {
    const result = layoutPayload(weighted([edge('a1', 'b1', 'CALLS'), edge('a2', 'a3')]), {
      seed: 1,
    });
    expect(Array.from(result.links)).toEqual([0, 1, 1, 2, 1, 3, 1, 4, 0, 5, 5, 6, 2, 6, 3, 4]);
  });

  it('draws no link for an edge whose endpoint is not in the payload', () => {
    const result = layoutPayload(
      weighted([edge('a1', 'ghost', 'CALLS'), edge('ghost', 'b1'), edge('a1', 'b1', 'CALLS')]),
      { seed: 1 },
    );
    expect(Array.from(result.links)).toEqual([0, 1, 1, 2, 1, 3, 1, 4, 0, 5, 5, 6, 2, 6]);
  });

  it('gives each link the mean of its endpoint sizes times 0.2', () => {
    const result = layoutPayload(weighted([edge('a1', 'b1', 'CALLS')]), { seed: 1 });
    const root = (20 + 17.6) / 2 / 5;
    const inner = (17.6 + 15.488) / 2 / 5;
    const leaf = 15.488 / 5;
    const expected = [root, inner, inner, inner, root, inner, leaf];
    const widths = Array.from(result.linkWidths);
    expect(widths).toHaveLength(7);
    expect(maxError(widths, expected)).toBeLessThan(1e-4);
  });
});

// Round two: the cases the test review named (a2-a6, b1, b2).

describe('ring radii build on the ring inside them (review a2)', () => {
  it('a ring beyond a widened ring sits one ring step past it, not at depth x 20', () => {
    // 16 files at depth 1 widen it to 16*12/2pi; one file's child at depth 2 sits 20 further out.
    const p = star(16);
    const withChild = payload([...p.nodes, node('g')], [...p.edges, entry('f0', 'g')]);
    const r1 = (16 * 12) / (2 * PI);
    for (const seed of [1, 2, 3]) {
      const result = layoutPayload(withChild, { seed });
      expect(misplaced(result, 'f5', ring(r1))).toEqual([]);
      expect(misplaced(result, 'g', ring(r1 + 20))).toEqual([]);
    }
  });
});

describe('slices weigh leaves, not direct children (review a3)', () => {
  it('a subtree with one child but three leaves still takes three quarters of the circle', () => {
    const p = payload(
      [
        node('R', 'DIRECTORY'),
        node('A', 'DIRECTORY'),
        node('A1', 'DIRECTORY'),
        node('a1'),
        node('a2'),
        node('a3'),
        node('B', 'DIRECTORY'),
        node('b1'),
      ],
      [
        entry('R', 'A'),
        entry('R', 'B'),
        entry('A', 'A1'),
        entry('A1', 'a1'),
        entry('A1', 'a2'),
        entry('A1', 'a3'),
        entry('B', 'b1'),
      ],
    );
    for (let seed = 0; seed < 50; seed++) {
      const result = layoutPayload(p, { seed });
      expect(misplaced(result, 'A', ring(20), [0.3, 1.2])).toEqual([]);
      expect(misplaced(result, 'B', ring(20), [1.6, 1.9])).toEqual([]);
    }
  });
});

describe('a custom hierarchy edge type (review a4)', () => {
  it('seeds the tree on that type and links every other type, HAS_ENTRY included', () => {
    const p = payload(
      [node('M', 'MODULE'), node('f', 'METHOD'), node('g', 'METHOD')],
      [edge('M', 'f', 'DECLARES'), edge('M', 'g', 'DECLARES'), entry('f', 'g')],
    );
    const result = layoutPayload(p, { seed: 1, parentTable: table(['DECLARES']) });
    expect(result.ids).toEqual(['M', 'f', 'g']);
    expect(Array.from(result.links)).toEqual([0, 1, 0, 2, 1, 2]);
  });
});

describe('cycles (review a1, a5)', () => {
  it('never adopts along a fallback edge that closes a longer cycle', () => {
    const p = payload(
      [node('P', 'DIRECTORY'), node('Q', 'DIRECTORY'), node('T')],
      [entry('P', 'Q'), entry('Q', 'T'), edge('T', 'P', 'DEFINES')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toEqual(['P', 'Q', 'T']);
    expect(Array.from(result.positions.subarray(0, 2))).toEqual([C, C]);
  });

  it('terminates when a fallback anchor sits on a hierarchy cycle', () => {
    // P and Q parent each other; Q DEFINES X, so the cycle check walks up from Q through the loop.
    const p = payload(
      [node('P', 'DIRECTORY'), node('Q', 'DIRECTORY'), node('X', 'SYMBOL')],
      [entry('P', 'Q'), entry('Q', 'P'), edge('Q', 'X', 'DEFINES')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toHaveLength(4);
    expect(result.ids.slice(1)).toEqual(['P', 'Q', 'X']);
  });

  it('a lone node that is its own hierarchy parent terminates as the single root', () => {
    const result = layoutPayload(payload([node('S', 'DIRECTORY')], [entry('S', 'S')]), { seed: 1 });
    expect(result.ids).toEqual(['S']);
    expect(Array.from(result.positions)).toEqual([C, C]);
    expect(Array.from(result.links)).toEqual([]);
  });
});

describe('hierarchy edges with a missing endpoint (review a6)', () => {
  it('a hierarchy edge from a node not in the payload parents nothing', () => {
    const p = payload([node('R', 'DIRECTORY'), node('x')], [entry('ghost', 'x'), entry('R', 'x')]);
    expect(layoutPayload(p, { seed: 1 }).ids).toEqual(['R', 'x']);
  });

  it('a hierarchy edge to a node not in the payload places no point', () => {
    const p = payload([node('R', 'DIRECTORY'), node('x')], [entry('R', 'ghost'), entry('R', 'x')]);
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toEqual(['R', 'x']);
    expect(result.positions).toHaveLength(4);
  });
});

describe('fallback anchors (review b1)', () => {
  it('an anchor with no parent of its own adopts nothing', () => {
    const p = payload([node('R', 'DIRECTORY'), node('S', 'SYMBOL')], [edge('R', 'S', 'DEFINES')]);
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toHaveLength(3);
    expect(result.ids.slice(1)).toEqual(['R', 'S']);
  });

  it('adopts in one pass over the edges: an anchor adopted later in the list adopts nothing earlier', () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('F'), node('S1', 'SYMBOL'), node('S2', 'SYMBOL')],
      [entry('R', 'F'), edge('S1', 'S2', 'DEFINES'), edge('F', 'S1', 'DEFINES')],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toHaveLength(5);
    expect(result.ids.slice(1)).toEqual(['R', 'F', 'S1', 'S2']);
  });
});

describe('the seed is read as an unsigned 32-bit integer (review b2)', () => {
  it('seeds equal modulo 2^32 give byte-identical positions', () => {
    const p = repoLike();
    const at = (seed: number): Uint8Array => bytes(layoutPayload(p, { seed }).positions);
    expect(at(-1)).toEqual(at(0xffffffff));
    expect(at(-(2 ** 31))).toEqual(at(2 ** 31));
    expect(at(2 ** 32)).toEqual(at(0));
    expect(at(2 ** 32 + 5)).toEqual(at(5));
    expect(at(-1)).not.toEqual(at(1));
  });
});

// Post-implementation (sabotage survivor: the clamp threshold doubled). Both clamp cases above want
// a ring of 3819.7, past twice the limit; these sit either side of the limit itself.
describe('the clamp threshold is MAX_RADIUS itself (sabotage)', () => {
  it('a ring just over the limit is clamped to it', () => {
    // 1000 leaves want 1000*12/2pi = 1909.9 > 2048*0.9/1.1 = 1675.6.
    const result = layoutPayload(star(1000), { seed: 6 });
    const bad = result.ids.slice(1).flatMap((id) => misplaced(result, id, ring(MAX_RADIUS)));
    expect(bad).toEqual([]);
  });

  it('a ring just under the limit keeps its own radius', () => {
    // 800 leaves want 800*12/2pi = 1527.9 < 1675.6: no scaling.
    const result = layoutPayload(star(800), { seed: 6 });
    const bad = result.ids
      .slice(1)
      .flatMap((id) => misplaced(result, id, ring((800 * 12) / (2 * PI))));
    expect(bad).toEqual([]);
  });
});

// Sprint 33 (BMO-100, controller decision 103): the code tier reaches its file through the table.

/** Each placed point's tree parent: the tree links come first in `links`, one per non-root point. */
function treeParents(result: LayoutResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < result.ids.length - 1; i++) {
    const parent = result.ids[result.links[2 * i] ?? -1];
    const child = result.ids[result.links[2 * i + 1] ?? -1];
    if (parent !== undefined && child !== undefined) out[child] = parent;
  }
  return out;
}

const HIERARCHY_ROWS = ['HAS_ENTRY', 'DECLARES', 'HAS_PARAM', 'SOURCE_FILE', 'IN_SCOPE'];
/** The edge of a hierarchy row that makes `parent` the parent of `child` (two rows point up). */
const parented = (type: string, parent: string, child: string): GraphEdge =>
  type === 'SOURCE_FILE' || type === 'IN_SCOPE'
    ? edge(child, parent, type)
    : edge(parent, child, type);

describe('the parent table (BMO-100)', () => {
  it("places a Python file's code tier under its FILE, from the one root", () => {
    const p = payload(
      [
        node('.', 'DIRECTORY'),
        node('pkg', 'DIRECTORY'),
        node('pkg/a.py'),
        node('mod', 'MODULE'),
        node('A', 'TYPE_DECL'),
        node('A.f', 'METHOD'),
        node('A.f.x', 'PARAM'),
        node('call', 'CALL'),
        node('imp', 'IMPORT'),
        node('sym:a', 'SYMBOL'),
        node('sym:os', 'SYMBOL'),
        node('sym:print', 'SYMBOL'),
        node('sym:Base', 'SYMBOL'),
      ],
      [
        // Fallbacks first and the filesystem last: edge order alone would place nothing.
        edge('mod', 'sym:a', 'DEFINES'),
        edge('imp', 'sym:os', 'IMPORTS'),
        edge('call', 'sym:print', 'CALLS'),
        edge('A', 'sym:Base', 'INHERITS_FROM'),
        edge('call', 'A.f', 'IN_SCOPE'),
        edge('A.f', 'A.f.x', 'HAS_PARAM'),
        edge('A', 'A.f', 'DECLARES'),
        edge('mod', 'A', 'DECLARES'),
        edge('mod', 'imp', 'DECLARES'),
        edge('mod', 'pkg/a.py', 'SOURCE_FILE'),
        entry('pkg', 'pkg/a.py'),
        entry('.', 'pkg'),
      ],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toHaveLength(13);
    expect(result.ids[0]).toBe('.');
    expect(treeParents(result)).toEqual({
      pkg: '.',
      'pkg/a.py': 'pkg',
      mod: 'pkg/a.py',
      A: 'mod',
      imp: 'mod',
      'A.f': 'A',
      'A.f.x': 'A.f',
      call: 'A.f',
      'sym:a': 'mod',
      'sym:os': 'imp',
      'sym:print': 'call',
      'sym:Base': 'A',
    });
  });

  it('takes the hierarchy rows in table order, whatever order the edges come in', () => {
    // x1 has an edge of each of the five rows, x2 of the last four, ..., x5 of IN_SCOPE alone,
    // always listed last row first; ek is the parent row k offers.
    const edges = HIERARCHY_ROWS.map((_, i) => entry('R', `e${i + 1}`));
    for (let k = 1; k <= 5; k++) {
      for (let j = 5; j >= k; j--)
        edges.push(parented(HIERARCHY_ROWS[j - 1] ?? '', `e${j}`, `x${k}`));
    }
    const nodes = [1, 2, 3, 4, 5].flatMap((i) => [node(`e${i}`), node(`x${i}`)]);
    const result = layoutPayload(payload([node('R', 'DIRECTORY'), ...nodes], edges), { seed: 1 });
    const offered = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`x${i}`, `e${i}`]));
    const anchors = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`e${i}`, 'R']));
    expect(treeParents(result)).toEqual({ ...anchors, ...offered });
  });

  it('takes the fallback rows in table order, whatever order the edges come in', () => {
    // s1 has all four fallbacks, s2 the last three, s3 the last two, s4 one; last row first.
    const p = payload(
      [
        node('R', 'DIRECTORY'),
        ...['a1', 'a2', 'a3', 'a4', 's1', 's2', 's3', 's4'].map((id) => node(id)),
      ],
      [
        ...['a1', 'a2', 'a3', 'a4'].map((id) => entry('R', id)),
        ...['s1', 's2', 's3', 's4'].map((s) => edge('a4', s, 'INHERITS_FROM')),
        ...['s1', 's2', 's3'].map((s) => edge('a3', s, 'CALLS')),
        ...['s1', 's2'].map((s) => edge('a2', s, 'IMPORTS')),
        edge('a1', 's1', 'DEFINES'),
      ],
    );
    const offered = Object.fromEntries([1, 2, 3, 4].map((i) => [`s${i}`, `a${i}`]));
    const anchors = Object.fromEntries([1, 2, 3, 4].map((i) => [`a${i}`, 'R']));
    expect(treeParents(layoutPayload(p, { seed: 1 }))).toEqual({ ...anchors, ...offered });
  });

  // Round two (review 2): the rejected anchor is the root, which has a child but no parent.
  it('passes a fallback whose anchor has no parent of its own to the next row', () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('F'), node('s', 'SYMBOL')],
      [entry('R', 'F'), edge('R', 's', 'IMPORTS'), edge('F', 's', 'CALLS')],
    );
    expect(treeParents(layoutPayload(p, { seed: 1 }))).toEqual({ F: 'R', s: 'F' });
  });

  // Round two (review 6).
  it("reads a fallback row's parent end from the table", () => {
    const p = payload(
      [node('R', 'DIRECTORY'), node('F'), node('S', 'SYMBOL')],
      [entry('R', 'F'), edge('S', 'F', 'BACK')],
    );
    const parentTable = { hierarchy: [rule('HAS_ENTRY')], fallback: [rule('BACK', 'target')] };
    expect(treeParents(layoutPayload(p, { seed: 1, parentTable }))).toEqual({ F: 'R', S: 'F' });
  });

  it('links each hierarchy-row edge once, as its tree link, then every other edge in order', () => {
    const p = payload(
      [
        node('R', 'DIRECTORY'),
        node('F'),
        node('M', 'MODULE'),
        node('k', 'CALL'),
        node('S', 'SYMBOL'),
      ],
      [
        entry('R', 'F'),
        edge('M', 'F', 'SOURCE_FILE'),
        edge('k', 'M', 'IN_SCOPE'),
        // Round two (review 1): a second IN_SCOPE edge places nothing and is not listed either.
        edge('k', 'R', 'IN_SCOPE'),
        edge('M', 'S', 'DEFINES'),
        edge('k', 'S', 'CALLS'),
        edge('F', 'M', 'IMPORTS'),
      ],
    );
    const result = layoutPayload(p, { seed: 1 });
    expect(result.ids).toEqual(['R', 'F', 'M', 'k', 'S']);
    // Tree links are (parent, child); then DEFINES (listed twice, as before: stop-list 49), CALLS,
    // IMPORTS. SOURCE_FILE and IN_SCOPE are not listed again, in either direction.
    expect(Array.from(result.links)).toEqual([0, 1, 1, 2, 2, 3, 2, 4, 2, 4, 3, 4, 1, 2]);
  });
});
