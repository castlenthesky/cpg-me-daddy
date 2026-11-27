// C-RESOLVE: the resolver seam. SEAT (types only): implementations land in U3 (the VS Code host
// accelerator), U6c (chain, null, python-path, applyResolutions), U8 (LSP driver) and U9. The LSP
// transport (src/lsp/) is REAL and lives outside this file.
//
// Types only, enforced by check-deps rule `contract-types-only`: the only imports are statement-level
// `import type` from @cpg/model, and the emitted JS is empty. The precise resolver calls the host's
// definition provider, and no host SDK is importable under packages/**, so the real implementation is
// forced to live in an app and arrive through this seam. Everything on this side is plain node, so a
// fake resolver can drive the hard part (definition location -> stable symbol id) with no host running.
//
// Ported from archive 21754b4:packages/cpg-generator/src/resolve.ts with C-RESOLVE's five amendments
// (ResolveBatch, capabilities, status(), ResolveContext, +5 reasons), DQ-02 paths (WorkspacePath)
// and readonly on every field.
//
// The extract-shaped types this seam consumes (EdgeElement, ExtractedFileSet and its SEALED brand) live in
// @cpg/extract (controller decision 88); applyResolutions (U6c) imports them from there.

import type { RESOLUTION_STATUS, WorkspacePath } from '@cpg/model';

/** Zero-based rows, UTF-16 code-unit columns: identical to `vscode.Position`, no conversion at the host. */
export interface RefPosition {
  readonly row: number;
  readonly column: number;
}

/**
 * The reference kinds the extractor emits. `receiver` and `receiver-type` both come from a CALL
 * node's receiver token and share its `nodeId`: `receiver` asks where the receiver is bound (a
 * RECEIVER edge), `receiver-type` asks what its type is (a type-evaluation edge, DQ-09). Widening is additive.
 */
export type RefKind = 'call' | 'import' | 'receiver' | 'receiver-type';

/** One bound name of an import statement. */
export interface ImportBindingRef {
  /** Dotted module path as written, leading dots stripped (empty for a bare relative import). */
  readonly module: string;
  /** Leading-dot count of a Python relative import; 0 for absolute and for TS/JS. */
  readonly relativeDepth: number;
  /** The name as the target module spells it; `*` for a wildcard; absent for a whole-module import. */
  readonly imported?: string;
  /** The name bound in the importing file. */
  readonly local: string;
}

/**
 * One place in the source that points at a definition: a call site or a single import binding.
 *
 * `position` is the crux. It must be the exact token a definition provider should be asked about,
 * which is neither the construct's extent nor necessarily its nameRange: for `greeter.greet()` it is
 * the LAST callee segment (asking on `greeter` resolves the local variable), and for an import it is
 * the imported name as the target module spells it, never the local alias (an alias resolves to itself).
 */
export interface RefSite {
  /** Unique per bound name, and the key a Resolution answers by. One IMPORT fans out to one site per name. */
  readonly id: string;
  /** The CALL or IMPORT node this came from, and the source of any edge minted for it. Several sites may share one. */
  readonly nodeId: string;
  readonly filePath: WorkspacePath;
  readonly kind: RefKind;
  readonly position: RefPosition;
  /** What a syntactic resolver needs when no language server answers. */
  readonly nameParts: readonly string[];
  /** Present iff `kind === 'import'`. */
  readonly importBinding?: ImportBindingRef;
  /** The extractor already knows why this will not resolve (C-EXTRACT). */
  readonly declined?: ResolutionReason;
}

/** Where a definition lives; mapped back to a symbol through `DefinitionLookup.symbolAt`. */
export interface DefinitionSite {
  readonly filePath: WorkspacePath;
  /** The definition's name token when the resolver could narrow to it; otherwise the construct's extent. */
  readonly position: RefPosition;
}

/** Model's shared five-value vocabulary (R6), so the two never fork. */
export type ResolutionStatus = (typeof RESOLUTION_STATUS)[number];

/** Enumerable codes rather than free text: this is the dimension an unresolved-rate metric groups by. */
export type ResolutionReason =
  | 'no-definition'
  | 'receiver-unknown'
  | 'name-not-exported'
  | 'module-not-found'
  | 'reexport-depth'
  | 'module-binding'
  | 'wildcard'
  | 'truncated-subgraph'
  | 'provider-error'
  | 'builtin'
  | 'self'
  | 'not-warm'
  | 'no-resolver'
  | 'timeout'
  | 'cancelled'
  | 'backend-unavailable'
  | 'unsupported-language'
  | 'unsupported-kind';

