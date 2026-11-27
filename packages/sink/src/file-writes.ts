// The code tier's two writes on MemoryStore (C-STORE; controller decisions 97 and 98): replace-file
// and delete-file, each one statement over the shared graph. memory-graph-store.ts owns the cell,
// the per-file records and the audit log; this file computes the next graph and says nothing else.

import type {
  EdgeTypeSpec,
  GraphEdge,
  GraphNode,
  GraphPayload,
  NodeLabel,
  NodeLabelSpec,
} from '@cpg/model';
import { EDGE_TYPES, isWorkspacePath, makeNodeId, NODE_LABELS, WORKSPACE_ROOT } from '@cpg/model';
import type { AuditEntry, EdgeRow, NodeRow, Properties, WriteOp, WriteReceipt } from '@cpg/store';
import { storeError } from '@cpg/store';

export type FileWriteOp = Extract<WriteOp, { readonly kind: 'replace-file' | 'delete-file' }>;

/**
 * The code tier's record of one file. `seq` is the last replace-file / delete-file seq
 * (FileState.seq); `revision_id` is the revision the file's code nodes were written at, undefined
 * before the first replace-file and after a delete-file.
 */
export interface CodeTierFile {
  readonly seq: number;
  readonly revision_id: string | undefined;
}

export interface FileWriteResult {
  /** The next graph; the same object when the write was not applied. */
  readonly graph: GraphPayload;
  readonly file: CodeTierFile;
  readonly receipt: Omit<WriteReceipt, 'durationMs'>;
  /** Present when the write was applied (C-STORE INV-8); the store stamps `at`. */
  readonly audit?: Omit<AuditEntry, 'at'>;
}

const NODE_SPEC_BY_LABEL: ReadonlyMap<string, NodeLabelSpec> = new Map(
  NODE_LABELS.map((spec): [string, NodeLabelSpec] => [spec.label, spec]),
);
const EDGE_SPEC_BY_TYPE: ReadonlyMap<string, EdgeTypeSpec> = new Map(
  EDGE_TYPES.map((spec): [string, EdgeTypeSpec] => [spec.type, spec]),
);
const IDENTITY_LABELS: ReadonlySet<string> = new Set(
  NODE_LABELS.filter((spec) => spec.ownership === 'identity').map((spec) => spec.label),
);
const FILE_CODE_OWNED_PROPS: ReadonlySet<string> = new Set(
  NODE_LABELS.filter((spec) => spec.label === 'FILE').flatMap((spec) =>
    spec.properties.filter((prop) => prop.owner === 'code').map((prop) => prop.name),
  ),
);

interface ValidatedRow {
  readonly row: NodeRow;
  readonly id: string;
  readonly kind: 'file-owned' | 'identity' | 'file';
}

function pruneAndClone(properties: Properties): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== null && value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

function idOf(label: NodeLabel, key: string): string {
  if (label !== 'DIRECTORY' && label !== 'FILE') return key;
  if (!isWorkspacePath(key) || (label === 'FILE' && key === WORKSPACE_ROOT)) {
    throw storeError('WRITE_SHAPE_VIOLATION', `invalid ${label} key: ${key}`);
  }
  return makeNodeId({ form: label === 'DIRECTORY' ? 'directory' : 'file', path: key });
}

function edgeTripleKey(source: string, type: string | undefined, target: string): string {
  return JSON.stringify([source, type, target]);
}

function isFileOwnedNode(node: GraphNode, file: string): boolean {
  if (node.data?.['file'] !== file) return false;
  const spec = NODE_SPEC_BY_LABEL.get(node.type);
  return spec === undefined || spec.ownership === 'file-owned';
}

function removeFileOwnedSubgraph(
  graph: GraphPayload,
  file: string,
): { keptNodes: GraphNode[]; keptEdges: GraphEdge[]; nodesDeleted: number } {
  const deletedIds = new Set<string>();
  const keptNodes: GraphNode[] = [];
  let nodesDeleted = 0;

  for (const node of graph.nodes) {
    if (isFileOwnedNode(node, file)) {
      deletedIds.add(node.id);
      nodesDeleted += 1;
    } else {
      keptNodes.push(node);
    }
  }

  const keptEdges: GraphEdge[] = [];
  for (const edge of graph.edges) {
    if (!deletedIds.has(edge.source) && !deletedIds.has(edge.target)) {
      keptEdges.push(edge);
    }
  }

  return { keptNodes, keptEdges, nodesDeleted };
}

