// C-STORE (05-contracts.yaml): the store thin waist. One interface, two tiers (MemoryStore always;
// FalkorStore from U5). Types only (check-deps rule contract-types-only).
// SEAT: CypherStatement / WritePlanner / toWriteOp arrive with the Cypher planner (U5) and the
// extractor (U6a); OverlayBatch with the first overlay job (U10).

import type { EdgeType, NodeLabel, WorkspacePath } from '@cpg/model';

export type Properties = Readonly<Record<string, unknown>>;

/** `key` is the label's declared key: id for :CPG labels, path for DIRECTORY/FILE, fqn for SYMBOL. */
export interface NodeRow {
  readonly label: NodeLabel;
  readonly key: string;
  readonly properties: Properties;
}

export interface EdgeRow {
  readonly type: EdgeType;
  readonly fromLabel: NodeLabel;
  readonly fromKey: string;
  readonly toLabel: NodeLabel;
  readonly toKey: string;
  readonly properties: Properties;
}

/** L-02: the ONLY scoping vocabulary for a destructive write. */
export type DeleteScope =
  | { readonly kind: 'file'; readonly file: WorkspacePath }
  /** Segment-boundary match: `app` never matches `application`. */
  | { readonly kind: 'subtree'; readonly directory: WorkspacePath }
  | {
      readonly kind: 'whole-graph';
      readonly confirm: 'I_AM_DROPPING_THE_ENTIRE_GRAPH';
      readonly reason: string;
    };

export interface FilesystemMove {
  readonly from: WorkspacePath;
  readonly to: WorkspacePath;
  readonly kind: 'file' | 'directory';
}

export type WriteOp =
  | {
      readonly kind: 'replace-file';
      readonly file: WorkspacePath;
      readonly seq: number;
      readonly revision_id: string;
      readonly nodes: readonly NodeRow[];
      readonly edges: readonly EdgeRow[];
    }
  | { readonly kind: 'delete-file'; readonly file: WorkspacePath; readonly seq: number }
  | {
      readonly kind: 'merge-filesystem';
      readonly directories: readonly NodeRow[];
      readonly files: readonly NodeRow[];
      /** HAS_ENTRY. */
      readonly links: readonly EdgeRow[];
      readonly moves: readonly FilesystemMove[];
      /** Each a file or directory path; a directory removes its whole subtree. */
      readonly removals: readonly WorkspacePath[];
    }
  | { readonly kind: 'merge-singleton'; readonly metadata: Properties };

export type NotApplied =
  | { readonly reason: 'stale-seq'; readonly current: number }
  | { readonly reason: 'revision-unchanged'; readonly revision_id: string };

export interface WriteReceipt {
  readonly applied: boolean;
  readonly notApplied?: NotApplied;
  readonly nodesWritten: number;
  readonly edgesWritten: number;
  readonly nodesDeleted: number;
  /** MUST be 1 for replace-file / delete-file (INV-3). */
  readonly statementCount: number;
  readonly durationMs: number;
  readonly degraded?: readonly string[];
}

export interface FileState {
  readonly file: WorkspacePath;
  /** The last replace-file / delete-file seq; -1 when the code tier never wrote this file. */
  readonly seq: number;
  readonly revision_id: string;
  /** Nodes the file owns (its `file` property), not counting the FILE node itself. */
  readonly nodeCount: number;
}

export interface StaleNode {
  readonly id: string;
  readonly file: WorkspacePath;
  readonly node_revision: string;
  readonly file_revision: string;
}

export interface AuditEntry {
  readonly at: number;
  readonly scope: DeleteScope;
  readonly nodesDeleted: number;
  readonly calledBy: string;
}

export interface OverlayWriter {
  write(batch: unknown): Promise<WriteReceipt>;
  close(): Promise<void>;
}

export interface StoreCapabilities {
  readonly tier: 'memory' | 'falkordb';
  readonly dialect: 'none' | 'cypher';
  /** Default false. */
  readonly allowDropGraph: boolean;
  /** 500_000. */
  readonly softLimitNodes: number;
  readonly maxRowsPerStatement: number;
}

export interface GraphStore {
  open(): Promise<void>;
  close(): Promise<void>;
  write(op: WriteOp): Promise<WriteReceipt>;
  overlayWriter(job: string): OverlayWriter;
  /** filesystem-reconciliation, revision-reconciliation. Sorted by file. */
  fileStates(): Promise<readonly FileState[]>;
  /** id-uniqueness: every node's key for one label, duplicates included. */
  nodeKeys(label: NodeLabel): Promise<readonly string[]>;
  stats(): Promise<{ nodeCount: number; edgeCount: number; beyondMeasuredScale: boolean }>;
  /** Golden diffing: the FILE row, the nodes it owns, and the edges leaving them. */
  readFile(file: WorkspacePath): Promise<{ nodes: readonly NodeRow[]; edges: readonly EdgeRow[] }>;
  /** P-B: nodes whose revision_id differs from their FILE's. */
  staleNodes(): Promise<readonly StaleNode[]>;
  auditLog(): readonly AuditEntry[];
  readonly capabilities: StoreCapabilities;
}

export type StoreErrorCode =
  | 'STORE_NOT_OPEN'
  | 'SCHEMA_INVALID'
  | 'OWNERSHIP_VIOLATION'
  | 'WRITE_SHAPE_VIOLATION'
  | 'UNSAFE_DELETE_REFUSED'
  | 'STRUCTURAL_TOKEN_REJECTED'
  | 'CAPACITY'
  | 'TIMEOUT'
  | 'CONNECTION_LOST'
  | 'BACKEND';

export type StoreError = Error & { readonly name: 'StoreError'; readonly code: StoreErrorCode };
