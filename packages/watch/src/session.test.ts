import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toWorkspacePath, type WorkspacePath } from '@cpg/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChangeBatch,
  ChangeKind,
  NormalizedChange,
  RawWatchEvent,
  TimerApi,
  WatchBackend,
  WatchCapabilities,
  WatchProbe,
  WatchSession,
  WatchSessionOptions,
  WatchSink,
} from './contract';
import { createWatchSession } from './session';

// Expected values are C-WATCH (05-contracts.yaml: INV-3, -4, -16, -20, -21, -22, -23, -26, the
// guarantees, budget_boundary.T1_T2), controller decisions 47-52, and the archive's cases
// (e45574f:packages/engine/test/unit/watch/watch-workspace.test.ts; its initial-pass and
// skipInitialIndex cases are part b's), written out by hand. Sprint decisions S20-1 to S20-3 are named
// where a case pins one. Everything runs on a fake clock and an in-memory disk: zero real sleeps.

const ROOT = '/ws';
const wp = (path: string): WorkspacePath => toWorkspacePath(ROOT, `${ROOT}/${path}`);
const abs = (path: string): string => (path.startsWith('/') ? path : `${ROOT}/${path}`);
const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function deferred<T = void>() {
  const handles = { resolve: (_value: T) => {}, reject: (_error: unknown) => {} };
  const promise = new Promise<T>((resolve, reject) => {
    handles.resolve = resolve;
    handles.reject = reject;
  });
  return { promise, ...handles };
}

/** A fake TimerApi and clock. `advance` fires each due timer in due-time order. */
function fakeClock() {
  let now = 0;
  let nextHandle = 1;
  const armed = new Map<number, { readonly fn: () => void; readonly dueAt: number }>();
  const timers: TimerApi = {
    setTimeout(fn, ms) {
      armed.set(nextHandle, { fn, dueAt: now + ms });
      return nextHandle++;
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') armed.delete(handle);
    },
  };
  function advance(ms: number) {
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
  }
  return { timers, now: () => now, advance, armedCount: () => armed.size };
}

/** An in-memory disk behind a WatchProbe. Directories report 64 bytes; `raced` digests to undefined. */
function memoryDisk() {
  const entries = new Map<
    string,
    { readonly entry: 'file' | 'directory'; readonly content: string }
  >();
  const raced = new Set<string>();
  const probe = {
    stat: vi.fn<WatchProbe['stat']>((path) => {
      const found = entries.get(path);
      if (found === undefined) return Promise.resolve(undefined);
      const sizeBytes = found.entry === 'file' ? found.content.length : 64;
      return Promise.resolve({ entry: found.entry, sizeBytes });
    }),
    digest: vi.fn<WatchProbe['digest']>((path) => {
      const found = entries.get(path);
      const ok = found?.entry === 'file' && !raced.has(path);
      return Promise.resolve(ok ? `sha-${found.content}` : undefined);
    }),
  };
  return {
    probe,
    raced,
    write: (path: string, content: string) => entries.set(path, { entry: 'file', content }),
    mkdir: (path: string) => entries.set(path, { entry: 'directory', content: '' }),
    rm: (path: string) => {
      // Deleting the visited key while iterating a Map is well defined.
      for (const key of entries.keys()) {
        if (key === path || key.startsWith(`${path}/`)) entries.delete(key);
      }
    },
  };
}

const CAPS: WatchCapabilities = {
  id: 'fake',
  directoryEvents: 'all',
  moveEvents: 'none',
  reportsErrors: false,
  reportsOverflow: false,
  honoursIgnore: 'none',
  pathCase: 'sensitive',
};

/** A backend the test drives. `closeGate` is what the subscription's close waits on. */
function fakeBackend() {
  const state = {
    roots: [] as string[],
    closes: 0,
    closeGate: Promise.resolve(),
    onEvents: (_events: readonly RawWatchEvent[]) => {},
  };
  const backend: WatchBackend = {
    capabilities: CAPS,
    subscribe(root, onEvents) {
      state.roots.push(root);
      state.onEvents = onEvents;
      const close = () => {
        state.closes += 1;
        return state.closeGate;
      };
      return Promise.resolve({ capabilities: CAPS, close });
    },
  };
  return { backend, state };
}

