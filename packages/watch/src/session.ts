// C-WATCH layer B's session (U4.1.2, BMO-51). REAL.
// Ported from e45574f:packages/engine/src/watch/watch-workspace.ts without its fs reads, its matcher
// or `skipInitialIndex`: the disk comes in as the injected WatchProbe (INV-3, decision 47), admission
// as `admit`, and what the consumer already holds as `seed`. The ancestor rule is
// 21754b4:packages/file-watcher/src/index.ts's ancestor rescan (WorkspaceGraphIndex.applyChange),
// reduced to decision 56.

import { WORKSPACE_ROOT, isWorkspacePath, toWorkspacePath, type WorkspacePath } from '@cpg/model';
import { coalesce, flushBatch, type PendingChange } from './coalesce';
import type {
  BatchCause,
  ChangeBatch,
  EntryKind,
  ListedEntry,
  NormalizedChange,
  RawWatchEvent,
  TimerApi,
  WatchError,
  WatchProbe,
  WatchSession,
  WatchSessionOptions,
  WatchSubscription,
} from './contract';
import { ChangeBatcher, type ChangeBatcherOptions } from './debounce';
import { isExcludedPath, pairFileRenames, type Admit } from './normalize';
import { SerialQueue, withRetry } from './queue';

interface MappedEvent {
  readonly kind: 'created' | 'changed' | 'deleted';
  readonly path: WorkspacePath;
  readonly observedAt: number;
}

type QueueJob =
  | { readonly kind: 'initial' }
  | { readonly kind: 'live'; readonly events: readonly RawWatchEvent[] }
  | { readonly kind: 'rescan' };

interface ReconcileResult {
  readonly changes: readonly NormalizedChange[];
  readonly clock: ChangeBatch['clock'];
}

interface Signal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

type StatResult = Awaited<ReturnType<WatchProbe['stat']>>;

const defaultAdmit: Admit = () => true;
const noop = (): void => {};

function createSignal(): Signal {
  let resolve: () => void = noop;
  let reject: (error: unknown) => void = noop;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mapPath(root: string, rawPath: string): WorkspacePath | undefined {
  try {
    const mapped = toWorkspacePath(root, rawPath);
    return mapped === WORKSPACE_ROOT ? undefined : mapped;
  } catch {
    return undefined;
  }
}

function mapRawEvents(root: string, events: readonly RawWatchEvent[]): MappedEvent[] {
  const mapped: MappedEvent[] = [];
  const push = (kind: MappedEvent['kind'], rawPath: string, observedAt: number): void => {
    const path = mapPath(root, rawPath);
    if (path !== undefined) mapped.push({ kind, path, observedAt });
  };
  for (const event of events) {
    if (event.kind === 'moved') {
      if (event.fromPath !== undefined) push('deleted', event.fromPath, event.observedAt);
      push('created', event.path, event.observedAt);
    } else {
      push(event.kind, event.path, event.observedAt);
    }
  }
  return mapped;
}

function properAncestors(path: WorkspacePath): WorkspacePath[] {
  const result: WorkspacePath[] = [];
  let slash = path.indexOf('/');
  while (slash !== -1) {
    const prefix = path.slice(0, slash);
    if (isWorkspacePath(prefix)) result.push(prefix);
    slash = path.indexOf('/', slash + 1);
  }
  return result;
}

function applyCoalesce(pending: Map<string, PendingChange>, change: NormalizedChange): void {
  for (const op of coalesce(pending, change)) {
    if (op.op === 'set') pending.set(op.change.path, op.change);
    else pending.delete(op.path);
  }
}

function memo<T>(
  cache: Map<WorkspacePath, Promise<T>>,
  key: WorkspacePath,
  load: (path: WorkspacePath) => Promise<T>,
): Promise<T> {
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = load(key);
    cache.set(key, pending);
  }
  return pending;
}

