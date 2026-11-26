import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT, toWorkspacePath, type WorkspacePath } from '@cpg/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BatchCause,
  ChangeBatch,
  ChangeKind,
  NormalizedChange,
  RawWatchEvent,
  TimerApi,
  WatchBackend,
  WatchCapabilities,
  WatchError,
  WatchProbe,
  WatchSession,
  WatchSessionOptions,
  WatchSink,
} from './contract';
import { createWatchSession } from './session';

// Expected values are C-WATCH (05-contracts.yaml: INV-3, -4, -5, -16, -20, -21, -22, -23, -25, -26,
// the guarantees, budget_boundary.T1_T2), controller decisions 47-58, and the archive's cases
// (e45574f:packages/engine/test/unit/watch/watch-workspace.test.ts; `seed` replaces its
// skipInitialIndex), written out by hand. Sprint decisions S20-1 to S20-3 and S21-1 to S21-9 are named
// where a case pins one. Everything runs on a fake clock and an in-memory disk: zero real sleeps.
// Since part b, seq 0 is always the initial batch: `start` sets it aside, and live batches count from 1.

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

/**
 * An in-memory disk behind a WatchProbe; the root '.' is a directory. Directories report 64 bytes;
 * `raced` digests to undefined; `list` answers in reverse insertion order (C-WATCH: any order). Each
 * call is logged as `<op> <path>`. A `delays` entry makes that call take so long on the clock: it
 * advances from a microtask, after the caller's own advance() has returned (sprint 20).
 */
type Entry = { readonly entry: 'file' | 'directory'; readonly content: string };
const sizeOf = (found: Entry) => (found.entry === 'file' ? found.content.length : 64);
const under = (dir: string, path: string) =>
  path !== '.' && (dir === '.' || path.startsWith(`${dir}/`));

