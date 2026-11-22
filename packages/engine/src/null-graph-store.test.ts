// NullGraphStore, from 03-architecture §5 ("counts, persists nothing; backs --dry-run") and the
// C-STORE text: a write that reached no backend is never reported applied, and a store that is not
// open refuses with STORE_NOT_OPEN.

import type { WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import type { EdgeRow, NodeRow, WriteOp } from '@cpg/store';
import { storeErrorCode } from '@cpg/store';
import { describe, expect, it } from 'vitest';
import { createNullGraphStore } from './null-graph-store';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const row = (label: 'DIRECTORY' | 'FILE', path: string): NodeRow => ({
  label,
  key: path,
  properties: { path },
});
const link = (from: string, to: string, toLabel: 'DIRECTORY' | 'FILE' = 'FILE'): EdgeRow => ({
  type: 'HAS_ENTRY',
  fromLabel: 'DIRECTORY',
  fromKey: from,
  toLabel,
  toKey: to,
  properties: {},
});

// 2 directories + 3 files = 5 nodes; 4 links. Every count differs, so a swapped field shows.
const MERGE: WriteOp = {
  kind: 'merge-filesystem',
  directories: [row('DIRECTORY', '.'), row('DIRECTORY', 'src')],
  files: [row('FILE', 'a.py'), row('FILE', 'src/b.ts'), row('FILE', 'src/c.ts')],
  links: [
    link('.', 'a.py'),
    link('src', 'src/b.ts'),
    link('src', 'src/c.ts'),
    link('.', 'src', 'DIRECTORY'),
  ],
  moves: [],
  removals: [wp('old.py')],
};

const receipt = (nodesWritten: number, edgesWritten: number) => ({
  applied: false,
  nodesWritten,
  edgesWritten,
  nodesDeleted: 0,
  statementCount: 0,
  durationMs: 0,
});

async function opened() {
  const store = createNullGraphStore();
  await store.open();
  return store;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => 'resolved',
    (e: unknown) => storeErrorCode(e),
  );
}

describe('NullGraphStore', () => {
  it('refuses writes and reads before open() and after close() (STORE_NOT_OPEN)', async () => {
    const store = createNullGraphStore();
    expect(await codeOf(store.write(MERGE))).toBe('STORE_NOT_OPEN');
    expect(await codeOf(store.fileStates())).toBe('STORE_NOT_OPEN');
    expect(await codeOf(store.nodeKeys('FILE'))).toBe('STORE_NOT_OPEN');
    expect(await codeOf(store.stats())).toBe('STORE_NOT_OPEN');
    expect(await codeOf(store.readFile(wp('a.py')))).toBe('STORE_NOT_OPEN');
    expect(await codeOf(store.staleNodes())).toBe('STORE_NOT_OPEN');
    await store.open();
    expect(await codeOf(store.write(MERGE))).toBe('resolved');
    await store.close();
    expect(await codeOf(store.write(MERGE))).toBe('STORE_NOT_OPEN');
  });

  it('counts a merge-filesystem: directories + files written, links as edges, never applied', async () => {
    const store = await opened();
    expect(await store.write(MERGE)).toEqual({
      applied: false,
      nodesWritten: 5,
      edgesWritten: 4,
      nodesDeleted: 0,
      statementCount: 0,
      durationMs: 0,
    });
  });

  it('counts a replace-file by its rows, and a delete-file and merge-singleton by what they touch', async () => {
    const store = await opened();
    const replace: WriteOp = {
      kind: 'replace-file',
      file: wp('a.py'),
      seq: 3,
      revision_id: 'ab',
      // file-owned code-tier rows (C-STORE: replace-file never carries filesystem rows)
      nodes: ['a.py:MODULE', 'a.py:METHOD:f', 'a.py:METHOD:g'].map((id): NodeRow => ({
        label: id.includes('METHOD') ? 'METHOD' : 'MODULE',
        key: id,
        properties: { id, file: 'a.py' },
      })),
      edges: [
        {
          type: 'DECLARES',
          fromLabel: 'MODULE',
          fromKey: 'a.py:MODULE',
          toLabel: 'METHOD',
          toKey: 'a.py:METHOD:f',
          properties: {},
        },
      ],
    };
    expect(await store.write(replace)).toEqual(receipt(3, 1));
    expect(await store.write({ kind: 'delete-file', file: wp('a.py'), seq: 4 })).toEqual(
      receipt(0, 0),
    );
    expect(await store.write({ kind: 'merge-singleton', metadata: { v: 1 } })).toEqual(
      receipt(1, 0),
    );
  });

  it('persists nothing: every read is empty after writes', async () => {
    const store = await opened();
    await store.write(MERGE);
    expect(await store.fileStates()).toEqual([]);
    expect(await store.nodeKeys('FILE')).toEqual([]);
    expect(await store.nodeKeys('DIRECTORY')).toEqual([]);
    expect(await store.stats()).toEqual({
      nodeCount: 0,
      edgeCount: 0,
      beyondMeasuredScale: false,
    });
    expect(await store.readFile(wp('a.py'))).toEqual({ nodes: [], edges: [] });
    expect(await store.staleNodes()).toEqual([]);
    expect(store.auditLog()).toEqual([]);
  });

  it('declares the memory tier with no dialect and refuses a whole-graph drop', () => {
    expect(createNullGraphStore().capabilities).toMatchObject({
      tier: 'memory',
      dialect: 'none',
      allowDropGraph: false,
    });
  });

  it('overlayWriter is a SEAT', () => {
    const store = createNullGraphStore();
    expect(() => store.overlayWriter('communities')).toThrow(/SEAT: overlayWriter/);
  });
});
