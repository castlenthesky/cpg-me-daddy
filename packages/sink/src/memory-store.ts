// MemoryStore: the always-on, durable, in-memory graph. This file is its GraphSink half; the
// GraphStore half (C-STORE write/fileStates/nodeKeys/staleNodes) lands in U2a.2c.

import type { GraphSink } from './contract';

export interface MemoryStoreOptions {
  /** Default 'memory'. */
  readonly id?: string;
}

export type MemoryStore = GraphSink;

export function createMemoryStore(_options: MemoryStoreOptions = {}): MemoryStore {
  // SEAT: U2a.2b
  throw new Error('SEAT: createMemoryStore is not built yet (U2a.2b)');
}
