/**
 * U1.3.3 reserved edges (DQ-09). Expected values come from the design doc (INV-RE-*) and spec, typed
 * here as literals, never read back from RESERVED_EDGES.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CPG_SCHEMA,
  EDGE_TYPES,
  NODE_LABELS,
  RESERVED_EDGES,
  edgeSpec,
  nodeSpec,
  renderSchemaRegion,
  reservedEdgeSpec,
} from '../index';
import * as enums from './enums';

/** The whole-word matcher the no-emitter scan uses. `_` is a word char, so EVAL_TYPE_RELATION is out. */
const NAMES_EVAL_TYPE = (text: string): boolean => /\bEVAL_TYPE\b/.test(text);

const only = <T>(xs: readonly T[]): T => {
  const [x] = xs;
  if (x === undefined || xs.length !== 1) throw new Error('expected exactly one reserved edge');
  return x;
};

describe('RESERVED_EDGES (INV-RE-1..3)', () => {
  it('reserves exactly EVAL_TYPE: producer none-yet, admitted at U8 by DQ-09', () => {
    expect(RESERVED_EDGES.map((e) => e.type)).toEqual(['EVAL_TYPE']);
    const e = only(RESERVED_EDGES);
    expect([e.producer, e.admittedAt, e.decision]).toEqual(['none-yet', 'U8', 'DQ-09']);
  });

  it('is disjoint from the admitted edge types', () => {
    const admitted: string[] = EDGE_TYPES.map((e) => e.type);
    expect(RESERVED_EDGES.filter((r) => admitted.includes(r.type))).toEqual([]);
    expect(edgeSpec('EVAL_TYPE')).toBeUndefined();
  });

  it('reservedEdgeSpec finds a reservation by exact, case-sensitive type', () => {
    expect(reservedEdgeSpec('EVAL_TYPE')).toBe(only(RESERVED_EDGES));
    expect(reservedEdgeSpec('eval_type')).toBeUndefined();
    expect(reservedEdgeSpec('CALLS')).toBeUndefined();
    expect(reservedEdgeSpec('NOPE')).toBeUndefined();
  });

  it('is CALL -> SYMBOL, file-owned (not overlay), code-owned relation enum, target off :CPG', () => {
    const e = only(RESERVED_EDGES);
    expect([e.from, e.to]).toEqual([['CALL'], ['SYMBOL']]);
    expect(e.ownership).toBe('file-owned');
    expect(e.write).toBe('delete-create');
    expect(enums.EVAL_TYPE_RELATION).toEqual(['receiver-type']);
    const rel = e.properties.find((p) => p.name === 'relation');
    expect(rel?.enumValues).toBe(enums.EVAL_TYPE_RELATION);
    expect(rel?.golden).toBe('include');
    expect(e.properties.map((p) => p.owner)).toEqual(['code']);
    expect(nodeSpec('SYMBOL')?.cpgCoLabel).toBe(false);
    const labels: string[] = NODE_LABELS.map((n) => n.label);
    expect([...e.from, ...e.to].filter((l) => !labels.includes(l))).toEqual([]);
  });

  it('is carried by CPG_SCHEMA but not rendered into the generated region', () => {
    expect(CPG_SCHEMA.reservedEdges).toBe(RESERVED_EDGES);
    expect(renderSchemaRegion(CPG_SCHEMA)).not.toContain('EVAL_TYPE');
  });
});

describe('no emitter exists (INV-RE-6)', () => {
  it.each([
    ["type: 'EVAL_TYPE'", true],
    ['"EVAL_TYPE"', true],
    ['`EVAL_TYPE`', true],
    ['EVAL_TYPE_RELATION', false],
    ['XEVAL_TYPE', false],
  ])('matcher on %s -> %s', (text, expected) => {
    expect(NAMES_EVAL_TYPE(text)).toBe(expected);
  });

  const root = join(__dirname, '../../../..');
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      if (d.name === 'node_modules' || d.name === 'dist') return [];
      const p = join(dir, d.name);
      return d.isDirectory() ? walk(p) : [p];
    });
  const srcRoots = ['packages', 'apps'].flatMap((top) =>
    readdirSync(join(root, top), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, top, d.name, 'src')),
  );
  const sources = srcRoots
    .flatMap((r) => {
      try {
        return walk(r);
      } catch {
        return [];
      }
    })
    .filter((f) => /\.(ts|mts|cts|js|mjs)$/.test(f) && !/\.test(-d)?\.[a-z]+$/.test(f));

  it('only reserved.ts, among non-test sources, names EVAL_TYPE', () => {
    expect(sources.length).toBeGreaterThan(20); // anti-vacuity: the scan reached real code
    const hits = sources
      .filter((f) => NAMES_EVAL_TYPE(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split(sep).join('/'));
    expect(hits).toEqual(['packages/model/src/schema/reserved.ts']);
  });
});
