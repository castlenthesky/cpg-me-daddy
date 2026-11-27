// CpgEngine.watch (U4.2.1 part a, BMO-60; controller decisions 59-63): index, then a @cpg/watch
// session seeded from the walk, each batch written as one merge-filesystem op, and the C-CLI
// WatchEvent stream. The CLI verb is part b. Sprint 26 (decisions 81, 82): each batch event carries
// one GraphDelta per change, built from the op, and the watch's one graph seq. U6a.3-3 (BMO-43 part
// 3; controller decisions 102 and the reversal of 110): each batch also writes the code tier
// (delete-file, merge-filesystem, replace-file) and carries one `producer: 'code'` delta per code write.

import {
  isWorkspacePath,
  makeNodeId,
  WORKSPACE_ROOT,
  type GraphDelta,
  type GraphEdge,
  type GraphNode,
  type WorkspacePath,
} from '@cpg/model';
import type { EdgeRow, NodeRow, WriteOp, WriteReceipt } from '@cpg/store';
import {
  createWatchSession,
  type EntryKind,
  type NormalizedChange,
  type TimerApi,
  type WatchBackend,
  type WatchError,
  type WatchSession,
  type WatchSink,
} from '@cpg/watch';
import type { CodeTier, ReplaceFileOp } from './code-tier';
import type {
  IndexProgress,
  IndexReport,
  IndexRequest,
  WatchEvent,
  WatchFailure,
  WatchRequest,
} from './port';
import { createAdmission } from './walker/admission';
import { filesystemTier } from './walker/filesystem-tier';
import type { WalkedDirectory, WalkedFile, WalkResult } from './walker/walker';
import { createWatchProbe } from './watch-probe';

/** What `index()` computed: its report, the walk it wrote, and the code tier it left held. */
export interface IndexRun {
  readonly report: IndexReport;
  readonly walk: WalkResult;
  /**
   * The code tier's file-owned node ids per file, as the store holds them after this index
   * (controller decision 102: the watch's HeldCode starts from it). With a session: from the one
   * store read index() already makes (decision 77), every node whose label is file-owned and whose
   * `data.file` is a string, grouped by that file in payload order; then each delete-file this index
   * wrote forgets its file, and each replace-file whose first receipt is `applied` holds its file's
   * NodeElement ids (`ExtractedFile.nodes`, in order). A file with no ids is absent. A dry run, or an
   * index interrupted before it wrote: empty.
   */
  readonly heldCode: ReadonlyMap<WorkspacePath, readonly string[]>;
  /** The `reported` set `failureWarnings` left after this index's code-tier warnings. */
  readonly reportedFailures: ReadonlySet<string>;
}

/** What `runWatch` takes from createEngine. */
export interface WatchDeps {
  /** `index()`'s own code (decision 60): the walk, the one op through every sink, the report. */
  readonly runIndex: (
    req: IndexRequest,
    onProgress: (progress: IndexProgress) => void,
    signal: AbortSignal,
  ) => Promise<IndexRun>;
  /** `index()`'s write: every sink in order, one after another; resolves with the first's receipt. */
  readonly write: (op: WriteOp) => Promise<WriteReceipt>;
  /** The registry's language for a path, as the walk uses it. */
  readonly languageOf: (path: string) => string | undefined;
  readonly backend: WatchBackend;
  /** The one clock: `WatchEvent.at`, the session's `clock.settledAt`, and the write's end (T3). */
  readonly now: () => number;
  /** The session's timers (debounce, retry backoff). Default: the global ones. */
  readonly timers?: TimerApi;
  /** `index()`'s code tier (one ParseService per engine): each batch runs it (decision 102). */
  readonly codeTier: CodeTier;
  /** The store's write seq (decision 98a): every replace-file and delete-file takes the next. */
  readonly nextWriteSeq: () => number;
}

function parentOf(path: WorkspacePath): WorkspacePath {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return WORKSPACE_ROOT;
  const parent = path.slice(0, slash);
  return isWorkspacePath(parent) ? parent : WORKSPACE_ROOT;
}

