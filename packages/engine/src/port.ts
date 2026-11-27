// The CpgEngine port (C-CLI): the one surface a front door sees. C-CLI Q1 puts the contract types in
// @cpg/engine's public surface. Types only. This is the slice built so far (identity, connect,
// index, watch, verify, inspect, schema); read and doctor arrive with their units.

import type {
  CheckResult,
  CheckState,
  GraphPayload,
  SchemaDocInput,
  WorkspacePath,
} from '@cpg/model';
import type { NormalizedChange } from '@cpg/watch';

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
  /** null under --dry-run and while no store dials a target (memory; FalkorStore is U5). */
  readonly target: StoreTarget | null;
  /** The ids of the sinks this run wrote through (P-A); empty under --dry-run. */
  readonly consumers: readonly string[];
}

export interface IndexProgress {
  readonly phase: 'walked' | 'written';
  /** Files the walk emitted. */
  readonly filesTotal: number;
}

// The check vocabulary lives in @cpg/model, shared with C-EXT's VerificationReport (controller
// decision 13); re-exported so C-CLI's types stay on this surface (Q1).
export type { CheckResult, CheckState, VerifyCheckId } from '@cpg/model';

export interface VerifyReport {
  /** The worst state of `checks`. */
  readonly state: CheckState;
  /** All six, once each, in enum order. */
  readonly checks: readonly CheckResult[];
  /** The store this run read (P-A). */
  readonly consumers: readonly string[];
  readonly durationMs: number;
}

/** The walk scope verify reconciles against, plus `--strict`. */
export interface VerifyConfig extends IndexConfig {
  /** Promote every `unavailable` check to `fail`. */
  readonly strict?: boolean;
}

/**
 * CpgEngine.watch's request (controller decision 59): the walk scope plus the debounce window. A
 * session is required: there is no dry-run watch.
 */
export interface WatchRequest {
  readonly config: IndexConfig & {
    /** Default 100 (C-WATCH budget_boundary.T1_T2). */
    readonly trailingMs?: number;
    /** Default 500 (C-WATCH budget_boundary.T1_T2). */
    readonly ceilingMs?: number;
  };
  readonly session: EngineSession;
}

/**
 * The C-CLI CliError kinds a watch reports, a subset of C-CLI's CliError union. `workspace` is a
 * WatchError (root-missing, a fatal backend error): `path` is the error's path, else the root, and
 * `message` starts with its code. `engine-rejected` is any other failure (the index, a sink's last
 * rejection of the initial batch, a probe that throws there), with the error's message.
 */
export type WatchFailure =
  | { readonly kind: 'workspace'; readonly path: string; readonly message: string }
  | { readonly kind: 'engine-rejected'; readonly message: string };

/**
 * The three intervals of C-WATCH budget_boundary, in ms. `t0_t1` is always null: T0 is outside our
 * code, and the benchmark measures it from outside (C-CLI amended, decision 63).
 */
export interface WatchLatency {
  readonly t0_t1: number | null;
  /** settledAt - firstEventAt: the debounce window. */
  readonly t1_t2: number;
  /** When every sink's write resolved, minus settledAt: the pipeline. */
  readonly t2_t3: number;
  /** t1_t2 + t2_t3. */
  readonly total: number;
}

/**
 * One event of CpgEngine.watch (C-CLI). `seq` is dense from 0 across every kind and `closed` is
 * always last (I-23); `at` is the engine's injected `now()` when the event is emitted (I-30).
 */
export type WatchEvent =
  | {
      readonly kind: 'ready';
      readonly seq: number;
      readonly at: number;
      /** The absolute root being watched: the request's `config.root`. */
      readonly root: string;
      /** The IndexReport of the index the watch started with. */
      readonly report: IndexReport;
    }
  | {
      readonly kind: 'batch';
      readonly seq: number;
      readonly at: number;
      readonly changes: readonly NormalizedChange[];
      /** The first sink's receipt (the built-in memory store), as IndexReport counts it. */
      readonly write: {
        readonly nodesWritten: number;
        readonly edgesWritten: number;
        readonly statementCount: number;
      };
      readonly latencyMs: WatchLatency;
    }
  | {
      readonly kind: 'warning';
      readonly seq: number;
      readonly at: number;
      readonly message: string;
    }
  | {
      readonly kind: 'error';
      readonly seq: number;
      readonly at: number;
      readonly error: WatchFailure;
    }
  | {
      readonly kind: 'closed';
      readonly seq: number;
      readonly at: number;
      readonly reason: 'signal' | 'error' | 'eof';
    };

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
  /**
   * Indexes as `index()` does, then watches the root and writes each settled batch of changes
   * through the same sinks until `signal` aborts or the watch fails (U4.2.1, decisions 59-63).
   * Every outcome is an event: it resolves after `closed` and never rejects.
   */
  watch(
    req: WatchRequest,
    onEvent: (event: WatchEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Read-only. `expected` must be null (C-CLI Q9: the live filesystem suffices). */
  verify(
    session: EngineSession,
    config: VerifyConfig,
    expected: IndexReport | null,
  ): Promise<VerifyReport>;
  /**
   * Read-only: the whole graph the session's store holds, as one payload (C-CLI; U2b.1 part 3b,
   * controller decision 20). `cpg index --inspect` sends it to the browser inspector. `config` is
   * the walk scope; the memory store holds one workspace, so it does not narrow the read.
   */
  inspect(session: EngineSession, config: IndexConfig): Promise<GraphPayload>;
  /**
   * The graph schema (CPG_SCHEMA). C-CLI types it `unknown`; the port narrows it to the part the CLI
   * reads: `cpg schema --check` renders its doc region, and `--print` serialises the whole object.
   */
  schema(): SchemaDocInput;
}
