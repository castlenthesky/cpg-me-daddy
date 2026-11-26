import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimerApi } from './contract';
import { SerialQueue, withRetry, type SerialQueueOptions } from './queue';

// NEW tests (the archive had none). Expected values are C-WATCH INV-21 (at most one batch in flight,
// delivery strictly in order) and the archive's queue.ts (e45574f:packages/engine/src/watch/queue.ts):
// a failed item goes to onError and the queue moves on; dispose drops what has not started; retries
// make 5 attempts and wait min(200 * 2^(attempt-1), 5000) ms between them (decision 46). Waits run on
// fake timers, but for one 3 ms real wait that checks the default; `settle` only lets pending promise
// callbacks run.

const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Settles until `done()` holds, at most `turns` times. */
async function until(done: () => boolean, turns = 200): Promise<void> {
  if (done() || turns === 0) return;
  await settle();
  await until(done, turns - 1);
}

function deferred() {
  const handles = { resolve: () => {}, reject: (_error: unknown) => {} };
  const promise = new Promise<void>((resolve, reject) => {
    handles.resolve = resolve;
    handles.reject = reject;
  });
  return { promise, ...handles };
}

/** A queue whose items each run until the test finishes them. `onStart` runs as an item starts. */
function harness(
  options: SerialQueueOptions = {},
  onStart?: (item: string, queue: SerialQueue<string>) => void,
) {
  const log: string[] = [];
  const running = new Map<string, ReturnType<typeof deferred>>();
  const queue: SerialQueue<string> = new SerialQueue<string>(async (item) => {
    log.push(`start ${item}`);
    const run = deferred();
    running.set(item, run);
    onStart?.(item, queue);
    await run.promise;
    log.push(`end ${item}`);
  }, options);
  async function finish(item: string, error?: Error) {
    const run = running.get(item);
    if (run === undefined) throw new Error(`${item} never started`);
    if (error === undefined) run.resolve();
    else run.reject(error);
    await settle();
  }
  return { log, queue, finish };
}

