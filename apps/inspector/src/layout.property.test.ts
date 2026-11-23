// Seed-quantified properties of the radial layout (BMO-35 line 1). The jitter windows are the
// archive's constants (radius +-10%, angle +-30% of a slice); the rest is what the seed may and may
// not change. Expected values are hand-derived, never captured from a run.
//
// No fast-check: check-deps rule 2 lets an app's tests import only vitest. Seeds and payloads come
// from fixed edge cases plus a test-local LCG (Numerical Recipes constants), so every run is the
// same run.

import type { GraphEdge, GraphNode, GraphPayload } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { layoutPayload, type LayoutResult } from './layout';

const C = 2048;
const TAU = 2 * Math.PI;
const N = 16;
// 16 leaves need 16*12/2pi of radius, more than the 20-unit ring step.
const R = (N * 12) / TAU;
const SLICE = TAU / N;
const EPS = 1e-3;

/** A test-local LCG over [0, 2^32): input generation only, unrelated to the layout's generator. */
function lcg(start: number): () => number {
  let state = start >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
}

const EDGE_SEEDS = [0, 1, 2, -1, -(2 ** 31), 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 0x9e3779b9];
const nextSeed = lcg(20261122);
/** Edge-case seeds, then LCG seeds spread over the signed and unsigned 32-bit ranges. */
const SEEDS = [
  ...EDGE_SEEDS,
  ...Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? nextSeed() : nextSeed() | 0)),
];

const node = (id: string, type = 'FILE'): GraphNode => ({ id, type });
const STAR: GraphPayload = {
  seq: 0,
  nodes: [node('root', 'DIRECTORY'), ...Array.from({ length: N }, (_, i) => node(`f${i}`))],
  edges: Array.from({ length: N }, (_, i) => ({
    source: 'root',
    target: `f${i}`,
    type: 'HAS_ENTRY',
  })),
};

/** Leaf i of STAR: its radius as a fraction of R, and its angle offset as a fraction of its slice. */
function jitter(result: LayoutResult, i: number): { radius: number; angle: number } {
  const k = result.ids.indexOf(`f${i}`);
  const dx = (result.positions[2 * k] ?? Number.NaN) - C;
  const dy = (result.positions[2 * k + 1] ?? Number.NaN) - C;
  let t = Math.atan2(dy, dx);
  if (t < 0) t += TAU;
  return { radius: Math.hypot(dx, dy) / R, angle: (t - (i + 0.5) * SLICE) / SLICE };
}

const bytes = (a: Float32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

describe('for any seed', () => {
  it('a leaf stays within 10% of its ring radius and 30% of its slice', () => {
    const outside = SEEDS.flatMap((seed) => {
      const result = layoutPayload(STAR, { seed });
      return Array.from({ length: N }, (_, i) => ({ seed, i, ...jitter(result, i) })).filter(
        (j) =>
          !(j.radius >= 0.9 - EPS && j.radius <= 1.1 + EPS) ||
          !(j.angle >= -0.3 - EPS && j.angle <= 0.3 + EPS),
      );
    });
    expect(outside).toEqual([]);
  });

  it('the same seed twice gives byte-identical positions, and the root stays on the centre', () => {
    for (const seed of SEEDS) {
      const a = layoutPayload(STAR, { seed });
      const b = layoutPayload(STAR, { seed });
      expect(bytes(a.positions)).toEqual(bytes(b.positions));
      expect(Array.from(a.positions.subarray(0, 2))).toEqual([C, C]);
    }
  });
});

// Laid out on first use, inside a test, so a failing layout fails tests rather than collection.
let memo: { radius: number; angle: number }[] | undefined;
const sampled = (): { radius: number; angle: number }[] =>
  (memo ??= Array.from({ length: 200 }, (_, seed) => layoutPayload(STAR, { seed })).flatMap(
    (result) => Array.from({ length: N }, (_, i) => jitter(result, i)),
  ));

describe('across seeds 0..199 (3200 leaf samples)', () => {
  it('the radius jitter reaches both ends of its +-10% window', () => {
    const radii = sampled().map((s) => s.radius);
    expect(Math.min(...radii)).toBeLessThan(0.91);
    expect(Math.max(...radii)).toBeGreaterThan(1.09);
  });

  it('the angle jitter reaches both ends of its +-30% window', () => {
    const angles = sampled().map((s) => s.angle);
    expect(Math.min(...angles)).toBeLessThan(-0.27);
    expect(Math.max(...angles)).toBeGreaterThan(0.27);
  });

  it('angle and radius come from separate draws', () => {
    // One shared draw would make the two normalised jitters equal at every point.
    const samples = sampled();
    const same = samples.filter(
      (s) => Math.abs((s.radius - 0.9) / 0.2 - (s.angle + 0.3) / 0.6) < 0.01,
    );
    expect(same.length).toBeLessThan(samples.length * 0.1);
  });
});

// Arbitrary hierarchies over a small id alphabet: cycles, self-loops, several parents, dangling
// endpoints. Ids are unique (duplicate ids are part 2's render-report, not this layout's).
const TYPES = ['HAS_ENTRY', 'DEFINES', 'CALLS', undefined] as const;
function arbitraryPayload(next: () => number): GraphPayload {
  const n = next() % 13;
  const edges: GraphEdge[] = Array.from({ length: next() % 31 }, () => {
    const source = `n${next() % 14}`;
    const target = `n${next() % 14}`;
    const type = TYPES[next() % TYPES.length];
    return type === undefined ? { source, target } : { source, target, type };
  });
  return { seq: 0, nodes: Array.from({ length: n }, (_, i) => node(`n${i}`)), edges };
}

/** Why a result breaks the layout's invariants, one line each; empty when it holds them. */
function broken(p: GraphPayload, result: LayoutResult): string[] {
  const out: string[] = [];
  const real = new Set(p.nodes.map((n) => n.id));
  const synthetic = result.ids.filter((id) => !real.has(id));
  if (synthetic.length > 1) out.push(`${synthetic.length} synthetic points`);
  if (synthetic.some((id) => !id.includes('\u0000'))) out.push('a synthetic id without U+0000');
  if (result.positions.length !== 2 * result.ids.length) out.push('positions/ids length mismatch');
  for (let i = 0; i < result.ids.length; i++) {
    const dx = (result.positions[2 * i] ?? Number.NaN) - C;
    const dy = (result.positions[2 * i + 1] ?? Number.NaN) - C;
    if (!(Math.hypot(dx, dy) <= 2048 * 0.9 + EPS))
      out.push(`point ${i} outside 0.9 of the half-space`);
  }
  for (const index of result.links) {
    if (!(Number.isInteger(index) && index >= 0 && index < result.ids.length)) {
      out.push(`link index ${index} names no point`);
    }
  }
  return out;
}

describe('for any hierarchy and seed', () => {
  it('terminates, places points inside 90% of the half-space, and names only payload ids', () => {
    // Cycles, self-loops, several parents and dangling endpoints over 14 ids. Ids are unique:
    // duplicate ids belong to part 2's render-report, not to this layout.
    const next = lcg(35);
    const failures = Array.from({ length: 300 }, (_, run) => {
      const p = arbitraryPayload(next);
      const seed = SEEDS[run % SEEDS.length] ?? 0;
      return { run, seed, why: broken(p, layoutPayload(p, { seed })) };
    }).filter((f) => f.why.length > 0);
    expect(failures).toEqual([]);
  });
});
