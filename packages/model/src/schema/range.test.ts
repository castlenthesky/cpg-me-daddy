/**
 * Controller decision 89: formatRange. Expected strings come from fixtures/ladder/README.md ("1-based lines,
 * 0-based UTF-16 columns and an exclusive end"; "a two-line file ends at `3:0` and an empty file is
 * `1:0-1:0`") and from hand-counted ladder ranges, never from running the code.
 */
import { describe, expect, it } from 'vitest';

import type { SourceRange } from '../index';
import { formatRange } from './range';

const r = (
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): SourceRange => ({
  startRow,
  startColumn,
  endRow,
  endColumn,
});

describe('formatRange', () => {
  const rows: [string, SourceRange, string][] = [
    ['an empty file (ladder README)', r(0, 0, 0, 0), '1:0-1:0'],
    ['a two-line file ends at 3:0 (ladder README)', r(0, 0, 2, 0), '1:0-3:0'],
    ['rung 05 class Greeter (rows 0-4, cols 0-12)', r(0, 0, 4, 12), '1:0-5:12'],
    ['rung 05 MEMBER greeting (row 1, cols 4-22)', r(1, 4, 1, 22), '2:4-2:22'],
    ['rung 04 first helper() call (row 5, cols 4-12)', r(5, 4, 5, 12), '6:4-6:12'],
    ['distinct values in every field', r(9, 3, 41, 17), '10:3-42:17'],
    ['an empty range mid-line', r(6, 8, 6, 8), '7:8-7:8'],
    ['a large row and column', r(99999, 1234, 100000, 0), '100000:1234-100001:0'],
  ];
  it.each(rows)('%s', (_name, range, want) => {
    expect(formatRange(range)).toBe(want);
  });

  const bad: [string, SourceRange][] = [
    ['a negative start row', r(-1, 0, 0, 0)],
    ['a negative start column', r(0, -1, 0, 0)],
    ['a negative end row', r(0, 0, -1, 0)],
    ['a negative end column', r(0, 0, 0, -1)],
    ['a negative end column on a later row', r(0, 0, 1, -1)],
    ['a fractional start row', r(0.5, 0, 1, 0)],
    ['a fractional start column', r(0, 1.5, 1, 0)],
    ['a fractional end row', r(0, 0, 1.5, 0)],
    ['a fractional end column', r(0, 0, 1, 0.5)],
    ['NaN', r(0, Number.NaN, 1, 0)],
    ['Infinity', r(0, 0, Number.POSITIVE_INFINITY, 0)],
    ['an unsafe integer', r(0, 0, 2 ** 53, 0)],
    ['the end on an earlier row', r(3, 0, 2, 9)],
    ['the end earlier on the same row', r(3, 5, 3, 4)],
  ];
  it.each(bad)('throws on %s', (_name, range) => {
    expect(() => formatRange(range)).toThrow(/^invalid source range: /);
  });

  it('an end on a later row may have a smaller column', () => {
    expect(formatRange(r(3, 9, 4, 0))).toBe('4:9-5:0');
  });

  it('reads a frozen range without changing it (C-MODEL I-11)', () => {
    const range = Object.freeze(r(2, 1, 3, 4));
    expect(formatRange(range)).toBe('3:1-4:4');
    expect(range).toEqual(r(2, 1, 3, 4));
  });
});
