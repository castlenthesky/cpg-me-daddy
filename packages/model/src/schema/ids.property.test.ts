/** U1.1.3 invariants ID-1..ID-4 over small adversarial alphabets (collisions and near-misses must happen). */
import { isDeepStrictEqual } from 'node:util';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { WorkspacePath } from '../paths';
import { makeNodeId, parseNodeId, type NodeIdParts } from './ids';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only brand forge.
const asWp = (s: string): WorkspacePath => s as WorkspacePath;
const word = (alphabet: string[], max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: max }).map((c) => c.join(''));

const pathSeg = word(['a', 'b', '.', '-', ':', '%', '#', '\\'], 3).filter(
  (s) => s !== '.' && s !== '..',
);
const filePath = fc.array(pathSeg, { minLength: 1, maxLength: 3 }).map((s) => asWp(s.join('/')));
const name = word(['a', '.', ':', '%', '#', '$', '<', '>', '[', ']'], 4);
const scope = fc.tuple(name, fc.array(name, { maxLength: 2 })).map(([h, t]) => [h, ...t] as const);
const kind = fc.constantFrom('METHOD', 'CALL', 'STMT', 'TYPE_DECL', 'A1');
const suffix = fc.oneof(
  fc.constant({}),
  fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map((ordinal) => ({ ordinal })),
  fc.oneof(word(['0', '1', '9', 'a', 'f'], 64)).map((bodyHash) => ({ bodyHash })),
);

const validParts: fc.Arbitrary<NodeIdParts> = fc.oneof(
  filePath.map((path): NodeIdParts => ({ form: 'file', path })),
  fc
    .oneof(filePath, fc.constant(asWp('.')))
    .map((path): NodeIdParts => ({ form: 'directory', path })),
  fc.tuple(filePath, kind, scope, suffix).map(([path, k, s, sfx]): NodeIdParts => ({
    form: 'scoped',
    path,
    kind: k,
    scope: [...s] as [string, ...string[]],
    ...sfx,
  })),
);

describe('node id properties', () => {
  it('ID-1: parse(make(p)) deep-equals p', () => {
    fc.assert(
      fc.property(validParts, (p) => {
        expect(parseNodeId(makeNodeId(p))).toStrictEqual(p);
      }),
      { numRuns: 500 },
    );
  });

  it('ID-7: every scoped id starts with its FILE id plus a colon', () => {
    fc.assert(
      fc.property(validParts, (p) => {
        if (p.form !== 'scoped') return;
        expect(makeNodeId(p).startsWith(`${makeNodeId({ form: 'file', path: p.path })}:`)).toBe(
          true,
        );
      }),
      { numRuns: 500 },
    );
  });

  const idChars = [
    'f',
    'i',
    'l',
    'e',
    'd',
    'r',
    ':',
    '.',
    '%',
    '2',
    '3',
    '5',
    'A',
    'E',
    '#',
    'a',
    '/',
  ];
  const tail = fc.array(fc.constantFrom(...idChars, 'M', 'T', 'H', 'O', 'D', '0', '1', '9', 'b'), {
    maxLength: 16,
  });
  // A real prefix plus a random tail, so a meaningful share of inputs parses and the canonical-form half runs.
  const prefixed = fc
    .tuple(fc.constantFrom('file:', 'dir:', 'file:a.ts:METHOD:', 'file:a.ts:CALL:f:'), tail)
    .map(([pre, t]) => pre + t.join(''));
  it('ID-2/ID-4: for prefixed arbitrary strings parse never throws, and a defined parse re-mints the identical string', () => {
    fc.assert(
      fc.property(prefixed, (s) => {
        const parsed = parseNodeId(s);
        expect(parsed === undefined ? s : makeNodeId(parsed)).toBe(s);
      }),
      { numRuns: 2000 },
    );
  });

  it('ID-2: one-character mutations of valid ids are rejected or canonical', () => {
    fc.assert(
      fc.property(validParts, fc.nat(), fc.constantFrom(...idChars), (p, at, ch) => {
        const id = makeNodeId(p);
        const i = at % id.length;
        const s = id.slice(0, i) + ch + id.slice(i + 1);
        const parsed = parseNodeId(s);
        expect(parsed === undefined ? s : makeNodeId(parsed)).toBe(s);
      }),
      { numRuns: 1000 },
    );
  });

  it('ID-4: parse never throws on arbitrary unicode, including NUL and lone surrogates', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 20 }), (s) => {
        expect(() => parseNodeId(s)).not.toThrow();
      }),
    );
  });

  it('ID-3: distinct valid parts give distinct ids', () => {
    fc.assert(
      fc.property(validParts, validParts, (a, b) => {
        const same = makeNodeId(a) === makeNodeId(b);
        expect(same).toBe(isDeepStrictEqual(a, b));
      }),
      { numRuns: 1000 },
    );
  });
});
