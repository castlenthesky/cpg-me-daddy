// C-WATCH layer A plus the seam's outbound vocabulary. SEAT (types only): layer B (coalesce,
// flushBatch, the session) and the parcel / fake backends land in U4; the engine's cold-index walk
// emits `cause: 'initial'` batches in U2a.
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
