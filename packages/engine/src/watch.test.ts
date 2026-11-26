// CpgEngine.watch (U4.2.1 part a, BMO-60; controller decisions 59-63). Expected values come from the
// decisions, C-CLI (WatchEvent, I-23 seq dense and closed last, I-30 the injected clock), C-SINK
// INV-19 (known state advances only on confirmed writes), C-WATCH (INV-19 an unknown changed is an
// upsert, OQ-8 a move is a remove and an add, budget_boundary's three intervals), F-1 (no seq on a
// node) and filesystemTier's row shapes. The disk is real (the engine's own probe); the backend,
// the clock and the timers are fakes, except in the one case that runs the real @parcel/watcher.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isWorkspacePath, makeNodeId, type WorkspacePath } from '@cpg/model';
import { createMemoryStore, type MemoryStore } from '@cpg/sink';
import type { EdgeRow, NodeRow, WriteOp, WriteReceipt } from '@cpg/store';
import type {
  ChangeKind,
  NormalizedChange,
  RawWatchEvent,
  TimerApi,
  WatchBackend,
  WatchCapabilities,
  WatchError,
} from '@cpg/watch';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import type { ConsumerSwitches, StoreTarget, WatchEvent, WatchRequest } from './port';
import { toBatchOp } from './watch';

const roots: string[] = [];
const controllers: AbortController[] = [];
const runs: Promise<void>[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(runs.splice(0));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tree(spec: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpg-watch-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(spec)) {
    const abs = join(root, ...path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }
  return root;
}

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const fileId = (path: string): string => makeNodeId({ form: 'file', path: wp(path) });
const dirId = (path: string): string => makeNodeId({ form: 'directory', path: wp(path) });
const TARGET: StoreTarget = { host: 'localhost', port: 6382, graph: 'cpg' };
const HEADLESS: ConsumerSwitches = { inspect: false, store: 'memory', vscode: false };

// ── filesystemTier's row shapes (walker/filesystem-tier.ts) ──
const fileRow = (path: string, revision: string, language: string | null): NodeRow => ({
  label: 'FILE',
  key: path,
  properties: {
    path,
    name: basename(path),
    language,
    content_hash: revision,
    revision_id: revision,
  },
});
const dirRow = (path: string): NodeRow => ({
  label: 'DIRECTORY',
  key: path,
  properties: { path, name: basename(path), status: 'ready' },
});
const link = (from: string, to: string, toLabel: 'FILE' | 'DIRECTORY'): EdgeRow => ({
  type: 'HAS_ENTRY',
  fromLabel: 'DIRECTORY',
  fromKey: from,
  toLabel,
  toKey: to,
  properties: {},
});
const byKey = (a: NodeRow, b: NodeRow): number => (a.key < b.key ? -1 : 1);
const byText = (a: unknown, b: unknown): number => (String(a) < String(b) ? -1 : 1);
/** Order inside an op is not part of the contract: sort every list by key. */
function sorted(op: WriteOp | undefined): unknown {
  if (op?.kind !== 'merge-filesystem') return op;
  return {
    ...op,
    directories: op.directories.toSorted(byKey),
    files: op.files.toSorted(byKey),
    links: op.links.toSorted((a, b) => (a.toKey < b.toKey ? -1 : 1)),
    removals: op.removals.toSorted(byText),
  };
}
const languageOf = (p: string): string | undefined =>
  p.endsWith('.ts') ? 'typescript' : p.endsWith('.py') ? 'python' : undefined;

// ── the fake clock: TimerApi plus now ──
interface Clock extends TimerApi {
  readonly now: () => number;
  /** Fires every timer due within `ms`, in due order, with now at each one's due time. */
  advance(ms: number): void;
  /** Moves now without firing anything. */
  tick(ms: number): void;
  armed(): number;
}
function fakeClock(origin: number): Clock {
  let t = origin;
  let nextId = 0;
  const timers = new Map<number, { readonly at: number; readonly fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      nextId += 1;
      timers.set(nextId, { at: t + ms, fn });
      return nextId;
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') timers.delete(handle);
    },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, x]) => x.at <= target)
          .toSorted((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (first === undefined) break;
        timers.delete(first[0]);
        t = first[1].at;
        first[1].fn();
      }
      t = target;
    },
    tick(ms) {
      t += ms;
    },
    armed: () => timers.size,
  };
}