function isWatchError(value: unknown): value is WatchError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'message' in value &&
    typeof value.message === 'string' &&
    'fatal' in value &&
    typeof value.fatal === 'boolean'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toFailure(error: unknown, root: string): WatchFailure {
  if (isWatchError(error)) {
    return {
      kind: 'workspace',
      path: typeof error.path === 'string' ? error.path : root,
      message: `${error.code}: ${error.message}`,
    };
  }
  return { kind: 'engine-rejected', message: errorMessage(error) };
}

type Stop =
  | { readonly reason: 'signal' }
  | { readonly reason: 'error'; readonly failure: WatchFailure };

/** A WatchEvent before the emitter stamps its `seq` and `at`. */
type WatchEventBody = WatchEvent extends infer E
  ? E extends WatchEvent
    ? Omit<E, 'seq' | 'at'>
    : never
  : never;

const noop = (): void => {};

/**
 * One batch's changes as ONE merge-filesystem op (decision 62), with filesystemTier's row shapes:
 * - a created or changed file: a FILE row `{ path, name, language, content_hash, revision_id }`
 *   (`language` from `languageOf`, else null; both hashes the change's `revision_id`), plus a
 *   HAS_ENTRY link from its parent DIRECTORY (`'.'` for a top-level path);
 * - a created or changed directory: a DIRECTORY row `{ path, name, status: 'ready' }` plus its link;
 * - a deleted path: a removal of `path` (a directory removes its subtree in the store);
 * - a moved: a removal of `fromPath`, plus the row and link at `path` for its entry.
 * Node ids derive from the path, so a move is a remove and an add (C-WATCH OQ-8); `moves` is
 * always `[]`. Order within the op carries no meaning: the store applies removals first. A file
 * change with no `revision_id` throws (C-WATCH INV-26: the session mints one for every file it
 * delivers).
 */
export function toBatchOp(
  changes: readonly NormalizedChange[],
  languageOf: (path: string) => string | undefined,
): WriteOp {
  // REAL
  const walkedFiles: WalkedFile[] = [];
  const walkedDirs: WalkedDirectory[] = [];
  const links: EdgeRow[] = [];
  const removals: WorkspacePath[] = [];

  for (const change of changes) {
    if (change.kind === 'deleted') {
      removals.push(change.path);
      continue;
    }
    if (change.kind === 'moved' && change.fromPath !== undefined) {
      removals.push(change.fromPath);
    }
    const parent = parentOf(change.path);
    const isDirectory = change.entry === 'directory';
    links.push({
      type: 'HAS_ENTRY',
      fromLabel: 'DIRECTORY',
      fromKey: parent,
      toLabel: isDirectory ? 'DIRECTORY' : 'FILE',
      toKey: change.path,
      properties: {},
    });
    if (isDirectory) {
      walkedDirs.push({ path: change.path, parent });
    } else {
      if (change.revision_id === undefined) {
        throw new Error(`file change missing revision_id: ${change.path}`);
      }
      walkedFiles.push({
        path: change.path,
        parent,
        language: languageOf(change.path) ?? null,
        sizeBytes: change.sizeBytes ?? 0,
        revision_id: change.revision_id,
      });
    }
  }

  const tier = filesystemTier({ files: walkedFiles, directories: walkedDirs });
  const directories: NodeRow[] = [];
  const files: NodeRow[] = [];
  for (const node of tier.nodes) {
    const path = node.data?.['path'];
    if (typeof path !== 'string') continue;
    if (node.type === 'DIRECTORY') {
      directories.push({ label: 'DIRECTORY', key: path, properties: { ...node.data } });
    } else if (node.type === 'FILE') {
      files.push({ label: 'FILE', key: path, properties: { ...node.data } });
    }
  }

  return { kind: 'merge-filesystem', directories, files, links, moves: [], removals };
}

