import { describe, expect, it } from 'vitest';
import { expandBraces, extractCoords, globToRegExp } from './check-archive-coords.mjs';

describe('expandBraces', () => {
  it('expands every brace set into each combination', () => {
    expect(expandBraces('a/{b,c}/x{1,2}.ts')).toEqual([
      'a/b/x1.ts',
      'a/b/x2.ts',
      'a/c/x1.ts',
      'a/c/x2.ts',
    ]);
  });

  it('keeps an empty alternative (docker/falkordb{,.dev}.yml)', () => {
    expect(expandBraces('docker/falkordb{,.dev}.yml')).toEqual([
      'docker/falkordb.yml',
      'docker/falkordb.dev.yml',
    ]);
  });
});

describe('globToRegExp', () => {
  it('lets ** cross directories but not *', () => {
    expect(globToRegExp('pkg/**').test('pkg/a/b.ts')).toBe(true);
    expect(globToRegExp('pkg/*.ts').test('pkg/a.ts')).toBe(true);
    expect(globToRegExp('pkg/*.ts').test('pkg/a/b.ts')).toBe(false);
    expect(globToRegExp('pkg/*.ts').test('pkgXa.ts')).toBe(false);
  });
});

describe('extractCoords', () => {
  it('reads sha coordinates and drops a :line suffix and trailing punctuation', () => {
    const text = 'see `27361a3:src/a.ts:224`, and 21754b4:b/c.ts.\nnot a coord: 12:30';
    expect(extractCoords(text)).toEqual([
      { ref: '27361a3', path: 'src/a.ts', line: 1 },
      { ref: '21754b4', path: 'b/c.ts', line: 1 },
    ]);
  });

  it('maps declared shorthand letters and ignores undeclared ones', () => {
    const text = '- { c: "M:packages/x.ts, M:src/y.ts", why: "Q:not/a.ts" }';
    expect(extractCoords(text, { M: '27361a3' })).toEqual([
      { ref: '27361a3', path: 'packages/x.ts', line: 1 },
      { ref: '27361a3', path: 'src/y.ts', line: 1 },
    ]);
  });
});