/** Records every call. Each call takes the next `plan` step: an Error rejects, a deferred holds. */
function recordingSink() {
  const calls: ChangeBatch[] = [];
  const delivered: ChangeBatch[] = [];
  const plan: (Error | ReturnType<typeof deferred<void>>)[] = [];
  const sink: WatchSink = {
    onBatch(batch) {
      calls.push(batch);
      const step = plan.shift();
      if (step instanceof Error) return Promise.reject(step);
      return (step?.promise ?? Promise.resolve()).then(() => {
        delivered.push(batch);
      });
    },
  };
  return { sink, calls, delivered, plan };
}

const sessions: WatchSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

type Event = readonly [ChangeKind, string, number?];

/** `omit` leaves out the fake timers or the fake clock, so the session falls back to its default. */
async function start(
  options: Partial<WatchSessionOptions> = {},
  omit: readonly ('timers' | 'now')[] = [],
) {
  const clock = fakeClock();
  const disk = memoryDisk();
  const backend = fakeBackend();
  const sink = recordingSink();
  const degraded: { paths: readonly string[]; error: unknown }[] = [];
  const session = await createWatchSession({
    root: ROOT,
    backend: backend.backend,
    sink: sink.sink,
    probe: disk.probe,
    ...(omit.includes('timers') ? {} : { timers: clock.timers }),
    ...(omit.includes('now') ? {} : { now: clock.now }),
    onDegraded: (paths, error) => {
      degraded.push({ paths: paths.toSorted(), error });
    },
    ...options,
  });
  sessions.push(session);
  const emit = (...events: readonly Event[]) => {
    backend.state.onEvents(
      events.map(([kind, path, observedAt]) => ({
        kind,
        path: abs(path),
        entry: 'unknown',
        observedAt: observedAt ?? clock.now(),
      })),
    );
  };
  async function wait(ms = 100) {
    clock.advance(ms);
    await settle();
    await settle();
  }
  /** Writes each entry (null: a directory), emits a created for each, and lets the window deliver. */
  async function seed(entries: Readonly<Record<string, string | null>>) {
    for (const [path, content] of Object.entries(entries)) {
      if (content === null) disk.mkdir(path);
      else disk.write(path, content);
    }
    emit(...Object.keys(entries).map((path) => ['created', path] as const));
    await wait();
  }
  return { clock, disk, backend: backend.state, sink, degraded, session, emit, wait, seed };
}

/** Exhausts withRetry's default bounds: the wait after each of the first four failures. */
async function backoff(h: { wait: (ms: number) => Promise<void> }) {
  await h.wait(200);
  await h.wait(400);
  await h.wait(800);
  await h.wait(1600);
}

const file = (kind: ChangeKind, path: string, content: string, at = 0): NormalizedChange => ({
  kind,
  entry: 'file',
  path: wp(path),
  observedAt: at,
  revision_id: `sha-${content}`,
  sizeBytes: content.length,
});
const dir = (kind: ChangeKind, path: string, at = 0): NormalizedChange => ({
  kind,
  entry: 'directory',
  path: wp(path),
  observedAt: at,
});
const gone = (entry: 'file' | 'directory', path: string, at = 0): NormalizedChange => ({
  kind: 'deleted',
  entry,
  path: wp(path),
  observedAt: at,
});
const moved = (from: string, path: string, content: string, at = 0): NormalizedChange => ({
  ...file('moved', path, content, at),
  fromPath: wp(from),
});
const live = (
  seq: number,
  changes: readonly NormalizedChange[],
  firstEventAt: number,
  settledAt: number,
): ChangeBatch => ({ seq, cause: 'live', changes, clock: { firstEventAt, settledAt } });

const C = 'export const x = 1;\n';

/** A native move as a backend with moveEvents 'native' would report it. */
const move = (path: string, fromPath: string): RawWatchEvent => ({
  kind: 'moved',
  entry: 'file',
  path: abs(path),
  fromPath: abs(fromPath),
  observedAt: 100,
});