// ── the fake backend ──
const CAPS: WatchCapabilities = {
  id: 'fake',
  directoryEvents: 'all',
  moveEvents: 'none',
  reportsErrors: true,
  reportsOverflow: true,
  honoursIgnore: 'none',
  pathCase: 'sensitive',
};
interface Backend extends WatchBackend {
  readonly subscribed: string[];
  closes: number;
  fire(...events: RawWatchEvent[]): void;
  fail(error: WatchError): void;
}
function backendFor(onSubscribe?: (backend: Backend) => Promise<void> | void): Backend {
  let onEvents: ((events: readonly RawWatchEvent[]) => void) | undefined;
  let onError: ((error: WatchError) => void) | undefined;
  const backend: Backend = {
    capabilities: CAPS,
    subscribed: [],
    closes: 0,
    async subscribe(root, events, options) {
      backend.subscribed.push(root);
      onEvents = events;
      onError = options?.onError;
      await onSubscribe?.(backend);
      return {
        capabilities: CAPS,
        close: async () => {
          // Round two (R4): closing takes real time, so a close that is not awaited shows.
          await new Promise((resolve) => setTimeout(resolve, 5));
          backend.closes += 1;
          onEvents = undefined;
          onError = undefined;
        },
      };
    },
    fire: (...events) => onEvents?.(events),
    fail: (error) => onError?.(error),
  };
  return backend;
}
const raw = (root: string, kind: ChangeKind, path: string, observedAt: number): RawWatchEvent => ({
  kind,
  path: join(root, path),
  entry: 'unknown',
  observedAt,
});
const failure = (code: WatchError['code'], fatal: boolean, extra: Partial<WatchError> = {}) => ({
  code,
  message: `${code} happened`,
  fatal,
  rescanRequired: false,
  ...extra,
});

// ── recording stores ──
interface Recorder {
  readonly store: MemoryStore;
  readonly ops: WriteOp[];
  /** Writes that resolved. */
  landed: number;
}
interface RecorderOptions {
  readonly id?: string;
  readonly log?: string[];
  readonly receipt?: Partial<WriteReceipt>;
  /** Rejects write number n (from 1) when true. */
  readonly rejects?: (n: number) => boolean;
  /** Runs inside each write, before it lands. */
  readonly during?: () => Promise<void> | void;
}
function recorder(o: RecorderOptions = {}): Recorder {
  const id = o.id ?? 'memory';
  const memory = createMemoryStore({ id });
  const ops: WriteOp[] = [];
  const recorded: Recorder = {
    ops,
    landed: 0,
    store: {
      ...memory,
      async write(op) {
        ops.push(op);
        o.log?.push(`${id}.write`);
        await o.during?.();
        if (o.rejects?.(ops.length) === true) throw new Error(`${id} refused`);
        const receipt = await memory.write(op);
        recorded.landed += 1;
        o.log?.push(`${id}.landed`);
        return { ...receipt, ...o.receipt };
      },
    },
  };
  return recorded;
}
const nodeIds = async (store: MemoryStore): Promise<string[]> =>
  (await store.readAll()).nodes.map((n) => n.id).toSorted(byText);
const nodePaths = async (store: MemoryStore): Promise<unknown[]> =>
  (await store.readAll()).nodes.map((n) => n.data?.['path']).toSorted(byText);

// ── one watch run ──
type BatchEvent = Extract<WatchEvent, { kind: 'batch' }>;
interface Run {
  readonly root: string;
  readonly events: WatchEvent[];
  readonly done: Promise<void>;
  readonly backend: Backend;
  readonly clock: Clock;
  readonly memory: Recorder;
  /** `backend.closes` when the closed event was emitted (round two, R4). */
  closesAtClosed(): number | undefined;
  abort(): void;
}
interface StartOptions {
  readonly backend?: Backend;
  readonly clock?: Clock;
  readonly memory?: Recorder;
  readonly host?: Recorder;
  readonly config?: Partial<Omit<WatchRequest['config'], 'root'>>;
  readonly controller?: AbortController;
  readonly onEvent?: (event: WatchEvent) => void;
}
async function start(root: string, o: StartOptions = {}): Promise<Run> {
  const clock = o.clock ?? fakeClock(5000);
  const backend = o.backend ?? backendFor();
  const memory = o.memory ?? recorder();
  const engine = createEngine(
    { version: '1', consumers: HEADLESS },
    {
      memoryStore: memory.store,
      ...(o.host !== undefined && { sinks: [o.host.store] }),
      watchBackend: backend,
      now: clock.now,
      timers: clock,
    },
  );
  const session = await engine.connect(TARGET, { readOnly: false });
  const controller = o.controller ?? new AbortController();
  controllers.push(controller);
  const events: WatchEvent[] = [];
  let closesAtClosed: number | undefined;
  const done = engine.watch(
    { config: { root, ...o.config }, session },
    (event) => {
      events.push(event);
      if (event.kind === 'closed') closesAtClosed = backend.closes;
      o.onEvent?.(event);
    },
    controller.signal,
  );
  runs.push(done);
  return {
    root,
    events,
    done,
    backend,
    clock,
    memory,
    closesAtClosed: () => closesAtClosed,
    abort: () => controller.abort(),
  };
}
const throwing = (): never => {
  throw new Error('consumer broke');
};
/** A clock far from Date.now (round two, R12): an interval mixing the two clocks is off by 1e6. */
const offsetNow = (): number => Date.now() + 1_000_000;
const realDelay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
/** The real-backend case's save, with all its bytes. */
const full = (c: NormalizedChange): boolean => c.path === 'b.ts' && c.revision_id === sha256('bee');

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- polling the real event loop
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const batches = (events: readonly WatchEvent[]): BatchEvent[] =>
  events.filter((e): e is BatchEvent => e.kind === 'batch');
