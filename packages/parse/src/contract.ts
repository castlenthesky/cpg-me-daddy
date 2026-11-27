// C-PARSE (docs/outline/05-contracts.yaml): text in, a live syntax tree out. Types only, enforced by
// check-deps rule `contract-types-only`. REAL: the registry (registry.ts), the ParseService over
// web-tree-sitter (service.ts), the ABI gate (abi.ts), the grammar-dir locator (grammar-dir.ts).
// SEAT: the retained-tree cache (ParseService.retain / releaseDocument).
//
// Shapes the contract names but does not spell out (RegisterOutcome, GrammarBytesOutcome,
// GrammarDirOutcome, ParserStats, the per-code ParseError fields) are decided here.

import type { WorkspacePath } from '@cpg/model';

/** 0-based row, UTF-16 code-unit column. */
export interface SyntaxPoint {
  readonly row: number;
  readonly column: number;
}

/** The read-only view of a tree node that EXTRACT walks. `text` is never truncated (I21). */
export interface SyntaxNode {
  readonly type: string;
  readonly startPosition: SyntaxPoint;
  readonly endPosition: SyntaxPoint;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly namedChildren: readonly SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  readonly text: string;
}

export type LanguageId = string;
export type DocumentKey = WorkspacePath;

/** Where a grammar's wasm comes from. Never a filesystem path: a GrammarSource turns it into bytes. */
export interface GrammarRef {
  readonly packageName: string;
  readonly wasmFile: string;
}

export interface LanguageRegistration {
  readonly id: LanguageId;
  readonly grammar: GrammarRef;
  /** The root node type a correctly routed file parses to (`module`, `program`). */
  readonly rootNodeType: string;
  /** Lower case, leading dot. */
  readonly extensions: readonly string[];
}

export type RegisterOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'frozen' }
  | { readonly ok: false; readonly reason: 'duplicate-id'; readonly id: LanguageId }
  | {
      readonly ok: false;
      readonly reason: 'extension-claimed';
      readonly extension: string;
      readonly by: LanguageId;
    };

export interface LanguageRegistry {
  register(registration: LanguageRegistration): RegisterOutcome;
  /** Called once by the composition root. Afterwards register() returns `frozen`. */
  freeze(): void;
  readonly frozen: boolean;
  get(id: LanguageId): LanguageRegistration | undefined;
  /** Case-insensitive; accepts `.py` or `py`. No aliasing, no default (I6). */
  languageForExtension(extension: string): LanguageId | undefined;
  /** By the basename's last extension only: no shebang sniffing, no content inspection. */
  languageForPath(path: string): LanguageId | undefined;
  ids(): readonly LanguageId[];
}

export type GrammarBytesOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly origin: string }
  | { readonly ok: false; readonly message: string };

/** The ONLY byte channel into the parser. Implemented by the host; never throws. */
export interface GrammarSource {
  load(ref: GrammarRef): Promise<GrammarBytesOutcome>;
  describe(): string;
}

/** Which rule chose the grammar directory (C-PARSE I11), on success and on failure alike. */
export type GrammarDirVia = 'explicit' | 'CPG_GRAMMAR_DIR' | 'package-anchor';

/** `dir` is always absolute. A failure names the rule that failed; it never falls through to the next. */
export type GrammarDirOutcome =
  | { readonly ok: true; readonly dir: string; readonly via: GrammarDirVia }
  | { readonly ok: false; readonly via: GrammarDirVia; readonly message: string };

export interface GrammarDirRequest {
  readonly packageName: string;
  readonly explicit?: string;
  /** The host's environment, injected: the locator never reads `process.env` (I10). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The host's `require.resolve(`${pkg}/package.json`)`. May throw when the package is absent. */
  resolvePackageJson(pkg: string): string;
}

/** explicit > CPG_GRAMMAR_DIR > package anchor (I11). Consults no __dirname, repo root or cwd (I10). */
export type GrammarDirResolver = (request: GrammarDirRequest) => GrammarDirOutcome;

export interface GrammarProvenance {
  readonly language: LanguageId;
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly wasmFile: string;
  readonly origin: string;
  readonly bytesSha256: string;
  readonly abiVersion: number;
  readonly abiSupported: { readonly minCompatible: number; readonly languageVersion: number };
}

export interface ParseRequest {
  readonly key: DocumentKey;
  readonly text: string;
  /** Omitted: route by the key's extension. */
  readonly language?: LanguageId;
}

export type ParseErrorCode =
  | 'unsupported-language'
  | 'grammar-unavailable'
  | 'grammar-rejected'
  | 'abi-unreadable'
  | 'abi-out-of-range'
  | 'runtime-unavailable'
  | 'no-tree'
  | 'disposed';

export interface ParseError {
  readonly code: ParseErrorCode;
  /** Names the cause. grammar-unavailable names the GrammarSource (`describe()`) and its message. */
  readonly message: string;
  readonly language?: LanguageId;
  readonly key?: DocumentKey;
}

/** A syntax error is `ok: true` with `hasError: true` (I22). */
export type ParseOutcome =
  | { readonly ok: true; readonly handle: ParseHandle }
  | { readonly ok: false; readonly error: ParseError };

export interface ParseDiagnostics {
  readonly errorNodeCount: number;
  readonly missingNodeCount: number;
  /** Characters inside ERROR nodes over total characters, 0..1. */
  readonly errorSpanRatio: number;
}

export interface ParseHandle {
  readonly key: DocumentKey;
  readonly language: LanguageId;
  /** Throws HandleReleasedError after release() (I24). */
  readonly root: SyntaxNode;
  readonly rootType: string;
  readonly hasError: boolean;
  /** rootType differs from the registration's rootNodeType. */
  readonly rootTypeMismatch: boolean;
  readonly released: boolean;
  diagnostics(): ParseDiagnostics;
  /** Idempotent. */
  release(): void;
}

/** Finite by construction: an unbounded cache is unrepresentable (I25). */
export interface TreeCachePolicy {
  readonly maxRetainedTrees: number;
}

export interface ParserStats {
  readonly liveHandles: number;
  readonly cachedTrees: number;
  readonly grammarLoads: number;
  readonly debugDumpsWritten: number;
}

export interface ParseService {
  ensureReady(ids: readonly LanguageId[]): Promise<readonly ParseError[]>;
  parse(request: ParseRequest): Promise<ParseOutcome>;
  retain(key: DocumentKey): void;
  releaseDocument(key: DocumentKey): void;
  provenance(): readonly GrammarProvenance[];
  stats(): ParserStats;
  dispose(): { readonly leakedHandles: number; readonly cachedTreesReleased: number };
}