describe('createWatchSession: the archive cases', () => {
  it('subscribes to the root; a created file is one live batch with seq 0, revision and size', async () => {
    const h = await start();
    expect(h.backend.roots).toEqual([ROOT]);
    h.disk.write('new.ts', C);
    h.emit(['created', 'new.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'new.ts', C)], 0, 100)]);
  });

  it('a deleted unknown path is a deleted file', async () => {
    const h = await start();
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [gone('file', 'a.ts')], 0, 100)]);
  });

  it('a delete and a create with the known revision become one moved', async () => {
    const h = await start();
    await h.seed({ 'old.ts': C });
    h.disk.rm('old.ts');
    h.disk.write('new.ts', C);
    h.emit(['deleted', 'old.ts'], ['created', 'new.ts']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(1, [moved('old.ts', 'new.ts', C, 100)], 100, 200));
  });

  it('a move into a directory created in the same window is a moved plus the created directory', async () => {
    const h = await start();
    await h.seed({ src: null, 'src/a.ts': 'A' });
    h.disk.mkdir('lib');
    h.disk.rm('src/a.ts');
    h.disk.write('lib/a.ts', 'A');
    h.emit(['created', 'lib'], ['deleted', 'src/a.ts'], ['created', 'lib/a.ts']);
    await h.wait();
    const changes = [moved('src/a.ts', 'lib/a.ts', 'A', 100), dir('created', 'lib', 100)];
    expect(h.sink.delivered[1]).toEqual(live(1, changes, 100, 200));
  });

  it('a new directory and its file are both created, parents first; only the file is digested', async () => {
    const h = await start();
    h.disk.mkdir('lib');
    h.disk.write('lib/x.ts', 'x');
    h.emit(['created', 'lib/x.ts'], ['created', 'lib']);
    await h.wait();
    const changes = [dir('created', 'lib'), file('created', 'lib/x.ts', 'x')];
    expect(h.sink.delivered).toEqual([live(0, changes, 0, 100)]);
    expect(h.disk.probe.digest.mock.calls).toEqual([[wp('lib/x.ts')]]);
  });

  it('a deleted known directory is one deleted directory, and its whole subtree is forgotten', async () => {
    const h = await start();
    await h.seed({ lib: null, 'lib/sub': null, 'lib/x.ts': 'x', 'libx.ts': 'L' });
    h.disk.rm('lib');
    h.emit(['deleted', 'lib']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(1, [gone('directory', 'lib', 100)], 100, 200));
    // Unknown again, so neither is dropped as known; libx.ts is not under lib/ and stays known.
    h.disk.mkdir('lib');
    h.disk.mkdir('lib/sub');
    h.disk.write('lib/x.ts', 'x');
    h.emit(
      ['created', 'lib'],
      ['created', 'lib/sub'],
      ['created', 'lib/x.ts'],
      ['created', 'libx.ts'],
    );
    await h.wait();
    const changes = [
      dir('created', 'lib', 200),
      dir('created', 'lib/sub', 200),
      file('created', 'lib/x.ts', 'x', 200),
    ];
    expect(h.sink.delivered[2]).toEqual(live(2, changes, 200, 300));
  });

  it('admit refuses excluded and oversized paths, deletes included, before any digest', async () => {
    const admit = vi.fn<NonNullable<WatchSessionOptions['admit']>>(
      (path, _entry, sizeBytes) => !path.startsWith('node_modules') && (sizeBytes ?? 0) <= 10,
    );
    const h = await start({ admit });
    h.disk.mkdir('node_modules');
    h.disk.write('node_modules/i.ts', 'x');
    h.disk.write('big.ts', 'x'.repeat(50));
    h.disk.write('ok.ts', 'ok');
    h.emit(
      ['created', 'node_modules'],
      ['created', 'node_modules/i.ts'],
      ['created', 'big.ts'],
      ['created', 'ok.ts'],
      ['deleted', 'node_modules/gone.ts'],
    );
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'ok.ts', 'ok')], 0, 100)]);
    const calls = admit.mock.calls.map(([path, entry, size]) => `${path} ${entry} ${size}`);
    expect(calls.toSorted()).toEqual([
      'big.ts file 50',
      'node_modules directory 64',
      'node_modules/gone.ts file undefined',
      'node_modules/i.ts file 1',
      'ok.ts file 2',
    ]);
    expect(h.disk.probe.digest.mock.calls).toEqual([[wp('ok.ts')]]);
  });

  it('a rejected delivery is retried after 200 ms under the same seq', async () => {
    const h = await start();
    h.sink.plan.push(new Error('transient store error'));
    h.disk.write('flaky.ts', 'f');
    h.emit(['created', 'flaky.ts']);
    await h.wait();
    await h.wait(199);
    expect(h.sink.calls).toHaveLength(1);
    await h.wait(1);
    expect(h.sink.calls).toHaveLength(2);
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'flaky.ts', 'f')], 0, 100)]);
    expect(h.degraded).toEqual([]);
  });

  it('exhausted retries: onDegraded gets every path and the last rejection; nothing advances (INV-22, INV-20)', async () => {
    const h = await start();
    await h.seed({ 'old.ts': 'm', 'c.ts': 'c1' });
    const errors = [1, 2, 3, 4, 5].map((n) => new Error(`store down ${n}`));
    h.sink.plan.push(...errors);
    h.disk.rm('old.ts');
    h.disk.write('new.ts', 'm');
    h.disk.write('c.ts', 'c2');
    const window: Event[] = [
      ['deleted', 'old.ts'],
      ['created', 'new.ts'],
      ['changed', 'c.ts'],
    ];
    h.emit(...window);
    await h.wait();
    await backoff(h);
    expect(h.sink.calls).toHaveLength(6);
    expect(h.degraded).toHaveLength(1);
    expect(h.degraded[0]?.paths).toEqual(['c.ts', 'new.ts', 'old.ts']);
    expect(h.degraded[0]?.error).toBe(errors[4]);
    await h.wait(10_000);
    expect(h.sink.calls).toHaveLength(6);
    // The known state did not move, so the same window is the same batch, under the reused seq 1.
    h.emit(...window);
    await h.wait();
    const changes = [moved('old.ts', 'new.ts', 'm', 13_200), file('changed', 'c.ts', 'c2', 13_200)];
    expect(h.sink.delivered).toEqual([h.sink.delivered[0], live(1, changes, 13_200, 13_300)]);
  });
});