describe('SerialQueue', () => {
  it('runs one item at a time, in the order enqueued (INV-21)', async () => {
    const h = harness();
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    h.queue.enqueue('c');
    await settle();
    expect(h.log).toEqual(['start a']);
    await h.finish('a');
    expect(h.log).toEqual(['start a', 'end a', 'start b']);
    await h.finish('b');
    await h.finish('c');
    expect(h.log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('never has two in flight, however many are enqueued at once', async () => {
    let inFlight = 0;
    let most = 0;
    const done: number[] = [];
    const queue = new SerialQueue<number>(async (item) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await settle();
      inFlight -= 1;
      done.push(item);
    });
    for (let i = 0; i < 20; i++) queue.enqueue(i);
    await until(() => done.length === 20);
    expect(done).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(most).toBe(1);
  });

  it('hands a rejection to onError and moves on to the next item', async () => {
    const errors: unknown[] = [];
    const h = harness({ onError: (error) => errors.push(error) });
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    await settle();
    const boom = new Error('boom');
    await h.finish('a', boom);
    expect(errors).toEqual([boom]);
    expect(h.log).toEqual(['start a', 'start b']);
  });

  it('without onError a rejection is dropped and the next item still runs', async () => {
    const h = harness();
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    await settle();
    await h.finish('a', new Error('boom'));
    expect(h.log).toEqual(['start a', 'start b']);
  });

  it('pendingCount counts the items waiting, not the one in flight', async () => {
    const h = harness();
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    h.queue.enqueue('c');
    await settle();
    expect(h.queue.pendingCount).toBe(2);
    await h.finish('a');
    expect(h.queue.pendingCount).toBe(1);
    await h.finish('b');
    expect(h.queue.pendingCount).toBe(0);
  });

  it('an item enqueued after the queue went idle runs', async () => {
    const h = harness();
    h.queue.enqueue('a');
    await settle();
    await h.finish('a');
    h.queue.enqueue('b');
    await settle();
    expect(h.log).toEqual(['start a', 'end a', 'start b']);
  });

  it('an item enqueued by the running item waits for it to finish', async () => {
    const h = harness({}, (item, queue) => {
      if (item === 'a') queue.enqueue('a2');
    });
    h.queue.enqueue('a');
    await settle();
    expect(h.log).toEqual(['start a']);
    await h.finish('a');
    expect(h.log).toEqual(['start a', 'end a', 'start a2']);
  });

  it('dispose drops what has not started, lets the one in flight finish, and is final', async () => {
    const h = harness();
    h.queue.enqueue('a');
    h.queue.enqueue('b');
    await settle();
    h.queue.dispose();
    expect(h.queue.pendingCount).toBe(0);
    await h.finish('a');
    h.queue.enqueue('c');
    await settle();
    expect(h.log).toEqual(['start a', 'end a']);
    expect(h.queue.pendingCount).toBe(0);
  });
});

/** Fake timers that record each delay and fire it on the next microtask. */
function autoTimers() {
  const delays: number[] = [];
  const timers: TimerApi = {
    setTimeout(fn, ms) {
      delays.push(ms);
      queueMicrotask(fn);
      return delays.length;
    },
    clearTimeout() {},
  };
  return { delays, timers };
}

/** `fn` rejects with errors[0], errors[1], ... for its first `failures` calls, then resolves 'ok'. */
function flaky(failures: number) {
  const errors = Array.from({ length: failures }, (_, i) => new Error(`failure ${i + 1}`));
  let calls = 0;
  const fn = () => {
    calls += 1;
    const error = errors[calls - 1];
    return error === undefined ? Promise.resolve('ok') : Promise.reject(error);
  };
  return { fn, errors, calls: () => calls };
}

function recordRetries() {
  const retries: [number, unknown][] = [];
  return { retries, onRetry: (attempt: number, error: unknown) => retries.push([attempt, error]) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRetry', () => {
  it('resolves with the first success and waits for nothing', async () => {
    const { delays, timers } = autoTimers();
    const f = flaky(0);
    const r = recordRetries();
    await expect(withRetry(f.fn, { timers, onRetry: r.onRetry })).resolves.toBe('ok');
    expect([f.calls(), delays, r.retries]).toEqual([1, [], []]);
  });

  it('retries a rejection after 200, then 400 ms, and resolves with the first success', async () => {
    const { delays, timers } = autoTimers();
    const f = flaky(2);
    const r = recordRetries();
    await expect(withRetry(f.fn, { timers, onRetry: r.onRetry })).resolves.toBe('ok');
    expect(f.calls()).toBe(3);
    expect(delays).toEqual([200, 400]);
    expect(r.retries).toEqual([
      [1, f.errors[0]],
      [2, f.errors[1]],
    ]);
  });

  it('gives up after 5 attempts and rejects with the last error', async () => {
    const { delays, timers } = autoTimers();
    const f = flaky(9);
    const r = recordRetries();
    await expect(withRetry(f.fn, { timers, onRetry: r.onRetry })).rejects.toBe(f.errors[4]);
    expect(f.calls()).toBe(5);
    expect(delays).toEqual([200, 400, 800, 1600]);
    expect(r.retries).toEqual([1, 2, 3, 4].map((attempt) => [attempt, f.errors[attempt - 1]]));
  });

  it('caps each wait at 5000 ms by default', async () => {
    const { delays, timers } = autoTimers();
    const f = flaky(9);
    await expect(withRetry(f.fn, { timers, maxAttempts: 8 })).rejects.toBe(f.errors[7]);
    expect(delays).toEqual([200, 400, 800, 1600, 3200, 5000, 5000]);
  });

  it('uses the maxAttempts, baseDelayMs and maxDelayMs it is given', async () => {
    const { delays, timers } = autoTimers();
    const f = flaky(9);
    const options = { timers, maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 3000 };
    await expect(withRetry(f.fn, options)).rejects.toBe(f.errors[4]);
    expect(delays).toEqual([1000, 2000, 3000, 3000]);
  });

  it('caps the first wait too, when baseDelayMs is over maxDelayMs', async () => {
    const { delays, timers } = autoTimers();
    const f = flaky(9);
    await expect(withRetry(f.fn, { timers, maxDelayMs: 100 })).rejects.toBe(f.errors[4]);
    expect(delays).toEqual([100, 100, 100, 100]);
  });

  it('maxAttempts 1 calls once and rejects without waiting or reporting a retry', async () => {
    const { delays, timers } = autoTimers();
    const f = flaky(1);
    const r = recordRetries();
    const options = { timers, maxAttempts: 1, onRetry: r.onRetry };
    await expect(withRetry(f.fn, options)).rejects.toBe(f.errors[0]);
    expect([f.calls(), delays, r.retries]).toEqual([1, [], []]);
  });

  it('counts a synchronous throw as a failed attempt', async () => {
    const { delays, timers } = autoTimers();
    let calls = 0;
    const fn = () => {
      calls += 1;
      if (calls === 1) throw new Error('sync');
      return Promise.resolve('ok');
    };
    await expect(withRetry(fn, { timers })).resolves.toBe('ok');
    expect([calls, delays]).toEqual([2, [200]]);
  });

  it('reports the retry, then waits for the timer before the next attempt', async () => {
    const held: (() => void)[] = [];
    const timers: TimerApi = {
      setTimeout(fn) {
        held.push(fn);
        return held.length;
      },
      clearTimeout() {},
    };
    const f = flaky(1);
    const r = recordRetries();
    const result = withRetry(f.fn, { timers, onRetry: r.onRetry });
    await settle();
    await settle();
    expect([f.calls(), held.length, r.retries]).toEqual([1, 1, [[1, f.errors[0]]]]);
    held[0]?.();
    await expect(result).resolves.toBe('ok');
    expect(f.calls()).toBe(2);
  });

  it('without timers it waits on the global setTimeout', async () => {
    // One real 3 ms wait; the odd delay keeps another caller's setTimeout from passing for ours.
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const f = flaky(1);
    await expect(withRetry(f.fn, { baseDelayMs: 3 })).resolves.toBe('ok');
    expect(armed).toHaveBeenCalledWith(expect.any(Function), 3);
    expect(f.calls()).toBe(2);
  });
});