const kinds = (events: readonly WatchEvent[]): string[] => events.map((e) => e.kind);
const seqs = (events: readonly WatchEvent[]): number[] => events.map((e) => e.seq);
const ready = (run: Run): Promise<void> =>
  until(() => run.events.some((e) => e.kind === 'ready'), 'ready');
/** Drives withRetry's four backoff waits (5 attempts) on the fake clock. */
async function drainRetries(clock: Clock): Promise<void> {
  for (const delay of [200, 400, 800, 1600]) {
    // oxlint-disable-next-line no-await-in-loop -- one backoff at a time
    await until(() => clock.armed() > 0, `a ${delay} ms backoff`);
    clock.advance(delay);
  }
}

describe('start: index, then ready (decision 60)', () => {
  it('runs index() and emits ready as seq 0 with its report; an unchanged disk writes nothing more', async () => {
    const root = await tree({
      'a.ts': 'a',
      'src/b.py': 'b',
      'README.md': 'r',
      'lib.min.js': 'm',
      'node_modules/x.js': 'x',
    });
    const run = await start(root);
    await ready(run);

    const twin = createEngine({ version: '1', consumers: HEADLESS });
    const twinSession = await twin.connect(TARGET, { readOnly: false });
    const signal = new AbortController().signal;
    const report = await twin.index(
      { config: { root }, session: twinSession, resumeFrom: null },
      () => undefined,
      signal,
    );
    expect(run.events).toEqual([
      {
        kind: 'ready',
        seq: 0,
        at: 5000,
        root,
        report: { ...report, durationMs: expect.any(Number) },
      },
    ]);
    const [event] = run.events;
    if (event?.kind !== 'ready') throw new Error('no ready');
    expect(event.report.walk).toEqual({
      filesSeen: 4,
      filesIndexed: 2,
      filesExcluded: 1,
      filesUnsupported: 1,
      filesTooLarge: 0,
      filesFailed: 0,
    });
    expect(event.report.files.map((f) => f.path)).toEqual(['a.ts', 'src/b.py']);
    expect(event.report.consumers).toEqual(['memory']);
    expect(run.memory.ops).toHaveLength(1);
    expect(run.backend.subscribed).toEqual([root]);
  });

  it('seeds the session from the walk, so the initial batch is only what changed since, written before ready', async () => {
    const root = await tree({ 'a.ts': 'one', 'gone.ts': 'x', 'keep/k.ts': 'k', 'README.md': 'r' });
    const log: string[] = [];
    const clock = fakeClock(5000);
    const backend = backendFor(async () => {
      clock.tick(11);
      await writeFile(join(root, 'a.ts'), 'two');
      await writeFile(join(root, 'keep', 'new.ts'), 'fresh');
      await rm(join(root, 'gone.ts'));
    });
    const run = await start(root, {
      backend,
      clock,
      memory: recorder({ log }),
      onEvent: (event) => log.push(`event ${event.kind}`),
    });
    await ready(run);

    expect(run.memory.ops).toHaveLength(2);
    expect(sorted(run.memory.ops[1])).toEqual({
      kind: 'merge-filesystem',
      directories: [],
      files: [
        fileRow('a.ts', sha256('two'), 'typescript'),
        fileRow('keep/new.ts', sha256('fresh'), 'typescript'),
      ],
      links: [link('.', 'a.ts', 'FILE'), link('keep', 'keep/new.ts', 'FILE')],
      moves: [],
      removals: ['gone.ts'],
    });
    expect(log).toEqual([
      'memory.write',
      'memory.landed',
      'memory.write',
      'memory.landed',
      'event ready',
    ]);
    expect(seqs(run.events)).toEqual([0]);
    expect(run.events[0]?.at).toBe(5011);
  });
});