describe('createWatchSession: the window, the clock and the order', () => {
  it('flushes 100 ms after the last event and at most 500 ms after the first (T1_T2 defaults)', async () => {
    const h = await start();
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait(99);
    expect(h.sink.calls).toHaveLength(0);
    await h.wait(1);
    expect(h.sink.calls).toHaveLength(1);
    for (const name of ['b', 'c', 'd', 'e', 'f', 'g']) {
      h.disk.write(`${name}.ts`, name);
      h.emit(['created', `${name}.ts`]);
      // oxlint-disable-next-line no-await-in-loop -- each step must land before the next event
      await h.wait(name === 'g' ? 49 : 90);
    }
    expect(h.sink.calls).toHaveLength(1);
    await h.wait(1);
    expect(h.sink.calls).toHaveLength(2);
    expect(h.sink.calls[1]?.changes).toHaveLength(6);
  });

  it('passes trailingMs and ceilingMs to the window', async () => {
    const h = await start({ trailingMs: 10, ceilingMs: 25 });
    for (const name of ['a', 'b', 'c', 'd']) h.disk.write(`${name}.ts`, name);
    h.emit(['created', 'a.ts']);
    await h.wait(9);
    expect(h.sink.calls).toHaveLength(0);
    await h.wait(1);
    expect(h.sink.calls).toHaveLength(1);
    h.emit(['changed', 'b.ts']);
    await h.wait(9);
    h.emit(['changed', 'c.ts']);
    await h.wait(9);
    h.emit(['changed', 'd.ts']);
    await h.wait(6);
    expect(h.sink.calls).toHaveLength(1);
    await h.wait(1);
    expect(h.sink.calls).toHaveLength(2);
  });

  it('without timers it arms the global setTimeout with the default window', async () => {
    const h = await start({}, ['timers']);
    const armed = vi.spyOn(globalThis, 'setTimeout');
    h.emit(['deleted', 'a.ts']);
    const delays = armed.mock.calls.map(([, ms]) => Number(ms));
    // close() disposes the window, so no real timer outlives the test.
    await h.session.close();
    expect(delays.toSorted((a, b) => a - b)).toEqual([100, 500]);
  });

  it('firstEventAt is the smallest raw observedAt; settledAt is now() as the job starts (decision 52)', async () => {
    const h = await start();
    h.disk.write('a.ts', 'a');
    h.disk.write('b.ts', 'b');
    h.emit(['created', 'b.ts', 30], ['created', 'a.ts', 7]);
    await h.wait(40);
    h.emit(['changed', 'a.ts', 47]);
    await h.wait();
    const changes = [file('created', 'a.ts', 'a', 47), file('created', 'b.ts', 'b', 30)];
    expect(h.sink.delivered).toEqual([live(0, changes, 7, 140)]);
  });

  // Post-implementation (sabotage #19): settledAt sampled when the batch is built passed every case.
  it('settledAt is taken as the job starts, before it reads the disk', async () => {
    const h = await start();
    h.disk.write('a.ts', 'a');
    // The read takes 30 ms. It advances the clock after the flush has returned, as a real read would.
    h.disk.probe.stat.mockImplementationOnce(async () => {
      await Promise.resolve();
      h.clock.advance(30);
      return { entry: 'file', sizeBytes: 1 };
    });
    h.emit(['created', 'a.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'a.ts', 'a')], 0, 100)]);
  });

  it('without now, settledAt is Date.now(), looked up at each call', async () => {
    const h = await start({}, ['now']);
    vi.spyOn(Date, 'now').mockReturnValue(4242);
    h.emit(['deleted', 'a.ts', 1]);
    await h.wait();
    expect(h.sink.delivered[0]?.clock).toEqual({ firstEventAt: 1, settledAt: 4242 });
  });

  it('one batch in flight: the next window waits, and its settledAt is when its job starts (INV-21)', async () => {
    const h = await start();
    const hung = deferred();
    h.sink.plan.push(hung);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait();
    h.disk.write('b.ts', 'b');
    h.emit(['created', 'b.ts']);
    await h.wait();
    await h.wait();
    expect(h.sink.calls).toHaveLength(1);
    hung.resolve();
    await settle();
    await settle();
    expect(h.sink.delivered).toEqual([
      live(0, [file('created', 'a.ts', 'a')], 0, 100),
      live(1, [file('created', 'b.ts', 'b', 100)], 100, 300),
    ]);
  });

  it('maps paths with toWorkspacePath: the root and anything outside it are dropped (INV-4, INV-23)', async () => {
    const h = await start();
    h.disk.mkdir('.');
    h.disk.write('2/x.ts', 'trap');
    h.disk.write('a.ts', 'a');
    h.emit(
      ['created', '/ws'],
      ['created', '/ws/'],
      ['created', '/ws2/x.ts'],
      ['created', '/elsewhere/a.ts'],
      ['created', '/ws/a.ts'],
      ['deleted', '/ws/'],
      ['deleted', '/ws/../etc/x.ts'],
      ['deleted', '/ws/b//c.ts'],
      ['deleted', '/ws2/y.ts'],
    );
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'a.ts', 'a')], 0, 100)]);
  });

  it('a raw moved is a deleted source plus a created path, and pairing restores a known move (S20-2)', async () => {
    const h = await start();
    await h.seed({ 'a.ts': 'A', 'z.ts': 'Z' });
    h.disk.rm('a.ts');
    h.disk.rm('z.ts');
    for (const [path, content] of [
      ['b.ts', 'A'],
      ['c.ts', 'C'],
      ['y.ts', 'Y'],
    ] as const) {
      h.disk.write(path, content);
    }
    h.backend.onEvents([
      move('b.ts', 'a.ts'),
      move('c.ts', '/outside/c.ts'),
      move('y.ts', 'x.ts'),
      move('/outside/z.ts', 'z.ts'),
    ]);
    await h.wait();
    const changes = [
      moved('a.ts', 'b.ts', 'A', 100),
      gone('file', 'x.ts', 100),
      gone('file', 'z.ts', 100),
      file('created', 'c.ts', 'C', 100),
      file('created', 'y.ts', 'Y', 100),
    ];
    expect(h.sink.delivered[1]).toEqual(live(1, changes, 100, 200));
  });
});

