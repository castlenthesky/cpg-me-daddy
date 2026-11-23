// MemoryStore's GraphStore half (C-STORE). It shares one graph with the GraphSink half through a
// GraphCell, so a FILE written by merge-filesystem and the code tier's delta onto it merge in place.
// REAL: merge-filesystem (directories, files, links, removals) and every read.
// SEAT, each with its first caller: replace-file and delete-file (U6a), merge-filesystem moves (U4),
// merge-singleton (bootstrap, U5), overlayWriter (U10).

import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  GraphPayload,
  NodeLabel,
  WorkspacePath,
} from '@cpg/model';
import { EDGE_TYPES, isWorkspacePath, makeNodeId, NODE_LABELS, WORKSPACE_ROOT } from '@cpg/model';
import type {
  AuditEntry,
  DeleteScope,
  EdgeRow,
  FileState,
  GraphStore,
  NodeRow,
  OverlayWriter,
  Properties,
  StaleNode,
  StoreCapabilities,
  WriteOp,
  WriteReceipt,
} from '@cpg/store';
import { storeError } from '@cpg/store';

export interface GraphCell {
  get(): GraphPayload;
  set(next: GraphPayload): void;
}

/**
 * The GraphStore half, plus `readAll`: the whole-graph read C-CLI Q6 names ("MemoryStore's
 * readFile/readAll"), which CpgEngine.inspect reads (U2b.1 part 3b). It is not part of C-STORE's
 * GraphStore.
 */
export type StoreHalf = Omit<GraphStore, 'capabilities'> & {
  /**
   * A deep copy of the whole graph, `{ seq, nodes, edges }`: mutating it never changes the store.
   * Like every read, it throws STORE_NOT_OPEN before open() or after close().
   */
  readAll(): Promise<GraphPayload>;
};

export const MEMORY_TIER_CAPABILITIES: StoreCapabilities = {
  tier: 'memory',
  dialect: 'none',
  allowDropGraph: false,
  softLimitNodes: 500_000,
  maxRowsPerStatement: 1_000_000,
};

const NODE_LABEL_BY_NAME: ReadonlyMap<string, NodeLabel> = new Map(
  NODE_LABELS.map((spec): [string, NodeLabel] => [spec.label, spec.label]),
);
const FILE_EDGE_TYPE_BY_NAME: ReadonlyMap<string | undefined, EdgeType> = new Map(
  EDGE_TYPES.filter((spec) => spec.type !== 'HAS_ENTRY').map((spec): [string, EdgeType] => [
    spec.type,
    spec.type,
  ]),
);

function pruneProperties(properties: Properties): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function idOf(label: NodeLabel, key: string): string {
  if (label !== 'DIRECTORY' && label !== 'FILE') return key;
  if (!isWorkspacePath(key) || (label === 'FILE' && key === '.')) {
    throw storeError('WRITE_SHAPE_VIOLATION', `invalid ${label} key: ${key}`);
  }
  return makeNodeId({ form: label === 'DIRECTORY' ? 'directory' : 'file', path: key });
}

function nodeKey(node: GraphNode): string {
  if (
    (node.type === 'DIRECTORY' || node.type === 'FILE') &&
    typeof node.data?.['path'] === 'string'
  ) {
    return node.data['path'];
  }
  return node.id;
}

function sortByField<K extends string, T extends Readonly<Record<K, string>>>(
  items: readonly T[],
  field: K,
): T[] {
  return items.toSorted((a, b) => Number(a[field] > b[field]) - Number(a[field] < b[field]));
}