describe('live batches (decisions 62, 63)', () => {
  it('a created file is one op through every sink, then a batch event: the first receipt, the three intervals, at from now (I-30)', async () => {
    const root = await tree({ 'src/a.ts': 'a' });
    const clock = fakeClock(5000);
    const log: string[] = [];
    let writeTakes = 0;
    const host = recorder({
      id: 'host',
      log,
      receipt: { nodesWritten: 90, edgesWritten: 80, statementCount: 70 },
      during: async () => {
        await Promise.resolve();
        clock.tick(writeTakes);
      },
    });
    const memory = recorder({ log, during: realDelay });
    const run = await start(root, { clock, host, memory });
    await ready(run);
    writeTakes = 7;

    await writeFile(join(root, 'src', 'new.ts'), 'hello');
    await writeFile(join(root, 'notes.txt'), 'n');
    run.backend.fire(
      raw(root, 'created', 'src/new.ts', 5040),
      raw(root, 'created', 'notes.txt', 5030),
    );
    // The window settles at 5100; the clock then stands at 5150 while the probe and the write run.
    clock.advance(150);
    await until(() => run.events.length === 2, 'a batch');

    expect(run.events[1]).toEqual({
      kind: 'batch',
      seq: 1,
      at: 5157,
      changes: [
        {
          kind: 'created',
          entry: 'file',
          path: 'notes.txt',
          observedAt: 5030,
          revision_id: sha256('n'),
          sizeBytes: 1,
        },
        {
          kind: 'created',
          entry: 'file',
          path: 'src/new.ts',
          observedAt: 5040,
          revision_id: sha256('hello'),
          sizeBytes: 5,
        },
      ],
      write: { nodesWritten: 2, edgesWritten: 2, statementCount: 1 },
      latencyMs: { t0_t1: null, t1_t2: 70, t2_t3: 57, total: 127 },
    });
    const expectedOp = {
      kind: 'merge-filesystem',
      directories: [],
      files: [
        fileRow('notes.txt', sha256('n'), null),
        fileRow('src/new.ts', sha256('hello'), 'typescript'),
      ],
      links: [link('.', 'notes.txt', 'FILE'), link('src', 'src/new.ts', 'FILE')],
      moves: [],
      removals: [],
    };
    expect(sorted(run.memory.ops[1])).toEqual(expectedOp);
    expect(sorted(host.ops[1])).toEqual(expectedOp);
    const oneWrite = ['memory.write', 'memory.landed', 'host.write', 'host.landed'];
    expect(log).toEqual([...oneWrite, ...oneWrite]);
    // F-1: seq lives on the envelope, never on a node.
    const { nodes } = await run.memory.store.readAll();
    expect(nodes.filter((n) => n.data !== undefined && 'seq' in n.data)).toEqual([]);
    expect(nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([fileId('notes.txt'), fileId('src/new.ts')]),
    );
  });

  it('a created directory is a DIRECTORY row and its link; the subtree walk finds what is inside', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const run = await start(root);
    await ready(run);
    await mkdir(join(root, 'lib', 'deep'), { recursive: true });
    await writeFile(join(root, 'lib', 'deep', 'x.py'), 'x');
    run.backend.fire(raw(root, 'created', 'lib', 5001));
    run.clock.advance(100);
    await until(() => batches(run.events).length === 1, 'a batch');

    expect(sorted(run.memory.ops[1])).toEqual({
      kind: 'merge-filesystem',
      directories: [dirRow('lib'), dirRow('lib/deep')],
      files: [fileRow('lib/deep/x.py', sha256('x'), 'python')],
      links: [
        link('.', 'lib', 'DIRECTORY'),
        link('lib', 'lib/deep', 'DIRECTORY'),
        link('lib/deep', 'lib/deep/x.py', 'FILE'),
      ],
      moves: [],
      removals: [],
    });
    const ids = await nodeIds(run.memory.store);
    expect(ids).toEqual(
      expect.arrayContaining([dirId('lib'), dirId('lib/deep'), fileId('lib/deep/x.py')]),
    );
  });

  it('a deleted file and a deleted directory are removals; the store drops the subtree', async () => {
    const root = await tree({ 'a.ts': 'a', 'b.ts': 'b', 'd/x.ts': 'x', 'd/e/y.ts': 'y' });
    const run = await start(root);
    await ready(run);
    await rm(join(root, 'a.ts'));
    await rm(join(root, 'd'), { recursive: true });
    run.backend.fire(raw(root, 'deleted', 'a.ts', 5001), raw(root, 'deleted', 'd', 5002));
    run.clock.advance(100);
    await until(() => batches(run.events).length === 1, 'a batch');

    expect(batches(run.events)[0]?.changes).toEqual([
      { kind: 'deleted', entry: 'file', path: 'a.ts', observedAt: 5001 },
      { kind: 'deleted', entry: 'directory', path: 'd', observedAt: 5002 },
    ]);
    expect(sorted(run.memory.ops[1])).toEqual({
      kind: 'merge-filesystem',
      directories: [],
      files: [],
      links: [],
      moves: [],
      removals: ['a.ts', 'd'],
    });
    expect(await nodePaths(run.memory.store)).toEqual(['.', 'b.ts']);
  });

  it('a rename is one moved change, written as a removal and an add with no moves (C-WATCH OQ-8)', async () => {
    const root = await tree({ 'src/old.ts': 'same bytes' });
    const run = await start(root);
    await ready(run);
    await rename(join(root, 'src', 'old.ts'), join(root, 'new.ts'));
    run.backend.fire(
      raw(root, 'deleted', 'src/old.ts', 5001),
      raw(root, 'created', 'new.ts', 5002),
    );
    run.clock.advance(100);
    await until(() => batches(run.events).length === 1, 'a batch');

    expect(batches(run.events)[0]?.changes).toEqual([
      {
        kind: 'moved',
        entry: 'file',
        path: 'new.ts',
        fromPath: 'src/old.ts',
        observedAt: 5002,
        revision_id: sha256('same bytes'),
        sizeBytes: 10,
      },
    ]);
    expect(sorted(run.memory.ops[1])).toEqual({
      kind: 'merge-filesystem',
      directories: [],
      files: [fileRow('new.ts', sha256('same bytes'), 'typescript')],
      links: [link('.', 'new.ts', 'FILE')],
      moves: [],
      removals: ['src/old.ts'],
    });
    expect(await nodePaths(run.memory.store)).toEqual(['.', 'new.ts', 'src']);
  });

  it('trailingMs and ceilingMs reach the session (decision 59)', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const run = await start(root, { config: { trailingMs: 30, ceilingMs: 50 } });
    await ready(run);
    await writeFile(join(root, 'w1.ts'), '1');
    run.backend.fire(raw(root, 'created', 'w1.ts', 5000));
    run.clock.advance(100);
    await until(() => batches(run.events).length === 1, 'the first window');
    await writeFile(join(root, 'w2.ts'), '2');
    run.backend.fire(raw(root, 'created', 'w2.ts', 5100));
    run.clock.advance(25);
    run.backend.fire(raw(root, 'changed', 'w2.ts', 5125));
    run.clock.advance(100);
    await until(() => batches(run.events).length === 2, 'the second window');

    expect(batches(run.events).map((b) => b.latencyMs.t1_t2)).toEqual([30, 50]);
  });
});

