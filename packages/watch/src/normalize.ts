// C-WATCH layer B's batch helpers (U4.1.1). REAL. Ported from
// e45574f:packages/engine/src/watch/normalize.ts. Pure, no I/O: INV-3 bars node:fs here and
// packages/watch may not import @cpg/engine, so the walker's matcher and the session's known state
// come in as functions (decision 44). The no-op filter (a revision equal to the known one) is the
// session's, not this file's.

import type { WorkspacePath } from '@cpg/model';
import { flushBatch, type PendingChange } from './coalesce';
import type { EntryKind, NormalizedChange } from './contract';

/** The walker's admission rule for one path. The engine passes its matcher in (U4.2.1). */
export type Admit = (path: WorkspacePath, entry: EntryKind) => boolean;

/** The revision_id the consumer last confirmed for a file path; undefined when it knows none. */
export type KnownRevision = (path: WorkspacePath) => string | undefined;

/**
 * True when `admit` refuses the path, so the watch and the walk never disagree about what belongs in
 * the graph. The backend's own `ignore` is a coarse pre-filter only (C-WATCH honoursIgnore).
 */
export function isExcludedPath(path: WorkspacePath, entry: EntryKind, admit: Admit): boolean {
  return !admit(path, entry);
}

function toPendingChange(change: NormalizedChange): PendingChange {
  const { kind, fromPath, ...payload } = change;
  if (kind !== 'moved') return { ...payload, kind };
  if (fromPath === undefined) return { ...payload, kind: 'created' };
  return { ...payload, kind, fromPath };
}

/**
 * Rename pairing by content hash, run on the flushed batch after coalesce (C-WATCH rename_pairing,
 * ND-11). A file delete whose known revision equals a create's revision_id becomes one moved at the
 * create's path, from the delete's path. Deletes are taken in batch order, and each takes the first
 * create, in batch order, not yet paired: the archive's rule for several candidates with one hash.
 * Returns a new batch in flushBatch order (INV-16, INV-17); `batch` is not modified.
 */
export function pairFileRenames(
  batch: readonly NormalizedChange[],
  knownRevision: KnownRevision,
): readonly NormalizedChange[] {
  // Queue candidate create indices by revision_id in batch order.
  const createsByRev = new Map<string, number[]>();
  for (const [index, change] of batch.entries()) {
    if (change.kind !== 'created' || change.revision_id === undefined) continue;
    const queue = createsByRev.get(change.revision_id);
    if (queue === undefined) createsByRev.set(change.revision_id, [index]);
    else queue.push(index);
  }

  const pairedDeletes = new Set<number>();
  const pairedFrom = new Map<number, WorkspacePath>();
  for (const [index, change] of batch.entries()) {
    if (change.kind !== 'deleted' || change.entry === 'directory') continue;
    const rev = knownRevision(change.path);
    if (rev === undefined) continue;
    const createIndex = createsByRev.get(rev)?.shift();
    if (createIndex === undefined) continue;
    pairedDeletes.add(index);
    pairedFrom.set(createIndex, change.path);
  }

  const pending = new Map<string, PendingChange>();
  for (const [index, change] of batch.entries()) {
    if (pairedDeletes.has(index)) continue;
    const fromPath = pairedFrom.get(index);
    if (fromPath !== undefined) {
      const { fromPath: _fromPath, ...payload } = change;
      pending.set(change.path, { ...payload, kind: 'moved', fromPath });
    } else {
      pending.set(change.path, toPendingChange(change));
    }
  }

  return flushBatch(pending);
}
