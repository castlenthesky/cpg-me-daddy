/** `ChangeBatcher`: 100ms trailing / 500ms ceiling, per-key coalescing — all against an injected fake clock, no real timers. */
import { describe, expect, test } from "bun:test";

import { ChangeBatcher } from "../../../src/watch/debounce.ts";

interface FakeTimer {
  readonly fn: () => void;
  dueAt: number;
}

function makeFakeClock() {
  let now = 0;
  const timers = new Map<number, FakeTimer>();
  let nextHandle = 1;

  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const handle = nextHandle++;
      timers.set(handle, { fn, dueAt: now + ms });
      return handle;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    /** Advances the clock by `ms`, firing any timer whose due time is reached, in due-time order. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, t]) => t.dueAt <= target)
          .toSorted((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (next === undefined) {
          break;
        }
        const [handle, timer] = next;
        timers.delete(handle);
        now = timer.dueAt;
        timer.fn();
      }
      now = target;
    },
  };
}

describe("ChangeBatcher", () => {
  test("flushes after the trailing window with no further adds", () => {
    const clock = makeFakeClock();
    const flushes: string[][] = [];
    const batcher = new ChangeBatcher<string>((items) => flushes.push([...items]), {
      trailingMs: 100,
      ceilingMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    batcher.add("a.ts", "a.ts");
    expect(flushes).toEqual([]);
    clock.advance(100);

    expect(flushes).toEqual([["a.ts"]]);
  });

  test("a later add resets the trailing window", () => {
    const clock = makeFakeClock();
    const flushes: string[][] = [];
    const batcher = new ChangeBatcher<string>((items) => flushes.push([...items]), {
      trailingMs: 100,
      ceilingMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    batcher.add("a.ts", "a.ts");
    clock.advance(80);
    expect(flushes).toEqual([]); // trailing window not yet elapsed
    batcher.add("a.ts", "a.ts"); // resets the 100ms trailing window
    clock.advance(80);
    expect(flushes).toEqual([]); // still within the new window
    clock.advance(20);
    expect(flushes).toEqual([["a.ts"]]);
  });

  test("the 500ms ceiling flushes even under continuous activity", () => {
    const clock = makeFakeClock();
    const flushes: string[][] = [];
    const batcher = new ChangeBatcher<string>((items) => flushes.push([...items]), {
      trailingMs: 100,
      ceilingMs: 500,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    // An add every 80ms keeps re-arming the 100ms trailing timer, so only
    // the 500ms ceiling can ever flush this.
    for (let i = 0; i < 8; i++) {
      batcher.add("a.ts", "a.ts");
      clock.advance(80);
    }

    expect(flushes).toEqual([["a.ts"]]);
  });

  test("coalesces multiple adds under the same key — last write wins, one flush entry", () => {
    const clock = makeFakeClock();
    const flushes: { path: string; hash: string }[][] = [];
    const batcher = new ChangeBatcher<{ path: string; hash: string }>(
      (items) => flushes.push([...items]),
      { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    );

    batcher.add("a.ts", { path: "a.ts", hash: "h1" });
    batcher.add("a.ts", { path: "a.ts", hash: "h2" });
    clock.advance(100);

    expect(flushes).toEqual([[{ path: "a.ts", hash: "h2" }]]);
  });

  test("different keys in the same window flush together", () => {
    const clock = makeFakeClock();
    const flushes: string[][] = [];
    const batcher = new ChangeBatcher<string>((items) => flushes.push([...items].toSorted()), {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    batcher.add("a.ts", "a.ts");
    batcher.add("b.ts", "b.ts");
    clock.advance(100);

    expect(flushes).toEqual([["a.ts", "b.ts"]]);
  });

  test("dispose() clears pending timers without flushing", () => {
    const clock = makeFakeClock();
    const flushes: string[][] = [];
    const batcher = new ChangeBatcher<string>((items) => flushes.push([...items]), {
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    batcher.add("a.ts", "a.ts");
    batcher.dispose();
    clock.advance(1000);

    expect(flushes).toEqual([]);
  });
});
