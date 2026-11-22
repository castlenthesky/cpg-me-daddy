// The CpgEngine port (C-CLI): the one surface a front door sees. C-CLI Q1 puts the contract types in
// @cpg/engine's public surface. Types only. This is the slice U2a needs (identity, connect, index,
// verify, schema); watch, read, inspect and doctor arrive with their units.

import type { SchemaDocInput, WorkspacePath } from '@cpg/model';

export interface StoreTarget {
  readonly host: string;
  readonly port: number;
  readonly graph: string;
}

export interface EngineSession {
  readonly target: StoreTarget;
  close(): Promise<void>;
}

/** C-CLI: the five config layers. The index in CONFIG_PRECEDENCE is the rank (0 wins). */
export type ConfigLayer = 'flag' | 'env' | 'file' | 'manifest' | 'default';

/** One resolved value with the layer and source it came from (C-CLI I-25). */
export interface Provenanced<T> {
  readonly value: T;
  readonly layer: ConfigLayer;
  /** The flag as typed (`--host`), the env var name, the file's absolute path, `cwd` or `built-in`. */
  readonly source: string;
}

/** One input to resolveConfig. `values` is keyed by ResolvedConfig key path (`store.port`). */
export interface ConfigLayerInput {
  readonly layer: ConfigLayer;
  readonly source: string;
  /** An undefined value is unset: the key falls through to the next layer. */
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ConsumerSwitches {
  readonly inspect: boolean;
  readonly store: 'memory' | 'falkor';
  readonly vscode: boolean;
}

/** C-CLI ResolvedConfig: every key carries its value, layer and source. */
export interface ResolvedConfig {
  readonly root: Provenanced<string>;
  readonly include: Provenanced<readonly string[]>;
  readonly exclude: Provenanced<readonly string[]>;
  readonly maxFileSizeBytes: Provenanced<number>;
  /** One provenance per switch (owner decision 1A): `--inspect` over a file's `store` keeps both. */
  readonly consumers: {
    readonly inspect: Provenanced<boolean>;
    readonly store: Provenanced<'memory' | 'falkor'>;
    readonly vscode: Provenanced<boolean>;
  };
  readonly store: {
    readonly host: Provenanced<string>;
    readonly port: Provenanced<number>;
    readonly graph: Provenanced<string>;
    readonly mode: Provenanced<'remote' | 'docker'>;
  };
  readonly queryTimeoutMs: Provenanced<number>;
  readonly resolve: {
    readonly perFileMs: Provenanced<number>;
    readonly perSiteMs: Provenanced<number>;
  };
  readonly watch: {
    readonly trailingMs: Provenanced<number>;
    readonly ceilingMs: Provenanced<number>;
    readonly bulkThresholdFiles: Provenanced<number>;
  };
}

type Unprovenanced<T> =
  T extends Provenanced<infer V> ? V : { readonly [K in keyof T]: Unprovenanced<T[K]> };

/** ResolvedConfig without provenance: the one object a front door hands the engine (U2c.1). */
export type CpgConfigInput = Unprovenanced<ResolvedConfig>;

/** The walk scope of one index run. A front door passes its CpgConfigInput, which satisfies it. */
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

/** The shared enum (05-contracts.yaml shared.verify_check_ids), in its order. */
export type VerifyCheckId =
  | 'filesystem-reconciliation'
  | 'identity-invariants'
  | 'id-uniqueness'
  | 'render-reconciliation'
  | 'revision-reconciliation'
  | 'resolution-health';

/** Worst-of ordering: fail > stale > unavailable > pass. */
export type CheckState = 'pass' | 'fail' | 'stale' | 'unavailable';

export interface CheckResult {
  readonly id: VerifyCheckId;
  readonly state: CheckState;
  readonly observed: number;
  readonly expected: number;
  /** The offending workspace paths (directories or files) or keys, sorted. */
  readonly localisedTo: readonly string[];
  readonly detail?: string;
  /** The graph's seq, snapshotted before the check's first await. */
  readonly asOfSeq: number;
}

export interface VerifyReport {
  /** The worst state of `checks`. */
  readonly state: CheckState;
  /** All six, once each, in enum order. */
  readonly checks: readonly CheckResult[];
  /** The ids of the stores this run read (P-A); empty when no store consumer is enabled. */
  readonly consumers: readonly string[];
  readonly durationMs: number;
}

/** The walk scope verify reconciles against, plus `--strict`. */
export interface VerifyConfig extends IndexConfig {
  /** Promote every `unavailable` check to `fail`. */
  readonly strict?: boolean;
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
  /** Read-only. `expected` must be null (C-CLI Q9: the live filesystem suffices). */
  verify(
    session: EngineSession,
    config: VerifyConfig,
    expected: IndexReport | null,
  ): Promise<VerifyReport>;
  /**
   * The graph schema (CPG_SCHEMA). C-CLI types it `unknown`; the port narrows it to the part the CLI
   * reads: `cpg schema --check` renders its doc region, and `--print` serialises the whole object.
   */
  schema(): SchemaDocInput;
}