function notAppliedResult(
  graph: GraphPayload,
  file: CodeTierFile,
  notApplied: NonNullable<WriteReceipt['notApplied']>,
): FileWriteResult {
  return {
    graph,
    file,
    receipt: {
      applied: false,
      notApplied,
      nodesWritten: 0,
      edgesWritten: 0,
      nodesDeleted: 0,
      statementCount: 1,
    },
  };
}

function validateRows(
  rows: readonly NodeRow[],
  file: string,
  fileNodeId: string,
): readonly ValidatedRow[] {
  const prefix = `${fileNodeId}:`;
  const seen = new Set<string>();
  const validated: ValidatedRow[] = [];

  for (const row of rows) {
    const spec = NODE_SPEC_BY_LABEL.get(row.label);
    if (spec === undefined) {
      throw storeError('WRITE_SHAPE_VIOLATION', `unknown node label: ${row.label}`);
    }
    const rowKey = JSON.stringify([row.label, row.key]);
    if (seen.has(rowKey)) {
      throw storeError('WRITE_SHAPE_VIOLATION', `duplicate node row: ${row.label} ${row.key}`);
    }
    seen.add(rowKey);

    if (spec.ownership === 'file-owned') {
      if (!row.key.startsWith(prefix) || row.properties['file'] !== file) {
        throw storeError(
          'OWNERSHIP_VIOLATION',
          `file-owned row ${row.label} ${row.key} does not belong to ${file}`,
        );
      }
      validated.push({ row, id: row.key, kind: 'file-owned' });
    } else if (spec.ownership === 'identity') {
      if (!spec.key.every((keyProp) => row.properties[keyProp] === row.key)) {
        throw storeError(
          'WRITE_SHAPE_VIOLATION',
          `identity row ${row.label} key mismatch: ${row.key}`,
        );
      }
      validated.push({ row, id: row.key, kind: 'identity' });
    } else if (spec.label === 'FILE') {
      if (row.key !== file) {
        throw storeError('OWNERSHIP_VIOLATION', `FILE row ${row.key} does not match ${file}`);
      }
      for (const prop of Object.keys(row.properties)) {
        if (!FILE_CODE_OWNED_PROPS.has(prop)) {
          throw storeError(
            'OWNERSHIP_VIOLATION',
            `FILE row may only name code-owned properties, got ${prop}`,
          );
        }
      }
      validated.push({ row, id: fileNodeId, kind: 'file' });
    } else {
      throw storeError('OWNERSHIP_VIOLATION', `disallowed row label in replace-file: ${row.label}`);
    }
  }

  return validated;
}

function isAllowedEndpoint(
  id: string,
  label: NodeLabel,
  opRowIds: ReadonlySet<string>,
  fileNodeId: string,
): boolean {
  return opRowIds.has(id) || id === fileNodeId || IDENTITY_LABELS.has(label);
}

function applyEdges(
  keptEdges: readonly GraphEdge[],
  edgeRows: readonly EdgeRow[],
  nodeMap: ReadonlyMap<string, GraphNode>,
  opRowIds: ReadonlySet<string>,
  fileNodeId: string,
): GraphEdge[] {
  // An edge merges onto the first edge with its (source, type, target); duplicates elsewhere in the
  // graph (the GraphSink half concatenates) stay as they are, since they are other files' (INV-12).
  const edges = [...keptEdges];
  const firstAt = new Map<string, number>();
  for (const [at, edge] of edges.entries()) {
    const key = edgeTripleKey(edge.source, edge.type, edge.target);
    if (!firstAt.has(key)) firstAt.set(key, at);
  }

  for (const edgeRow of edgeRows) {
    const spec = EDGE_SPEC_BY_TYPE.get(edgeRow.type);
    if (spec === undefined) {
      throw storeError('WRITE_SHAPE_VIOLATION', `unknown edge type: ${edgeRow.type}`);
    }
    if (spec.ownership !== 'file-owned' && spec.ownership !== 'identity') {
      throw storeError(
        'OWNERSHIP_VIOLATION',
        `disallowed edge type in replace-file: ${edgeRow.type}`,
      );
    }

    const source = idOf(edgeRow.fromLabel, edgeRow.fromKey);
    const target = idOf(edgeRow.toLabel, edgeRow.toKey);
    const fromNode = nodeMap.get(source);
    const toNode = nodeMap.get(target);
    if (
      fromNode === undefined ||
      fromNode.type !== edgeRow.fromLabel ||
      toNode === undefined ||
      toNode.type !== edgeRow.toLabel
    ) {
      throw storeError(
        'WRITE_SHAPE_VIOLATION',
        `dangling edge ${edgeRow.fromLabel}(${edgeRow.fromKey}) -[${edgeRow.type}]-> ${edgeRow.toLabel}(${edgeRow.toKey})`,
      );
    }

    if (
      !isAllowedEndpoint(source, edgeRow.fromLabel, opRowIds, fileNodeId) ||
      !isAllowedEndpoint(target, edgeRow.toLabel, opRowIds, fileNodeId)
    ) {
      throw storeError(
        'OWNERSHIP_VIOLATION',
        `edge endpoint outside file scope: ${edgeRow.fromLabel}(${edgeRow.fromKey}) -[${edgeRow.type}]-> ${edgeRow.toLabel}(${edgeRow.toKey})`,
      );
    }

    const pruned = pruneAndClone(edgeRow.properties);
    const key = edgeTripleKey(source, edgeRow.type, target);
    const at = firstAt.get(key);
    const existing = at === undefined ? undefined : edges[at];
    const data = existing?.data !== undefined ? { ...existing.data, ...pruned } : pruned;
    const next: GraphEdge = {
      source,
      target,
      type: edgeRow.type,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };
    if (at === undefined) {
      firstAt.set(key, edges.length);
      edges.push(next);
    } else {
      edges[at] = next;
    }
  }

  return edges;
}

