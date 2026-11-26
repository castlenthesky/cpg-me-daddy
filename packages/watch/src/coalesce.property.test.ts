import { toWorkspacePath } from '@cpg/model';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { coalesce, flushBatch, type PendingChange } from './coalesce';
import type { ChangeKind, NormalizedChange } from './contract';

const wp = (path: string) => toWorkspacePath('/w', path === '.' ? '/w' : `/w/${path}`);
const ev = (kind: ChangeKind, path: string, fromPath?: string): NormalizedChange => ({
  kind,
  entry: 'file',
  path: wp(path),
  observedAt: 0,
  ...(fromPath === undefined ? {} : { fromPath: wp(fromPath) }),
});
const KINDS: readonly ChangeKind[] = ['created', 'changed', 'deleted', 'moved'];

// Nested names and the root, so ancestor pairs are common. '-' sorts before '.', so plain path
// order would put it ahead of the root it lives under.
const TREE = ['.', '-', 'a', 'a/b', 'a/b/c', 'a/c', 'b', 'b/a', 'ab'];
const pendingChange = fc
  .tuple(fc.constantFrom(...KINDS), fc.constantFrom(...TREE), fc.constantFrom(...TREE))
  .filter(([kind, path, from]) => kind !== 'moved' || path !== from)
  .map(([kind, path, from]): PendingChange => {
    const base = { entry: 'file', path: wp(path), observedAt: 0 } as const;
    return kind === 'moved' ? { ...base, kind, fromPath: wp(from) } : { ...base, kind };
  });
const windowEntries = fc.uniqueArray(pendingChange, { selector: (c) => c.path });
const mapOf = (changes: readonly PendingChange[]) => new Map(changes.map((c) => [c.path, c]));

// From the spec, not the implementation.
const RANK = { moved: 0, deleted: 1, changed: 2, created: 3 } as const;
const isAncestor = (a: string, b: string) => (a === '.' ? b !== '.' : b.startsWith(`${a}/`));
const byPath = (x: NormalizedChange, y: NormalizedChange) => (x.path < y.path ? -1 : 1);
const wrongOrder = (x: NormalizedChange, y: NormalizedChange) =>
  RANK[x.kind] > RANK[y.kind] ||
  (x.kind === 'deleted' && y.kind === 'deleted' && isAncestor(x.path, y.path)) ||
  (x.kind === 'created' && y.kind === 'created' && isAncestor(y.path, x.path));
/** Every pair (earlier, later) in the batch that breaks INV-16. */
const misordered = (batch: readonly NormalizedChange[]) =>
  batch.flatMap((x, i) =>
    batch
      .slice(i + 1)
      .filter((y) => wrongOrder(x, y))
      .map((y) => `${x.kind} ${x.path} before ${y.kind} ${y.path}`),
  );

describe('flushBatch and coalesce properties', () => {
  it('INV-16: the batch is the window, in kind order, deletes children-first, creates parents-first', () => {
    fc.assert(
      fc.property(windowEntries, (changes) => {
        const batch = flushBatch(mapOf(changes));
        expect(batch.toSorted(byPath)).toEqual(changes.toSorted(byPath));
        expect(misordered(batch)).toEqual([]);
      }),
    );
  });

  it('INV-17: the batch is identical under any insertion order of the window', () => {
    const permuted = windowEntries.chain((changes) =>
      fc.tuple(
        fc.constant(changes),
        fc.shuffledSubarray(changes, { minLength: changes.length, maxLength: changes.length }),
      ),
    );
    fc.assert(
      fc.property(permuted, ([changes, shuffled]) => {
        expect(flushBatch(mapOf(shuffled))).toEqual(flushBatch(mapOf(changes)));
      }),
    );
  });

  it('INV-14: coalesce is pure: it never mutates the pending map and repeats its answer', () => {
    const tree = fc.constantFrom(...TREE);
    const incoming = fc
      .tuple(fc.constantFrom(...KINDS), tree, fc.option(tree, { nil: undefined }))
      .map(([kind, path, from]) => ev(kind, path, from));
    fc.assert(
      fc.property(windowEntries, incoming, (changes, change) => {
        const map = mapOf(changes);
        const before = structuredClone([...map]);
        const ops = coalesce(map, change);
        expect([...map]).toEqual(before);
        expect(coalesce(map, change)).toEqual(ops);
      }),
    );
  });
});