describe("admission is the walker's (decision 61)", () => {
  it('what the walk excludes never reaches the store: at start or live', async () => {
    // src/ is a directory far over the 8-byte cap: the cap is for files only. include is files-only
    // too: src/ is entered although it does not match **/*.ts (round two, R8).
    const root = await tree({
      'a.ts': 'a',
      'src/s.ts': 's',
      'notes.md': 'n',
      'build/pre.ts': 'p',
      'big-start.ts': '123456789',
      'start.log': 'l',
    });
    // Relative targets: a 4- or 5-byte link is under the size cap, so only the symlink rule refuses it.
    await symlink('a.ts', join(root, 'link-start.ts'));
    const config = { include: ['**/*.ts'], exclude: ['build/', '**/*.log'], maxFileSizeBytes: 8 };
    const run = await start(root, { config });
    await ready(run);
    expect(run.memory.ops).toHaveLength(1);

    await writeFile(join(root, 'build', 'out.ts'), 'o');
    await writeFile(join(root, 'x.log'), 'x');
    await writeFile(join(root, 'big.ts'), '123456789');
    await writeFile(join(root, 'ok.ts'), '12345678');
    await writeFile(join(root, 'live.md'), 'm');
    await symlink('ok.ts', join(root, 'link.ts'));
    run.backend.fire(
      ...['build/out.ts', 'x.log', 'big.ts', 'ok.ts', 'live.md', 'link.ts'].map((p) =>
        raw(root, 'created', p, 5001),
      ),
    );
    run.clock.advance(100);
    await until(() => batches(run.events).length === 1, 'a batch');

    expect(batches(run.events)[0]?.changes.map((c) => c.path)).toEqual(['ok.ts']);
    expect(sorted(run.memory.ops[1])).toMatchObject({
      files: [fileRow('ok.ts', sha256('12345678'), 'typescript')],
    });
  });
});