function memoryDisk(clock: ReturnType<typeof fakeClock>, log: string[]) {
  const entries = new Map<string, Entry>([['.', { entry: 'directory', content: '' }]]);
  const raced = new Set<string>();
  const delays = new Map<string, number>();
  async function answer<T>(op: string, path: string, value: () => T): Promise<T> {
    log.push(`${op} ${path}`);
    const ms = delays.get(`${op} ${path}`);
    if (ms !== undefined) {
      await Promise.resolve();
      clock.advance(ms);
    }
    return value();
  }
  const probe = {
    stat: vi.fn<WatchProbe['stat']>((path) =>
      answer('stat', path, () => {
        const found = entries.get(path);
        return found && { entry: found.entry, sizeBytes: sizeOf(found) };
      }),
    ),
    digest: vi.fn<WatchProbe['digest']>((path) =>
      answer('digest', path, () => {
        const found = entries.get(path);
        const ok = found?.entry === 'file' && !raced.has(path);
        return ok ? `sha-${found.content}` : undefined;
      }),
    ),
    list: vi.fn<WatchProbe['list']>((dir) =>
      answer('list', dir, () => {
        if (entries.get(dir)?.entry !== 'directory') return [];
        const found = [...entries].filter(([path]) => under(dir, path));
        return found
          .map(([path, e]) => ({ path: wp(path), entry: e.entry, sizeBytes: sizeOf(e) }))
          .toReversed();
      }),
    ),
  };
  return {
    probe,
    raced,
    delays,
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
  reportsErrors: true,
  reportsOverflow: false,
  honoursIgnore: 'none',
  pathCase: 'sensitive',
};

/** A backend the test drives. Subscribe waits on `subscribeGate`, the subscription's close on `closeGate`. */
function fakeBackend(capabilities: WatchCapabilities, log: string[]) {
  const state = {
    roots: [] as string[],
    closes: 0,
    subscribeGate: Promise.resolve(),
    closeGate: Promise.resolve(),
    onEvents: (_events: readonly RawWatchEvent[]) => {},
    onError: (_error: WatchError) => {},
  };
  const backend: WatchBackend = {
    capabilities,
    async subscribe(root, onEvents, options) {
      log.push(`subscribe ${root}`);
      state.roots.push(root);
      state.onEvents = onEvents;
      state.onError = options?.onError ?? (() => {});
      await state.subscribeGate;
      const close = () => {
        log.push('close');
        state.closes += 1;
        return state.closeGate;
      };
      return { capabilities, close };
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

interface Setup {
  /** Leaves out the fake timers or the fake clock, so the session falls back to its default. */
  readonly omit?: readonly ('timers' | 'now')[];
  readonly caps?: Partial<WatchCapabilities>;
  /** On the disk before the session starts, so the initial walk finds it (null: a directory). */
  readonly disk?: Readonly<Record<string, string | null>>;
  /** Runs once the fakes exist, before createWatchSession is called. */
  readonly prepare?: (fakes: {
    readonly disk: ReturnType<typeof memoryDisk>;
    readonly backend: ReturnType<typeof fakeBackend>['state'];
  }) => void;
}

/** Calls createWatchSession and hands back its promise as `ready`, unawaited. */
function open(options: Partial<WatchSessionOptions> = {}, setup: Setup = {}) {
  const log: string[] = [];
  const clock = fakeClock();
  const disk = memoryDisk(clock, log);
  const backend = fakeBackend({ ...CAPS, ...setup.caps }, log);
  const sink = recordingSink();
  const degraded: { paths: readonly string[]; error: unknown }[] = [];
  const errors: WatchError[] = [];
  for (const [path, content] of Object.entries(setup.disk ?? {})) {
    if (content === null) disk.mkdir(path);
    else disk.write(path, content);
  }
  setup.prepare?.({ disk, backend: backend.state });
  const omit = setup.omit ?? [];
  const ready = createWatchSession({
    root: ROOT,
    backend: backend.backend,
    sink: sink.sink,
    probe: disk.probe,
    ...(omit.includes('timers') ? {} : { timers: clock.timers }),
    ...(omit.includes('now') ? {} : { now: clock.now }),
    onDegraded: (paths, error) => {
      degraded.push({ paths: paths.toSorted(), error });
    },
    onError: (error) => {
      errors.push(error);
      log.push(`onError ${error.code}`);
    },
    ...options,
  });
  ready.then(
    (session) => sessions.push(session),
    () => {},
  );
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
  /** A backend error, through the onError the session passed to subscribe. */
  const fail = (error: WatchError) => backend.state.onError(error);
  return {
    log,
    clock,
    disk,
    backend: backend.state,
    sink,
    degraded,
    errors,
    ready,
    emit,
    wait,
    seed,
    fail,
  };
}

/** Opens a session and waits for it. The initial batch and the start-up probe calls are set aside. */
async function start(options: Partial<WatchSessionOptions> = {}, setup: Setup = {}) {
  const h = open(options, setup);
  const session = await h.ready;
  const initial = h.sink.calls.splice(0);
  h.sink.delivered.splice(0);
  h.disk.probe.stat.mockClear();
  h.disk.probe.digest.mockClear();
  h.disk.probe.list.mockClear();
  return { ...h, session, initial };
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
const batchOf =
  (cause: BatchCause) =>
  (
    seq: number,
    changes: readonly NormalizedChange[],
    firstEventAt: number,
    settledAt: number,
  ): ChangeBatch => ({ seq, cause, changes, clock: { firstEventAt, settledAt } });
const live = batchOf('live');
const rescan = batchOf('rescan');
const initial = (changes: readonly NormalizedChange[], firstEventAt = 0, settledAt = 0) =>
  batchOf('initial')(0, changes, firstEventAt, settledAt);

const C = 'export const x = 1;\n';
const seedOf = (files: Readonly<Record<string, string>>, directories: readonly string[] = []) => ({
  files: new Map(
    Object.entries(files).map(([path, content]) => [wp(path), `sha-${content}`] as const),
  ),
  directories: new Set(directories.map(wp)),
});
type Listing = Awaited<ReturnType<WatchProbe['list']>>;
const RESCAN: WatchError = {
  code: 'overflow',
  message: 'events lost',
  fatal: false,
  rescanRequired: true,
};
const FATAL: WatchError = {
  code: 'backend-crashed',
  message: 'watcher died',
  fatal: true,
  rescanRequired: false,
};

/** A native move as a backend with moveEvents 'native' would report it. */
const move = (path: string, fromPath: string): RawWatchEvent => ({
  kind: 'moved',
  entry: 'file',
  path: abs(path),
  fromPath: abs(fromPath),
  observedAt: 100,
});

describe('createWatchSession: the archive cases', () => {
  it('subscribes to the root; a created file is one live batch with seq 1, revision and size', async () => {
    const h = await start();
    expect(h.backend.roots).toEqual([ROOT]);
    h.disk.write('new.ts', C);
    h.emit(['created', 'new.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'new.ts', C)], 0, 100)]);
  });

  // Reworked for decision 58: the archive delivered a deleted file for a path it never knew.
  it('a deleted path never known is dropped: an atomic save leaves only its changed (decision 58)', async () => {
    const h = await start({}, { disk: { 'a.ts': 'v1' } });
    h.disk.write('a.ts', 'v2');
    h.disk.write('x.ts', 'x');
    h.emit(
      ['created', 'a.ts.tmp'],
      ['deleted', 'a.ts.tmp'],
      ['created', 'a.ts'],
      ['deleted', 'b.ts'],
      // Round two: dropped before coalesce, so the delete cannot cancel the create before it.
      ['created', 'x.ts'],
      ['deleted', 'x.ts'],
    );
    await h.wait();
    const changes = [file('changed', 'a.ts', 'v2'), file('created', 'x.ts', 'x')];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
  });

  it('a delete and a create with the known revision become one moved', async () => {
    const h = await start();
    await h.seed({ 'old.ts': C });
    h.disk.rm('old.ts');
    h.disk.write('new.ts', C);
    h.emit(['deleted', 'old.ts'], ['created', 'new.ts']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(2, [moved('old.ts', 'new.ts', C, 100)], 100, 200));
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
    expect(h.sink.delivered[1]).toEqual(live(2, changes, 100, 200));
  });

  it('a new directory and its file are both created, parents first; only the file is digested', async () => {
    const h = await start();
    h.disk.mkdir('lib');
    h.disk.write('lib/x.ts', 'x');
    h.emit(['created', 'lib/x.ts'], ['created', 'lib']);
    await h.wait();
    const changes = [dir('created', 'lib'), file('created', 'lib/x.ts', 'x')];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
    expect(h.disk.probe.digest.mock.calls).toEqual([[wp('lib/x.ts')]]);
  });

  it('a deleted known directory is one deleted directory, and its whole subtree is forgotten', async () => {
    const h = await start();
    await h.seed({ lib: null, 'lib/sub': null, 'lib/x.ts': 'x', 'libx.ts': 'L' });
    h.disk.rm('lib');
    h.emit(['deleted', 'lib']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(2, [gone('directory', 'lib', 100)], 100, 200));
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
    expect(h.sink.delivered[2]).toEqual(live(3, changes, 200, 300));
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
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'ok.ts', 'ok')], 0, 100)]);
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
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'flaky.ts', 'f')], 0, 100)]);
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
    // The known state did not move, so the same window is the same batch, under the reused seq 2.
    h.emit(...window);
    await h.wait();
    const changes = [moved('old.ts', 'new.ts', 'm', 13_200), file('changed', 'c.ts', 'c2', 13_200)];
    expect(h.sink.delivered).toEqual([h.sink.delivered[0], live(2, changes, 13_200, 13_300)]);
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
    const h = await start({}, { omit: ['timers'] });
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
    expect(h.sink.delivered).toEqual([live(1, changes, 7, 140)]);
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
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'a.ts', 'a')], 0, 100)]);
  });

  it('without now, settledAt is Date.now(), looked up at each call', async () => {
    const h = await start({}, { omit: ['now'], disk: { 'a.ts': 'a' } });
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
      live(1, [file('created', 'a.ts', 'a')], 0, 100),
      live(2, [file('created', 'b.ts', 'b', 100)], 100, 300),
    ]);
  });

  it('maps paths with toWorkspacePath: the root and anything outside it are dropped (INV-4, INV-23)', async () => {
    // Known, so a wrong mapping of the deletes below would be delivered, not dropped (decision 58).
    const h = await start({}, { disk: { '2/y.ts': 't', 'b/c.ts': 't', 'etc/x.ts': 't' } });
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
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'a.ts', 'a')], 0, 100)]);
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
      gone('file', 'z.ts', 100),
      file('created', 'c.ts', 'C', 100),
      file('created', 'y.ts', 'Y', 100),
    ];
    expect(h.sink.delivered[1]).toEqual(live(2, changes, 100, 200));
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
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'ok.ts', 'ok')], 0, 100)]);
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
    expect(h.sink.delivered[1]).toEqual(live(2, changes, 100, 200));
  });

  it('events coalesce before pairing: a rename target edited in the same window is still a moved', async () => {
    const h = await start();
    await h.seed({ 'old.ts': 'm' });
    h.disk.rm('old.ts');
    h.disk.write('new.ts', 'm');
    h.emit(['deleted', 'old.ts'], ['created', 'new.ts'], ['changed', 'new.ts']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(2, [moved('old.ts', 'new.ts', 'm', 100)], 100, 200));
  });

  it('a file is digested once per window, however many events name it (INV-26)', async () => {
    const h = await start();
    h.disk.mkdir('lib');
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'lib'], ['created', 'a.ts'], ['changed', 'a.ts'], ['changed', 'a.ts']);
    await h.wait();
    expect(h.disk.probe.digest.mock.calls).toEqual([[wp('a.ts')]]);
    const changes = [file('created', 'a.ts', 'a'), dir('created', 'lib')];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
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
    expect(h.sink.delivered[1]).toEqual(live(2, changes, 100, 200));
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
    expect(h.sink.delivered[1]).toEqual(live(2, [moved('a.ts', 'b.ts', 'A', 100)], 100, 200));
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
    expect(h.sink.delivered[2]).toEqual(live(3, [file('created', 'a.ts', 'a', 200)], 200, 300));
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
    expect(h.sink.delivered[1]).toEqual(live(2, [file('created', 'b.ts', 'b', 200)], 200, 300));
  });

  it('a directory created or changed is created when unknown and dropped when known (S20-1)', async () => {
    const h = await start();
    await h.seed({ lib: null });
    h.disk.mkdir('src');
    h.emit(['created', 'lib'], ['changed', 'src']);
    await h.wait();
    expect(h.sink.delivered[1]).toEqual(live(2, [dir('created', 'src', 100)], 100, 200));
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
    expect(h.sink.delivered[2]).toEqual(live(3, [file('created', 'old.ts', 'm', 200)], 200, 300));
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
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'a.ts', 'a', 100)], 100, 200)]);
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
    const h = await start(
      {
        onDegraded: () => {
          throw new Error('consumer bug');
        },
      },
      { disk: { 'a.ts': 'a' } },
    );
    h.sink.plan.push(...[1, 2, 3, 4, 5].map((n) => new Error(`down ${n}`)));
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    await backoff(h);
    h.disk.write('b.ts', 'b');
    h.emit(['created', 'b.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'b.ts', 'b', 3100)], 3100, 3200)]);
  });

  it('rejects with the backend error when subscribe rejects; onError has its report (the parcel shape)', async () => {
    const error = new Error('Bad file descriptor');
    const report: WatchError = { ...FATAL, code: 'root-missing', cause: error };
    const backend: WatchBackend = {
      capabilities: CAPS,
      subscribe: (_root, _onEvents, options) => {
        options?.onError?.(report);
        return Promise.reject(error);
      },
    };
    const { sink } = recordingSink();
    const { probe } = memoryDisk(fakeClock(), []);
    const errors: WatchError[] = [];
    const ready = createWatchSession({
      root: ROOT,
      backend,
      sink,
      probe,
      onError: (e) => errors.push(e),
    });
    await expect(ready).rejects.toBe(error);
    expect(errors).toEqual([report]);
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
    const h = await start({}, { disk: { 'a.ts': 'a' } });
    h.sink.plan.push(new Error('transient'));
    h.emit(['deleted', 'a.ts']);
    await h.wait();
    await h.session.close();
    await h.wait(200);
    expect(h.clock.armedCount()).toBe(0);
  });

  it('a retry that wakes after close does not call the sink, and onDegraded never fires', async () => {
    const h = await start({}, { disk: { 'a.ts': 'a' } });
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
    const h = await start({}, { disk: { 'a.ts': 'a' } });
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

describe('createWatchSession: the start and the initial batch (decisions 53-55, 57)', () => {
  it.each<[string, Setup]>([
    ['gone', { prepare: ({ disk }) => disk.rm('.') }],
    ['a file', { disk: { '.': 'not a directory' } }],
  ])(
    'rejects root-missing, fatal, when the root is %s, and never subscribes',
    async (_case, setup) => {
      const h = open({}, setup);
      const error = await h.ready.catch((reason: unknown) => reason);
      // Round two: an Error that carries the WatchError fields, not a plain object (S21-9).
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        code: 'root-missing',
        fatal: true,
        rescanRequired: false,
        path: ROOT,
        message: expect.stringContaining(ROOT),
      });
      expect(h.backend.roots).toEqual([]);
      expect(h.errors).toEqual([]);
    },
  );

  it('stats the root, subscribes, then walks: seq 0 is the disk as created, each file digested once (INV-16, INV-26)', async () => {
    const h = open(
      {},
      {
        disk: { lib: null, 'lib/a.ts': 'A', 'lib/sub': null, 'top.ts': 'T' },
        prepare: ({ disk }) => {
          for (const [call, ms] of [
            ['stat .', 5],
            ['list .', 30],
            ['digest top.ts', 10],
          ] as const) {
            disk.delays.set(call, ms);
          }
        },
      },
    );
    await h.ready;
    expect(h.log.slice(0, 3)).toEqual(['stat .', 'subscribe /ws', 'list .']);
    expect(h.log.slice(3).toSorted()).toEqual(['digest lib/a.ts', 'digest top.ts']);
    // firstEventAt and observedAt: the walk's start; settledAt: after the listing and the digests (S21-1).
    const changes = [
      dir('created', 'lib', 5),
      file('created', 'top.ts', 'T', 5),
      file('created', 'lib/a.ts', 'A', 5),
      dir('created', 'lib/sub', 5),
    ];
    expect(h.sink.delivered).toEqual([initial(changes, 5, 45)]);
  });

  it('resolves once seq 0 is confirmed, even empty; a window that settles meanwhile queues behind it', async () => {
    const h = open();
    const hung = deferred();
    h.sink.plan.push(hung);
    let resolved = false;
    void h.ready.then(() => {
      resolved = true;
    });
    await h.wait(0);
    expect(h.sink.calls).toEqual([initial([])]);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait(100);
    expect(h.sink.calls).toHaveLength(1);
    expect(resolved).toBe(false);
    hung.resolve();
    await h.wait(0);
    expect(resolved).toBe(true);
    expect(h.sink.delivered).toEqual([
      initial([]),
      live(1, [file('created', 'a.ts', 'a')], 0, 100),
    ]);
  });

  it('seq 0 is the initial batch even when a window settles while subscribe is pending', async () => {
    const gate = deferred();
    const h = open(
      {},
      {
        prepare: ({ backend }) => {
          backend.subscribeGate = gate.promise;
        },
      },
    );
    await h.wait(0);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait(500);
    gate.resolve();
    await h.ready;
    await h.wait(0);
    expect(h.sink.delivered).toEqual([initial([file('created', 'a.ts', 'a', 500)], 500, 500)]);
  });

  it('with a seed, seq 0 is the diff; a vanished directory is one delete; the unchanged is absent (decision 54)', async () => {
    const seed = seedOf(
      // Round two: old/deep before old, and old.ts beside it.
      {
        'same.ts': 'S',
        'edit.ts': 'E1',
        'gone.ts': 'G',
        'old.ts': 'O',
        'old/x.ts': 'X',
        'old/deep/y.ts': 'Y',
      },
      ['old/deep', 'old', 'kept'],
    );
    const disk = { 'same.ts': 'S', 'edit.ts': 'E2', 'new.ts': 'N', kept: null, fresh: null };
    const h = await start({ seed }, { disk });
    expect(h.initial).toEqual([
      initial([
        gone('file', 'gone.ts'),
        gone('directory', 'old'),
        gone('file', 'old.ts'),
        file('changed', 'edit.ts', 'E2'),
        dir('created', 'fresh'),
        file('created', 'new.ts', 'N'),
      ]),
    ]);
    // Known state is now the disk, so none of these is news.
    h.emit(
      ['changed', 'same.ts'],
      ['changed', 'edit.ts'],
      ['changed', 'new.ts'],
      ['deleted', 'gone.ts'],
      ['deleted', 'old/x.ts'],
      ['created', 'kept'],
    );
    await h.wait();
    expect(h.sink.calls).toEqual([]);
  });

  it("admits every listed entry; an excluded directory's contents stay out and are never digested (decision 53)", async () => {
    const admit = vi.fn<NonNullable<WatchSessionOptions['admit']>>(
      (path, entry, sizeBytes) =>
        path !== 'node_modules' && (entry === 'directory' || (sizeBytes ?? 0) <= 10),
    );
    const disk = {
      node_modules: null,
      'node_modules/pkg': null,
      'node_modules/pkg/i.ts': 'x',
      'node_modules2/a.ts': 'n',
      'big.ts': 'x'.repeat(50),
      'ok.ts': 'ok',
    };
    const h = await start({ admit }, { disk });
    const changes = [file('created', 'ok.ts', 'ok'), file('created', 'node_modules2/a.ts', 'n')];
    expect(h.initial).toEqual([initial(changes)]);
    const digests = h.log.filter((call) => call.startsWith('digest'));
    expect(digests.toSorted()).toEqual(['digest node_modules2/a.ts', 'digest ok.ts']);
    const calls = admit.mock.calls.map(([path, entry, size]) => `${path} ${entry} ${size}`);
    expect(calls).toEqual(
      expect.arrayContaining(['node_modules directory 64', 'big.ts file 50', 'ok.ts file 2']),
    );
  });

  it('seq 0 exhausts its retries: the subscription closes, createWatchSession rejects with the last rejection', async () => {
    const h = open();
    const errors = [1, 2, 3, 4, 5].map((n) => new Error(`sink down ${n}`));
    h.sink.plan.push(...errors);
    const outcome = h.ready.catch((error: unknown) => error);
    await h.wait(0);
    await backoff(h);
    expect(await outcome).toBe(errors[4]);
    expect(h.sink.calls).toHaveLength(5);
    expect(h.backend.closes).toBe(1);
    expect(h.degraded).toEqual([]);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait();
    expect(h.sink.calls).toHaveLength(5);
  });

  it('a walk that throws at start: the subscription closes, createWatchSession rejects with it (S21-3)', async () => {
    const failure = new Error('EACCES');
    const h = open({}, { prepare: ({ disk }) => disk.probe.list.mockRejectedValueOnce(failure) });
    await expect(h.ready).rejects.toBe(failure);
    expect(h.backend.closes).toBe(1);
    expect(h.sink.calls).toEqual([]);
    expect(h.degraded).toEqual([]);
  });

  it('a fatal error during the walk: once the subscription has closed, createWatchSession rejects with it (S21-3)', async () => {
    const listing = deferred<Listing>();
    const gate = deferred();
    const h = open(
      {},
      {
        prepare: ({ disk, backend }) => {
          disk.probe.list.mockReturnValueOnce(listing.promise);
          backend.closeGate = gate.promise;
        },
      },
    );
    let outcome: unknown = 'pending';
    void h.ready.then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await h.wait(0);
    const fatal = { ...FATAL };
    h.fail(fatal);
    await h.wait(0);
    expect(h.backend.closes).toBe(1);
    expect(outcome).toBe('pending');
    // Round two: it waits for the close, not for the walk, which is still pending.
    gate.resolve();
    await h.wait(0);
    expect(outcome).toBe(fatal);
    listing.resolve([]);
    await h.wait(0);
    expect(h.sink.calls).toEqual([]);
    expect(h.degraded).toEqual([]);
    expect(h.errors).toEqual([fatal]);
  });

  // Round two: part a's retry, which returns quietly after close, must not resolve seq 0.
  it('a fatal error while seq 0 waits to retry: createWatchSession rejects with it (S21-3)', async () => {
    const h = open();
    h.sink.plan.push(new Error('sink down'));
    const outcome = h.ready.catch((error: unknown) => error);
    await h.wait(0);
    const fatal = { ...FATAL };
    h.fail(fatal);
    await h.wait(200);
    expect(await outcome).toBe(fatal);
    expect(h.sink.calls).toHaveLength(1);
    expect(h.degraded).toEqual([]);
  });

  // Round two, my own addition: the fatal error comes while subscribe is pending, which then resolves.
  // Post-implementation (sabotage #51): a seq 0 sink call that resolves after close confirmed nothing.
  it('a fatal error while the seq 0 sink call is in flight: that call confirms nothing (S21-3)', async () => {
    const gate = deferred();
    const h = open(
      {},
      {
        prepare: ({ backend }) => {
          backend.closeGate = gate.promise;
        },
      },
    );
    const hung = deferred();
    h.sink.plan.push(hung);
    const outcome = h.ready.catch((error: unknown) => error);
    await h.wait(0);
    const fatal = { ...FATAL };
    h.fail(fatal);
    hung.resolve();
    await h.wait(0);
    gate.resolve();
    expect(await outcome).toBe(fatal);
  });

  it('a fatal error before subscribe resolves: the subscription closes when it does; createWatchSession rejects', async () => {
    const gate = deferred();
    const h = open(
      {},
      {
        prepare: ({ backend }) => {
          backend.subscribeGate = gate.promise;
        },
      },
    );
    await h.wait(0);
    const fatal = { ...FATAL };
    h.fail(fatal);
    gate.resolve();
    await expect(h.ready).rejects.toBe(fatal);
    expect(h.backend.closes).toBe(1);
    expect(h.errors).toEqual([fatal]);
    expect(h.disk.probe.list).not.toHaveBeenCalled();
  });

  // Round two: the walk runs inside the queue, so a window that settles during it waits.
  it('a window that settles during the initial walk is delivered after seq 0, as seq 1 (decision 55)', async () => {
    const listing = deferred<Listing>();
    const h = open(
      {},
      { prepare: ({ disk }) => disk.probe.list.mockReturnValueOnce(listing.promise) },
    );
    await h.wait(0);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait(100);
    expect(h.sink.calls).toEqual([]);
    listing.resolve([]);
    await h.ready;
    await h.wait(0);
    const next = live(1, [file('created', 'a.ts', 'a')], 0, 100);
    expect(h.sink.delivered).toEqual([initial([], 0, 100), next]);
  });
});

