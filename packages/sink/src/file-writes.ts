// The code tier's two writes on MemoryStore (C-STORE; controller decisions 97 and 98): replace-file
// and delete-file, each one statement over the shared graph. memory-graph-store.ts owns the cell,
// the per-file records and the audit log; this file computes the next graph and says nothing else.

import type { GraphPayload } from '@cpg/model';
import type { AuditEntry, WriteOp, WriteReceipt } from '@cpg/store';

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
  _graph: GraphPayload,
  _op: FileWriteOp,
  _record: CodeTierFile | undefined,
): FileWriteResult {
  // SEAT: U6a.3-1 implements it
  throw new Error('SEAT: replace-file and delete-file land in U6a.3-1');
}
