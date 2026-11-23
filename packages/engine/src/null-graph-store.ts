// NullGraphStore: backs --dry-run (03-architecture §5). It counts what each write would touch and
// persists nothing, so every read is empty. It lives in the engine, never in a front door (C-CLI).

import type {
  AuditEntry,
  EdgeRow,
  FileState,
  GraphStore,
  NodeRow,
  OverlayWriter,
  StaleNode,
  StoreCapabilities,
  WriteOp,
  WriteReceipt,
} from '@cpg/store';
import { storeError } from '@cpg/store';

const CAPABILITIES: StoreCapabilities = {
  tier: 'memory',
  dialect: 'none',
  allowDropGraph: false,
  softLimitNodes: 500_000,
  maxRowsPerStatement: 1_000_000,
};

function countOp(op: WriteOp): { nodesWritten: number; edgesWritten: number } {
  if (op.kind === 'merge-filesystem') {
    return {
      nodesWritten: op.directories.length + op.files.length,
      edgesWritten: op.links.length,
    };
  }
  if (op.kind === 'replace-file') {
    return { nodesWritten: op.nodes.length, edgesWritten: op.edges.length };
  }
  if (op.kind === 'merge-singleton') {
    return { nodesWritten: 1, edgesWritten: 0 };
  }
  return { nodesWritten: 0, edgesWritten: 0 };
}

export function createNullGraphStore(): GraphStore {
  // REAL
  let isOpen = false;

  function assertOpen(): void {
    if (!isOpen) {
      throw storeError('STORE_NOT_OPEN', 'store is not open; call open() first');
    }
  }

  return {
    capabilities: CAPABILITIES,

    async open(): Promise<void> {
      isOpen = true;
    },

    async close(): Promise<void> {
      isOpen = false;
    },

    async write(op: WriteOp): Promise<WriteReceipt> {
      assertOpen();
      const { nodesWritten, edgesWritten } = countOp(op);
      return {
        applied: false,
        nodesWritten,
        edgesWritten,
        nodesDeleted: 0,
        statementCount: 0,
        durationMs: 0,
      };
    },

    overlayWriter(job: string): OverlayWriter {
      // SEAT: U10
      throw new Error(`SEAT: overlayWriter(${job}) lands with its first caller (U10)`);
    },

    async fileStates(): Promise<readonly FileState[]> {
      assertOpen();
      return [];
    },

    async nodeKeys(): Promise<readonly string[]> {
      assertOpen();
      return [];
    },

    async stats(): Promise<{ nodeCount: number; edgeCount: number; beyondMeasuredScale: boolean }> {
      assertOpen();
      return { nodeCount: 0, edgeCount: 0, beyondMeasuredScale: false };
    },

    async readFile(): Promise<{ nodes: readonly NodeRow[]; edges: readonly EdgeRow[] }> {
      assertOpen();
      return { nodes: [], edges: [] };
    },

    async staleNodes(): Promise<readonly StaleNode[]> {
      assertOpen();
      return [];
    },

    auditLog(): readonly AuditEntry[] {
      return [];
    },
  };
}