export interface Resolution {
  /** The `RefSite.id` this answers. */
  readonly refId: string;
  readonly status: ResolutionStatus;
  /**
   * Where the definition lives, when the resolver only knows a location (all a language server
   * reports). Set iff status is resolved or ambiguous; never for external, which is outside the graph.
   */
  readonly definition?: DefinitionSite;
  /** The resolved symbol, when the resolver already has it from the DefinitionLookup. Wins over `definition`. */
  readonly target?: { readonly fqn: string; readonly filePath?: WorkspacePath };
  /** `Resolver.id` of the link that produced this, mirrored onto the edge (provenance per edge). */
  readonly resolvedBy: string;
  /** In [0, 1]; 0 when the answer ranks no better than unresolved. */
  readonly confidence: number;
  readonly reason?: ResolutionReason;
}

/** Structural subset of `vscode.CancellationToken`, so a host can pass one through. */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

/** Defaults 250 / 500 / 4000 ms. */
export interface ResolveBudget {
  readonly perSiteMs: number;
  readonly perFileMs: number;
  readonly warmupMs: number;
}

export interface ResolveContext {
  readonly token?: CancellationLike;
  readonly budget?: ResolveBudget;
}

/**
 * "Is there a definition here, in a file we actually indexed?" Implemented on the graph side and
 * satisfied structurally. A resolver is handed a lookup, never the graph. It returns the symbol fqn,
 * not an AST node id: a node id is positional and changes on the defining file's next re-parse.
 */
export interface DefinitionLookup {
  /** The fqn of the definition whose name token starts here, or that most tightly encloses it. */
  symbolAt(filePath: WorkspacePath, row: number, column: number): string | undefined;
  /** A module-level symbol by simple name. The caller must ALREADY have picked the file. */
  symbolNamed(filePath: WorkspacePath, name: string): string | undefined;
  /** Whether a symbol node exists for this fqn; an edge to an absent id would hide the bug. */
  hasSymbol(fqn: string): boolean;
  /** Whether this file was parsed into the graph at all: the difference between unresolved and external. */
  isIndexed(filePath: WorkspacePath): boolean;
}

export interface ResolverWorkspace {
  /** Absolute; plain string (DQ-02 confines AbsolutePath to FilesystemProbe and SourceOpener). */
  readonly rootPath: string;
  readonly definitions: DefinitionLookup;
}

export interface ResolverCapabilities {
  readonly extensions: readonly string[];
  readonly kinds: readonly RefKind[];
  readonly host: 'headless' | 'host-accelerator';
  readonly maxConcurrentFiles: number;
}

export type BackendState = 'stopped' | 'starting' | 'warming' | 'ready' | 'degraded';

/** Codes arrive additively with the LSP driver (U8). */
export interface ResolverError {
  readonly message: string;
  readonly cause?: unknown;
}

export interface ResolverStatus {
  readonly resolverId: string;
  readonly state: BackendState;
  readonly restarts: number;
  readonly lastError?: ResolverError;
}

export interface ResolveDiagnostics {
  readonly resolverId: string;
  readonly filePath: WorkspacePath;
  readonly siteCount: number;
  readonly backend: BackendState;
  readonly degraded: boolean;
  readonly elapsedMs: number;
  readonly timedOutSites: number;
}

/** Exactly one Resolution per input ref, in input order. */
export interface ResolveBatch {
  readonly resolutions: readonly Resolution[];
  readonly diagnostics: ResolveDiagnostics;
}

/**
 * Answers WHERE a reference points, never what it is called: symbol identity stays on the graph side,
 * so swapping a resolver can never change a symbol id.
 *
 * Batch-shaped (one call per file) because the precise implementation is a language-server round trip
 * per site; a per-site interface would push concurrency control into every caller. It never throws for
 * an unanswerable site: that site comes back `status: 'unresolved'` with a reason, because an
 * unanswerable reference is the normal case and a short array is one every caller would misreconcile.
 */
export interface Resolver {
  /** Stable identifier, recorded on every edge this resolver produces. */
  readonly id: string;
  readonly precision: 'syntactic' | 'checker' | 'index';
  readonly capabilities: ResolverCapabilities;
  open(workspace: ResolverWorkspace): Promise<void>;
  /** `null` text means the file was deleted. */
  fileChanged(filePath: WorkspacePath, text: string | null): Promise<void>;
  resolve(
    filePath: WorkspacePath,
    refs: readonly RefSite[],
    ctx?: ResolveContext,
  ): Promise<ResolveBatch>;
  status(): ResolverStatus;
  close(): Promise<void>;
}

// ── The process seam (C-RESOLVE INV-18): a resolver spawns nothing except through it ──

/** The composition root implements this with node:child_process; tests script it in memory. */
export interface ProcessHost {
  spawn(
    command: string,
    args: readonly string[],
    options?: { readonly cwd?: string },
  ): SubprocessHandle;
}

/** One running child: bytes in on stdin, bytes out on stdout, one exit. */
export interface SubprocessHandle {
  write(chunk: Uint8Array): void;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  /** Called once. `code` is null when a signal ended the process. */
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}
