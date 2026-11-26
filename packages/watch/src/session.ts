// C-WATCH layer B's session, part a (U4.1.2, BMO-51). REAL.
// Ported from e45574f:packages/engine/src/watch/watch-workspace.ts, without its initial walk, its
// matcher and its fs reads: the disk comes in as the injected WatchProbe (INV-3, decision 47) and
// admission as `admit`. Part b (sprint 21) adds the initial walk, the subtree walk on a directory
// create (INV-5) and the backend's errors (INV-25); until then every batch is `cause: 'live'` and
// backend errors are not handled here.

import { WORKSPACE_ROOT, toWorkspacePath, type WorkspacePath } from '@cpg/model';
import { coalesce, flushBatch, type PendingChange } from './coalesce';
import type {
  ChangeBatch,
  EntryKind,
  NormalizedChange,
  RawWatchEvent,
  TimerApi,
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

type StatResult = Awaited<ReturnType<WatchProbe['stat']>>;

const defaultAdmit: Admit = () => true;

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

/**
 * SEAT (U4.1.2 part b, sprint 21): the root check, the initial and rescan reconcile, the subtree walk,
 * the ancestor rule, the unknown-delete rule and the backend's errors (decisions 53-58) are not
 * written yet. Everything below it is part a, REAL.
 */
function seatPartB(_options: WatchSessionOptions): void {
  throw new Error('SEAT: U4.1.2 part b (decisions 53-58) is not implemented');
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

/**
 * Subscribes `options.backend` to `options.root` and turns each settled window of raw events into
 * at most one `ChangeBatch` for `options.sink`. Rejects, with the backend's own error, when
 * subscribe rejects.
 *
 * Per window, in one SerialQueue job (at most one in flight, INV-21):
 * - `clock.settledAt` is `now()` as the job starts; `clock.firstEventAt` is the smallest `observedAt`
 *   among the window's raw events.
 * - Each raw path (and a moved's `fromPath`) maps through `toWorkspacePath(root, path)`; one that
 *   throws, and the root itself, is dropped (INV-4, INV-23). A raw moved is taken as a deleted of
 *   its source plus a created of its path; pairing restores the move (native moves are BMO-131's).
 * - A deleted is a `'directory'` when its path is a known directory, else a `'file'`. A created or
 *   changed is classified by `probe.stat` (`undefined`: dropped), then admitted, then a file is
 *   digested by `probe.digest` (`undefined`: dropped) into `revision_id`, with `sizeBytes` from the
 *   stat; a directory carries neither. Each file is digested at most once per window (INV-26).
 * - `admit(path, entry, sizeBytes?)` runs on every event, deletes included; a refused path never
 *   reaches coalesce. The default admits everything.
 * - The changes fold through `coalesce` into a fresh pending map, then `flushBatch` and
 *   `pairFileRenames` against the known revisions.
 * - Kind rules (decision 49): a file created or changed is `created` on an unknown path, `changed` on
 *   a known one, and dropped when its revision equals the known one. A directory created or changed
 *   is `created` when unknown and dropped when known. The result is in flushBatch order (INV-16).
 * - An empty batch is not delivered and takes no seq. Otherwise the batch (`cause: 'live'`, the next
 *   seq, from 0) goes to `sink.onBatch` through `withRetry` with its default bounds and the session's
 *   timers.
 *
 * Confirmed delivery advances the seq by one and the known state, in batch order: a created or
 * changed file records its revision, a created directory is known, a deleted file is forgotten, a
 * deleted directory forgets its whole subtree, a moved moves the revision from `fromPath` to `path`.
 * When the retries are exhausted, `onDegraded` gets every path in the batch (`fromPath` included) and
 * the last rejection unchanged; nothing advances and the seq is reused (INV-20, INV-22). A probe or
 * `admit` that throws also reaches `onDegraded`, with every workspace path the window's raw events
 * named.
 *
 * `close()` is idempotent and resolves after the subscription's own close. From the call on, no
 * `sink.onBatch` call starts (a retry wakes and returns), `onDegraded` never fires, and the open
 * window and queued windows are dropped (OQ-3). It does not wait for a sink call in flight.
 */
export async function createWatchSession(options: WatchSessionOptions): Promise<WatchSession> {
  seatPartB(options);
  const admit: Admit = options.admit ?? defaultAdmit;
  const timers: TimerApi = options.timers ?? globalThis;
  const files = new Map<WorkspacePath, string>();
  const dirs = new Set<WorkspacePath>();
  let nextSeq = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;

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

  async function buildChanges(
    mapped: readonly MappedEvent[],
  ): Promise<readonly NormalizedChange[]> {
    const stats = new Map<WorkspacePath, Promise<StatResult>>();
    const digests = new Map<WorkspacePath, Promise<string | undefined>>();

    async function classify(event: MappedEvent): Promise<NormalizedChange | undefined> {
      if (event.kind === 'deleted') {
        const entry: EntryKind = dirs.has(event.path) ? 'directory' : 'file';
        if (isExcludedPath(event.path, entry, admit)) return undefined;
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

    const pending = new Map<string, PendingChange>();
    for (const event of mapped) {
      // oxlint-disable-next-line no-await-in-loop -- events classify in arrival order before coalescing
      const change = await classify(event);
      if (change === undefined) continue;
      for (const op of coalesce(pending, change)) {
        if (op.op === 'set') pending.set(op.change.path, op.change);
        else pending.delete(op.path);
      }
    }

    const paired = pairFileRenames(flushBatch(pending), (path) => files.get(path));
    return applyKindRules(paired);
  }

  async function processBatch(events: readonly RawWatchEvent[]): Promise<void> {
    const settledAt = (options.now ?? Date.now)();
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

    if (changes.length === 0) return;

    const batch: ChangeBatch = {
      seq: nextSeq,
      cause: 'live',
      changes,
      clock: { firstEventAt, settledAt },
    };

    try {
      await withRetry(() => (closed ? Promise.resolve() : options.sink.onBatch(batch)), { timers });
    } catch (error) {
      if (!closed) {
        const affected = new Set<string>();
        for (const change of changes) {
          affected.add(change.path);
          if (change.fromPath !== undefined) affected.add(change.fromPath);
        }
        options.onDegraded?.([...affected], error);
      }
      return;
    }

    if (closed) return;

    nextSeq += 1;
    advanceKnownState(changes);
  }

  const queue = new SerialQueue<readonly RawWatchEvent[]>(processBatch, {
    onError: () => {},
  });

  const batcherOptions: ChangeBatcherOptions = {
    ...(options.trailingMs !== undefined ? { trailingMs: options.trailingMs } : {}),
    ...(options.ceilingMs !== undefined ? { ceilingMs: options.ceilingMs } : {}),
    ...(options.timers !== undefined ? { timers: options.timers } : {}),
  };

  const batcher = new ChangeBatcher<RawWatchEvent>((items) => {
    queue.enqueue(items);
  }, batcherOptions);

  let subscription: WatchSubscription;
  try {
    subscription = await options.backend.subscribe(options.root, (events) => {
      for (const event of events) {
        batcher.add(event);
      }
    });
  } catch (error) {
    batcher.dispose();
    queue.dispose();
    throw error;
  }

  function close(): Promise<void> {
    if (closePromise === undefined) {
      closed = true;
      batcher.dispose();
      queue.dispose();
      closePromise = subscription.close();
    }
    return closePromise;
  }

  return { close };
}
