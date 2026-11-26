// C-WATCH layer B's pure core (U4.1.2). REAL. WatchSession (not yet written) owns the pending map,
// applies the ops and flushes it. MERGE and SOURCE are written from 05-contracts.yaml C-WATCH
// .merge_table (the archived reference coalesce is in no commit); each departure says AMENDED, and
// the consumer property in coalesce.property.test.ts is the evidence for it. RANK is ported from
// master's typeRank (d957b69:src/services/FileSystemWatcher.ts:126).

import { WORKSPACE_ROOT, type WorkspacePath } from '@cpg/model';
import type { ChangeKind, EntryKind, NormalizedChange } from './contract';

/** What a merge takes from the incoming event: everything but its kind and its source. */
type Payload = Omit<NormalizedChange, 'kind' | 'fromPath'>;

/** One path's net change in the window, keyed by `path`. Only a moved has a source. */
export type PendingChange =
  | (Payload & { readonly kind: Exclude<ChangeKind, 'moved'>; readonly fromPath?: never })
  | (Payload & { readonly kind: 'moved'; readonly fromPath: WorkspacePath });

/** An edit to the pending map. One coalesce result touches each path at most once. */
export type CoalesceOp =
  | { readonly op: 'set'; readonly change: PendingChange }
  | { readonly op: 'drop'; readonly path: WorkspacePath };

type Slot = 'absent' | ChangeKind;

/**
 * merge_table: existing (row) x incoming (column) -> the kind left at the destination. A moved result
 * keeps the incoming move's source if there is one, else the existing one (the spec's moved{from:P}).
 */
const MERGE: Readonly<Record<Slot, Readonly<Record<ChangeKind, ChangeKind>>>> = {
  absent: { created: 'created', changed: 'changed', deleted: 'deleted', moved: 'moved' },
  created: { created: 'created', changed: 'created', deleted: 'deleted', moved: 'created' },
  changed: { created: 'changed', changed: 'changed', deleted: 'deleted', moved: 'moved' },
  deleted: { created: 'changed', changed: 'changed', deleted: 'deleted', moved: 'changed' },
  moved: { created: 'moved', changed: 'moved', deleted: 'deleted', moved: 'moved' },
};

type SourceRule = { readonly source: 'keep' | 'drop' | 'delete'; readonly as: 'created' | 'moved' };

/**
 * source_key_rules: what an incoming move does to the entry at its source, and what it arrives as. A
 * move out of a moved source composes (takes that move's source). AMENDED: a created or moved source
 * is deleted, where the spec drops it or is silent. Either may sit on a file the consumer knows (an
 * atomic save, a move onto it): dropping it is the CS-10 defect created x deleted -> deleted fixed.
 */
const SOURCE: Readonly<Record<Slot, SourceRule>> = {
  absent: { source: 'keep', as: 'moved' },
  created: { source: 'delete', as: 'created' },
  changed: { source: 'drop', as: 'moved' },
  deleted: { source: 'keep', as: 'created' },
  moved: { source: 'delete', as: 'moved' },
};

const sourceOf = (change: PendingChange | undefined): WorkspacePath | undefined =>
  change?.kind === 'moved' ? change.fromPath : undefined;

const deletion = (path: WorkspacePath, entry: EntryKind, observedAt: number): CoalesceOp => ({
  op: 'set',
  change: { kind: 'deleted', entry, path, observedAt },
});

/** A move with no source, or its own path as source, is a created (source_key_rules). */
function toPending(kind: ChangeKind, payload: Payload, from?: WorkspacePath): PendingChange {
  if (kind !== 'moved') return { ...payload, kind };
  if (from === undefined || from === payload.path) return { ...payload, kind: 'created' };
  return { ...payload, kind, fromPath: from };
}

/** Pure (INV-14): reads `pending`, returns the edits that fold `incoming` into it. */
export function coalesce(
  pending: ReadonlyMap<string, PendingChange>,
  incoming: NormalizedChange,
): readonly CoalesceOp[] {
  const ops = new Map<WorkspacePath, CoalesceOp>();
  const current = (path: WorkspacePath): PendingChange | undefined => {
    const op = ops.get(path);
    if (op === undefined) return pending.get(path);
    return op.op === 'set' ? op.change : undefined;
  };
  const { kind, fromPath, ...payload } = incoming;

  let arriving = toPending(kind, payload, fromPath);
  if (arriving.kind === 'moved') {
    const source = pending.get(arriving.fromPath);
    const rule = SOURCE[source?.kind ?? 'absent'];
    const from = arriving.fromPath;
    if (rule.source === 'drop') ops.set(from, { op: 'drop', path: from });
    if (rule.source === 'delete') ops.set(from, deletion(from, payload.entry, payload.observedAt));
    arriving = toPending(rule.as, payload, sourceOf(source) ?? from);
  }

  const existing = pending.get(payload.path);
  const merged = toPending(
    MERGE[existing?.kind ?? 'absent'][arriving.kind],
    payload,
    sourceOf(arriving) ?? sourceOf(existing),
  );
  ops.set(merged.path, { op: 'set', change: merged });

  // A move that did not survive leaves its source empty, so the source is deleted unless something
  // is pending there again: the spec's "+ set P=deleted", AMENDED to cover created/deleted x moved.
  for (const move of [existing, arriving]) {
    if (move?.kind !== 'moved' || move.fromPath === sourceOf(merged)) continue;
    if (current(move.fromPath) !== undefined) continue;
    ops.set(move.fromPath, deletion(move.fromPath, move.entry, payload.observedAt));
  }
  return [...ops.values()];
}

/** master's typeRank. A move relocates its source before a delete of that path can remove it. */
const RANK: Record<ChangeKind, number> = { moved: 0, deleted: 1, changed: 2, created: 3 };
/** Deletes go children-first and creates parents-first; moved and changed have no depth order. */
const DEPTH: Record<ChangeKind, number> = { moved: 0, deleted: -1, changed: 0, created: 1 };

const depth = (path: WorkspacePath) => (path === WORKSPACE_ROOT ? 0 : path.split('/').length);

/** INV-16, and INV-17: the order is total, so insertion order cannot show through. */
export function flushBatch(
  pending: ReadonlyMap<string, PendingChange>,
): readonly NormalizedChange[] {
  return [...pending]
    .toSorted(
      ([keyA, a], [keyB, b]) =>
        RANK[a.kind] - RANK[b.kind] ||
        DEPTH[a.kind] * (depth(a.path) - depth(b.path)) ||
        // Map keys are unique, so two entries never tie here.
        (keyA < keyB ? -1 : 1),
    )
    .map(([, change]) => change);
}