describe('failures and warnings (decision 63)', () => {
  it('known state advances only when every sink confirmed: an unwritten file comes back after a failed batch (C-SINK INV-19)', async () => {
    const root = await tree({ 'a.ts': 'a' });
    let refusing = false;
    const host = recorder({ id: 'host', rejects: () => refusing });
    const run = await start(root, { host });
    await ready(run);

    refusing = true;
    await writeFile(join(root, 'new.ts'), 'n');
    await writeFile(join(root, 'other.ts'), 'o');
    run.backend.fire(raw(root, 'created', 'new.ts', 5001), raw(root, 'created', 'other.ts', 5002));
    run.clock.advance(100);
    await drainRetries(run.clock);
    await until(() => run.events.some((e) => e.kind === 'warning'), 'the warning');
    const warning = run.events[1];
    expect(warning?.kind === 'warning' && warning.message).toContain('new.ts');
    expect(warning?.kind === 'warning' && warning.message).toContain('other.ts');
    // ready at 5000, the window settled at 5100, four backoff waits of 3000 ms in all (R11).
    expect(warning?.at).toBe(8100);

    refusing = false;
    run.backend.fire(raw(root, 'changed', 'new.ts', 9000), raw(root, 'changed', 'other.ts', 9001));
    run.clock.advance(100);
    await until(() => batches(run.events).length === 1, 'the batch again');
    expect(batches(run.events)[0]?.changes).toMatchObject([
      { kind: 'created', path: 'new.ts' },
      { kind: 'created', path: 'other.ts' },
    ]);
    expect(seqs(run.events)).toEqual([0, 1, 2]);
  });

  it('seq is dense from 0 across every kind and closed is last (I-23): a non-fatal error is a warning, its rescan a batch', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const run = await start(root);
    await ready(run);
    await writeFile(join(root, 'missed.ts'), 'm');
    run.backend.fail(failure('overflow', false, { rescanRequired: true, message: 'queue full' }));
    await until(() => batches(run.events).length === 1, 'the rescan batch');
    run.abort();
    await run.done;

    expect(kinds(run.events)).toEqual(['ready', 'warning', 'batch', 'closed']);
    expect(seqs(run.events)).toEqual([0, 1, 2, 3]);
    const [, warning, batch] = run.events;
    expect(warning?.kind === 'warning' && warning.message).toMatch(/^overflow\b.*queue full/);
    expect(batch?.kind === 'batch' && batch.changes.map((c) => c.path)).toEqual(['missed.ts']);
  });

  it.each([
    ['without a path, the root', undefined],
    ['with its own path', '/elsewhere/x'],
  ])(
    'a fatal backend error, %s, is error then closed, and nothing follows',
    async (_name, path) => {
      const root = await tree({ 'a.ts': 'a' });
      const run = await start(root);
      await ready(run);
      run.backend.fail(failure('backend-crashed', true, path === undefined ? {} : { path }));
      await run.done;

      expect(run.events.slice(1)).toEqual([
        {
          kind: 'error',
          seq: 1,
          at: 5000,
          error: {
            kind: 'workspace',
            path: path ?? root,
            message: expect.stringMatching(/^backend-crashed\b.*happened/),
          },
        },
        { kind: 'closed', seq: 2, at: 5000, reason: 'error' },
      ]);
      expect(run.backend.closes).toBe(1);
      expect(run.closesAtClosed()).toBe(1);
      await writeFile(join(root, 'late.ts'), 'l');
      run.backend.fire(raw(root, 'created', 'late.ts', 6000));
      run.clock.advance(1000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(run.events).toHaveLength(3);
      expect(run.memory.ops).toHaveLength(1);
    },
  );

  it.each([
    ['reported through onError alone', false],
    // Round two (R5): parcel-backend.ts reports the WatchError, then rejects subscribe with the cause.
    ['reported, then subscribe rejects with the raw cause, as parcel does', true],
  ])('a fatal error during start, %s, is one error, then closed', async (_name, rethrow) => {
    const root = await tree({ 'a.ts': 'a' });
    const backend = backendFor((b) => {
      b.fail(failure('watch-limit', true));
      if (rethrow) throw new Error('Bad file descriptor');
    });
    const run = await start(root, { backend });
    await run.done;
    expect(run.events).toEqual([
      {
        kind: 'error',
        seq: 0,
        at: 5000,
        error: { kind: 'workspace', path: root, message: expect.stringMatching(/^watch-limit\b/) },
      },
      { kind: 'closed', seq: 1, at: 5000, reason: 'error' },
    ]);
  });

  it('a warning that arrives before ready is held, so ready is seq 0', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const backend = backendFor((b) => b.fail(failure('permission', false, { message: 'early' })));
    const run = await start(root, { backend });
    await until(() => run.events.length === 2, 'ready and the warning');
    expect(kinds(run.events)).toEqual(['ready', 'warning']);
    expect(seqs(run.events)).toEqual([0, 1]);
  });

  it('a missing root is error { workspace } then closed, and nothing subscribes', async () => {
    const root = join(await tree({}), 'nope');
    const run = await start(root);
    await run.done;
    expect(run.events).toEqual([
      {
        kind: 'error',
        seq: 0,
        at: 5000,
        error: { kind: 'workspace', path: root, message: expect.stringMatching(/^root-missing\b/) },
      },
      { kind: 'closed', seq: 1, at: 5000, reason: 'error' },
    ]);
    expect(run.backend.subscribed).toEqual([]);
  });

  it('a sink that refuses the initial batch is error { engine-rejected } then closed, with no ready', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const host = recorder({ id: 'host', rejects: (n) => n >= 2 });
    const backend = backendFor(() => writeFile(join(root, 'b.ts'), 'b'));
    const run = await start(root, { host, backend });
    await drainRetries(run.clock);
    await run.done;
    // The four backoff waits moved the clock 3000 ms.
    expect(run.events).toEqual([
      {
        kind: 'error',
        seq: 0,
        at: 8000,
        error: { kind: 'engine-rejected', message: 'host refused' },
      },
      { kind: 'closed', seq: 1, at: 8000, reason: 'error' },
    ]);
    expect(run.backend.closes).toBe(1);
  });

  it('an index that fails is error { engine-rejected } then closed, and nothing subscribes', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const run = await start(root, { host: recorder({ id: 'host', rejects: () => true }) });
    await run.done;
    expect(run.events).toEqual([
      {
        kind: 'error',
        seq: 0,
        at: 5000,
        error: { kind: 'engine-rejected', message: 'host refused' },
      },
      { kind: 'closed', seq: 1, at: 5000, reason: 'error' },
    ]);
    expect(run.backend.subscribed).toEqual([]);
  });

  it('a throwing onEvent is contained: the batch is not written again', async () => {
    const root = await tree({ 'a.ts': 'a' });
    let throwOnce = true;
    const run = await start(root, {
      onEvent: (event) => {
        if (event.kind === 'batch' && throwOnce) {
          throwOnce = false;
          throw new Error('consumer broke');
        }
      },
    });
    await ready(run);
    await writeFile(join(root, 'one.ts'), '1');
    run.backend.fire(raw(root, 'created', 'one.ts', 5001));
    run.clock.advance(100);
    await until(() => batches(run.events).length === 1, 'the first batch');
    await writeFile(join(root, 'two.ts'), '2');
    run.backend.fire(raw(root, 'created', 'two.ts', 5101));
    run.clock.advance(300);
    await until(() => batches(run.events).length === 2, 'the second batch');

    expect(batches(run.events).map((b) => b.changes.map((c) => c.path))).toEqual([
      ['one.ts'],
      ['two.ts'],
    ]);
    expect(run.memory.ops).toHaveLength(3);
  });
});

