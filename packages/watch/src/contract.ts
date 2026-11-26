// C-WATCH layer A plus the seam's outbound vocabulary, types only. Layer B's coalesce/flushBatch are
// in coalesce.ts, its debounce, pairing and delivery queue in debounce.ts, normalize.ts and queue.ts,
// its session in session.ts (U4.1.2), whose probe, seed and options are typed here. The session's
// own walks are `cause: 'initial'` and `'rescan'`; the engine's cold-index walk emits `cause:
// 'initial'` batches in U2a.
//
// Types only, enforced by check-deps rule `contract-types-only`: the only import is a statement-level
// `import type` from @cpg/model, and the emitted JS is empty.

import type { WorkspacePath } from '@cpg/model';

export type ChangeKind = 'created' | 'changed' | 'deleted' | 'moved';
export type EntryKind = 'file' | 'directory' | 'unknown';

// ── Layer A: the backend seam (parcel, the fake, a host) ──

export interface RawWatchEvent {
  readonly kind: ChangeKind;
  /** ABSOLUTE, under the subscribed root. Layer B converts it with toWorkspacePath. */
  readonly path: string;
  readonly entry: EntryKind;
  /** ABSOLUTE; present for a native move. */
  readonly fromPath?: string;
  /** T1: when the backend observed the event (ms). */
  readonly observedAt: number;
}

export interface WatchCapabilities {
  readonly id: string;
  readonly directoryEvents: 'all' | 'delete-only' | 'none';
  readonly moveEvents: 'native' | 'host-only' | 'none';
  readonly reportsErrors: boolean;
  readonly reportsOverflow: boolean;
  readonly honoursIgnore: 'advisory' | 'none';
  readonly pathCase: 'sensitive' | 'insensitive';
}

export type WatchErrorCode =
  | 'root-missing'
  | 'permission'
  | 'overflow'
  | 'watch-limit'
  | 'backend-crashed'
  | 'unsupported';

export interface WatchError {
  readonly code: WatchErrorCode;
  readonly message: string;
  readonly fatal: boolean;
  readonly rescanRequired: boolean;
  readonly path?: string;
  readonly cause?: unknown;
}

/** Named (C-WATCH writes it inline) so U4's fake and parcel backends share one type. */
export interface WatchSubscribeOptions {
  readonly ignore?: readonly string[];
  readonly onError?: (error: WatchError) => void;
}

export interface WatchBackend {
  readonly capabilities: WatchCapabilities;
  /** `root` is absolute, plain string (DQ-02). */
  subscribe(
    root: string,
    onEvents: (events: readonly RawWatchEvent[]) => void,
    options?: WatchSubscribeOptions,
  ): Promise<WatchSubscription>;
}

export interface WatchSubscription {
  readonly capabilities: WatchCapabilities;
  close(): Promise<void>;
}

// ── What leaves the seam (layer B emits it in U4; the engine's cold walk emits cause:'initial' in U2a) ──

export interface NormalizedChange {
  readonly kind: ChangeKind;
  readonly entry: EntryKind;
  readonly path: WorkspacePath;
  readonly fromPath?: WorkspacePath;
  readonly observedAt: number;
  /** sha256 of the bytes; present for a file created/changed. WATCH mints it, model carries it (INV-26). */
  readonly revision_id?: string;
  readonly sizeBytes?: number;
}

export type BatchCause = 'initial' | 'live' | 'rescan';

export interface ChangeBatch {
  /** Per session, from 0, no gaps. NOT the delta seq, which SINK allocates (F-1). */
  readonly seq: number;
  readonly cause: BatchCause;
  readonly changes: readonly NormalizedChange[];
  readonly clock: { readonly firstEventAt: number; readonly settledAt: number };
}

/** Awaited; a rejection means the batch was NOT delivered. */
export interface WatchSink {
  onBatch(batch: ChangeBatch): Promise<void>;
}

/**
 * The timers layer B schedules with (C-WATCH WatchSessionOptions.timers). The global
 * setTimeout/clearTimeout satisfy it; a test passes a fake clock, so no test sleeps.
 */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// ── Layer B's session (U4.1.2) ──

/**
 * Layer B's one window onto the disk: the injected probe C-WATCH INV-3 names (decision 47). A separate
 * name, because C-EXT's FilesystemProbe is the host's `{ listFiles, digest }`. packages/watch imports
 * no node:fs; the composition root passes an implementation, a test an in-memory one.
 */
export interface WatchProbe {
  /**
   * lstat semantics: a symlink is reported as `'file'` and left to `admit`. `undefined` means the
   * path is gone.
   */
  stat(
    path: WorkspacePath,
  ): Promise<{ readonly entry: 'file' | 'directory'; readonly sizeBytes: number } | undefined>;
  /** sha256 hex of the file's bytes (INV-26). `undefined` means it raced away. */
  digest(path: WorkspacePath): Promise<string | undefined>;
  /**
   * Every entry strictly under `dir`, recursively, in any order, with lstat semantics: no symlink is
   * followed, and a symlink is a `'file'`, left to `admit` (decision 53). `[]` when `dir` is gone.
   * `dir` may be WORKSPACE_ROOT.
   */
  list(dir: WorkspacePath): Promise<readonly ListedEntry[]>;
}

/** One entry of `WatchProbe.list`. */
export interface ListedEntry {
  readonly path: WorkspacePath;
  readonly entry: 'file' | 'directory';
  readonly sizeBytes: number;
}

/** What the consumer already holds when the session starts (decision 55). */
export interface WatchSeed {
  /** path -> revision_id. */
  readonly files: ReadonlyMap<WorkspacePath, string>;
  readonly directories: ReadonlySet<WorkspacePath>;
}

export interface WatchSessionOptions {
  /** ABSOLUTE, plain string (DQ-02): what the backend subscribes to; raw paths are under it. */
  readonly root: string;
  readonly backend: WatchBackend;
  readonly sink: WatchSink;
  readonly probe: WatchProbe;
  /**
   * The walker's admission rule, run on every event with its classified entry (`sizeBytes` from
   * `probe.stat`, absent for a deleted) and on every listed entry. A refused path never reaches
   * coalesce, and a refused directory's listed descendants are refused with it. Default: admit
   * everything; the engine passes the walker's admission (U4.2.1).
   */
  readonly admit?: (path: WorkspacePath, entry: EntryKind, sizeBytes?: number) => boolean;
  /**
   * Known state at the start (decision 55); empty without one. The initial batch is the disk's diff
   * against it.
   */
  readonly seed?: WatchSeed;
  /** Default 100 (C-WATCH budget_boundary.T1_T2). */
  readonly trailingMs?: number;
  /** Default 500 (C-WATCH budget_boundary.T1_T2). */
  readonly ceilingMs?: number;
  /** Default: the global setTimeout/clearTimeout, looked up at each call. */
  readonly timers?: TimerApi;
  /** The clock for `clock.settledAt` (T2). Default `Date.now`, looked up at each call. */
  readonly now?: () => number;
  /**
   * INV-22: a batch that was not delivered, with every path in it (a moved's `fromPath` included).
   * `error` is `unknown`, not WatchError: a sink's rejection fits no WatchErrorCode, and it is passed
   * through unchanged (decision 50).
   */
  readonly onDegraded?: (paths: readonly string[], error: unknown) => void;
  /** INV-25: every error the backend reports, unchanged, until close (decision 57). */
  readonly onError?: (error: WatchError) => void;
}

export interface WatchSession {
  /** Idempotent; resolves after the backend subscription closes. Silence after close (C-WATCH). */
  close(): Promise<void>;
}
