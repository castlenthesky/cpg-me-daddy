// The watch benchmark (U4.2.1 part b, BMO-60 line 3; controller decision 68). Sources: decision 68
// (T0 before each write, T3 the `at` of the first batch holding the path, p50/p95 of T3-T0 and of
// latencyMs.total, misses past 5 s, the enabled set beside the numbers, SIGINT then exit 130 and a
// last closed line), the sprint 23 design notes (the matching rule, the line formats), and C-WATCH
// budget_boundary.T1_T2 (trailingMs 100, ceilingMs 500 by default). Percentiles are nearest-rank
// (spike-report.mjs). Expected values are worked out by hand.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { benchLines, matchSaves } from './bench-watch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'bench-watch.mjs');
const CLI = join(HERE, '..', 'apps', 'cli', 'dist', 'main.js');
const F = 'src/f00.ts';

const change = (path, extra = {}) => ({ kind: 'changed', entry: 'file', path, ...extra });
const batch = (at, paths, total) => ({
  kind: 'batch',
  seq: 1,
  at,
  changes: paths.map((p) => (typeof p === 'string' ? change(p) : p)),
  write: { nodesWritten: 1, edgesWritten: 1, statementCount: 1 },
  latencyMs: { t0_t1: null, t1_t2: 1, t2_t3: total - 1, total },
});
const save = (t0, path = F) => ({ path, t0 });
const deepFreeze = (value) => {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

const m = (t0t3, total) => ({ t0t3, total });
const READY = { kind: 'ready', seq: 0, at: 1100, root: '/w', report: { files: [{ path: F }] } };
const WARNING = { kind: 'warning', seq: 1, at: 1110, message: `${F} not written` };
const MOVED_AWAY = change('src/f02.ts', { kind: 'moved', fromPath: F });

describe('matchSaves', () => {
  it.each([
    [
      'one batch each; ready and warning are not batches',
      [save(1000), save(3000)],
      [READY, WARNING, batch(1130, [F], 95), batch(3210, [F], 160)],
      [m(130, 95), m(210, 160)],
    ],
    [
      "a batch before T0 is an earlier save's",
      [save(2000)],
      [batch(1500, [F], 10), batch(2300, [F], 20)],
      [m(300, 20)],
    ],
    [
      'other paths and a move away are skipped',
      [save(1000)],
      [batch(1100, ['b.ts'], 5), batch(1180, [MOVED_AWAY], 6), batch(1250, ['b.ts', F], 40)],
      [m(250, 40)],
    ],
    ['at === T0 counts', [save(1000)], [batch(1000, [F], 7)], [m(0, 7)]],
    ['exactly 5000 ms later counts', [save(1000)], [batch(6000, [F], 9)], [m(5000, 9)]],
    ['5001 ms later is a miss', [save(1000)], [batch(6001, [F], 9)], [null]],
    ['no batch at all is a miss', [save(1000), save(2000)], [], [null, null]],
    [
      'two saves in one batch both take it',
      [save(1000), save(1400)],
      [batch(1700, [F], 250)],
      [m(700, 250), m(300, 250)],
    ],
    [
      'the first in stream order, not the earliest at',
      [save(1000)],
      [batch(1300, [F], 30), batch(1200, [F], 20)],
      [m(300, 30)],
    ],
    [
      'each save looks for its own path',
      [save(1000, 'a.ts'), save(1000, 'b.ts')],
      [batch(1100, ['b.ts'], 11), batch(1200, ['a.ts'], 12)],
      [m(200, 12), m(100, 11)],
    ],
  ])('%s', (_what, saves, events, expected) => {
    expect(matchSaves(deepFreeze(saves), deepFreeze(events))).toEqual(expected);
  });

  it('honours missMs', () => {
    const events = [batch(1150, [F], 3)];
    expect([matchSaves([save(1000)], events, 100), matchSaves([save(1000)], events, 150)]).toEqual([
      [null],
      [m(150, 3)],
    ]);
  });
});

describe('benchLines', () => {
  const base = {
    file: F,
    spacingMs: 1000,
    trailingMs: 100,
    ceilingMs: 500,
    consumers: ['memory', 'panel'],
    platform: 'linux 6.1.0 x64',
    cpu: 'Xeon x 8',
  };

  it('the numbers, each beside the enabled set; misses counted', () => {
    const matches = [m(210, 160), m(130, 95), null, m(170, 120), m(150, 110)];
    // T0->T3 sorted 130 150 170 210: p50 rank 2 = 150, p95 rank 4 = 210.
    // total sorted 95 110 120 160: p50 rank 2 = 110, p95 rank 4 = 160.
    expect(benchLines(deepFreeze({ ...base, matches }))).toEqual([
      'cpg watch benchmark: 5 saves of src/f00.ts, 1000 ms apart; trailingMs 100, ceilingMs 500',
      'platform: linux 6.1.0 x64; cpu: Xeon x 8',
      'T0->T3: p50 150 ms, p95 210 ms, n=4; consumers: memory, panel',
      'latencyMs.total: p50 110 ms, p95 160 ms, n=4; consumers: memory, panel',
      'misses: 1 of 5 (no batch within 5000 ms)',
    ]);
  });

  // Round two (review 10): under 20 samples the nearest-rank p95 is the largest.
  it('p95 of twenty is the 19th, not the largest', () => {
    const matches = [null, ...Array.from({ length: 20 }, (_, i) => m((20 - i) * 10, 20 - i))];
    // T0->T3 10..200: p50 rank 10 = 100, p95 rank 19 = 190. total 1..20: p50 10, p95 19.
    expect(benchLines({ ...base, consumers: ['memory'], matches }).slice(2)).toEqual([
      'T0->T3: p50 100 ms, p95 190 ms, n=20; consumers: memory',
      'latencyMs.total: p50 10 ms, p95 19 ms, n=20; consumers: memory',
      'misses: 1 of 21 (no batch within 5000 ms)',
    ]);
  });

  it('every save missed: nothing is measured, the enabled set is still printed', () => {
    expect(benchLines({ ...base, consumers: ['memory'], matches: [null, null] })).toEqual([
      'cpg watch benchmark: 2 saves of src/f00.ts, 1000 ms apart; trailingMs 100, ceilingMs 500',
      'platform: linux 6.1.0 x64; cpu: Xeon x 8',
      'T0->T3: not measured: every save missed; consumers: memory',
      'latencyMs.total: not measured: every save missed; consumers: memory',
      'misses: 2 of 2 (no batch within 5000 ms)',
    ]);
  });
});

// The spawn path, once (decision 68: a test with a small save count). Each child runs in its own
// process group, killed in afterEach, so a failing case never leaves a `cpg watch` behind. Round
// two (review 11): the group is killed even after the bench itself exited (its child may not have),
// and the caller's CPG_* variables never reach it.
const children = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the whole group is gone
    }
  }
});
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CPG_')));