// Round two (R13): a throw on ready (inside the initial batch) or on closed is contained too.
it('an onEvent that throws on every event: ready once, the batch once, closed, and watch() resolves', async () => {
  const root = await tree({ 'a.ts': 'a' });
  const run = await start(root, { onEvent: throwing });
  await ready(run);
  await writeFile(join(root, 'one.ts'), '1');
  run.backend.fire(raw(root, 'created', 'one.ts', 5001));
  run.clock.advance(100);
  await until(() => batches(run.events).length === 1, 'the batch');
  run.clock.advance(5000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  run.abort();
  await run.done;
  expect(kinds(run.events)).toEqual(['ready', 'batch', 'closed']);
  expect(run.memory.ops).toHaveLength(2);
});

describe('stop (decision 63)', () => {
  it('abort closes the session, then closed { signal } is last, and watch() resolves after it', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const run = await start(root);
    await ready(run);
    run.clock.tick(42);
    run.abort();
    await run.done;
    expect(run.events).toEqual([
      expect.objectContaining({ kind: 'ready', seq: 0 }),
      { kind: 'closed', seq: 1, at: 5042, reason: 'signal' },
    ]);
    expect(run.backend.closes).toBe(1);
    expect(run.closesAtClosed()).toBe(1);

    await writeFile(join(root, 'late.ts'), 'l');
    run.backend.fire(raw(root, 'created', 'late.ts', 6000));
    run.clock.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.events).toHaveLength(2);
    expect(run.memory.ops).toHaveLength(1);
  });

  it('a signal already aborted: only closed { signal }, nothing written, nothing subscribed', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const controller = new AbortController();
    controller.abort();
    const run = await start(root, { controller });
    await run.done;
    expect(run.events).toEqual([{ kind: 'closed', seq: 0, at: 5000, reason: 'signal' }]);
    expect(run.memory.ops).toEqual([]);
    expect(run.backend.subscribed).toEqual([]);
  });

  // Round two (R7): the signal fires while index() writes, after its own pre-write check.
  it('an abort during the index: closed { signal }, and nothing subscribes', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const controller = new AbortController();
    const host = recorder({ id: 'host', during: () => controller.abort() });
    const run = await start(root, { controller, host });
    await run.done;
    expect(run.events).toEqual([{ kind: 'closed', seq: 0, at: 5000, reason: 'signal' }]);
    expect(host.ops).toHaveLength(1);
    expect(run.backend.subscribed).toEqual([]);
  });

  it('an abort during start: no ready; the session is closed once it starts, then closed { signal }', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const controller = new AbortController();
    const backend = backendFor(() => controller.abort());
    const run = await start(root, { controller, backend });
    await run.done;
    expect(run.events).toEqual([{ kind: 'closed', seq: 0, at: 5000, reason: 'signal' }]);
    expect(run.backend.closes).toBe(1);
    expect(run.closesAtClosed()).toBe(1);
  });

  it('a write in flight is not awaited, and its batch never follows closed', async () => {
    const root = await tree({ 'a.ts': 'a' });
    let gate: Promise<void> | undefined;
    let release: (() => void) | undefined;
    const host = recorder({ id: 'host', during: () => gate });
    const run = await start(root, { host });
    await ready(run);
    gate = new Promise((resolve) => {
      release = resolve;
    });
    await writeFile(join(root, 'slow.ts'), 's');
    run.backend.fire(raw(root, 'created', 'slow.ts', 5001));
    run.clock.advance(100);
    await until(() => host.ops.length === 2, 'the write to start');
    run.abort();
    await run.done;
    expect(kinds(run.events)).toEqual(['ready', 'closed']);

    release?.();
    await until(() => host.landed === 2, 'the write');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kinds(run.events)).toEqual(['ready', 'closed']);
  });
});

