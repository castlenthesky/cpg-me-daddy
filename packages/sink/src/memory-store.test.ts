// MemoryStore-specific behaviour beyond the shared GraphSink suite (sink.conformance.test.ts).

import { describe, expect, it } from 'vitest';
import { classifyFailure } from './delta';
import { createMemoryStore } from './memory-store';

describe('createMemoryStore', () => {
  it('is a durable sink that degrades rather than resyncing by snapshot (C-SINK Q1)', () => {
    const store = createMemoryStore();
    expect(store.id).toBe('memory');
    expect(store.capabilities).toMatchObject({ durability: 'durable', resyncBySnapshot: false });
    expect(createMemoryStore({ id: 'm2' }).id).toBe('m2');
  });

  it('reports a COMPLETE nodeIds list', async () => {
    const store = createMemoryStore();
    await store.onSnapshot(
      { seq: 0, nodes: [{ id: 'dir:.', type: 'DIRECTORY', data: { path: '.' } }], edges: [] },
      { seq: 0, cause: 'initial' },
    );
    expect((await store.inspect()).nodeIds).toEqual(['dir:.']);
  });

  it('rejects every delivery after dispose as permanent', async () => {
    const store = createMemoryStore();
    await store.dispose();
    const kind = await store
      .onSnapshot({ seq: 0, nodes: [], edges: [] }, { seq: 0, cause: 'initial' })
      .then(
        () => 'resolved',
        (error: unknown) => classifyFailure(error),
      );
    expect(kind).toBe('permanent');
  });
});
