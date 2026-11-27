/**
 * Controller decision 89: makeSymbolFqn over small adversarial alphabets, where a renderer that does not
 * escape collides. SYMBOL.fqn is UNIQUE and a SYMBOL is merged on it, so distinct parts must give
 * distinct fqns (04-schema.yaml SYMBOL.fqn), and an fqn extends its enclosing declaration's fqn.
 */
import { isDeepStrictEqual } from 'node:util';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { WorkspacePath } from '../paths';
import { makeSymbolFqn, type SymbolDescriptor, type SymbolFqnParts } from './symbols';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only brand forge.
const asWp = (s: string): WorkspacePath => s as WorkspacePath;
const SUFFIX = { namespace: '/', type: '#', term: '.', method: '().' } as const;
const word = (alphabet: string[], max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: max }).map((c) => c.join(''));

const name = word(['a', 'b', '`', '/', '#', '.', '(', ')', ' ', 'é'], 4);
const kind = fc.constantFrom('namespace', 'type', 'term', 'method');
const descriptor: fc.Arbitrary<SymbolDescriptor> = fc.record({ kind, name });
const descriptors = fc.array(descriptor, { maxLength: 3 });
const pathSeg = word(['a', '`', '.', ':', '#'], 3).filter((s) => s !== '.' && s !== '..');
const path = fc.array(pathSeg, { minLength: 1, maxLength: 2 }).map((s) => asWp(s.join('/')));
const parts: fc.Arbitrary<SymbolFqnParts> = fc.oneof(
  fc.record({ form: fc.constant('local' as const), path, descriptors }),
  fc.record({
    form: fc.constant('external' as const),
    scheme: word(['a', 'b', '-'], 2),
    package: word(['a', ':', '/', '@'], 3),
    descriptors,
  }),
);

/** Half the pairs are deep copies, so "equal parts give one fqn" is exercised too. */
const pair: fc.Arbitrary<[SymbolFqnParts, SymbolFqnParts]> = fc.oneof(
  fc.tuple(parts, parts),
  parts.map((p): [SymbolFqnParts, SymbolFqnParts] => [p, structuredClone(p)]),
);

/** Two parts a renderer without escaping maps to one string: one name holding a suffix vs two names. */
const merged: fc.Arbitrary<[SymbolFqnParts, SymbolFqnParts]> = fc
  .tuple(path, kind, word(['a', 'b'], 2), word(['a', 'b'], 2))
  .map(([p, k, x, y]) => [
    { form: 'local', path: p, descriptors: [{ kind: k, name: `${x}${SUFFIX[k]}${y}` }] },
    {
      form: 'local',
      path: p,
      descriptors: [
        { kind: k, name: x },
        { kind: k, name: y },
      ],
    },
  ]);

describe('makeSymbolFqn properties', () => {
  it('distinct parts give distinct fqns', () => {
    fc.assert(
      fc.property(pair, ([a, b]) => {
        expect(makeSymbolFqn(a) === makeSymbolFqn(b)).toBe(isDeepStrictEqual(a, b));
      }),
      { numRuns: 2000 },
    );
  });

  it('a name holding a suffix never collides with the two names it splits into', () => {
    fc.assert(
      fc.property(merged, ([one, two]) => {
        expect(makeSymbolFqn(one)).not.toBe(makeSymbolFqn(two));
      }),
      { numRuns: 300 },
    );
  });

  it("an fqn extends its enclosing declaration's fqn (the owner alone for the outermost)", () => {
    fc.assert(
      fc.property(parts, (p) => {
        const outer = { ...p, descriptors: p.descriptors.slice(0, -1) };
        expect(makeSymbolFqn(p).startsWith(makeSymbolFqn(outer))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('a local fqn starts with a backtick and an external one never does', () => {
    fc.assert(
      fc.property(parts, (p) => {
        expect(makeSymbolFqn(p).startsWith('`')).toBe(p.form === 'local');
      }),
      { numRuns: 500 },
    );
  });

  it('the generators reach the hostile shapes (anti-vacuity)', () => {
    const sample = fc.sample(pair, { numRuns: 2000, seed: 28 });
    const names = sample.flatMap(([a, b]) =>
      [...a.descriptors, ...b.descriptors].map((d) => d.name),
    );
    expect(names.some((n) => n.includes('`'))).toBe(true);
    expect(names.some((n) => /^[ab]+$/.test(n))).toBe(true);
    expect(sample.some(([a, b]) => isDeepStrictEqual(a, b))).toBe(true);
    expect(sample.some(([a, b]) => !isDeepStrictEqual(a, b))).toBe(true);
    expect(sample.some(([a]) => a.form === 'external')).toBe(true);
    expect(sample.some(([a]) => a.form === 'local' && a.path.includes('`'))).toBe(true);
  });
});