/** `now` stamps AuditEntry.at. */
export function createStoreHalf(cell: GraphCell, now: () => number): StoreHalf {
  // REAL
  let isOpen = false;
  const audit: AuditEntry[] = [];

  function assertOpen(): void {
    if (!isOpen) {
      throw storeError('STORE_NOT_OPEN', 'store is not open; call open() first');
    }
  }

  return {
    async open(): Promise<void> {
      isOpen = true;
    },

    async close(): Promise<void> {
      isOpen = false;
    },

    async write(op: WriteOp): Promise<WriteReceipt> {
      assertOpen();
      const start = now();
      if (op.kind !== 'merge-filesystem') {
        // SEAT: replace-file and delete-file (U6a), merge-singleton (U5)
        const caller = op.kind === 'merge-singleton' ? 'U5' : 'U6a';
        throw storeError(
          'WRITE_SHAPE_VIOLATION',
          `SEAT: ${op.kind} lands with its first caller (${caller})`,
        );
      }
      if (op.moves.length > 0) {
        // SEAT: merge-filesystem moves (U4)
        throw storeError(
          'WRITE_SHAPE_VIOLATION',
          'SEAT: merge-filesystem moves lands with its first caller (U4)',
        );
      }

      const rowGroups: readonly [NodeLabel, readonly NodeRow[]][] = [
        ['DIRECTORY', op.directories],
        ['FILE', op.files],
      ];
      for (const [expectedLabel, rows] of rowGroups) {
        for (const row of rows) {
          if (row.label !== expectedLabel || row.properties['path'] !== row.key) {
            throw storeError(
              'WRITE_SHAPE_VIOLATION',
              `invalid ${expectedLabel} row: label=${row.label} key=${row.key}`,
            );
          }
        }
      }
      // Removing the root is a whole-graph drop: only DeleteScope 'whole-graph' with the confirm
      // token and allowDropGraph may do that (C-STORE INV-7), never a merge-filesystem removal.
      if (op.removals.includes(WORKSPACE_ROOT)) {
        throw storeError('UNSAFE_DELETE_REFUSED', "merge-filesystem may not remove the root '.'");
      }
      for (const edgeRow of op.links) {
        if (edgeRow.type !== 'HAS_ENTRY') {
          throw storeError(
            'WRITE_SHAPE_VIOLATION',
            `merge-filesystem links must be HAS_ENTRY, got ${edgeRow.type}`,
          );
        }
      }

      const current = cell.get();
      let workingNodes = current.nodes;
      const deletedIds = new Set<string>();
      const pendingAudit: AuditEntry[] = [];
      let totalNodesDeleted = 0;

      for (const targetPath of op.removals) {
        let isDir = false;
        for (const node of workingNodes) {
          if (node.type === 'DIRECTORY' && nodeKey(node) === targetPath) {
            isDir = true;
            break;
          }
        }
        const nextNodes: GraphNode[] = [];
        let deletedHere = 0;
        for (const node of workingNodes) {
          const key = nodeKey(node);
          const match = isDir
            ? (node.type === 'DIRECTORY' || node.type === 'FILE') &&
              (key === targetPath || key.startsWith(`${targetPath}/`))
            : node.type === 'FILE' && key === targetPath;
          if (match) {
            deletedIds.add(node.id);
            deletedHere += 1;
          } else {
            nextNodes.push(node);
          }
        }
        workingNodes = nextNodes;
        totalNodesDeleted += deletedHere;
        const scope: DeleteScope = isDir
          ? { kind: 'subtree', directory: targetPath }
          : { kind: 'file', file: targetPath };
        pendingAudit.push({
          at: now(),
          scope,
          nodesDeleted: deletedHere,
          calledBy: 'merge-filesystem',
        });
      }

      const nodeMap = new Map<string, GraphNode>();
      for (const node of workingNodes) {
        nodeMap.set(node.id, node);
      }

      for (const row of [...op.directories, ...op.files]) {
        const id = idOf(row.label, row.key);
        const incomingData = pruneProperties(row.properties);
        const existing = nodeMap.get(id);
        const data =
          existing?.data !== undefined ? { ...existing.data, ...incomingData } : incomingData;
        const name =
          typeof incomingData['name'] === 'string' ? incomingData['name'] : existing?.name;
        nodeMap.set(id, {
          id,
          type: row.label,
          ...(name !== undefined ? { name } : {}),
          data,
        });
      }

      const workingEdges: GraphEdge[] = [];
      const existingEdges = new Set<string>();
      for (const edge of current.edges) {
        if (deletedIds.has(edge.source) || deletedIds.has(edge.target)) continue;
        workingEdges.push(edge);
        existingEdges.add(JSON.stringify([edge.source, edge.type, edge.target]));
      }

      for (const edgeRow of op.links) {
        const source = idOf(edgeRow.fromLabel, edgeRow.fromKey);
        const target = idOf(edgeRow.toLabel, edgeRow.toKey);
        if (!nodeMap.has(source) || !nodeMap.has(target)) {
          throw storeError(
            'WRITE_SHAPE_VIOLATION',
            `dangling link ${source} -[${edgeRow.type}]-> ${target}`,
          );
        }
        const edgeKey = JSON.stringify([source, edgeRow.type, target]);
        if (existingEdges.has(edgeKey)) continue;
        existingEdges.add(edgeKey);
        const data = pruneProperties(edgeRow.properties);
        workingEdges.push({
          source,
          target,
          type: edgeRow.type,
          ...(Object.keys(data).length > 0 ? { data } : {}),
        });
      }

      cell.set({ seq: current.seq, nodes: [...nodeMap.values()], edges: workingEdges });
      audit.push(...pendingAudit);

      return {
        applied: true,
        nodesWritten: op.directories.length + op.files.length,
        edgesWritten: op.links.length,
        nodesDeleted: totalNodesDeleted,
        statementCount: 1,
        durationMs: Math.max(0, now() - start),
      };
    },

    overlayWriter(job: string): OverlayWriter {
      // SEAT: U10
      throw new Error(`SEAT: overlayWriter(${job}) lands with its first caller (U10)`);
    },

    async fileStates(): Promise<readonly FileState[]> {
      assertOpen();
      const { nodes } = cell.get();
      const ownedCounts = new Map<string, number>();
      for (const node of nodes) {
        const file = node.data?.['file'];
        if (node.type !== 'FILE' && typeof file === 'string') {
          ownedCounts.set(file, (ownedCounts.get(file) ?? 0) + 1);
        }
      }
      const states: FileState[] = [];
      for (const node of nodes) {
        if (node.type !== 'FILE') continue;
        const path = node.data?.['path'];
        if (typeof path !== 'string' || !isWorkspacePath(path)) continue;
        const revision = node.data?.['revision_id'];
        states.push({
          file: path,
          seq: -1,
          revision_id: typeof revision === 'string' ? revision : '',
          nodeCount: ownedCounts.get(path) ?? 0,
        });
      }
      return sortByField(states, 'file');
    },

    async nodeKeys(label: NodeLabel): Promise<readonly string[]> {
      assertOpen();
      const keys: string[] = [];
      for (const node of cell.get().nodes) {
        if (node.type === label) keys.push(nodeKey(node));
      }
      return keys;
    },

    async readAll(): Promise<GraphPayload> {
      // SEAT: U2b.1 part 3b
      throw new Error('SEAT: readAll lands with CpgEngine.inspect (U2b.1 part 3b)');
    },

    async stats(): Promise<{ nodeCount: number; edgeCount: number; beyondMeasuredScale: boolean }> {
      assertOpen();
      const { nodes, edges } = cell.get();
      return {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        beyondMeasuredScale: nodes.length > MEMORY_TIER_CAPABILITIES.softLimitNodes,
      };
    },

    async readFile(
      file: WorkspacePath,
    ): Promise<{ nodes: readonly NodeRow[]; edges: readonly EdgeRow[] }> {
      assertOpen();
      const { nodes, edges } = cell.get();
      const rowById = new Map<string, NodeRow>();
      const ownedById = new Map<string, NodeRow>();

      for (const node of nodes) {
        const label = NODE_LABEL_BY_NAME.get(node.type);
        if (label === undefined) continue;
        const row: NodeRow = { label, key: nodeKey(node), properties: { ...node.data } };
        rowById.set(node.id, row);
        if ((node.type === 'FILE' && row.key === file) || node.data?.['file'] === file) {
          ownedById.set(node.id, row);
        }
      }

      const edgeRows: EdgeRow[] = [];
      for (const edge of edges) {
        const from = ownedById.get(edge.source);
        const to = rowById.get(edge.target);
        const type = FILE_EDGE_TYPE_BY_NAME.get(edge.type);
        if (from && to && type) {
          edgeRows.push({
            type,
            fromLabel: from.label,
            fromKey: from.key,
            toLabel: to.label,
            toKey: to.key,
            properties: { ...edge.data },
          });
        }
      }

      return { nodes: [...ownedById.values()], edges: edgeRows };
    },

    async staleNodes(): Promise<readonly StaleNode[]> {
      assertOpen();
      const { nodes } = cell.get();
      const fileRevisions = new Map<string, string>();
      for (const node of nodes) {
        if (node.type !== 'FILE') continue;
        const path = node.data?.['path'];
        const revision = node.data?.['revision_id'];
        if (typeof path === 'string' && typeof revision === 'string') {
          fileRevisions.set(path, revision);
        }
      }

      const stale: StaleNode[] = [];
      for (const node of nodes) {
        const file = node.data?.['file'];
        const nodeRevision = node.data?.['revision_id'];
        if (
          typeof file !== 'string' ||
          !isWorkspacePath(file) ||
          typeof nodeRevision !== 'string'
        ) {
          continue;
        }
        const fileRevision = fileRevisions.get(file);
        if (fileRevision !== undefined && nodeRevision !== fileRevision) {
          stale.push({
            id: node.id,
            file,
            node_revision: nodeRevision,
            file_revision: fileRevision,
          });
        }
      }
      return sortByField(stale, 'id');
    },

    auditLog(): readonly AuditEntry[] {
      return [...audit];
    },
  };
}