// The end-to-end oracle. A few top-level files emit events the way C-WATCH allows a backend to: a
// write is created or changed, a rename is a native moved or deleted + created, and any event may
// arrive twice. A consumer that knew the disk applies the batch in order: moved drops its source and
// upserts its path, deleted drops, created and changed upsert (INV-19).
const FILES = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
type FsOp =
  | { readonly op: 'write'; readonly path: string }
  | { readonly op: 'delete'; readonly path: string }
  | { readonly op: 'rename'; readonly path: string; readonly to: string; readonly native: boolean }
  | { readonly op: 'redeliver' };
const file = fc.constantFrom(...FILES);
const fsOp: fc.Arbitrary<FsOp> = fc.oneof(
  fc.record({ op: fc.constantFrom('write', 'delete'), path: file }),
  fc.record({ op: fc.constant('rename'), path: file, to: file, native: fc.boolean() }),
  fc.constant({ op: 'redeliver' }),
);

/** Runs the ops on `disk` (mutated) and returns the events a backend may report for them. */
function run(disk: Set<string>, ops: readonly FsOp[]): NormalizedChange[] {
  const events: NormalizedChange[] = [];
  const vacated = new Set<string>(); // sources of native moves: see the KNOWN GAP test
  for (const step of ops) {
    if (step.op === 'redeliver') {
      events.push(...events.slice(-1));
    } else if (step.op === 'write') {
      events.push(ev(disk.has(step.path) ? 'changed' : 'created', step.path));
      disk.add(step.path);
    } else if (step.op === 'delete') {
      if (disk.delete(step.path)) events.push(ev('deleted', step.path));
    } else if (disk.has(step.path) && step.path !== step.to) {
      const native = step.native && !vacated.has(step.to);
      if (native) vacated.add(step.path);
      events.push(
        ...(native
          ? [ev('moved', step.to, step.path)]
          : [ev('deleted', step.path), ev('created', step.to)]),
      );
      disk.delete(step.path);
      disk.add(step.to);
    }
  }
  return events;
}

function consume(known: Set<string>, events: readonly NormalizedChange[]): string[] {
  const map = new Map<string, PendingChange>();
  for (const e of events) {
    for (const op of coalesce(map, e)) {
      if (op.op === 'set') map.set(op.change.path, op.change);
      else map.delete(op.path);
    }
  }
  for (const change of flushBatch(map)) {
    if (change.fromPath !== undefined) known.delete(change.fromPath);
    if (change.kind === 'deleted') known.delete(change.path);
    else known.add(change.path);
  }
  return [...known].toSorted();
}

describe('coalesce + flushBatch against a consumer', () => {
  it('a consumer that knew the disk and applies the batch in order knows the disk again', () => {
    fc.assert(
      fc.property(
        fc.subarray(FILES),
        fc.array(fsOp, { minLength: 4, maxLength: 16 }),
        (initial, ops) => {
          const disk = new Set(initial);
          const events = run(disk, ops);
          expect(consume(new Set(initial), events)).toEqual([...disk].toSorted());
        },
      ),
      { numRuns: 2000 },
    );
  });

  // KNOWN GAP, outside the spec: C-WATCH orders moved first but not moves among themselves, so a
  // path vacated by one move and refilled by another in the same window can be applied in the wrong
  // order. `mv a.ts c.ts; mv b.ts a.ts` flushes [a.ts<-b.ts, c.ts<-a.ts]: the second move carries the
  // refilled a.ts away. Deferred by ND-11 until a backend reports native moves (BMO-131); drop `.fails`
  // when moves are ordered.
  it.fails('KNOWN GAP: a path vacated by a move and refilled by another move', () => {
    const events = [ev('moved', 'c.ts', 'a.ts'), ev('moved', 'a.ts', 'b.ts')];
    expect(consume(new Set(['a.ts', 'b.ts']), events)).toEqual(['a.ts', 'c.ts']);
  });

  // ND-11 (C-WATCH rename_pairing): renames are paired after coalesce, so with parcel (moveEvents
  // 'none') the same chain reaches coalesce as deletes and creates, and the consumer ends up right.
  it('the same chain as deletes and creates, the shape a moveEvents none backend sends, loses no path', () => {
    const events = [
      ev('deleted', 'a.ts'),
      ev('created', 'c.ts'),
      ev('deleted', 'b.ts'),
      ev('created', 'a.ts'),
    ];
    expect(consume(new Set(['a.ts', 'b.ts']), events)).toEqual(['a.ts', 'c.ts']);
  });
});