describe('createWatchSession: the per-event and kind rules (decisions 48, 49)', () => {
  it('a created or changed that stats or digests to undefined is dropped', async () => {
    const h = await start();
    h.disk.write('raced.ts', 'r');
    h.disk.raced.add('raced.ts');
    h.disk.write('ok.ts', 'ok');
    h.emit(['created', 'gone.ts'], ['changed', 'raced.ts'], ['created', 'ok.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'ok.ts', 'ok')], 0, 100)]);
  });

  it('each event is classified before coalesce, so a dropped create leaves its delete standing', async () => {
    const h = await start({ admit: (_path, _entry, sizeBytes) => (sizeBytes ?? 0) <= 10 });
    await h.seed({ 'a.ts': 'a', 'b.ts': 'b' });
    h.disk.rm('a.ts');
    h.disk.write('b.ts', 'x'.repeat(50));
    // a.ts is gone again at flush; b.ts comes back too big to admit.
    h.emit(['deleted', 'a.ts'], ['created', 'a.ts'], ['deleted', 'b.ts'], ['created', 'b.ts']);
    await h.wait();
    const changes = [gone('file', 'a.ts', 100), gone('file', 'b.ts', 100)];
    expect(h.sink.delivered[1]).toEqual(live(1, changes, 100, 200));
  });

  it('events coalesce before pairing: a rename target edited in the same window is still a moved', async () => {
    const h = await start();
    await h.seed({ 'old.ts': 'm' });
    h.disk.rm('old.ts');
    h.disk.write('new.ts', 'm');
    h.emit(['deleted', 'old.ts'], ['created', 'new.ts'], ['changed', 'new.ts']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(1, [moved('old.ts', 'new.ts', 'm', 100)], 100, 200));
  });

  it('a file is digested once per window, however many events name it (INV-26)', async () => {
    const h = await start();
    h.disk.mkdir('lib');
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'lib'], ['created', 'a.ts'], ['changed', 'a.ts'], ['changed', 'a.ts']);
    await h.wait();
    expect(h.disk.probe.digest.mock.calls).toEqual([[wp('a.ts')]]);
    const changes = [file('created', 'a.ts', 'a'), dir('created', 'lib')];
    expect(h.sink.delivered).toEqual([live(0, changes, 0, 100)]);
  });

  it('a file takes its kind from known state, and the batch stays in flushBatch order (INV-16)', async () => {
    const h = await start();
    await h.seed({ 'a.ts': 'v1', 'b.ts': 'b1' });
    h.disk.write('a.ts', 'v2');
    h.disk.write('c.ts', 'c');
    // An atomic save arrives as created on a known path; c.ts is unknown; b.ts is byte-identical.
    h.emit(['created', 'a.ts'], ['changed', 'c.ts'], ['created', 'b.ts']);
    await h.wait();
    const changes = [file('changed', 'a.ts', 'v2', 100), file('created', 'c.ts', 'c', 100)];
    expect(h.sink.delivered[1]).toEqual(live(1, changes, 100, 200));
    // Both revisions were recorded, so the same bytes again are no-ops.
    h.emit(['created', 'a.ts'], ['changed', 'c.ts']);
    await h.wait();
    expect(h.sink.calls).toHaveLength(2);
  });

  it('pairing runs before the kind rules: a rename over a known file is a moved', async () => {
    const h = await start();
    await h.seed({ 'a.ts': 'A', 'b.ts': 'B' });
    h.disk.rm('a.ts');
    h.disk.write('b.ts', 'A');
    h.emit(['deleted', 'a.ts'], ['created', 'b.ts']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(1, [moved('a.ts', 'b.ts', 'A', 100)], 100, 200));
    h.emit(['changed', 'b.ts']);
    await h.wait();
    expect(h.sink.calls).toHaveLength(2);
  });

  it('a delivered delete forgets the file, so the same bytes again are created (decision 52)', async () => {
    const h = await start();
    await h.seed({ 'a.ts': 'a' });
    h.disk.rm('a.ts');
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait();
    expect(h.sink.delivered[2]).toEqual(live(2, [file('created', 'a.ts', 'a', 200)], 200, 300));
  });

  it('a byte-identical rewrite delivers nothing and takes no seq (INV-20)', async () => {
    const h = await start();
    await h.seed({ 'a.ts': 'v1' });
    h.emit(['changed', 'a.ts']);
    await h.wait();
    expect(h.sink.calls).toHaveLength(1);
    h.disk.write('b.ts', 'b');
    h.emit(['created', 'b.ts']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(1, [file('created', 'b.ts', 'b', 200)], 200, 300));
  });

  it('a directory created or changed is created when unknown and dropped when known (S20-1)', async () => {
    const h = await start();
    await h.seed({ lib: null });
    h.disk.mkdir('src');
    h.emit(['created', 'lib'], ['changed', 'src']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(1, [dir('created', 'src', 100)], 100, 200));
    h.emit(['changed', 'lib'], ['created', 'src']);
    await h.wait();
    expect(h.sink.calls).toHaveLength(2);
  });

  it('a moved moves the known revision from fromPath to path (decision 52)', async () => {
    const h = await start();
    await h.seed({ 'old.ts': 'm' });
    h.disk.rm('old.ts');
    h.disk.write('new.ts', 'm');
    h.emit(['deleted', 'old.ts'], ['created', 'new.ts']);
    await h.wait();
    h.disk.write('old.ts', 'm');
    h.emit(['changed', 'new.ts'], ['created', 'old.ts']);
    await h.wait();
    expect(h.sink.delivered[2]).toEqual(live(2, [file('created', 'old.ts', 'm', 200)], 200, 300));
  });
});