function rootMissingError(root: string): Error & WatchError {
  return Object.assign(new Error(`watch root is missing or not a directory: ${root}`), {
    code: 'root-missing' as const,
    fatal: true,
    rescanRequired: false,
    path: root,
  });
}

/**
 * Checks `options.root`, subscribes `options.backend` to it, delivers the initial batch as seq 0,
 * and then turns each settled window of raw events, and each rescan, into at most one `ChangeBatch`
 * for `options.sink`.
 *
 * Start (decisions 55, 57):
 * - `probe.stat(WORKSPACE_ROOT)` first: when it is `undefined` or not a directory, rejects with an
 *   Error carrying `{ code: 'root-missing', fatal: true, rescanRequired: false, path: root }`,
 *   without subscribing or calling `onError`. A backend may not lstat, so the session does.
 * - Subscribes with `{ onError }`; a rejected subscribe rejects with the backend's own error.
 * - The initial reconcile is the queue's first job, so no live window runs before it, even one that
 *   settles while subscribe is pending. It is seq 0, `cause: 'initial'`, delivered even when empty.
 *   Resolves once seq 0 is confirmed.
 * - seq 0 fails on exhausted retries (the last rejection), a probe or `admit` that throws (that
 *   error), or a fatal backend error before it is confirmed (that WatchError, without waiting for a
 *   walk or sink call in flight). The session then closes, and rejects once the close resolves.
 *   `onDegraded` is never called for seq 0.
 *
 * Reconcile, for the initial batch and every rescan (decisions 53, 54): `probe.list(WORKSPACE_ROOT)`,
 * `admit` on every entry (a refused directory's descendants are refused too, in whatever order they
 * are listed), one `probe.digest` per admitted file (`undefined`: not listed), no `probe.stat`.
 * Against known state, which starts as a copy of `seed`: created for a new path, changed for a known
 * file with another revision, deleted for a known path not listed (a vanished directory once, its
 * known descendants not separately), nothing for the unchanged. No pairing; flushBatch order. Every
 * change's `observedAt` and `clock.firstEventAt` are `now()` as the walk starts; `clock.settledAt` is
 * `now()` after the listing and every digest. The archive's `'.'` directory change is not ported:
 * `list` returns entries strictly under the root.
 *
 * Per live window, in one SerialQueue job (at most one in flight, INV-21), part a's rules hold:
 * - `clock.settledAt` is `now()` as the job starts; `clock.firstEventAt` is the smallest raw
 *   `observedAt`. Raw paths map through `toWorkspacePath(root, path)`; one that throws, and the root
 *   itself, is dropped (INV-4, INV-23). A raw moved is a deleted source plus a created path.
 * - A deleted is a `'directory'` when its path is a known directory, else a `'file'`. After `admit`,
 *   it is dropped when nothing is known at or under its path (decision 58).
 * - A created or changed is classified by `probe.stat` (`undefined`: dropped), admitted, and a file
 *   digested (`undefined`: dropped), at most once per file per window (INV-26).
 * - Every admitted directory `created` is followed by `probe.list(dir)`, whatever `directoryEvents`
 *   says (decision 56, INV-5). Its admitted entries enter coalesce as created after the window's raw
 *   events, with that directory event's `observedAt`.
 * - When `directoryEvents` is not `'all'`, a file created or changed adds a directory created, with
 *   its `observedAt`, for each unknown ancestor that `admit(path, 'directory')` accepts (decision 56).
 * - Then coalesce, `flushBatch`, `pairFileRenames` and the kind rules (decision 49): a file is
 *   created when unknown, changed when known, dropped when its revision is the known one; a directory
 *   is created when unknown, dropped when known. An empty batch is not delivered and takes no seq.
 *
 * Confirmed delivery advances the seq by one and the known state, in batch order: a created or
 * changed file records its revision, a created directory is known, a deleted file is forgotten, a
 * deleted directory forgets its whole subtree, a moved moves the revision from `fromPath` to `path`.
 * When the retries of a live or rescan batch are exhausted, `onDegraded` gets every path in it
 * (`fromPath` included) and the last rejection; nothing advances and the seq is reused (INV-20,
 * INV-22). A probe or `admit` that throws reaches `onDegraded` too: with every workspace path the
 * window's raw events named, or with `[WORKSPACE_ROOT]` for a rescan.
 *
 * Backend errors (decision 57, INV-25): each goes to `onError` unchanged (a throwing `onError` is
 * contained). A fatal one closes the session and nothing else. Otherwise `rescanRequired` enqueues
 * one reconcile as `cause: 'rescan'`: requests before it starts collapse into it, one during it
 * enqueues another, and an empty one is not delivered and takes no seq.
 *
 * `close()` is idempotent and resolves after the subscription's own close. From the call on, no
 * `sink.onBatch` call starts (a retry wakes and returns), neither `onError` nor `onDegraded` fires,
 * and the open window and queued jobs are dropped (OQ-3). It does not wait for a sink call in flight.
 */