function nodeIdFor(label: NodeRow['label'], key: string): string {
  if (!isWorkspacePath(key)) {
    throw new Error(`invalid ${label} key: ${key}`);
  }
  return makeNodeId({ form: label === 'DIRECTORY' ? 'directory' : 'file', path: key });
}

function pruneProperties(properties: NodeRow['properties']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function rowToNode(row: NodeRow): GraphNode {
  const data = pruneProperties(row.properties);
  const name = typeof data['name'] === 'string' ? data['name'] : undefined;
  return {
    id: nodeIdFor(row.label, row.key),
    type: row.label,
    ...(name !== undefined ? { name } : {}),
    data,
  };
}

/**
 * The FILE and DIRECTORY paths the watch's sinks hold (controller decision 81): the engine's own
 * record of what it wrote, never a read of the store (C-EXT may_not). runWatch seeds it with the
 * walk's files and directories (`'.'` included), which `index()` made the store hold exactly
 * (decision 77), then advances it with the initial batch and with every batch it writes.
 */
export class HeldPaths {
  private readonly files: Set<WorkspacePath>;
  private readonly directories: Set<WorkspacePath>;

  constructor(files: Iterable<WorkspacePath>, directories: Iterable<WorkspacePath>) {
    // REAL
    this.files = new Set(files);
    this.directories = new Set(directories);
  }

  /**
   * The node ids the store's merge-filesystem removal of `path` drops: when `path` is a held
   * directory, the DIRECTORY id of every held directory and the FILE id of every held file at or
   * under it; else, when `path` is a held file, its FILE id; else none. In no particular order.
   */
  removedBy(path: WorkspacePath): readonly string[] {
    // REAL
    if (this.directories.has(path)) {
      const prefix = `${path}/`;
      const ids: string[] = [];
      for (const dir of this.directories) {
        if (dir === path || dir.startsWith(prefix)) {
          ids.push(makeNodeId({ form: 'directory', path: dir }));
        }
      }
      for (const file of this.files) {
        if (file === path || file.startsWith(prefix)) {
          ids.push(makeNodeId({ form: 'file', path: file }));
        }
      }
      return ids;
    }
    if (this.files.has(path)) {
      return [makeNodeId({ form: 'file', path })];
    }
    return [];
  }

  /**
   * One written change: a deleted forgets `path` (a held directory with everything under it); a
   * moved forgets `fromPath` the same way, then holds `path`; a created or changed holds `path` as
   * its entry (a file, or a directory).
   */
  advance(change: NormalizedChange): void {
    // REAL
    if (change.kind === 'deleted') {
      this.forget(change.path);
      return;
    }
    if (change.kind === 'moved' && change.fromPath !== undefined) {
      this.forget(change.fromPath);
    }
    if (change.entry === 'directory') {
      this.directories.add(change.path);
    } else {
      this.files.add(change.path);
    }
  }

  private forget(path: WorkspacePath): void {
    if (this.directories.has(path)) {
      const prefix = `${path}/`;
      for (const dir of this.directories) {
        if (dir === path || dir.startsWith(prefix)) this.directories.delete(dir);
      }
      for (const file of this.files) {
        if (file === path || file.startsWith(prefix)) this.files.delete(file);
      }
      return;
    }
    this.files.delete(path);
  }
}

/**
 * One GraphDelta per change, in `changes` order (controller decisions 81, 82), each from
 * `toBatchOp([change], languageOf)`, the op's rows for that change alone, so a delta is exactly what
 * the batch op writes for its path:
 * - `seq`: `firstSeq`, then one more for each later delta;
 * - `file`: the change's `path` (a move's delta belongs to the new path); `producer: 'filesystem'`;
 * - `revision_id`: the change's, or `''` when it has none (a deletion, a directory);
 * - `addedNodes`: the op's DIRECTORY and FILE rows as the store holds them: `{ id: makeNodeId(the
 *   row's form and key), type: the label, name: properties.name, data: the properties without the
 *   null or undefined ones }` (the store prunes them);
 * - `addedEdges`: the op's HAS_ENTRY link as `{ source, target, type: 'HAS_ENTRY' }` (no `data`),
 *   so a new file or folder arrives attached to its parent; none for a `changed` file, whose link
 *   the store already holds (S26-1: applyGraphDelta concatenates edges, stop-list 50, so re-sending
 *   it would add one duplicate per save to every host's payload);
 * - `removedNodeIds`: `held.removedBy` of the op's removal (`path` for a deleted, `fromPath` for a
 *   moved), read before the change advances `held`; none otherwise.
 * `held` is advanced by each change once its delta is built, so a later change in the same batch
 * sees the earlier ones. A file change with no `revision_id` throws, as toBatchOp does.
 */
export function toBatchDeltas(
  changes: readonly NormalizedChange[],
  languageOf: (path: string) => string | undefined,
  held: HeldPaths,
  firstSeq: number,
): readonly GraphDelta[] {
  // REAL
  const deltas: GraphDelta[] = [];
  let seq = firstSeq;
  for (const change of changes) {
    const op = toBatchOp([change], languageOf);
    if (op.kind !== 'merge-filesystem') continue;
    const addedNodes: GraphNode[] = [...op.directories.map(rowToNode), ...op.files.map(rowToNode)];
    const addedEdges: GraphEdge[] =
      change.kind === 'changed'
        ? []
        : op.links.map((link) => ({
            source: nodeIdFor(link.fromLabel, link.fromKey),
            target: nodeIdFor(link.toLabel, link.toKey),
            type: 'HAS_ENTRY',
          }));
    const removal = op.removals[0];
    const removedNodeIds = removal !== undefined ? held.removedBy(removal) : [];
    deltas.push({
      seq,
      file: change.path,
      revision_id: change.revision_id ?? '',
      producer: 'filesystem',
      addedNodes,
      addedEdges,
      removedNodeIds,
    });
    held.advance(change);
    seq += 1;
  }
  return deltas;
}

/** The delete-file arm of WriteOp. */
export type DeleteFileOp = Extract<WriteOp, { readonly kind: 'delete-file' }>;

/**
 * The code tier's file-owned node ids per file, as the watch's sinks hold them (controller decision
 * 102): the engine's own record of the replace-files and delete-files it wrote, never a read of the
 * store (C-EXT may_not). runWatch seeds it with `IndexRun.heldCode`. It holds file-owned ids only
 * (an ExtractedFile's NodeElements), never a SYMBOL (C-MODEL I-15): exactly what a replace-file or
 * a delete-file of that file removes from the store.
 */
export class HeldCode {
  /** Copies `entries`; an entry with no ids is not held. */
  constructor(entries: ReadonlyMap<WorkspacePath, readonly string[]>) {
    // SEAT (U6a.3-3)
    void entries;
    throw new Error('SEAT: HeldCode (U6a.3-3)');
  }

  /** The ids held for `file`, in the order they were held; `[]` when it holds none. */
  idsOf(file: WorkspacePath): readonly string[] {
    // SEAT (U6a.3-3)
    void file;
    throw new Error('SEAT: HeldCode.idsOf (U6a.3-3)');
  }

  /**
   * Every held file that is `path` or lies under it (starts with `path` + `/`), sorted by code-unit
   * order; never a file that only shares the prefix (`pkg2/a.py` is not under `pkg`).
   */
  filesAt(path: WorkspacePath): readonly WorkspacePath[] {
    // SEAT (U6a.3-3)
    void path;
    throw new Error('SEAT: HeldCode.filesAt (U6a.3-3)');
  }

  /** Holds `ids` (copied) for `file`, replacing what it held; an empty `ids` forgets the file. */
  hold(file: WorkspacePath, ids: readonly string[]): void {
    // SEAT (U6a.3-3)
    void [file, ids];
    throw new Error('SEAT: HeldCode.hold (U6a.3-3)');
  }

  /** Forgets `file`; a file it does not hold is a no-op. */
  forget(file: WorkspacePath): void {
    // SEAT (U6a.3-3)
    void file;
    throw new Error('SEAT: HeldCode.forget (U6a.3-3)');
  }
}

/** One batch's code-tier writes (decision 102), as planCodeWrites lists them. */
export interface CodeWritePlan {
  /**
   * The delete-files: for each deleted change (its `path`) and each moved change (its `fromPath`),
   * in `changes` order, every file `held.filesAt` that path, in that order. A file is listed once per
   * batch: the first change that names it takes it. `change` is that change's index in `changes`.
   */
  readonly deletes: readonly { readonly change: number; readonly file: WorkspacePath }[];
  /**
   * The replace-files, in `changes` order: each created, changed or moved change whose `entry` is
   * `'file'`, which carries a `revision_id`, and whose `languageOf(path)` is a language `covers`
   * accepts. `change` is its index in `changes`; `language` is that language.
   */
  readonly replaces: readonly { readonly change: number; readonly language: string }[];
}

/** Lists one batch's code-tier writes (decision 102). Pure: `held` is read, never changed. */
export function planCodeWrites(
  changes: readonly NormalizedChange[],
  held: HeldCode,
  languageOf: (path: string) => string | undefined,
  covers: (language: string | null) => boolean,
): CodeWritePlan {
  // SEAT (U6a.3-3)
  void [changes, held, languageOf, covers];
  throw new Error('SEAT: planCodeWrites (U6a.3-3)');
}

/**
 * The code tier's GraphDelta for one code op the batch wrote (decision 102): `seq`, `file` = the
 * op's file, `producer: 'code'`, and
 * - `revision_id`: a replace-file's `revision_id`; `''` for a delete-file;
 * - `addedNodes` (replace-file only; `[]` for a delete-file): every node row of the op except the
 *   FILE row, in op order, as the store holds a node it creates: `{ id: the row's key, type: the
 *   label, name: properties.name when it is a string, data: the properties without the null or
 *   undefined ones }`. The FILE's code-owned half is not sent (S34-1: its `version` is the store's
 *   read-modify-write);
 * - `addedEdges` (replace-file only): every edge row, in op order, as `{ source, target, type, data }`:
 *   an endpoint is `makeNodeId` of its key for a FILE or DIRECTORY and its key otherwise; `data` is
 *   the properties without the null or undefined ones, left out when that is empty;
 * - `removedNodeIds`: `removed` as given (the ids HeldCode held for the file before the op; never a
 *   SYMBOL, C-MODEL I-15).
 * Undefined when all three lists are empty (C-SINK INV-3: the all-empty delta is unrepresentable).
 * Pure: the op is not changed and the delta shares no array with it.
 */
export function toCodeDelta(
  op: ReplaceFileOp | DeleteFileOp,
  removed: readonly string[],
  seq: number,
): GraphDelta | undefined {
  // SEAT (U6a.3-3)
  void [op, removed, seq];
  throw new Error('SEAT: toCodeDelta (U6a.3-3)');
}

/**
 * CpgEngine.watch. Resolves after `closed`, never rejects, and emits nothing after `closed`.
 *
 * Start (decision 60):
 * 1. `runIndex({ config: req.config, session: req.session, resumeFrom: null }, ...)`. If it throws:
 *    `error { engine-rejected }`, then `closed { reason: 'error' }`. If `signal` has aborted by the
 *    time it returns: `closed { reason: 'signal' }`, and no session is created.
 * 2. `createWatchSession` over `req.config.root` with `deps.backend`, the node probe
 *    (`createWatchProbe`, entering only directories the admission admits), `admit` = the walker's
 *    `createAdmission(req.config).admits`, with a path the probe last saw as a symlink passed as
 *    `'symlink'`, `seed` = the walk's files (path -> revision_id, every walked file) and directories
 *    (every walked directory but `'.'`), `trailingMs`/`ceilingMs` when given, `now`, `timers`.
 * 3. A rejected `createWatchSession`: `error` (a WatchError-shaped rejection, such as root-missing,
 *    is `workspace`; anything else `engine-rejected`), then `closed { reason: 'error' }`.
 *
 * The sink (decisions 62, 63, 80, 102). `heldCode` is a HeldCode of `IndexRun.heldCode`. A batch
 * with changes is written through `deps.write`, each write awaited before the next:
 * 1. First, before any write: `plan = planCodeWrites(changes, heldCode, deps.languageOf,
 *    deps.codeTier.covers)` and the merge-filesystem op `toBatchOp(changes, deps.languageOf)` (so a
 *    file change with no `revision_id` throws before anything is written).
 * 2. One `{ kind: 'delete-file', file, seq: deps.nextWriteSeq() }` per `plan.deletes` entry, in order.
 * 3. The merge-filesystem op.
 * 4. Per `plan.replaces` entry, in order: the file's bytes, read once now (`probe.read(path)`); then
 *    `deps.codeTier.run({ path, parent: its parent directory ('.' for a top-level path), language,
 *    sizeBytes: change.sizeBytes ?? 0, revision_id: change.revision_id }, bytes)`. Nothing re-hashes
 *    (C-WATCH INV-26): the nodes carry the change's `revision_id` even when the bytes changed after
 *    the session's digest, and the batch that change brings rewrites them. When it extracted:
 *    `attachSourceFile(toWriteOp(file, [], deps.nextWriteSeq()))` is written (no MODULE: the warning
 *    `code tier: <path>: no MODULE, so no SOURCE_FILE edge`, as index() gives). A read that rejects
 *    is a failure `{ code: 'read-failed', message: the rejection's message }`; a failure writes
 *    nothing more for that file (its FILE row is written; the code tier it held stays held).
 * Once a stop has begun, the job writes nothing more and emits nothing. The batch is acknowledged
 * only after every write resolved (C-SINK INV-19); a rejected write rejects the batch, which the
 * session retries whole, re-planned from the same `heldCode`. When every write has resolved and no
 * stop has begun, `heldCode` advances: each delete forgets its file, then each replace-file written
 * holds its file's NodeElement ids (`ExtractedFile.nodes`). An empty batch writes nothing. Then,
 * with `at = now()`:
 * - the initial batch emits `ready { root: req.config.root, report, graphSeq: 0 }`, the first event
 *   (seq 0), and carries no deltas (what it wrote is in the snapshot a host reads after ready);
 * - every other batch emits `batch { cause: batch.cause, changes, write: { nodesWritten,
 *   edgesWritten, statementCount }, each summed over every receipt the batch's writes returned,
 *   latencyMs: { t0_t1: null, t1_t2: settledAt - firstEventAt, t2_t3: at - settledAt, total: t1_t2
 *   + t2_t3 }, deltas, graphSeq }`;
 * - then the batch's code-tier failures, as `failureWarnings(failures, reported)` in plan order, each
 *   a `warning` (`reported` starts as a copy of `IndexRun.reportedFailures`, so one group is said
 *   once per watch), then its no-MODULE warnings.
 * A throw from `onEvent` is contained: it never rejects the batch (that would rewrite it).
 *
 * Deltas (decisions 81, 82, 102): one graph seq counter per watch. `ready` carries `graphSeq: 0`. A
 * batch event's `deltas` are built once its writes have resolved and only when the event is
 * emitted, change by change in `changes` order: the change's filesystem delta (`toBatchDeltas` of
 * that change alone, on `held`), then its code deltas: `toCodeDelta(delete-file op, the ids
 * heldCode held for its file before the batch)` for each of its `plan.deletes` in order, then
 * `toCodeDelta(replace-file op, the ids heldCode held for its path before the batch)` when its
 * replace-file was written. Each delta takes the next graph seq; an undefined one takes none. The
 * batch's `graphSeq` is then its last delta's. `held` is a HeldPaths of the walk's files and
 * directories; the initial batch advances it with its changes. A batch whose event is not emitted
 * takes no graph seq.
 *
 * Drift crawl (decisions 78, 79; S25-1, S25-3): `interval = req.config.rescanIntervalMs ?? 0`.
 * `onRescanDone` re-arms a single countdown timer (`deps.timers ?? globalThis`) for `interval` ms
 * whenever `interval > 0` and no stop has begun; when it fires, it calls `session.rescan()`. After
 * `createWatchSession` resolves (and only if no stop has begun), the countdown is armed once and
 * `req.rescan` is subscribed: each command clears any armed timer and calls `session.rescan()`.
 *
 * Warnings and errors (decision 63): `onDegraded(paths, error)` is a `warning` whose message names
 * every path; a non-fatal backend error is a `warning` whose message starts with its code. A
 * warning that arrives before `ready` is held and emitted right after it, so `ready` is seq 0. A
 * fatal backend error is `error { workspace }`, then `closed { reason: 'error' }`, once the session
 * has closed; its rejection of a start in progress is not reported twice.
 *
 * Stop: `signal` aborting clears any armed rescan timer and unsubscribes `req.rescan` before
 * closing the session, then `closed { reason: 'signal' }`. Once a stop has begun
 * (abort, or a fatal error), nothing is armed or fires, only `closed` follows: no `ready`, `batch`
 * or `warning`, and a write still in flight is not awaited (a hung sink must not hang the stop;
 * decision 51).
 */
export async function runWatch(
  deps: WatchDeps,
  req: WatchRequest,
  onEvent: (event: WatchEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  // REAL
  let seq = 0;
  let closed = false;
  let readyEmitted = false;
  const heldWarnings: string[] = [];

  function emit(body: WatchEventBody, at: number = deps.now()): void {
    if (closed) return;
    const event: WatchEvent = { ...body, seq, at };
    seq += 1;
    if (body.kind === 'closed') closed = true;
    try {
      onEvent(event);
    } catch {
      // A throwing consumer is contained: watch() never rejects and never retries a batch for it.
    }
  }

  function flushWarnings(): void {
    for (const message of heldWarnings.splice(0)) {
      emit({ kind: 'warning', message });
    }
  }

  function emitWarning(message: string): void {
    if (!readyEmitted) {
      heldWarnings.push(message);
      return;
    }
    emit({ kind: 'warning', message });
  }

  let stop: Stop | undefined;
  let resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  function requestStop(next: Stop): void {
    if (stop !== undefined) return;
    stop = next;
    resolveStop?.();
  }

  const onAbort = (): void => requestStop({ reason: 'signal' });
  if (signal.aborted) {
    requestStop({ reason: 'signal' });
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  let session: WatchSession | undefined;
  const interval = req.config.rescanIntervalMs ?? 0;
  const timers: TimerApi = deps.timers ?? globalThis;
  /** The armed rescan countdown; a TimerApi handle is `unknown`, so it is boxed. */
  let countdown: { readonly handle: unknown } | undefined;
  let unsubscribe: (() => void) | undefined;

  function disarm(): void {
    if (countdown !== undefined) timers.clearTimeout(countdown.handle);
    countdown = undefined;
  }

  function fire(): void {
    countdown = undefined;
    if (stop === undefined) session?.rescan();
  }

  function arm(): void {
    disarm();
    if (stop !== undefined || interval <= 0) return;
    countdown = { handle: timers.setTimeout(fire, interval) };
  }

  try {
    if (stop === undefined) {
      let indexRun: IndexRun | undefined;
      try {
        indexRun = await deps.runIndex(
          { config: req.config, session: req.session, resumeFrom: null },
          noop,
          signal,
        );
      } catch (error) {
        requestStop({
          reason: 'error',
          failure: { kind: 'engine-rejected', message: errorMessage(error) },
        });
      }

      if (signal.aborted) {
        requestStop({ reason: 'signal' });
      }

      if (stop === undefined && indexRun !== undefined) {
        const admission = createAdmission(req.config);
        const probe = createWatchProbe(req.config.root, {
          enters: (dir) => admission.admits(dir, 'directory'),
        });
        const admit = (path: WorkspacePath, entry: EntryKind, sizeBytes?: number): boolean =>
          admission.admits(
            path,
            probe.isSymlink(path) ? 'symlink' : entry === 'directory' ? 'directory' : 'file',
            sizeBytes,
          );
        const seedFiles = new Map<WorkspacePath, string>();
        for (const file of indexRun.walk.files) {
          seedFiles.set(file.path, file.revision_id);
        }
        const seedDirectories = new Set<WorkspacePath>();
        for (const dir of indexRun.walk.directories) {
          if (dir.path !== WORKSPACE_ROOT) seedDirectories.add(dir.path);
        }
        const held = new HeldPaths(
          indexRun.walk.files.map((file) => file.path),
          indexRun.walk.directories.map((dir) => dir.path),
        );
        let graphSeq = 0;
        const { report } = indexRun;
        const sink: WatchSink = {
          async onBatch(batch) {
            if (stop !== undefined) return;
            let receipt: WriteReceipt | undefined;
            if (batch.changes.length > 0) {
              receipt = await deps.write(toBatchOp(batch.changes, deps.languageOf));
            }
            const at = deps.now();
            if (stop !== undefined) return;
            if (batch.cause === 'initial') {
              for (const change of batch.changes) {
                held.advance(change);
              }
              emit({ kind: 'ready', root: req.config.root, report, graphSeq: 0 }, at);
              readyEmitted = true;
              flushWarnings();
              return;
            }
            if (receipt === undefined) return;
            const deltas = toBatchDeltas(batch.changes, deps.languageOf, held, graphSeq + 1);
            const lastDelta = deltas.at(-1);
            if (lastDelta !== undefined) graphSeq = lastDelta.seq;
            const t1_t2 = batch.clock.settledAt - batch.clock.firstEventAt;
            const t2_t3 = at - batch.clock.settledAt;
            emit(
              {
                kind: 'batch',
                cause: batch.cause,
                changes: batch.changes,
                write: {
                  nodesWritten: receipt.nodesWritten,
                  edgesWritten: receipt.edgesWritten,
                  statementCount: receipt.statementCount,
                },
                latencyMs: { t0_t1: null, t1_t2, t2_t3, total: t1_t2 + t2_t3 },
                deltas,
                graphSeq,
              },
              at,
            );
          },
        };

        try {
          session = await createWatchSession({
            root: req.config.root,
            backend: deps.backend,
            sink,
            probe,
            admit,
            seed: { files: seedFiles, directories: seedDirectories },
            now: deps.now,
            ...(req.config.trailingMs !== undefined ? { trailingMs: req.config.trailingMs } : {}),
            ...(req.config.ceilingMs !== undefined ? { ceilingMs: req.config.ceilingMs } : {}),
            ...(deps.timers !== undefined ? { timers: deps.timers } : {}),
            onRescanDone: arm,
            onError(error) {
              if (stop !== undefined) return;
              if (error.fatal) {
                requestStop({ reason: 'error', failure: toFailure(error, req.config.root) });
                return;
              }
              emitWarning(`${error.code}: ${error.message}`);
            },
            onDegraded(paths, error) {
              if (stop !== undefined) return;
              emitWarning(
                `${paths.length} path(s) not written (${paths.join(', ')}): ${errorMessage(error)}`,
              );
            },
          });
        } catch (error) {
          requestStop({ reason: 'error', failure: toFailure(error, req.config.root) });
        }

        if (session !== undefined && stop === undefined) {
          arm();
          unsubscribe = req.rescan?.subscribe(() => {
            if (stop !== undefined) return;
            disarm();
            session?.rescan();
          });
        }

        if (session !== undefined) {
          await stopped;
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    disarm();
    unsubscribe?.();
    if (session !== undefined) {
      try {
        await session.close();
      } catch {
        // Contain a failing close so `closed` is still emitted and watch() never rejects.
      }
    }
    flushWarnings();
    const finalStop: Stop = stop ?? { reason: 'signal' };
    if (finalStop.reason === 'error') {
      emit({ kind: 'error', error: finalStop.failure });
    }
    emit({ kind: 'closed', reason: finalStop.reason });
  }
}