describe('createWatchSession: the subtree walk, the ancestor rule, unknown deletes (decisions 56, 58)', () => {
  it('a created directory is listed: its entries join the window as created, each file digested once (INV-5, INV-26)', async () => {
    const h = await start();
    h.disk.mkdir('lib');
    h.disk.mkdir('lib/sub');
    h.disk.write('lib/a.ts', 'A');
    h.disk.write('lib/sub/b.ts', 'B');
    // Round two: lib comes first, so a walk run inline would let lib/a.ts's own event land last.
    h.emit(['created', 'lib', 7], ['created', 'lib/a.ts', 3]);
    await h.wait();
    // The listing is the window's last look, after its raw events; its finds carry lib's time (S21-2).
    const changes = [
      dir('created', 'lib', 7),
      file('created', 'lib/a.ts', 'A', 7),
      dir('created', 'lib/sub', 7),
      file('created', 'lib/sub/b.ts', 'B', 7),
    ];
    expect(h.sink.delivered).toEqual([live(1, changes, 3, 100)]);
    expect(h.disk.probe.list.mock.calls).toEqual([[wp('lib')]]);
    const digested = h.disk.probe.digest.mock.calls.map(([path]) => path);
    expect(digested.toSorted()).toEqual(['lib/a.ts', 'lib/sub/b.ts']);
  });

  // Round two: the finds go through coalesce and pairing, so a move into a new directory needs no raw create.
  it('a file the walk finds pairs with a known delete into a moved (decision 56)', async () => {
    const h = await start({}, { disk: { src: null, 'src/a.ts': 'A' } });
    h.disk.rm('src/a.ts');
    h.disk.mkdir('lib');
    h.disk.write('lib/a.ts', 'A');
    h.emit(['created', 'lib'], ['deleted', 'src/a.ts']);
    await h.wait();
    const changes = [moved('src/a.ts', 'lib/a.ts', 'A'), dir('created', 'lib')];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
  });

  it('lists with directoryEvents none and on a known directory; the kind rules drop what is known', async () => {
    const disk = { lib: null, 'lib/same.ts': 'S', 'lib/edit.ts': 'E1' };
    const h = await start({}, { caps: { directoryEvents: 'none' }, disk });
    h.disk.write('lib/edit.ts', 'E2');
    h.disk.write('lib/new.ts', 'N');
    h.emit(['created', 'lib']);
    await h.wait();
    const changes = [file('changed', 'lib/edit.ts', 'E2'), file('created', 'lib/new.ts', 'N')];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
  });

  it('a refused directory is not listed; a refused listed directory keeps its contents out (decision 53)', async () => {
    // Round two: admit sees the listed size, and lib/node_modules2 is not under lib/node_modules.
    const h = await start({
      admit: (path, entry, sizeBytes) =>
        path !== 'vendor' &&
        path !== 'lib/node_modules' &&
        (entry === 'directory' || (sizeBytes ?? 0) <= 10),
    });
    for (const path of ['vendor', 'lib', 'lib/node_modules']) h.disk.mkdir(path);
    const files = ['vendor/v.ts', 'lib/node_modules/x.ts', 'lib/node_modules2/y.ts', 'lib/a.ts'];
    for (const path of files) h.disk.write(path, 'x');
    h.disk.write('lib/big.ts', 'x'.repeat(50));
    h.emit(['created', 'vendor'], ['created', 'lib']);
    await h.wait();
    const changes = [
      dir('created', 'lib'),
      file('created', 'lib/a.ts', 'x'),
      file('created', 'lib/node_modules2/y.ts', 'x'),
    ];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
    expect(h.disk.probe.list.mock.calls).toEqual([[wp('lib')]]);
    const digested = h.disk.probe.digest.mock.calls.map(([path]) => path);
    expect(digested.toSorted()).toEqual(['lib/a.ts', 'lib/node_modules2/y.ts']);
  });

  it('a listing that rejects reaches onDegraded with the window paths (S20-3)', async () => {
    const h = await start();
    const failure = new Error('EMFILE');
    h.disk.mkdir('lib');
    h.disk.write('a.ts', 'a');
    h.disk.probe.list.mockRejectedValueOnce(failure);
    h.emit(['created', 'lib'], ['created', 'a.ts']);
    await h.wait();
    expect(h.degraded).toEqual([{ paths: ['a.ts', 'lib'], error: failure }]);
    expect(h.sink.calls).toEqual([]);
  });

  it.each(['none', 'delete-only'] as const)(
    'with directoryEvents %s, a file created or changed adds a created for each unknown ancestor',
    async (directoryEvents) => {
      // The disk lists p/q.ts without p, so p stays unknown; a is known.
      const h = await start({}, { caps: { directoryEvents }, disk: { a: null, 'p/q.ts': 'Q1' } });
      h.disk.write('a/b/c/f.ts', 'F');
      h.disk.write('a/b/g.ts', 'G');
      h.disk.write('p/q.ts', 'Q2');
      h.emit(['created', 'a/b/c/f.ts', 9], ['created', 'a/b/g.ts', 9], ['changed', 'p/q.ts', 4]);
      await h.wait();
      // Round two: each ancestor carries its file's observedAt; a/b, under two files, comes once.
      const changes = [
        file('changed', 'p/q.ts', 'Q2', 4),
        dir('created', 'p', 4),
        dir('created', 'a/b', 9),
        dir('created', 'a/b/c', 9),
        file('created', 'a/b/g.ts', 'G', 9),
        file('created', 'a/b/c/f.ts', 'F', 9),
      ];
      expect(h.sink.delivered).toEqual([live(1, changes, 4, 100)]);
    },
  );

  it('with directoryEvents all (parcel), unknown ancestors are not added', async () => {
    const h = await start({}, { disk: { 'p/q.ts': 'Q1' } });
    h.disk.write('a/b/f.ts', 'F');
    h.disk.write('p/q.ts', 'Q2');
    h.emit(['created', 'a/b/f.ts'], ['changed', 'p/q.ts']);
    await h.wait();
    const changes = [file('changed', 'p/q.ts', 'Q2'), file('created', 'a/b/f.ts', 'F')];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
  });

  it('an unknown ancestor that admit refuses as a directory is not added (S21-6)', async () => {
    const admit = vi.fn<NonNullable<WatchSessionOptions['admit']>>(
      (path, entry) => !(path === 'gen' && entry === 'directory'),
    );
    const h = await start({ admit }, { caps: { directoryEvents: 'none' } });
    h.disk.mkdir('gen');
    h.disk.mkdir('gen/sub');
    h.disk.write('gen/sub/x.ts', 'X');
    h.emit(['created', 'gen/sub/x.ts']);
    await h.wait();
    const changes = [dir('created', 'gen/sub'), file('created', 'gen/sub/x.ts', 'X')];
    expect(h.sink.delivered).toEqual([live(1, changes, 0, 100)]);
    // Round two: an ancestor is not stat-ed, and admit sees it with no size.
    expect(h.disk.probe.stat.mock.calls).toEqual([[wp('gen/sub/x.ts')]]);
    const gen = admit.mock.calls.filter(([path]) => path === 'gen');
    expect(gen.map(([, entry, size]) => `${entry} ${size}`)).toEqual(['directory undefined']);
  });

  // Post-implementation (sabotage #6): no case deleted a known directory with nothing known under it.
  it('a deleted known directory with nothing known under it is delivered (decision 58)', async () => {
    const h = await start({}, { disk: { empty: null } });
    h.disk.rm('empty');
    h.emit(['deleted', 'empty']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(1, [gone('directory', 'empty')], 0, 100)]);
  });

  // Post-implementation (sabotage #31): an ancestor created on a known directory merged its delete away.
  it('with directoryEvents delete-only, the ancestor rule leaves a known directory delete standing', async () => {
    const h = await start({}, { caps: { directoryEvents: 'delete-only' }, disk: { a: null } });
    h.disk.rm('a');
    h.disk.write('a/x.ts', 'X');
    h.emit(['deleted', 'a'], ['created', 'a/x.ts']);
    await h.wait();
    expect(h.sink.delivered[0]?.changes).toContainEqual(gone('directory', 'a'));
  });

  it('a deleted unknown path stays when a known file or directory is under it, as a file (decisions 48, 58)', async () => {
    // The disk lists pkg/a.ts and deps/sub without their parents, so pkg and deps stay unknown.
    const h = await start({}, { disk: { 'pkg/a.ts': 'A', 'deps/sub': null } });
    h.disk.rm('pkg/a.ts');
    h.disk.rm('deps/sub');
    h.emit(['deleted', 'pkg'], ['deleted', 'deps'], ['deleted', 'pk'], ['deleted', 'dep']);
    await h.wait();
    expect(h.sink.delivered).toEqual([
      live(1, [gone('file', 'deps'), gone('file', 'pkg')], 0, 100),
    ]);
  });
});

