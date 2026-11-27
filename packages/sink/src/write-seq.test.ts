// MemoryStore.nextWriteSeq, the code tier's write seq (controller decision 98a: SINK is the one seq
// allocator, 03-architecture §4; C-STORE INV-13 is what it serves). Expected values are written from
// the decision: one more than every value returned and every code-tier record's seq, 0 when fresh.

import type { WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import type { NodeRow, WriteOp } from '@cpg/store';
import { storeErrorCode } from '@cpg/store';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from './memory-store';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const REV_A = 'a1'.repeat(32);
const REV_B = 'b1'.repeat(32);

const fileRow = (path: string, rev: string): NodeRow => ({
  label: 'FILE',
  key: path,
  properties: { path, name: path, language: 'python', revision_id: rev },
});
const TREE: WriteOp = {
  kind: 'merge-filesystem',
  directories: [],
  files: [fileRow('a.py', REV_A), fileRow('b.py', REV_B)],
  links: [],
  moves: [],
  removals: [],
};
const del = (file: string, seq: number): WriteOp => ({ kind: 'delete-file', file: wp(file), seq });
const moduleRow = (file: string, rev: string): NodeRow => ({
  label: 'MODULE',
  key: `file:${file}:MODULE:$root`,
  properties: { name: 'm', file, revision_id: rev, range: '1:0-1:0' },
});
const replace = (file: string, seq: number, rev: string): WriteOp => ({
  kind: 'replace-file',
  file: wp(file),
  seq,
  revision_id: rev,
  nodes: [moduleRow(file, rev)],
  edges: [],
});

async function opened() {
  const store = createMemoryStore();
  await store.open();
  await store.write(TREE);
  return store;
}

describe('MemoryStore.nextWriteSeq (decision 98a)', () => {
  it('a fresh store hands out 0, 1, 2, before open() and after close() alike', async () => {
    const store = createMemoryStore();
    const before = store.nextWriteSeq();
    await store.open();
    const during = store.nextWriteSeq();
    await store.close();
    expect([before, during, store.nextWriteSeq()]).toEqual([0, 1, 2]);
  });

  it('every store counts on its own', () => {
    const a = createMemoryStore();
    const b = createMemoryStore();
    expect([a.nextWriteSeq(), a.nextWriteSeq(), a.nextWriteSeq(), b.nextWriteSeq()]).toEqual([
      0, 1, 2, 0,
    ]);
  });

  it('goes above a seq a caller wrote directly (an applied delete-file at 10 gives 11)', async () => {
    const store = await opened();
    expect((await store.write(del('a.py', 10))).applied).toBe(true);
    expect(store.nextWriteSeq()).toBe(11);
    // a lower seq on another file applies, but the next value stays above everything seen
    expect((await store.write(del('b.py', 4))).applied).toBe(true);
    expect(store.nextWriteSeq()).toBe(12);
    // round two (review 2): a direct write after values were handed out still counts
    expect((await store.write(del('b.py', 20))).applied).toBe(true);
    expect(store.nextWriteSeq()).toBe(21);
  });

  it('a revision-unchanged replace-file moves the record, so the next value is above it', async () => {
    const store = await opened();
    expect((await store.write(replace('a.py', 20, REV_A))).applied).toBe(true);
    const unchanged = await store.write(replace('a.py', 25, REV_A));
    expect(unchanged.notApplied).toEqual({ reason: 'revision-unchanged', revision_id: REV_A });
    expect(store.nextWriteSeq()).toBe(26);
  });

  it('a stale-seq write and a refused write move nothing', async () => {
    const store = await opened();
    await store.write(del('a.py', 7));
    const stale = await store.write(del('a.py', 3));
    expect(stale.notApplied).toEqual({ reason: 'stale-seq', current: 7 });
    // refused before any record changes: `'.'` is not a file
    const refused = await store.write(del('.', 40)).then(String, storeErrorCode);
    expect(refused).toBe('WRITE_SHAPE_VIOLATION');
    expect([store.nextWriteSeq(), store.nextWriteSeq()]).toEqual([8, 9]);
  });

  it('allocating writes nothing: the graph, the file states and the audit log are unchanged', async () => {
    const store = await opened();
    await store.write(replace('a.py', 2, REV_A));
    const graph = await store.readAll();
    const states = await store.fileStates();
    const audit = store.auditLog().length;
    store.nextWriteSeq();
    store.nextWriteSeq();
    expect([await store.readAll(), await store.fileStates(), store.auditLog().length]).toEqual([
      graph,
      states,
      audit,
    ]);
    // and the record is still the write's own: a write at the allocated value's predecessor is stale
    expect((await store.write(del('a.py', 2))).notApplied).toEqual({
      reason: 'stale-seq',
      current: 2,
    });
  });
});