export async function createWatchSession(options: WatchSessionOptions): Promise<WatchSession> {
  const rootStat = await options.probe.stat(WORKSPACE_ROOT);
  if (rootStat === undefined || rootStat.entry !== 'directory') {
    throw rootMissingError(options.root);
  }

  const admit: Admit = options.admit ?? defaultAdmit;
  const timers: TimerApi = options.timers ?? globalThis;
  const readNow = (): number => (options.now ?? Date.now)();
  const files = new Map<WorkspacePath, string>(options.seed?.files);
  const dirs = new Set<WorkspacePath>(options.seed?.directories);
  let nextSeq = 0;
  let closed = false;
  let rescanPending = false;
  let closePromise: Promise<void> | undefined;
  let subscription: WatchSubscription | undefined;

  const subscribeDone = createSignal();
  const subscribed = createSignal();
  void subscribed.promise.catch(noop);
  const initial = createSignal();
  let subscribing = true;
  let startup = true;
  let startupFatal: WatchError | undefined;

  function forgetSubtree(rootPath: WorkspacePath): void {
    const prefix = `${rootPath}/`;
    dirs.delete(rootPath);
    for (const path of dirs) {
      if (path.startsWith(prefix)) dirs.delete(path);
    }
    files.delete(rootPath);
    for (const path of files.keys()) {
      if (path.startsWith(prefix)) files.delete(path);
    }
  }

  function isKnownPath(path: WorkspacePath): boolean {
    if (files.has(path) || dirs.has(path)) return true;
    const prefix = `${path}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    for (const key of dirs) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  function admitListing(entries: readonly ListedEntry[]): ListedEntry[] {
    const refusedDirs: string[] = [];
    const admittedDirs = new Set<WorkspacePath>();
    for (const entry of entries) {
      if (entry.entry !== 'directory') continue;
      if (isExcludedPath(entry.path, 'directory', admit, entry.sizeBytes)) {
        refusedDirs.push(`${entry.path}/`);
      } else {
        admittedDirs.add(entry.path);
      }
    }
    return entries.filter((entry) => {
      if (refusedDirs.some((prefix) => entry.path.startsWith(prefix))) return false;
      return entry.entry === 'directory'
        ? admittedDirs.has(entry.path)
        : !isExcludedPath(entry.path, 'file', admit, entry.sizeBytes);
    });
  }

  function applyKindRules(paired: readonly NormalizedChange[]): readonly NormalizedChange[] {
    const survivors = new Map<string, PendingChange>();
    for (const change of paired) {
      const { kind, fromPath, ...payload } = change;
      if (kind === 'moved') {
        if (fromPath !== undefined) {
          survivors.set(payload.path, { ...payload, kind: 'moved', fromPath });
        }
        continue;
      }
      if (kind === 'deleted') {
        survivors.set(payload.path, { ...payload, kind: 'deleted' });
        continue;
      }
      if (payload.entry === 'directory') {
        if (!dirs.has(payload.path)) {
          survivors.set(payload.path, { ...payload, kind: 'created' });
        }
        continue;
      }
      const known = files.get(payload.path);
      if (known !== undefined) {
        if (known !== payload.revision_id) {
          survivors.set(payload.path, { ...payload, kind: 'changed' });
        }
      } else {
        survivors.set(payload.path, { ...payload, kind: 'created' });
      }
    }
    return flushBatch(survivors);
  }

  function advanceKnownState(changes: readonly NormalizedChange[]): void {
    for (const change of changes) {
      if (change.kind === 'moved') {
        if (change.fromPath !== undefined) {
          const revision = files.get(change.fromPath);
          files.delete(change.fromPath);
          if (revision !== undefined) files.set(change.path, revision);
        }
      } else if (change.kind === 'deleted') {
        if (change.entry === 'directory') forgetSubtree(change.path);
        else files.delete(change.path);
      } else if (change.entry === 'directory') {
        dirs.add(change.path);
      } else if (change.revision_id !== undefined) {
        files.set(change.path, change.revision_id);
      }
    }
  }

  async function reconcile(): Promise<ReconcileResult> {
    const t0 = readNow();
    const admitted = admitListing(await options.probe.list(WORKSPACE_ROOT));

    const listedDirs = new Set<WorkspacePath>();
    const listedFiles = new Map<
      WorkspacePath,
      { readonly revision_id: string; readonly sizeBytes: number }
    >();
    for (const entry of admitted) {
      if (entry.entry === 'directory') {
        listedDirs.add(entry.path);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- digest each admitted file once before diffing
      const revision = await options.probe.digest(entry.path);
      if (revision !== undefined) {
        listedFiles.set(entry.path, { revision_id: revision, sizeBytes: entry.sizeBytes });
      }
    }

    const settledAt = readNow();
    const pending = new Map<string, PendingChange>();
    const vanishedDirs = new Set<WorkspacePath>();
    for (const dirPath of dirs) {
      if (!listedDirs.has(dirPath)) vanishedDirs.add(dirPath);
    }
    const underVanishedDir = (path: WorkspacePath): boolean =>
      properAncestors(path).some((ancestor) => vanishedDirs.has(ancestor));

    for (const path of vanishedDirs) {
      if (!underVanishedDir(path)) {
        pending.set(path, { kind: 'deleted', entry: 'directory', path, observedAt: t0 });
      }
    }
    for (const path of files.keys()) {
      if (!listedFiles.has(path) && !underVanishedDir(path)) {
        pending.set(path, { kind: 'deleted', entry: 'file', path, observedAt: t0 });
      }
    }
    for (const path of listedDirs) {
      if (!dirs.has(path)) {
        pending.set(path, { kind: 'created', entry: 'directory', path, observedAt: t0 });
      }
    }
    for (const [path, { revision_id, sizeBytes }] of listedFiles) {
      const known = files.get(path);
      if (known !== revision_id) {
        pending.set(path, {
          kind: known === undefined ? 'created' : 'changed',
          entry: 'file',
          path,
          observedAt: t0,
          revision_id,
          sizeBytes,
        });
      }
    }

    return { changes: flushBatch(pending), clock: { firstEventAt: t0, settledAt } };
  }

  async function buildChanges(
    mapped: readonly MappedEvent[],
  ): Promise<readonly NormalizedChange[]> {
    const stats = new Map<WorkspacePath, Promise<StatResult>>();
    const digests = new Map<WorkspacePath, Promise<string | undefined>>();
    const pending = new Map<string, PendingChange>();
    const createdDirs = new Map<WorkspacePath, number>();
    const synthesizeAncestors = options.backend.capabilities.directoryEvents !== 'all';

    async function classify(event: MappedEvent): Promise<NormalizedChange | undefined> {
      if (event.kind === 'deleted') {
        const entry: EntryKind = dirs.has(event.path) ? 'directory' : 'file';
        if (isExcludedPath(event.path, entry, admit) || !isKnownPath(event.path)) return undefined;
        return { kind: 'deleted', entry, path: event.path, observedAt: event.observedAt };
      }
      const stat = await memo(stats, event.path, (path) => options.probe.stat(path));
      if (stat === undefined) return undefined;
      if (isExcludedPath(event.path, stat.entry, admit, stat.sizeBytes)) return undefined;
      if (stat.entry === 'directory') {
        return {
          kind: event.kind,
          entry: 'directory',
          path: event.path,
          observedAt: event.observedAt,
        };
      }
      const revision = await memo(digests, event.path, (path) => options.probe.digest(path));
      if (revision === undefined) return undefined;
      return {
        kind: event.kind,
        entry: 'file',
        path: event.path,
        observedAt: event.observedAt,
        revision_id: revision,
        sizeBytes: stat.sizeBytes,
      };
    }

    for (const event of mapped) {
      // oxlint-disable-next-line no-await-in-loop -- events classify in arrival order before coalescing
      const change = await classify(event);
      if (change === undefined) continue;
      applyCoalesce(pending, change);
      if (change.entry === 'directory' && change.kind === 'created') {
        createdDirs.set(change.path, change.observedAt);
      } else if (
        synthesizeAncestors &&
        change.entry === 'file' &&
        (change.kind === 'created' || change.kind === 'changed')
      ) {
        for (const ancestor of properAncestors(change.path)) {
          if (dirs.has(ancestor) || isExcludedPath(ancestor, 'directory', admit)) continue;
          applyCoalesce(pending, {
            kind: 'created',
            entry: 'directory',
            path: ancestor,
            observedAt: change.observedAt,
          });
        }
      }
    }

    for (const [dirPath, observedAt] of createdDirs) {
      // oxlint-disable-next-line no-await-in-loop -- subtree walks coalesce after raw events in directory order
      const listed = await options.probe.list(dirPath);
      for (const entry of admitListing(listed)) {
        if (entry.entry === 'directory') {
          applyCoalesce(pending, {
            kind: 'created',
            entry: 'directory',
            path: entry.path,
            observedAt,
          });
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- digests reuse the window memo in listing order
        const revision = await memo(digests, entry.path, (path) => options.probe.digest(path));
        if (revision === undefined) continue;
        applyCoalesce(pending, {
          kind: 'created',
          entry: 'file',
          path: entry.path,
          observedAt,
          revision_id: revision,
          sizeBytes: entry.sizeBytes,
        });
      }
    }

    const paired = pairFileRenames(flushBatch(pending), (path) => files.get(path));
    return applyKindRules(paired);
  }

  async function deliverBatch(
    cause: BatchCause,
    changes: readonly NormalizedChange[],
    clock: ChangeBatch['clock'],
  ): Promise<boolean> {
    if (closed) return false;
    const batch: ChangeBatch = { seq: nextSeq, cause, changes, clock };
    await withRetry(() => (closed ? Promise.resolve() : options.sink.onBatch(batch)), { timers });
    if (closed) return false;
    nextSeq += 1;
    advanceKnownState(changes);
    return true;
  }

  async function deliverNonInitial(
    cause: 'live' | 'rescan',
    changes: readonly NormalizedChange[],
    clock: ChangeBatch['clock'],
  ): Promise<void> {
    if (changes.length === 0) return;
    try {
      await deliverBatch(cause, changes, clock);
    } catch (error) {
      if (!closed) {
        const affected = new Set<string>();
        for (const change of changes) {
          affected.add(change.path);
          if (change.fromPath !== undefined) affected.add(change.fromPath);
        }
        options.onDegraded?.([...affected], error);
      }
    }
  }

  async function runInitial(): Promise<void> {
    try {
      await subscribed.promise;
    } catch {
      return;
    }
    try {
      const result = await reconcile();
      if (await deliverBatch('initial', result.changes, result.clock)) {
        initial.resolve();
      }
    } catch (error) {
      if (!closed) {
        await close();
        initial.reject(error);
      }
    }
  }

  async function runRescan(): Promise<void> {
    rescanPending = false;
    let result: ReconcileResult;
    try {
      result = await reconcile();
    } catch (error) {
      if (!closed) {
        options.onDegraded?.([WORKSPACE_ROOT], error);
      }
      return;
    }
    await deliverNonInitial('rescan', result.changes, result.clock);
  }

  async function processLive(events: readonly RawWatchEvent[]): Promise<void> {
    const settledAt = readNow();
    let firstEventAt = Number.POSITIVE_INFINITY;
    for (const event of events) {
      if (event.observedAt < firstEventAt) firstEventAt = event.observedAt;
    }

    const mapped = mapRawEvents(options.root, events);

    let changes: readonly NormalizedChange[];
    try {
      changes = await buildChanges(mapped);
    } catch (error) {
      if (!closed) {
        const windowPaths = [...new Set(mapped.map((event) => event.path))];
        options.onDegraded?.(windowPaths, error);
      }
      return;
    }

    await deliverNonInitial('live', changes, { firstEventAt, settledAt });
  }

  async function processJob(job: QueueJob): Promise<void> {
    if (job.kind === 'initial') return runInitial();
    if (job.kind === 'rescan') return runRescan();
    return processLive(job.events);
  }

  const queue = new SerialQueue<QueueJob>(processJob, { onError: noop });

  const batcherOptions: ChangeBatcherOptions = {
    ...(options.trailingMs !== undefined ? { trailingMs: options.trailingMs } : {}),
    ...(options.ceilingMs !== undefined ? { ceilingMs: options.ceilingMs } : {}),
    ...(options.timers !== undefined ? { timers: options.timers } : {}),
  };

  const batcher = new ChangeBatcher<RawWatchEvent>((items) => {
    queue.enqueue({ kind: 'live', events: items });
  }, batcherOptions);

  function close(): Promise<void> {
    if (closePromise === undefined) {
      closed = true;
      batcher.dispose();
      queue.dispose();
      closePromise =
        subscription !== undefined
          ? subscription.close()
          : subscribeDone.promise.then(() => subscription?.close());
    }
    return closePromise;
  }

  function enqueueRescan(): void {
    if (closed || rescanPending) return;
    rescanPending = true;
    queue.enqueue({ kind: 'rescan' });
  }

  function handleError(error: WatchError): void {
    if (closed) return;
    try {
      options.onError?.(error);
    } catch {
      // A throwing onError is contained; never throw into the backend's callback.
    }
    if (error.fatal) {
      const closing = close();
      void closing.catch(noop);
      if (subscribing) {
        startupFatal = error;
      } else if (startup) {
        const failInitial = (): void => initial.reject(error);
        void closing.then(failInitial, failInitial);
      }
      return;
    }
    if (error.rescanRequired) {
      enqueueRescan();
    }
  }

  // Enqueue initial before subscribing so no live window can run ahead of seq 0 (decision 55).
  queue.enqueue({ kind: 'initial' });

  try {
    subscription = await options.backend.subscribe(
      options.root,
      (events) => {
        for (const event of events) {
          batcher.add(event);
        }
      },
      { onError: handleError },
    );
  } catch (error) {
    subscribing = false;
    subscribeDone.resolve();
    closed = true;
    batcher.dispose();
    queue.dispose();
    subscribed.reject(error);
    throw error;
  }

  subscribing = false;
  subscribeDone.resolve();

  if (startupFatal !== undefined) {
    subscribed.reject(startupFatal);
    await close();
    throw startupFatal;
  }

  subscribed.resolve();
  await initial.promise;
  startup = false;

  return {
    close,
    rescan(): void {
      // SEAT: decision 76 (sprint 25): enqueueRescan() under the rescanRequired rules.
      throw new Error('SEAT: WatchSession.rescan() lands in sprint 25 (decision 76)');
    },
  };
}
