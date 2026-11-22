import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyGraphDelta,
  makeNodeId,
  readNodeLocation,
  readNodeResolution,
  toWorkspacePath,
  validatePayload,
  type EdgeResolution,
  type GraphNode,
  type GraphPayload,
  type NodeLocation,
} from './index';

const NUL = '\u0000';
// Small alphabet with the interesting ids so collisions and defects occur.
const weirdId = fc.oneof(
  fc.constantFrom('a', 'b', 'c', '', `a${NUL}`),
  fc.constantFrom('a', 'b', 'c'),
  fc.integer(),
  fc.constant('1'), // string '1' beside integer 1: duplicates must not be keyed by String(id)
  fc.constant(1),
);
const anyData = fc.dictionary(fc.constantFrom('location', 'resolution', 'zz'), fc.anything(), {
  maxKeys: 3,
});
const looseNode = fc.record({
  id: weirdId,
  type: fc.constant('METHOD'),
  data: fc.oneof(anyData, fc.anything()),
});
const looseEdge = fc.record({
  source: weirdId,
  target: weirdId,
  data: fc.oneof(anyData, fc.anything()),
});
const loosePayload = fc.record({
  seq: fc.oneof(fc.integer({ min: -3, max: 5 }), fc.double({ noDefaultInfinity: false })),
  nodes: fc.array(looseNode, { maxLength: 7 }),
  edges: fc.array(looseEdge, { maxLength: 7 }),
});
// The generators deliberately build ill-typed ids; the cast mirrors JSON arriving from outside.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON-shaped untrusted input.
const asPayload = (v: unknown) => v as GraphPayload;

const isUsableId = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && !v.includes(NUL);

describe('validatePayload properties', () => {
  it('P-1 never throws, never mutates, and is deterministic on arbitrary payloads', () => {
    fc.assert(
      fc.property(
        loosePayload,
        fc.option(fc.integer({ min: -3, max: 5 }), { nil: undefined }),
        (raw, prev) => {
          const p = asPayload(raw);
          const before = structuredClone(raw);
          const opts = prev === undefined ? undefined : { previousSeq: prev };
          const first = validatePayload(p, opts);
          expect(validatePayload(p, opts)).toEqual(first);
          expect(raw).toEqual(before);
          // detail is for humans: only require that it is a non-empty string, never its wording.
          first.forEach((d) => {
            expect(typeof d.detail).toBe('string');
            expect(d.detail.length).toBeGreaterThan(0);
          });
        },
      ),
    );
  });

  it('P-2 duplicate-node-id count is nodes.length minus distinct ids (V-2, every id, usable or not)', () => {
    fc.assert(
      fc.property(loosePayload, (raw) => {
        const dups = validatePayload(asPayload(raw)).filter((d) => d.code === 'duplicate-node-id');
        expect(dups).toHaveLength(raw.nodes.length - new Set(raw.nodes.map((n) => n.id)).size);
      }),
    );
  });

  it('P-3 dangling-edge reports exactly the usable endpoints missing from the node set, and keeps edges', () => {
    fc.assert(
      fc.property(loosePayload, (raw) => {
        const p = asPayload(raw);
        const ids = new Set(raw.nodes.map((n) => n.id));
        const want: string[] = [];
        raw.edges.forEach((e, i) => {
          if (isUsableId(e.source) && !ids.has(e.source)) want.push(`${i}:source`);
          if (isUsableId(e.target) && !ids.has(e.target)) want.push(`${i}:target`);
        });
        const got = validatePayload(p)
          .filter((d) => d.code === 'dangling-edge')
          .map((d) => `${d.edgeIndex}:${d.endpoint}`);
        expect(got).toEqual(want);
        expect(p.edges).toHaveLength(raw.edges.length);
      }),
    );
  });
});

// Independent oracle for D7: a hand-written predicate, not the implementation.
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : undefined;
const nonNegInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const rangeOk = (r: unknown): boolean => {
  const x = rec(r);
  if (x === undefined) return false;
  const { startRow: sr, startColumn: sc, endRow: er, endColumn: ec } = x;
  if (!(nonNegInt(sr) && nonNegInt(sc) && nonNegInt(er) && nonNegInt(ec))) return false;
  return sr < er || (sr === er && sc <= ec);
};
const pathOk = (p: unknown) =>
  typeof p === 'string' &&
  p !== '.' &&
  p !== '' &&
  !p.includes(NUL) &&
  p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const locationOk = (l: unknown): boolean => {
  const x = rec(l);
  if (x === undefined) return false;
  const nr = x['nameRange'];
  return pathOk(x['filePath']) && rangeOk(x['range']) && (nr == null || rangeOk(nr));
};

