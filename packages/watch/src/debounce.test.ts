import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimerApi } from './contract';
import { ChangeBatcher, type ChangeBatcherOptions } from './debounce';

// Expected values are C-WATCH budget_boundary.T1_T2 (100 ms trailing, 500 ms ceiling, a ceiling so a
// burst cannot delay a batch indefinitely) and the archive's window rules
// (e45574f:packages/engine/test/unit/watch/debounce.test.ts), written out by hand. Every test runs on
// the fake clock below: zero real sleeps (decision 45).

interface FakeTimer {
  readonly fn: () => void;
  readonly dueAt: number;
}

/** A fake TimerApi. `advance` fires each due timer in due-time order (ties: the earlier armed). */
function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const armed = new Map<number, FakeTimer>();
  const timers: TimerApi = {
    setTimeout(fn, ms) {
      const handle = nextHandle++;
      armed.set(handle, { fn, dueAt: now + ms });
      return handle;
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') armed.delete(handle);
    },
  };
  return {
    timers,
    now: () => now,
    armedCount: () => armed.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const [due] = [...armed]
          .filter(([, timer]) => timer.dueAt <= target)
          .toSorted(([ha, a], [hb, b]) => a.dueAt - b.dueAt || ha - hb);
        if (due === undefined) break;
        armed.delete(due[0]);
        now = due[1].dueAt;
        due[1].fn();
      }
      now = target;
    },
  };
}

interface Flush {
  readonly at: number;
  readonly items: readonly string[];
}

/** A batcher on a fake clock. Each flush is kept with its time and the very array onFlush got. */
function harness(options: Omit<ChangeBatcherOptions, 'timers'> = {}, onFlush?: () => void) {
  const clock = fakeClock();
  const flushes: Flush[] = [];
  const batcher: ChangeBatcher<string> = new ChangeBatcher<string>(
    (items) => {
      flushes.push({ at: clock.now(), items });
      onFlush?.();
    },
    { ...options, timers: clock.timers },
  );
  return { clock, flushes, batcher };
}

/** Adds `count` items named `${prefix}0`, `${prefix}1`, ..., one every `everyMs`. */
function addEvery(h: ReturnType<typeof harness>, count: number, everyMs: number, prefix = 'e') {
  for (let i = 0; i < count; i++) {
    h.batcher.add(`${prefix}${i}`);
    h.clock.advance(everyMs);
  }
}

const names = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChangeBatcher', () => {
  it('flushes the window 100 ms after its only add, and not before', () => {
    const h = harness();
    h.batcher.add('a.ts');
    h.clock.advance(99);
    expect(h.flushes).toEqual([]);
    h.clock.advance(1);
    expect(h.flushes).toEqual([{ at: 100, items: ['a.ts'] }]);
    expect(h.clock.armedCount()).toBe(0);
  });

  it('a later add restarts the 100 ms trailing window', () => {
    const h = harness();
    h.batcher.add('a.ts');
    h.clock.advance(80);
    h.batcher.add('b.ts');
    h.clock.advance(80);
    expect(h.flushes).toEqual([]);
    h.clock.advance(20);
    expect(h.flushes).toEqual([{ at: 180, items: ['a.ts', 'b.ts'] }]);
  });

  it('under continuous activity each window flushes 500 ms after its own first add', () => {
    const h = harness();
    // An add every 80 ms keeps re-arming the trailing timer, so only the ceiling can flush. Window 1
    // opens at 0 (adds 0..480), window 2 at 560 (adds 560..1040), window 3 at 1120.
    addEvery(h, 16, 80);
    expect(h.flushes).toEqual([
      { at: 500, items: names('e', 0, 6) },
      { at: 1060, items: names('e', 7, 13) },
    ]);
    h.clock.advance(20);
    expect(h.flushes[2]).toEqual({ at: 1300, items: ['e14', 'e15'] });
  });

  it('hands over every item in arrival order: nothing is keyed or merged', () => {
    const h = harness();
    h.batcher.add('a.ts');
    h.batcher.add('b.ts');
    h.batcher.add('a.ts');
    h.clock.advance(100);
    expect(h.flushes).toEqual([{ at: 100, items: ['a.ts', 'b.ts', 'a.ts'] }]);
  });

  it('uses the trailingMs and ceilingMs it is given', () => {
    const h = harness({ trailingMs: 30, ceilingMs: 70 });
    h.batcher.add('a.ts');
    h.clock.advance(29);
    expect(h.flushes).toEqual([]);
    h.clock.advance(1);
    // Window 2 opens at 30, so its ceiling is at 100: the adds at 30, 50, 70 and 90 are in it.
    addEvery(h, 5, 20, 'c');
    expect(h.flushes).toEqual([
      { at: 30, items: ['a.ts'] },
      { at: 100, items: names('c', 0, 3) },
    ]);
  });

  it('a flush closes its window: the old ceiling never fires into the next one', () => {
    const h = harness();
    h.batcher.add('a.ts');
    h.clock.advance(450);
    h.batcher.add('b.ts');
    h.clock.advance(50);
    expect(h.flushes).toEqual([{ at: 100, items: ['a.ts'] }]);
    h.clock.advance(50);
    expect(h.flushes).toEqual([
      { at: 100, items: ['a.ts'] },
      { at: 550, items: ['b.ts'] },
    ]);
  });

  it('a trailing timer and a ceiling due at the same instant flush once', () => {
    const h = harness();
    // Adds at 0, 80, ..., 400 keep the window open; the last one's trailing timer is due at 500.
    addEvery(h, 5, 80);
    h.batcher.add('e5');
    h.clock.advance(600);
    expect(h.flushes).toEqual([{ at: 500, items: names('e', 0, 5) }]);
    expect(h.clock.armedCount()).toBe(0);
  });

  it('an add made inside onFlush opens a new window and is not lost', () => {
    let first = true;
    const h = harness({}, () => {
      if (!first) return;
      first = false;
      h.batcher.add('late.ts');
    });
    h.batcher.add('a.ts');
    h.clock.advance(200);
    expect(h.flushes).toEqual([
      { at: 100, items: ['a.ts'] },
      { at: 200, items: ['late.ts'] },
    ]);
  });

  it('dispose drops the open window unflushed, and later adds are ignored', () => {
    const h = harness();
    h.batcher.add('a.ts');
    h.batcher.dispose();
    expect(h.clock.armedCount()).toBe(0);
    h.clock.advance(1000);
    h.batcher.add('b.ts');
    expect(h.clock.armedCount()).toBe(0);
    h.clock.advance(1000);
    expect(h.flushes).toEqual([]);
  });

  it('without timers it arms the global setTimeout and dispose clears what it armed', () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const batcher = new ChangeBatcher<string>(() => {});
    batcher.add('a.ts');
    const delays = armed.mock.calls.map(([, ms]) => Number(ms));
    expect(delays.toSorted((a, b) => a - b)).toEqual([100, 500]);
    const handles = armed.mock.results.map((result) => result.value);
    batcher.dispose();
    const clearedHandles = cleared.mock.calls.map(([handle]) => handle);
    expect(handles.filter((handle) => !clearedHandles.includes(handle))).toEqual([]);
  });
});