/**
 * One replace-file or delete-file against `graph`, given the file's record (`undefined`: the code
 * tier never wrote it, so its seq is -1). Pure: a throw is a StoreError and nothing changes (INV-20).
 *
 * Both ops:
 * - WRITE_SHAPE_VIOLATION unless `seq` is a non-negative safe integer and `file` a WorkspacePath
 *   other than `'.'`.
 * - `seq <= record.seq` is `applied: false`, `notApplied: { reason: 'stale-seq', current }` (INV-13).
 * - Not applied: every count 0, `statementCount` 1 (INV-3), no audit entry, the graph unchanged.
 * - The file-owned subgraph of `file` is every node whose `data.file` is `file` and whose label is a
 *   file-owned one (or not in the schema), with every edge incident to one of them. FILE, SYMBOL,
 *   TAG, DIRECTORY, COMMUNITY and META_DATA nodes are never in it (INV-12, C-MODEL I-15).
 * - Applied: `statementCount` 1 and one audit entry `{ scope: { kind: 'file', file }, nodesDeleted,
 *   calledBy: op.kind }`. The graph's `seq` (the GraphSink half's) is never moved.
 *
 * replace-file:
 * - `revision_id` equal to the record's is `applied: false`, `notApplied: { reason:
 *   'revision-unchanged', revision_id }`; the record's seq still becomes `seq`. Checked after stale-seq.
 * - WRITE_SHAPE_VIOLATION when the graph holds no FILE for `file` (merge-filesystem writes it first).
 * - Rows. An unknown label, or two rows with one label and key, is WRITE_SHAPE_VIOLATION. A
 *   file-owned row is created: its key must start with the FILE's id and `:` and its `file` property
 *   must be `file`, else OWNERSHIP_VIOLATION; so is a key held by a node outside the file-owned
 *   subgraph. An identity row (SYMBOL, TAG) is merged on its key, whose property must equal the row
 *   key (else WRITE_SHAPE_VIOLATION). A FILE row must be `file`'s and name only FILE's code-owned
 *   properties (DQ-01), else OWNERSHIP_VIOLATION; it merges onto the FILE. Any other label
 *   (DIRECTORY, COMMUNITY, META_DATA) is OWNERSHIP_VIOLATION (INV-10).
 * - Merges prune null and undefined first and never remove a property (INV-11).
 * - The statement: delete the file-owned subgraph, create and merge the rows, then set the FILE's
 *   `status` to `'ready'` and its `version` to the prior version + 1 (1 when it had none).
 * - Edges. An unknown type is WRITE_SHAPE_VIOLATION; an overlay type is OWNERSHIP_VIOLATION
 *   (INV-10). Each endpoint must be a node of that label and key after the rows are
 *   written (else WRITE_SHAPE_VIOLATION, dangling) and must be a row of this op, an identity node,
 *   or `file`'s FILE (else OWNERSHIP_VIOLATION: cross-file travels through SYMBOL only, L-03). Each
 *   edge is merged on (source, type, target), its properties null-pruned.
 * - Receipt: `nodesWritten` = rows, `edgesWritten` = edge rows, `nodesDeleted` = the subgraph's
 *   nodes. The record becomes `{ seq, revision_id }`.
 *
 * delete-file deletes the file-owned subgraph and nothing else (the FILE keeps every property; a
 * SYMBOL the file minted stays, decision 104). It needs no FILE. Receipt: `nodesWritten` 0,
 * `edgesWritten` 0. The record becomes `{ seq, revision_id: undefined }`.
 */
