import { toWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type { EntryKind, NormalizedChange } from './contract';
import { isExcludedPath, pairFileRenames, type Admit } from './normalize';

// Expected values are C-WATCH rename_pairing (ND-11) and decision 44, written out by hand: pairing runs
// on the flushed batch, a file delete whose known revision equals a created's revision_id becomes one
// moved, and several candidates with one hash keep the archive's rule
// (e45574f:packages/engine/src/watch/normalize.ts): each delete, in batch order, takes the first
// create, in batch order, not yet paired. Every input batch below is already in flushBatch order.

const wp = (path: string) => toWorkspacePath('/w', `/w/${path}`);

const del = (path: string, entry: EntryKind = 'file'): NormalizedChange => ({
  kind: 'deleted',
  entry,
  path: wp(path),
  observedAt: 1,
});

const file = (kind: 'created' | 'changed', path: string, revision: string): NormalizedChange => ({
  kind,
  entry: 'file',
  path: wp(path),
  observedAt: 2,
  revision_id: revision,
  sizeBytes: 10,
});

const created = (path: string, revision: string) => file('created', path, revision);

/** The create at `path`, now a move from `fromPath`: everything else is the create's. */
const moved = (path: string, fromPath: string, revision: string): NormalizedChange => ({
  ...created(path, revision),
  kind: 'moved',
  fromPath: wp(fromPath),
});

/** The consumer's known revisions, as the session's lookup. */
function known(revisions: Record<string, string>) {
  const map = new Map(Object.entries(revisions));
  return (path: string) => map.get(path);
}

describe('pairFileRenames', () => {
  it.each(['file', 'unknown'] as const)(
    'a %s delete and a create of its known revision become one moved',
    (entry) => {
      const batch = [del('src/old.ts', entry), created('src/new.ts', 'h1')];
      expect(pairFileRenames(batch, known({ 'src/old.ts': 'h1' }))).toEqual([
        moved('src/new.ts', 'src/old.ts', 'h1'),
      ]);
    },
  );

  it('a delete of a path with no known revision is never paired', () => {
    const batch = [del('src/unknown.ts'), created('src/new.ts', 'h1')];
    expect(pairFileRenames(batch, known({ 'src/other.ts': 'h1' }))).toEqual(batch);
  });

  it('a delete with no create of its revision stays a delete, and that create stays a create', () => {
    const batch = [del('src/old.ts'), created('src/new.ts', 'h2')];
    expect(pairFileRenames(batch, known({ 'src/old.ts': 'h1' }))).toEqual(batch);
    expect(pairFileRenames([del('src/old.ts')], known({ 'src/old.ts': 'h1' }))).toEqual([
      del('src/old.ts'),
    ]);
    expect(pairFileRenames([created('src/new.ts', 'h1')], known({}))).toEqual([
      created('src/new.ts', 'h1'),
    ]);
  });

  it('only a created pairs: a changed with the same revision does not', () => {
    const batch = [del('src/old.ts'), file('changed', 'src/c.ts', 'h1')];
    expect(pairFileRenames(batch, known({ 'src/old.ts': 'h1' }))).toEqual(batch);
  });

  it('a directory delete never pairs', () => {
    const batch = [del('src/dir', 'directory'), created('src/new.ts', 'h1')];
    expect(pairFileRenames(batch, known({ 'src/dir': 'h1' }))).toEqual(batch);
  });

  it('two deletes, one create: the first delete in batch order pairs, and deletes go children-first', () => {
    // flushBatch puts the deeper delete first, so path order (c.ts first) would pick the wrong one.
    const batch = [del('z/y/x.ts'), del('c.ts'), created('new.ts', 'h1')];
    expect(pairFileRenames(batch, known({ 'z/y/x.ts': 'h1', 'c.ts': 'h1' }))).toEqual([
      moved('new.ts', 'z/y/x.ts', 'h1'),
      del('c.ts'),
    ]);
  });

  it('one delete, two creates: the first create in batch order pairs, and creates go parents-first', () => {
    const batch = [del('old.ts'), created('z.ts', 'h1'), created('a/b/c.ts', 'h1')];
    expect(pairFileRenames(batch, known({ 'old.ts': 'h1' }))).toEqual([
      moved('z.ts', 'old.ts', 'h1'),
      created('a/b/c.ts', 'h1'),
    ]);
  });

  it('a create pairs at most once: two deletes and two creates of one revision pair in order', () => {
    const batch = [del('a.ts'), del('b.ts'), created('c.ts', 'h1'), created('d.ts', 'h1')];
    expect(pairFileRenames(batch, known({ 'a.ts': 'h1', 'b.ts': 'h1' }))).toEqual([
      moved('c.ts', 'a.ts', 'h1'),
      moved('d.ts', 'b.ts', 'h1'),
    ]);
  });

  it('returns the batch in flushBatch order: moves by path first, then the rest as they were', () => {
    // a.ts pairs with y.ts and b.ts with x.ts, so pairing order is y then x; m.ts is a native move.
    const batch = [
      moved('m.ts', 'l.ts', 'h9'),
      del('a.ts'),
      del('b.ts'),
      del('gone.ts'),
      file('changed', 'c.ts', 'h3'),
      created('e.ts', 'h4'),
      created('x.ts', 'h2'),
      created('y.ts', 'h1'),
    ];
    const knownRevisions = known({ 'a.ts': 'h1', 'b.ts': 'h2', 'gone.ts': 'h5' });
    expect(pairFileRenames(batch, knownRevisions)).toEqual([
      batch[0],
      moved('x.ts', 'b.ts', 'h2'),
      moved('y.ts', 'a.ts', 'h1'),
      del('gone.ts'),
      file('changed', 'c.ts', 'h3'),
      created('e.ts', 'h4'),
    ]);
  });

  it('leaves its input as it was', () => {
    const batch = Object.freeze(
      [del('old.ts'), created('new.ts', 'h1')].map((c) => Object.freeze(c)),
    );
    expect(pairFileRenames(batch, known({ 'old.ts': 'h1' }))).toEqual([
      moved('new.ts', 'old.ts', 'h1'),
    ]);
    expect(batch).toEqual([del('old.ts'), created('new.ts', 'h1')]);
  });
});

describe('isExcludedPath', () => {
  it.each([
    ['node_modules', 'directory', false, true],
    ['node_modules/pkg/index.ts', 'file', false, true],
    ['src/a.ts', 'file', true, false],
    ['src/gone.ts', 'unknown', true, false],
  ] as const)('%s (%s): admit says %s, so excluded is %s', (path, entry, admitted, excluded) => {
    const asked: [string, EntryKind][] = [];
    const admit: Admit = (p, e) => {
      asked.push([p, e]);
      return admitted;
    };
    expect(isExcludedPath(wp(path), entry, admit)).toBe(excluded);
    expect(asked).toEqual([[path, entry]]);
  });
});