describe('toBatchOp (decision 62)', () => {
  it('a changed on a path the store lacks is an upsert (C-WATCH INV-19)', async () => {
    const memory = createMemoryStore();
    await memory.open();
    await memory.write({
      kind: 'merge-filesystem',
      directories: [dirRow('.'), dirRow('x')],
      files: [],
      links: [link('.', 'x', 'DIRECTORY')],
      moves: [],
      removals: [],
    });
    const change: NormalizedChange = {
      kind: 'changed',
      entry: 'file',
      path: wp('x/new.ts'),
      observedAt: 1,
      revision_id: 'ab12',
      sizeBytes: 3,
    };
    const op = toBatchOp([change], languageOf);
    expect(op).toEqual({
      kind: 'merge-filesystem',
      directories: [],
      files: [fileRow('x/new.ts', 'ab12', 'typescript')],
      links: [link('x', 'x/new.ts', 'FILE')],
      moves: [],
      removals: [],
    });
    await memory.write(op);
    const { nodes, edges } = await memory.readAll();
    expect(nodes.find((n) => n.id === fileId('x/new.ts'))?.data?.['revision_id']).toBe('ab12');
    expect(edges).toContainEqual({
      source: dirId('x'),
      target: fileId('x/new.ts'),
      type: 'HAS_ENTRY',
    });
  });

  it('moves, deletes and creates of both entries; moves stays []', () => {
    const at = { observedAt: 1 };
    const changes: NormalizedChange[] = [
      {
        ...at,
        kind: 'moved',
        entry: 'file',
        path: wp('b.ts'),
        fromPath: wp('a.ts'),
        revision_id: 'r1',
      },
      { ...at, kind: 'moved', entry: 'directory', path: wp('to'), fromPath: wp('from') },
      { ...at, kind: 'deleted', entry: 'directory', path: wp('d') },
      { ...at, kind: 'deleted', entry: 'file', path: wp('e.ts') },
      { ...at, kind: 'changed', entry: 'directory', path: wp('c') },
      { ...at, kind: 'created', entry: 'directory', path: wp('n') },
      { ...at, kind: 'created', entry: 'file', path: wp('n/f.py'), revision_id: 'r2' },
      { ...at, kind: 'created', entry: 'file', path: wp('n/g.md'), revision_id: 'r3' },
    ];
    expect(sorted(toBatchOp(changes, languageOf))).toEqual({
      kind: 'merge-filesystem',
      directories: [dirRow('c'), dirRow('n'), dirRow('to')],
      files: [
        fileRow('b.ts', 'r1', 'typescript'),
        fileRow('n/f.py', 'r2', 'python'),
        fileRow('n/g.md', 'r3', null),
      ],
      links: [
        link('.', 'b.ts', 'FILE'),
        link('.', 'c', 'DIRECTORY'),
        link('.', 'n', 'DIRECTORY'),
        link('n', 'n/f.py', 'FILE'),
        link('n', 'n/g.md', 'FILE'),
        link('.', 'to', 'DIRECTORY'),
      ],
      moves: [],
      removals: ['a.ts', 'd', 'e.ts', 'from'],
    });
  });

  it('an empty batch is an empty op, and a file change without revision_id throws (INV-26)', () => {
    expect(toBatchOp([], languageOf)).toEqual({
      kind: 'merge-filesystem',
      directories: [],
      files: [],
      links: [],
      moves: [],
      removals: [],
    });
    // Round two (R10): created, changed and moved alike.
    const bare: NormalizedChange[] = [
      { kind: 'created', entry: 'file', path: wp('a.ts'), observedAt: 1 },
      { kind: 'changed', entry: 'file', path: wp('a.ts'), observedAt: 1 },
      { kind: 'moved', entry: 'file', path: wp('a.ts'), fromPath: wp('b.ts'), observedAt: 1 },
    ];
    for (const change of bare) {
      expect(() => toBatchOp([change], languageOf)).toThrow(/revision_id/);
    }
  });
});

describe('the default backend is @parcel/watcher', () => {
  it('a real save on a real disk arrives as a batch, then abort closes', async () => {
    const root = await tree({ 'a.ts': 'a' });
    const startedAt = offsetNow();
    const engine = createEngine({ version: '1', consumers: HEADLESS }, { now: offsetNow });
    const session = await engine.connect(TARGET, { readOnly: false });
    const controller = new AbortController();
    controllers.push(controller);
    const events: WatchEvent[] = [];
    const done = engine.watch(
      { config: { root }, session },
      (event) => events.push(event),
      controller.signal,
    );
    runs.push(done);
    await until(() => events.length > 0, 'ready', 15_000);
    expect(events[0]?.kind).toBe('ready');

    await writeFile(join(root, 'b.ts'), 'bee');
    // Round two (R14): a create and its write may arrive in two windows; wait for the bytes.
    const saved = (): boolean => batches(events).some((b) => b.changes.some(full));
    await until(saved, 'the save', 15_000);
    controller.abort();
    await done;

    expect(events.at(-1)).toMatchObject({ kind: 'closed', reason: 'signal' });
    const batch = batches(events).find((b) => b.changes.some(full));
    expect(batch?.latencyMs.t0_t1).toBeNull();
    // One clock end to end (R12): parcel's observedAt is the engine's now, not Date.now.
    expect(events[0]?.at).toBeGreaterThanOrEqual(startedAt);
    expect(batch?.latencyMs.t1_t2).toBeGreaterThanOrEqual(0);
    expect(batch?.latencyMs.t1_t2).toBeLessThan(10_000);
    expect(batch?.latencyMs.t2_t3).toBeGreaterThanOrEqual(0);
    expect(batch?.latencyMs.t2_t3).toBeLessThan(10_000);
    expect(batch?.latencyMs.total).toBe(
      (batch?.latencyMs.t1_t2 ?? 0) + (batch?.latencyMs.t2_t3 ?? 0),
    );
  }, 40_000);
});
