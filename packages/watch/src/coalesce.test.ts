import { toWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { coalesce, flushBatch, type CoalesceOp, type PendingChange } from './coalesce';
import type { ChangeKind, NormalizedChange } from './contract';

// Expected values are C-WATCH.merge_table and source_key_rules (docs/outline/05-contracts.yaml),
// written out by hand. AMENDED marks where coalesce.ts departs from them, and says why.

const wp = (path: string) => toWorkspacePath('/w', path === '.' ? '/w' : `/w/${path}`);
const from = (fromPath?: string) => (fromPath === undefined ? {} : { fromPath: wp(fromPath) });

/** An incoming event, observed at 2. */
const event = (kind: ChangeKind, path: string, fromPath?: string): NormalizedChange => ({
  kind,
  entry: 'file',
  path: wp(path),
  observedAt: 2,
  ...from(fromPath),
});

/** A pending entry built by hand, observed at 1. */
function pending(kind: ChangeKind, path: string, fromPath = 'p.ts'): PendingChange {
  const base = { entry: 'file', path: wp(path), observedAt: 1 } as const;
  return kind === 'moved' ? { ...base, kind, fromPath: wp(fromPath) } : { ...base, kind };
}

const mapOf = (...changes: PendingChange[]): ReadonlyMap<string, PendingChange> =>
  new Map(changes.map((c) => [c.path, c]));

/** What WatchSession does with the ops: the map is keyed by path. */
function apply(map: ReadonlyMap<string, PendingChange>, ops: readonly CoalesceOp[]) {
  const next = new Map(map);
  for (const op of ops) {
    if (op.op === 'set') next.set(op.change.path, op.change);
    else next.delete(op.path);
  }
  return next;
}

const fold = (events: readonly NormalizedChange[]) =>
  events.reduce((map, e) => apply(map, coalesce(map, e)), mapOf());

/** path -> 'kind@observedAt' ('moved from <source>@...'), so @2 marks what the event wrote. */
const summary = (map: ReadonlyMap<string, PendingChange>) =>
  Object.fromEntries(
    [...map.values()].map((c) => [
      c.path,
      `${c.fromPath ? `moved from ${c.fromPath}` : c.kind}@${c.observedAt}`,
    ]),
  );
const after = (map: ReadonlyMap<string, PendingChange>, e: NormalizedChange) =>
  summary(apply(map, coalesce(map, e)));
const batch = (events: NormalizedChange[]) =>
  flushBatch(fold(events)).map((c) => `${c.kind} ${c.path}`);

describe('coalesce: merge_table, existing (row) x incoming (column) at d.ts (INV-15)', () => {
  const rows = {
    absent: mapOf(),
    created: mapOf(pending('created', 'd.ts')),
    changed: mapOf(pending('changed', 'd.ts')),
    deleted: mapOf(pending('deleted', 'd.ts')),
    moved_P: mapOf(pending('moved', 'd.ts', 'p.ts')),
  };
  const columns = {
    created: event('created', 'd.ts'),
    changed: event('changed', 'd.ts'),
    deleted: event('deleted', 'd.ts'),
    'moved from f.ts': event('moved', 'd.ts', 'f.ts'),
  };
  it.each<[keyof typeof rows, keyof typeof columns, Record<string, string>]>([
    ['absent', 'created', { 'd.ts': 'created@2' }],
    // INV-19: a changed on a path the window has not seen is an upsert, never dropped.
    ['absent', 'changed', { 'd.ts': 'changed@2' }],
    ['absent', 'deleted', { 'd.ts': 'deleted@2' }],
    ['absent', 'moved from f.ts', { 'd.ts': 'moved from f.ts@2' }],
    ['created', 'created', { 'd.ts': 'created@2' }],
    // The D1 fix: kind-blind last-write-wins dropped file creations.
    ['created', 'changed', { 'd.ts': 'created@2' }],
    // Deletes absorb (CS-10).
    ['created', 'deleted', { 'd.ts': 'deleted@2' }],
    // AMENDED: the move does not survive, so its source f.ts is released.
    ['created', 'moved from f.ts', { 'd.ts': 'created@2', 'f.ts': 'deleted@2' }],
    ['changed', 'created', { 'd.ts': 'changed@2' }],
    ['changed', 'changed', { 'd.ts': 'changed@2' }],
    ['changed', 'deleted', { 'd.ts': 'deleted@2' }],
    ['changed', 'moved from f.ts', { 'd.ts': 'moved from f.ts@2' }],
    ['deleted', 'created', { 'd.ts': 'changed@2' }],
    ['deleted', 'changed', { 'd.ts': 'changed@2' }],
    ['deleted', 'deleted', { 'd.ts': 'deleted@2' }],
    // AMENDED: as created x moved.
    ['deleted', 'moved from f.ts', { 'd.ts': 'changed@2', 'f.ts': 'deleted@2' }],
    ['moved_P', 'created', { 'd.ts': 'moved from p.ts@2' }],
    ['moved_P', 'changed', { 'd.ts': 'moved from p.ts@2' }],
    ['moved_P', 'deleted', { 'd.ts': 'deleted@2', 'p.ts': 'deleted@2' }],
    ['moved_P', 'moved from f.ts', { 'd.ts': 'moved from f.ts@2', 'p.ts': 'deleted@2' }],
  ])('%s x %s', (row, col, leaves) => {
    expect(after(rows[row], columns[col])).toEqual(leaves);
  });
});

describe('coalesce: source_key_rules, an incoming move s.ts -> d.ts', () => {
  it.each<[string, PendingChange[], Record<string, string>]>([
    ['absent: keep', [], { 'd.ts': 'moved from s.ts@2' }],
    // AMENDED from "drop": a created source may be an overwrite of a file the consumer knows. Shrunk
    // from the consumer property: `mv x.ts s.ts` (as deleted + created) then `mv s.ts d.ts` kept s.ts.
    [
      'created: delete, degrade to created',
      [pending('created', 's.ts')],
      { 's.ts': 'deleted@2', 'd.ts': 'created@2' },
    ],
    ['changed: drop, stays moved', [pending('changed', 's.ts')], { 'd.ts': 'moved from s.ts@2' }],
    [
      'deleted: keep, degrade to created',
      [pending('deleted', 's.ts')],
      { 's.ts': 'deleted@1', 'd.ts': 'created@2' },
    ],
    // AMENDED where the spec is silent. Shrunk from the consumer property: `mv o.ts s.ts; mv s.ts
    // d.ts` with s.ts known left the overwritten s.ts in the consumer.
    [
      'moved from o.ts: compose, delete',
      [pending('moved', 's.ts', 'o.ts')],
      { 's.ts': 'deleted@2', 'd.ts': 'moved from o.ts@2' },
    ],
  ])('source %s', (_rule, before, leaves) => {
    expect(after(mapOf(...before), event('moved', 'd.ts', 's.ts'))).toEqual(leaves);
  });

  it.each([
    ['no fromPath', undefined],
    ['its own path as fromPath', 'd.ts'],
  ])('a move with %s degrades to created', (_case, fromPath) => {
    expect(after(mapOf(), event('moved', 'd.ts', fromPath))).toEqual({ 'd.ts': 'created@2' });
  });

  it('a move away and back inside one window leaves a created at the original path', () => {
    const map = fold([event('moved', 's.ts', 'd.ts'), event('moved', 'd.ts', 's.ts')]);
    expect(summary(map)).toEqual({ 'd.ts': 'created@2', 's.ts': 'deleted@2' });
  });

  it('a duplicated move event changes nothing (backends may deliver twice)', () => {
    const map = mapOf(pending('moved', 'd.ts', 'p.ts'));
    expect(after(map, event('moved', 'd.ts', 'p.ts'))).toEqual({ 'd.ts': 'moved from p.ts@2' });
  });

  it('a released source that a later event re-created stays created, not deleted', () => {
    const map = mapOf(pending('moved', 'd.ts', 'p.ts'), pending('created', 'p.ts'));
    expect(after(map, event('deleted', 'd.ts'))).toEqual({
      'd.ts': 'deleted@2',
      'p.ts': 'created@1',
    });
  });
});

describe('coalesce: what a merge carries', () => {
  it("the merged change carries the incoming event's payload (its bytes are the latest)", () => {
    const map = mapOf({ ...pending('created', 'd.ts'), revision_id: 'r1', sizeBytes: 1 });
    const incoming = { ...event('changed', 'd.ts'), revision_id: 'r2', sizeBytes: 2 };
    const merged = apply(map, coalesce(map, incoming)).get('d.ts');
    expect(merged).toEqual({
      ...pending('created', 'd.ts'),
      observedAt: 2,
      revision_id: 'r2',
      sizeBytes: 2,
    });
  });
});

// Measured with @parcel/watcher 2.6.0 on Linux inotify. The table is not changed for any of these.
describe('coalesce + flushBatch on the event shapes parcel delivers', () => {
  it('a create and changes split across parcel windows flush as one created, never dropped', () => {
    const events = [event('created', 'a.ts'), event('changed', 'a.ts'), event('changed', 'a.ts')];
    expect(batch(events)).toEqual(['created a.ts']);
  });

  it('create+delete split across parcel windows flushes as one deleted (deletes absorb)', () => {
    // Inside one window parcel delivers nothing at all.
    expect(batch([event('created', 'a.ts'), event('deleted', 'a.ts')])).toEqual(['deleted a.ts']);
  });

  it('an atomic save arrives as created on a known path and flushes as created, which a consumer treats as an upsert', () => {
    // absent x created = created: created-of-known is INV-19's sibling.
    expect(batch([event('created', 'known.ts')])).toEqual(['created known.ts']);
  });

  it('a rename arrives as deleted + created and coalesce never synthesizes a move from it', () => {
    const events = [event('created', 'new.ts'), event('deleted', 'old.ts')];
    expect(batch(events)).toEqual(['deleted old.ts', 'created new.ts']);
  });
});

describe('flushBatch (INV-16)', () => {
  it('orders moved < deleted < changed < created, deletes children-first, creates parents-first', () => {
    // Inserted out of order; '.' is the workspace root, above every other path.
    const map = mapOf(
      pending('created', 'src/a.ts'),
      pending('deleted', '.'),
      pending('changed', 'b.ts'),
      pending('created', 'src'),
      pending('moved', 'c.ts', 'z.ts'),
      pending('deleted', 'old'),
    );
    expect(flushBatch(map).map((c) => `${c.kind} ${c.path}`)).toEqual([
      'moved c.ts',
      'deleted old',
      'deleted .',
      'changed b.ts',
      'created src',
      'created src/a.ts',
    ]);
  });
});