export function writeFileOp(
  graph: GraphPayload,
  op: FileWriteOp,
  record: CodeTierFile | undefined,
): FileWriteResult {
  // REAL
  if (!Number.isSafeInteger(op.seq) || op.seq < 0) {
    throw storeError('WRITE_SHAPE_VIOLATION', `invalid seq: ${String(op.seq)}`);
  }
  if (!isWorkspacePath(op.file) || op.file === WORKSPACE_ROOT) {
    throw storeError('WRITE_SHAPE_VIOLATION', `invalid file path: ${op.file}`);
  }

  if (record !== undefined && op.seq <= record.seq) {
    return notAppliedResult(graph, record, { reason: 'stale-seq', current: record.seq });
  }

  if (op.kind === 'delete-file') {
    const { keptNodes, keptEdges, nodesDeleted } = removeFileOwnedSubgraph(graph, op.file);
    return {
      graph: { seq: graph.seq, nodes: keptNodes, edges: keptEdges },
      file: { seq: op.seq, revision_id: undefined },
      receipt: {
        applied: true,
        nodesWritten: 0,
        edgesWritten: 0,
        nodesDeleted,
        statementCount: 1,
      },
      audit: {
        scope: { kind: 'file', file: op.file },
        nodesDeleted,
        calledBy: 'delete-file',
      },
    };
  }

  if (record !== undefined && record.revision_id === op.revision_id) {
    return notAppliedResult(
      graph,
      { seq: op.seq, revision_id: record.revision_id },
      { reason: 'revision-unchanged', revision_id: op.revision_id },
    );
  }

  const fileNodeId = makeNodeId({ form: 'file', path: op.file });
  const existingFile = graph.nodes.find((node) => node.id === fileNodeId && node.type === 'FILE');
  if (existingFile === undefined) {
    throw storeError('WRITE_SHAPE_VIOLATION', `no FILE node for ${op.file}`);
  }

  const validatedRows = validateRows(op.nodes, op.file, fileNodeId);
  const { keptNodes, keptEdges, nodesDeleted } = removeFileOwnedSubgraph(graph, op.file);

  const nodeMap = new Map<string, GraphNode>();
  for (const node of keptNodes) {
    nodeMap.set(node.id, node);
  }

  for (const entry of validatedRows) {
    if (entry.kind === 'file-owned' && nodeMap.has(entry.id)) {
      throw storeError(
        'OWNERSHIP_VIOLATION',
        `file-owned row id collides with existing node: ${entry.id}`,
      );
    }
  }

  const priorVersion =
    typeof existingFile.data?.['version'] === 'number' ? existingFile.data['version'] : 0;
  let fileNode: GraphNode = existingFile;
  const opRowIds = new Set<string>();

  for (const { row, id, kind } of validatedRows) {
    opRowIds.add(id);
    const pruned = pruneAndClone(row.properties);
    const existing = kind === 'file-owned' ? undefined : nodeMap.get(id);
    const data = existing?.data !== undefined ? { ...existing.data, ...pruned } : pruned;
    const name = typeof pruned['name'] === 'string' ? pruned['name'] : existing?.name;
    const nextNode: GraphNode = {
      id,
      type: row.label,
      ...(name !== undefined ? { name } : {}),
      data,
    };
    nodeMap.set(id, nextNode);
    if (kind === 'file') fileNode = nextNode;
  }

  nodeMap.set(fileNodeId, {
    ...fileNode,
    data: {
      ...fileNode.data,
      status: 'ready',
      version: priorVersion + 1,
    },
  });

  const edges = applyEdges(keptEdges, op.edges, nodeMap, opRowIds, fileNodeId);

  return {
    graph: { seq: graph.seq, nodes: [...nodeMap.values()], edges },
    file: { seq: op.seq, revision_id: op.revision_id },
    receipt: {
      applied: true,
      nodesWritten: op.nodes.length,
      edgesWritten: op.edges.length,
      nodesDeleted,
      statementCount: 1,
    },
    audit: {
      scope: { kind: 'file', file: op.file },
      nodesDeleted,
      calledBy: 'replace-file',
    },
  };
}
