// C-WATCH layer B's batch helpers (U4.1.1). SEAT until U4.1.1 lands. Ported from
// e45574f:packages/engine/src/watch/normalize.ts. Pure, no I/O: INV-3 bars node:fs here and
// packages/watch may not import @cpg/engine, so the walker's matcher and the session's known state
// come in as functions (decision 44). The no-op filter (a revision equal to the known one) is the
// session's, not this file's.

import type { WorkspacePath } from '@cpg/model';
import type { EntryKind, NormalizedChange } from './contract';

/** The walker's admission rule for one path. The engine passes its matcher in (U4.2.1). */
export type Admit = (path: WorkspacePath, entry: EntryKind) => boolean;

/** The revision_id the consumer last confirmed for a file path; undefined when it knows none. */
export type KnownRevision = (path: WorkspacePath) => string | undefined;

/**
 * True when `admit` refuses the path, so the watch and the walk never disagree about what belongs in
 * the graph. The backend's own `ignore` is a coarse pre-filter only (C-WATCH honoursIgnore).
 */
export function isExcludedPath(_path: WorkspacePath, _entry: EntryKind, _admit: Admit): boolean {
  throw new Error('SEAT: isExcludedPath lands in U4.1.1');
}

/**
 * Rename pairing by content hash, run on the flushed batch after coalesce (C-WATCH rename_pairing,
 * ND-11). A file delete whose known revision equals a create's revision_id becomes one moved at the
 * create's path, from the delete's path. Deletes are taken in batch order, and each takes the first
 * create, in batch order, not yet paired: the archive's rule for several candidates with one hash.
 * Returns a new batch in flushBatch order (INV-16, INV-17); `batch` is not modified.
 */
export function pairFileRenames(
  _batch: readonly NormalizedChange[],
  _knownRevision: KnownRevision,
): readonly NormalizedChange[] {
  throw new Error('SEAT: pairFileRenames lands in U4.1.1');
}
