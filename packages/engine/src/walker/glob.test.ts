// The glob subset documented in glob.ts. Expected values come from that dialect's rules.

import { describe, expect, it } from 'vitest';
import { compileMatcher } from './glob';

type Case = readonly [pattern: string, path: string, isDirectory: boolean, matches: boolean];

const CASES: readonly Case[] = [
  // `**/x/**` prunes the directory itself, at any depth.
  ['**/node_modules/**', 'node_modules', true, true],
  ['**/node_modules/**', 'a/b/node_modules', true, true],
  ['**/node_modules/**', 'a/node_modules/x.js', false, true],
  ['**/node_modules/**', 'node_modules_old', true, false],
  // `*` never crosses a segment; `?` is exactly one character.
  ['/src/*.ts', 'src/a.ts', false, true],
  ['/src/*.ts', 'src/a/b.ts', false, false],
  ['/a?.py', 'ab.py', false, true],
  ['/a?.py', 'abc.py', false, false],
  ['/a?.py', 'a/.py', false, false],
  // A leading `/` anchors to the root; without it the pattern matches at any depth.
  ['/build', 'build', true, true],
  ['/build', 'pkg/build', true, false],
  ['build', 'pkg/build', true, true],
  // A trailing `/` is directory-only.
  ['build/', 'build', false, false],
  ['build/', 'build', true, true],
  // Regex metacharacters are literal.
  ['**/*.min.js', 'vendor/jquery.min.js', false, true],
  ['**/*.min.js', 'vendor/jqueryxminxjs', false, false],
  ['**/*.d.ts', 'types/index.d.ts', false, true],
  ['/(a)+.ts', '(a)+.ts', false, true],
  // `**` matches zero segments.
  ['/a/**/b.ts', 'a/b.ts', false, true],
  ['/a/**/b.ts', 'a/x/y/b.ts', false, true],
];

describe('compileMatcher', () => {
  it.each(CASES)('%s vs %s (dir=%s) -> %s', (pattern, path, isDirectory, matches) => {
    expect(compileMatcher([pattern]).test(path, isDirectory)).toBe(matches);
  });

  it('a set matches when any pattern does, and the empty set matches nothing', () => {
    const set = compileMatcher(['/a.ts', '/b.ts']);
    expect([set.test('a.ts', false), set.test('b.ts', false), set.test('c.ts', false)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(compileMatcher([]).test('a.ts', false)).toBe(false);
  });
});