describe('createWatchSession: backend errors and the rescan (decision 57, INV-25)', () => {
  it('passes every backend error to onError unchanged, and runs on', async () => {
    const h = await start();
    const error: WatchError = { ...FATAL, code: 'permission', fatal: false, path: '/ws/lib' };
    h.fail(error);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBe(error);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'a.ts', 'a')], 0, 100)]);
    expect(h.disk.probe.list).not.toHaveBeenCalled();
  });

  it('rescanRequired runs one reconcile: cause rescan, the next seq, the walk clock (decisions 54, 57)', async () => {
    const h = await start({}, { disk: { 'a.ts': 'A', 'b.ts': 'B', lib: null, 'lib/x.ts': 'X' } });
    h.disk.write('a.ts', 'A2');
    h.disk.rm('b.ts');
    h.disk.rm('lib');
    h.disk.write('c.ts', 'C');
    await h.wait(50);
    h.disk.delays.set('list .', 20);
    h.fail({ ...RESCAN });
    await h.wait(0);
    const changes = [
      gone('file', 'b.ts', 50),
      gone('directory', 'lib', 50),
      file('changed', 'a.ts', 'A2', 50),
      file('created', 'c.ts', 'C', 50),
    ];
    expect(h.sink.delivered).toEqual([rescan(1, changes, 50, 70)]);
    expect(h.errors).toEqual([RESCAN]);
    // Delivered, so known: none of these is news.
    h.emit(['changed', 'a.ts'], ['deleted', 'b.ts'], ['deleted', 'lib/x.ts']);
    await h.wait();
    expect(h.sink.calls).toHaveLength(1);
  });

  it('an empty rescan is not delivered and takes no seq (INV-20)', async () => {
    const h = await start();
    h.fail({ ...RESCAN });
    await h.wait(0);
    expect(h.disk.probe.list.mock.calls).toEqual([[WORKSPACE_ROOT]]);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait();
    expect(h.sink.delivered).toEqual([live(1, [file('created', 'a.ts', 'a')], 0, 100)]);
  });

  it('rescans asked for before one starts collapse into one; one asked for during its walk gets its own', async () => {
    const h = await start();
    const hung = deferred();
    h.sink.plan.push(hung);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    await h.wait();
    h.fail({ ...RESCAN });
    h.fail({ ...RESCAN });
    h.fail({ ...RESCAN });
    hung.resolve();
    await h.wait(0);
    expect(h.disk.probe.list).toHaveBeenCalledTimes(1);
    const listing = deferred<Listing>();
    h.disk.probe.list.mockReturnValueOnce(listing.promise);
    h.fail({ ...RESCAN });
    await h.wait(0);
    h.fail({ ...RESCAN });
    listing.resolve([]);
    await h.wait(0);
    expect(h.disk.probe.list).toHaveBeenCalledTimes(3);
    // Round two: collapsed or not, every error reached onError (INV-25: surfaced).
    expect(h.errors).toHaveLength(5);
  });

  it('a rescan that exhausts its retries reaches onDegraded with every path; the seq is reused (INV-22)', async () => {
    const h = await start({}, { disk: { 'a.ts': 'A' } });
    h.disk.rm('a.ts');
    h.disk.write('b.ts', 'B');
    const errors = [1, 2, 3, 4, 5].map((n) => new Error(`store down ${n}`));
    h.sink.plan.push(...errors);
    h.fail({ ...RESCAN });
    await h.wait(0);
    await backoff(h);
    expect(h.degraded).toEqual([{ paths: ['a.ts', 'b.ts'], error: errors[4] }]);
    // Nothing advanced, so the next rescan finds the same diff.
    h.fail({ ...RESCAN });
    await h.wait(0);
    const changes = [gone('file', 'a.ts', 3000), file('created', 'b.ts', 'B', 3000)];
    expect(h.sink.delivered).toEqual([rescan(1, changes, 3000, 3000)]);
  });

  it('a rescan whose walk throws reaches onDegraded with the root (S21-4)', async () => {
    const h = await start();
    const failure = new Error('EIO');
    h.disk.probe.list.mockRejectedValueOnce(failure);
    h.fail({ ...RESCAN });
    await h.wait(0);
    expect(h.degraded).toEqual([{ paths: [WORKSPACE_ROOT], error: failure }]);
    expect(h.sink.calls).toEqual([]);
    // Round two: the next rescan still runs, under the seq the failed one did not take.
    h.disk.write('b.ts', 'B');
    h.fail({ ...RESCAN });
    await h.wait(0);
    expect(h.sink.delivered).toEqual([rescan(1, [file('created', 'b.ts', 'B')], 0, 0)]);
  });

  // Round two: the rescan path is as silent after close as a live window.
  it.each([
    ['resolves', (listing: ReturnType<typeof deferred<Listing>>) => listing.resolve([])],
    [
      'rejects',
      (listing: ReturnType<typeof deferred<Listing>>) => listing.reject(new Error('EIO')),
    ],
  ])(
    'a rescan walk that %s after close() calls neither the sink nor onDegraded',
    async (_case, end) => {
      const h = await start({}, { disk: { 'a.ts': 'a' } });
      const listing = deferred<Listing>();
      h.disk.probe.list.mockReturnValueOnce(listing.promise);
      h.fail({ ...RESCAN });
      await h.wait(0);
      await h.session.close();
      end(listing);
      await h.wait(1000);
      expect(h.sink.calls).toEqual([]);
      expect(h.degraded).toEqual([]);
    },
  );

  // Round two: S21-5 had no case.
  it('in reconcile, a listed file that digests to undefined counts as gone (S21-5)', async () => {
    const h = await start({}, { disk: { 'k.ts': 'K' } });
    h.disk.write('u.ts', 'U');
    h.disk.raced.add('k.ts');
    h.disk.raced.add('u.ts');
    h.fail({ ...RESCAN });
    await h.wait(0);
    expect(h.sink.delivered).toEqual([rescan(1, [gone('file', 'k.ts')], 0, 0)]);
  });

  it('a fatal error closes the session after onError has it; then nothing is heard (decision 51)', async () => {
    const h = await start();
    h.fail({ ...FATAL, rescanRequired: true });
    await h.wait(0);
    expect(h.log.slice(-2)).toEqual(['onError backend-crashed', 'close']);
    h.disk.write('a.ts', 'a');
    h.emit(['created', 'a.ts']);
    h.fail({ ...RESCAN });
    await h.wait();
    await h.session.close();
    expect(h.backend.closes).toBe(1);
    expect(h.errors).toHaveLength(1);
    expect(h.disk.probe.list).not.toHaveBeenCalled();
    expect(h.sink.calls).toEqual([]);
  });

  it('after close(), a backend error reaches no one and starts no rescan', async () => {
    const h = await start();
    await h.session.close();
    h.fail({ ...RESCAN });
    await h.wait(0);
    expect(h.errors).toEqual([]);
    expect(h.disk.probe.list).not.toHaveBeenCalled();
  });

  it('an onError that throws is contained: the rescan and the fatal close still happen (S21-7)', async () => {
    const onError = vi.fn<(error: WatchError) => void>(() => {
      throw new Error('consumer bug');
    });
    const h = await start({ onError });
    expect(() => h.fail({ ...RESCAN })).not.toThrow();
    await h.wait(0);
    expect(h.disk.probe.list).toHaveBeenCalledTimes(1);
    expect(() => h.fail({ ...FATAL })).not.toThrow();
    await h.wait(0);
    expect(h.backend.closes).toBe(1);
    expect(onError).toHaveBeenCalledTimes(2);
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
