// MemoryStore's GraphStore half (C-STORE). It shares one graph with the GraphSink half through a
// GraphCell, so a FILE written by merge-filesystem and the code tier's delta onto it merge in place.
// REAL: merge-filesystem (directories, files, links, removals) and every read.
// SEAT, each with its first caller: replace-file and delete-file (U6a), merge-filesystem moves (U4),
// merge-singleton (bootstrap, U5), overlayWriter (U10).

import type { GraphPayload } from '@cpg/model';
import type { GraphStore, StoreCapabilities } from '@cpg/store';

export interface GraphCell {
  get(): GraphPayload;
  set(next: GraphPayload): void;
}

export type StoreHalf = Omit<GraphStore, 'capabilities'>;

export const MEMORY_TIER_CAPABILITIES: StoreCapabilities = {
  tier: 'memory',
  dialect: 'none',
  allowDropGraph: false,
  softLimitNodes: 500_000,
  maxRowsPerStatement: 1_000_000,
};

const seat = (): never => {
  throw new Error('SEAT: the MemoryStore GraphStore half is not built yet (U2a.2c)');
};

/** `now` stamps AuditEntry.at. */
export function createStoreHalf(_cell: GraphCell, _now: () => number): StoreHalf {
  // SEAT: U2a.2c
  return {
    open: seat,
    close: seat,
    write: seat,
    overlayWriter: seat,
    fileStates: seat,
    nodeKeys: seat,
    stats: seat,
    readFile: seat,
    staleNodes: seat,
    auditLog: seat,
  };
}
