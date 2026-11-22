// The CpgEngine port (C-CLI): the one surface a front door sees. C-CLI Q1 puts the contract types in
// @cpg/engine's public surface. Types only. This is the slice U2a needs (identity, connect, index);
// watch, read, verify, inspect, doctor and schema arrive with their units (U4, U2a.3, U2b, U2a.4).

import type { WorkspacePath } from '@cpg/model';

export interface StoreTarget {
  readonly host: string;
  readonly port: number;
  readonly graph: string;
}

export interface EngineSession {
  readonly target: StoreTarget;
  close(): Promise<void>;
}

/** The walk scope of one index run. The config loader (U2c.1) resolves it with provenance. */
export interface IndexConfig {
  /** Absolute path to the workspace root. */
  readonly root: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFileSizeBytes?: number;
}

export interface IndexedFile {
  readonly path: WorkspacePath;
  /** Lowercase hex sha256 of the raw bytes (C-CLI spells it sha256:<hex>; stop-list #9). */
  readonly revision_id: string;
  /** Code-tier nodes the file owns, not its FILE node; 0 until the extractor (U6a). */
  readonly nodes: number;
  /** Code-tier edges leaving those nodes; 0 until the extractor (U6a). */
  readonly edges: number;
}

export interface IndexRequest {
  readonly config: IndexConfig;
  /** null iff --dry-run: the engine writes to its own NullGraphStore. */
  readonly session: EngineSession | null;
  /** v1 is not resumable: must be null. */
  readonly resumeFrom: readonly IndexedFile[] | null;
}

/** I-20: `filesSeen === filesIndexed + filesExcluded + filesUnsupported + filesTooLarge + filesFailed`. */
export interface IndexWalk {
  readonly filesSeen: number;
  readonly filesIndexed: number;
  readonly filesExcluded: number;
  readonly filesUnsupported: number;
  readonly filesTooLarge: number;
  readonly filesFailed: number;
}

export interface IndexReport {
  /** The absolute root that was walked. */
  readonly root: string;
  readonly walk: IndexWalk;
  /** The indexed files (a language claims them), sorted by path in UTF-16 code-unit order. */
  readonly files: readonly IndexedFile[];
  readonly nodesWritten: number;
  readonly edgesWritten: number;
  readonly durationMs: number;
  readonly dryRun: boolean;
  /** The signal fired before the write: nothing was written and `files` is empty. */
  readonly interrupted: boolean;
  readonly warnings: readonly string[];
  readonly target: StoreTarget | null;
  /** The ids of the sinks this run wrote through (P-A); empty under --dry-run. */
  readonly consumers: readonly string[];
}

export interface IndexProgress {
  readonly phase: 'walked' | 'written';
  /** Files the walk emitted. */
  readonly filesTotal: number;
}

export interface CpgEngine {
  readonly identity: {
    readonly name: string;
    readonly version: string;
    readonly languages: readonly string[];
  };
  connect(target: StoreTarget, opts: { readonly readOnly: boolean }): Promise<EngineSession>;
  index(
    req: IndexRequest,
    onProgress: (progress: IndexProgress) => void,
    signal: AbortSignal,
  ): Promise<IndexReport>;
}