describe('createWatchSession: failures (decisions 50, 52; S20-3)', () => {
  it('a probe that rejects reaches onDegraded with the window paths; the seq is not taken', async () => {
    const h = await start();
    const failure = new Error('EACCES');
    h.disk.write('a.ts', 'a');
    h.disk.probe.stat.mockRejectedValueOnce(failure);
    h.emit(['created', 'a.ts'], ['deleted', 'b.ts']);
    await h.wait();
    expect(h.sink.calls).toEqual([]);
    expect(h.degraded.map(({ paths }) => paths)).toEqual([['a.ts', 'b.ts']]);
    expect(h.degraded[0]?.error).toBe(failure);
    h.emit(['created', 'a.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'a.ts', 'a', 100)], 100, 200)]);
  });

  it('an admit that throws reaches onDegraded too, and an outside path in the window is still dropped', async () => {
    const failure = new Error('matcher bug');
    const h = await start({
      admit: () => {
        throw failure;
      },
    });
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts'], ['created', '/outside/x.ts']);
    await h.wait();
    expect(h.degraded.map(({ paths }) => paths)).toEqual([['a.ts']]);
    expect(h.degraded[0]?.error).toBe(failure);
    expect(h.sink.calls).toEqual([]);
  });

  it('an onDegraded that throws does not stop the session', async () => {
    const h = await start({
      onDegraded: () => {
        throw new Error('consumer bug');
      },
    });
    h.sink.plan.push(...[1, 2, 3, 4, 5].map((n) => new Error(`down ${n}`)));
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    await backoff(h);
    h.disk.write('b.ts', 'b');
    h.emit(['created', 'b.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(0, [file('created', 'b.ts', 'b', 3100)], 3100, 3200)]);
  });

  it('rejects with the backend error when subscribe rejects', async () => {
    const error = new Error('root missing');
    const backend: WatchBackend = { capabilities: CAPS, subscribe: () => Promise.reject(error) };
    const { sink } = recordingSink();
    const { probe } = memoryDisk();
    await expect(createWatchSession({ root: ROOT, backend, sink, probe })).rejects.toBe(error);
  });
});

describe('createWatchSession: close (decision 51, silence after close)', () => {
  it('is idempotent and resolves only after the subscription has closed, which it closes once', async () => {
    const h = await start();
    const gate = deferred();
    h.backend.closeGate = gate.promise;
    let resolved = 0;
    const count = () => {
      resolved += 1;
    };
    const first = h.session.close().then(count);
    const second = h.session.close().then(count);
    await settle();
    expect(resolved).toBe(0);
    gate.resolve();
    await Promise.all([first, second]);
    expect(resolved).toBe(2);
    expect(h.backend.closes).toBe(1);
  });

  it('is silent from the moment close() is called, before the subscription has closed', async () => {
    const h = await start();
    const gate = deferred();
    h.backend.closeGate = gate.promise;
    h.sink.plan.push(new Error('transient'));
    h.disk.write('a.ts', 'a');
    h.disk.write('b.ts', 'b');
    h.emit(['created', 'a.ts']);
    await h.wait();
    h.emit(['created', 'b.ts']);
    const closing = h.session.close();
    await backoff(h);
    expect(h.sink.calls).toHaveLength(1);
    expect(h.degraded).toEqual([]);
    expect(h.disk.probe.stat.mock.calls).toEqual([[wp('a.ts')]]);
    gate.resolve();
    await closing;
  });

  it('drops the open window and ignores later events: no timer, no probe call, no sink call', async () => {
    const h = await start();
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.session.close();
    expect(h.clock.armedCount()).toBe(0);
    h.emit(['created', 'a.ts']);
    await h.wait(1000);
    expect(h.disk.probe.stat).not.toHaveBeenCalled();
    expect(h.sink.calls).toEqual([]);
  });

  it('drops a queued window behind a hung sink call, and does not wait for that call', async () => {
    const h = await start();
    const hung = deferred();
    h.sink.plan.push(hung);
    h.disk.write('a.ts', 'a');
    h.disk.write('b.ts', 'b');
    h.emit(['created', 'a.ts']);
    await h.wait();
    h.emit(['created', 'b.ts']);
    await h.wait();
    const stats = h.disk.probe.stat.mock.calls.length;
    await h.session.close();
    hung.resolve();
    await h.wait(1000);
    expect(h.disk.probe.stat.mock.calls).toHaveLength(stats);
    expect(h.sink.calls).toHaveLength(1);
  });

  // Post-implementation (sabotage #26): a woken retry that rejects kept the retries going after close.
  it('a retry that wakes after close ends the retries: no timer is left armed', async () => {
    const h = await start();
    h.sink.plan.push(new Error('transient'));
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    await h.session.close();
    await h.wait(200);
    expect(h.clock.armedCount()).toBe(0);
  });

  it('a retry that wakes after close does not call the sink, and onDegraded never fires', async () => {
    const h = await start();
    h.sink.plan.push(new Error('transient'));
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    await h.session.close();
    await backoff(h);
    await h.wait(10_000);
    expect(h.sink.calls).toHaveLength(1);
    expect(h.degraded).toEqual([]);
  });

  it('a last attempt that rejects after close does not reach onDegraded', async () => {
    const h = await start();
    const last = deferred();
    h.sink.plan.push(...[1, 2, 3, 4].map((n) => new Error(`down ${n}`)), last);
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    await backoff(h);
    expect(h.sink.calls).toHaveLength(5);
    await h.session.close();
    last.reject(new Error('down 5'));
    await h.wait(1000);
    expect(h.degraded).toEqual([]);
  });

  it('a job still reading the disk at close never calls the sink', async () => {
    const h = await start();
    const digest = deferred<string | undefined>();
    h.disk.write('a.ts', 'a');
    h.disk.probe.digest.mockReturnValueOnce(digest.promise);
    h.emit(['created', 'a.ts']);
    await h.wait();
    expect(h.disk.probe.digest).toHaveBeenCalledTimes(1);
    await h.session.close();
    digest.resolve('sha-a');
    await h.wait(1000);
    expect(h.sink.calls).toEqual([]);
  });

  it('a probe that rejects after close does not reach onDegraded', async () => {
    const h = await start();
    const stat = deferred<Awaited<ReturnType<WatchProbe['stat']>>>();
    h.disk.probe.stat.mockReturnValueOnce(stat.promise);
    h.emit(['created', 'a.ts']);
    await h.wait();
    await h.session.close();
    stat.reject(new Error('EIO'));
    await h.wait(1000);
    expect(h.degraded).toEqual([]);
  });
});

describe('C-WATCH INV-3', () => {
  const SRC = __dirname;
  const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  const FORBIDDEN = /^(?:node:)?fs(?:\/promises)?$|^vscode$|^@cpg\/(?:parse|store)$/;

  it('no runtime file in packages/watch imports node:fs, vscode, the parser or a store', () => {
    const runtime = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.includes('.test'),
    );
    const imports = runtime.flatMap((f) =>
      [...readFileSync(join(SRC, f), 'utf8').matchAll(IMPORT)].map((m) => `${f} ${m[1] ?? ''}`),
    );
    // Anti-vacuity: the scan sees a static import and parcel's dynamic one.
    expect(imports).toEqual(
      expect.arrayContaining(['session.ts ./contract', 'parcel-backend.ts @parcel/watcher']),
    );
    expect(imports.filter((line) => FORBIDDEN.test(line.split(' ')[1] ?? ''))).toEqual([]);
  });
});