function bench(args) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { detached: true, env: ENV });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('bench-watch.mjs, spawned', () => {
  it.each([['0'], ['x'], ['-3'], ['1.5']])(
    "--saves '%s' exits 2 before anything runs",
    async (n) => {
      const r = await bench(['--saves', n]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`bench-watch: --saves must be a positive integer, got '${n}'`);
      expect(r.stdout).toBe('');
    },
  );

  it('two saves against the built cpg: both matched, exit 130 and a last closed line', async () => {
    expect(existsSync(CLI)).toBe(true);
    const r = await bench(['--saves', '2']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(
      'cpg watch benchmark: 2 saves of src/f00.ts, 1000 ms apart; trailingMs 100, ceilingMs 500',
    );
    expect(lines[1]).toMatch(/^platform: \S+ \S+ \S+; cpu: .+ x \d+$/);
    expect(lines[2]).toMatch(/^T0->T3: p50 \d+ ms, p95 \d+ ms, n=2; consumers: memory$/);
    expect(lines[3]).toMatch(/^latencyMs\.total: p50 \d+ ms, p95 \d+ ms, n=2; consumers: memory$/);
    expect(lines[4]).toBe('misses: 0 of 2 (no batch within 5000 ms)');
    expect(lines[5]).toBe('exit: 130 after SIGINT; last event closed');
  }, 60_000);
});
