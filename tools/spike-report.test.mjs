// What the spikes report (U3.1.2; controller decisions 34 and 41). Expected values worked out by hand.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { percentile, reportLines } from './spike-report.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'spike-report.mjs');
const run = (path) => spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' });
const upTo = (n) => Array.from({ length: n }, (_, index) => index + 1);

describe('percentile (nearest rank)', () => {
  it.each([
    ['the median of five', [5, 1, 4, 2, 3], 50, 3],
    ['of four: the lower of the middle two', [4, 1, 3, 2], 50, 2],
    ['p95 of twenty: the 19th', upTo(20), 95, 19],
    ['p95 of ten: the 10th', upTo(10), 95, 10],
    // 0.07 * 100 is 7.000000000000001.
    ['p7 of a hundred: the 7th', upTo(100), 7, 7],
    ['p100: the largest', [2, 30, 4], 100, 30],
    ['compares numbers, not text', [10, 9, 100], 50, 10],
    ['one sample', [8], 95, 8],
  ])('%s', (_what, samples, percent, expected) => {
    const before = [...samples];
    expect(percentile(samples, percent)).toBe(expected);
    expect(samples).toEqual(before);
  });

  it('is undefined for no samples', () => {
    expect(percentile([], 50)).toBeUndefined();
  });
});

const conditions = { vscode: '1.2.3', webgl: 'SwiftShader' };

describe('reportLines', () => {
  it('one line of conditions, then one per series', () => {
    const series = [
      { name: 'graph', samples: upTo(20).map((n) => n / 2), first: 120.004 },
      { name: 'transfer 10k', samples: [3, 1, 2], bytes: 2500000 },
      { name: 'plain', samples: [1.25, 1.5] },
    ];
    expect(reportLines({ conditions, series })).toEqual([
      'vscode: 1.2.3; webgl: SwiftShader',
      'graph: p50 5.00 ms, p95 9.50 ms, max 10.00 ms, n=20, first 120.00 ms',
      'transfer 10k: p50 2.00 ms, p95 3.00 ms, max 3.00 ms, n=3, 2500000 bytes of JSON',
      'plain: p50 1.25 ms, p95 1.50 ms, max 1.50 ms, n=2',
    ]);
  });

  it('a failure is said, after what was measured before it, and nothing is made up', () => {
    const series = [
      { name: 'transfer 500k', samples: [], bytes: 9, failed: 'no answer in 120000 ms' },
      { name: 'transfer 100k', samples: [4], failed: 'RangeError: Invalid string length' },
      { name: 'first only', samples: [], first: 7 },
    ];
    expect(reportLines({ conditions, series })).toEqual([
      'vscode: 1.2.3; webgl: SwiftShader',
      'transfer 500k: not measured: no answer in 120000 ms',
      'transfer 100k: p50 4.00 ms, p95 4.00 ms, max 4.00 ms, n=1',
      'transfer 100k: not measured: RangeError: Invalid string length',
      'first only: not measured: no samples',
    ]);
  });
});

describe('the script', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spike-report-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it('prints the lines of the file it is given', () => {
    const measured = { conditions, series: [{ name: 'graph', samples: [1, 2, 3] }] };
    const path = join(dir, 'samples.json');
    writeFileSync(path, JSON.stringify(measured));
    const { status, stdout } = run(path);
    expect([status, stdout.trimEnd().split('\n')]).toEqual([0, reportLines(measured)]);
  });

  it.each([
    ['a missing file', undefined],
    ['a file that is not JSON', '{'],
    ['a file with no series', JSON.stringify({ conditions, series: [] })],
  ])('fails on %s', (_what, text) => {
    const path = join(dir, 'samples.json');
    if (text !== undefined) writeFileSync(path, text);
    expect(run(path).status).not.toBe(0);
  });
});