const validRange = fc.tuple(fc.nat(50), fc.nat(50), fc.nat(50), fc.nat(50)).map(([a, b, c, d]) => {
  const [sr, er] = a <= c ? [a, c] : [c, a];
  const [sc, ec] = sr === er && b > d ? [d, b] : [b, d];
  return { startRow: sr, startColumn: sc, endRow: er, endColumn: ec };
});
const pathArb = fc.constantFrom('a.ts', 'src/x.ts', 'a/b/c.py', 'a b/é.ts');
const pathMaybeBad = fc.constantFrom(
  'a.ts',
  '/abs.ts',
  '.',
  '',
  'a//b',
  './a',
  'a/../b',
  `a${NUL}`,
);
const rangeMaybeBad = fc.oneof(
  validRange,
  fc.record({
    startRow: fc.integer({ min: -2, max: 3 }),
    startColumn: fc.constantFrom(0, 1.5, 2),
    endRow: fc.integer({ min: -2, max: 3 }),
    endColumn: fc.constantFrom(0, 2, Number.NaN),
  }),
  fc.constantFrom(null, undefined, 'r', [], {}),
);
const locationCandidate = fc.oneof(
  fc.anything(),
  fc.record(
    { filePath: pathMaybeBad, range: rangeMaybeBad, nameRange: rangeMaybeBad },
    { requiredKeys: ['filePath', 'range'] },
  ),
  fc.record({ filePath: pathArb, range: validRange }),
);

const nodeWith = (location: unknown): GraphNode => ({
  id: 'n',
  type: 'METHOD',
  data: { location },
});

describe('read accessor properties', () => {
  it('P-4 readNodeLocation is absent iff undefined/null, present iff the D7 oracle holds, else malformed', () => {
    fc.assert(
      fc.property(locationCandidate, (loc) => {
        const got = readNodeLocation(nodeWith(loc));
        const want = loc == null ? 'absent' : locationOk(loc) ? 'present' : 'malformed';
        expect(got.state).toBe(want);
      }),
      { numRuns: 500 },
    );
  });

  it('P-5 a valid location or resolution round-trips to its declared-key projection', () => {
    fc.assert(
      fc.property(
        pathArb,
        validRange,
        fc.option(validRange, { nil: undefined }),
        fc.dictionary(fc.constantFrom('junk', 'extra'), fc.jsonValue(), { maxKeys: 2 }),
        (filePath, range, nameRange, extra) => {
          // Extra keys inside the nested ranges are stripped too (design §5: only declared keys).
          const stored = {
            ...extra,
            filePath,
            range: { ...range, junk: 1 },
            ...(nameRange ? { nameRange: { ...nameRange, junk: 2 } } : {}),
          };
          const value: NodeLocation = {
            filePath: toWorkspacePath('/w', `/w/${filePath}`),
            range,
            ...(nameRange ? { nameRange } : {}),
          };
          expect(readNodeLocation(nodeWith(stored))).toEqual({ state: 'present', value });
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (status, resolvedBy, confidence, reason) => {
          const value: EdgeResolution = {
            status,
            resolvedBy,
            ...(confidence === undefined ? {} : { confidence }),
            ...(reason === undefined ? {} : { reason }),
          };
          const n: GraphNode = {
            id: 'n',
            type: 'CALL',
            data: { resolution: { ...value, junk: 1 } },
          };
          expect(readNodeResolution(n)).toEqual({ state: 'present', value });
        },
      ),
    );
  });
});

const fileId = (p: string) => makeNodeId({ form: 'file', path: toWorkspacePath('/w', `/w/${p}`) });

describe('clean payloads', () => {
  const paths = fc.uniqueArray(fc.constantFrom('a.ts', 'b.ts', 'c/d.ts', 'e.py', 'f/g/h.ts'), {
    minLength: 1,
    maxLength: 5,
  });
  it('P-6 validates clean, and stays clean after a delta that adds a node and edges between existing nodes', () => {
    fc.assert(
      fc.property(paths, fc.nat(4), fc.nat(4), validRange, (ps, i, j, range) => {
        const ids = ps.map(fileId);
        const nodes = ps.map((p, k): GraphNode => ({
          id: ids.at(k) ?? '',
          type: 'FILE',
          data: { location: { filePath: p, range } },
        }));
        const e = { source: ids.at(i % ids.length) ?? '', target: ids.at(j % ids.length) ?? '' };
        const p0: GraphPayload = { seq: 0, nodes, edges: [e] };
        expect(validatePayload(p0)).toEqual([]);
        const r = applyGraphDelta(p0, {
          seq: 1,
          file: toWorkspacePath('/w', '/w/new.ts'),
          revision_id: 'r',
          producer: 'code',
          addedNodes: [{ id: 'extra-node', type: 'X-FUTURE' }],
          addedEdges: [{ source: 'extra-node', target: ids.at(0) ?? '' }, e],
          removedNodeIds: [],
        });
        expect(r.outcome).toBe('applied');
        expect(
          r.outcome === 'applied'
            ? validatePayload(r.payload, { previousSeq: 0 })
            : ['not applied'],
        ).toEqual([]);
      }),
    );
  });
});
