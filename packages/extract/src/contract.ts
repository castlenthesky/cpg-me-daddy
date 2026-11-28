// C-EXTRACT: parse tree in, graph elements out, per file, with zero cross-file knowledge. Types only
// (check-deps rule `contract-types-only`: statement-level `import type` from @cpg/model alone, so the
// emitted JS is empty). What runs lives beside it: U6a.2-2's front door, builder, digests, seal and the
// walker's MODULE tier, and U6a.2-3's Pass A declarations; Pass B calls, imports and ref sites are U6a.2-4.
//
// Controller decision 88 (owner delegation, 2026-11-26): this file owns FileOwnedLabel, PropertyValue,
// EndpointRef, EdgeElement and the ExtractedFileSet brand, moved out of @cpg/resolve. `SyntaxNode` is
// C-PARSE's shape and `RefSite` is C-RESOLVE's, declared again here because a contract may import only
// @cpg/model; apps/cli/src/contracts-agree.test-d.ts pins each copy to its owner both ways.

import type {
  CALL_KIND,
  EdgeType,
  METHOD_KIND,
  NodeLabel,
  SourceRange,
  SymbolDescriptor,
  TYPE_DECL_KIND,
  WorkspacePath,
} from '@cpg/model';

// ── The tree (C-PARSE's shape) ──

/** 0-based row, UTF-16 code-unit column. */
export interface SyntaxPoint {
  readonly row: number;
  readonly column: number;
}

/** The read-only view of a tree node (web-tree-sitter's `Node` satisfies it). `text` is never truncated. */
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

/** C-PARSE's `LanguageId`: the grammar a tree came from (`python`, `typescript`, `tsx`, `javascript`). */
export type GrammarId = string;

// ── The request ──

/** The labels a file-owned node may carry. Naming any other label does not compile (I8). */
export type FileOwnedLabel = Exclude<
  NodeLabel,
  'DIRECTORY' | 'FILE' | 'SYMBOL' | 'COMMUNITY' | 'TAG' | 'META_DATA'
>;

/** Lets a future expression pass be additive (ND-10). */
export type Tier = 'structural' | 'expression';

export interface ExtractRequest {
  readonly path: WorkspacePath;
  readonly grammarId: GrammarId;
  readonly root: SyntaxNode;
  /** The owning file's content hash. It travels onto every element and NEVER enters an id (I6). */
  readonly revision_id: string;
  readonly lineCount: number;
  /** The expression tier is off unless asked for (I16). */
  readonly tiers?: { readonly expression?: boolean };
  /** No hidden default: an absent limit is no limit (I17). */
  readonly budget?: { readonly maxNodes?: number; readonly maxDepth?: number };
}

// ── The elements ──

/** Mirrors model's PropertyType. */
export type PropertyValue = string | number | boolean | readonly string[];

export interface NodeElement {
  readonly label: FileOwnedLabel;
  /** `makeNodeId` form, so it starts `file:<path>:` (I6). */
  readonly id: string;
  /** Always the request's path (I5). */
  readonly file: WorkspacePath;
  readonly revision_id: string;
  readonly tier: Tier;
  /** 0-based; the store's write op formats the schema's `range` string with `formatRange`. */
  readonly range: SourceRange;
  readonly nameRange?: SourceRange;
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

/** A SYMBOL, in its own channel: a per-file replace never sweeps a symbol another file points at. */
export interface SymbolElement {
  /** `makeSymbolFqn` form; unique within the file (I7). */
  readonly fqn: string;
  readonly origin: 'local' | 'external' | 'builtin';
  readonly language: string;
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

/** An edge endpoint: a node of this file by id, or a SYMBOL by fqn (cross-file travels only so, I10). */
export type EndpointRef =
  | { readonly by: 'id'; readonly label: FileOwnedLabel; readonly key: string }
  | { readonly by: 'fqn'; readonly label: 'SYMBOL'; readonly key: string };

export interface EdgeElement {
  readonly type: EdgeType;
  readonly from: EndpointRef;
  readonly to: EndpointRef;
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

// ── Ref sites (C-RESOLVE's shape) ──

/** `receiver` and `receiver-type` come from a CALL's receiver token and share its `nodeId`. */
export type RefKind = 'call' | 'import' | 'receiver' | 'receiver-type';

/** The closed enum the unresolved-rate metric groups by (05-contracts shared_vocabulary). */
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

/** One place that points at a definition: a call site, a receiver, or one bound name of an import. */
export interface RefSite {
  /** Unique per BOUND NAME: one IMPORT fans out to one site per name. */
  readonly id: string;
  /** The CALL or IMPORT node it came from; several sites may share one. */
  readonly nodeId: string;
  readonly filePath: WorkspacePath;
  readonly kind: RefKind;
  /** The token a definition provider is asked about: the LAST callee segment, the IMPORTED name (I20). */
  readonly position: { readonly row: number; readonly column: number };
  readonly nameParts: readonly string[];
  /** Present iff `kind === 'import'`. */
  readonly importBinding?: {
    /** Dotted module path as written, leading dots stripped. */
    readonly module: string;
    /** Leading-dot count of a Python relative import; 0 otherwise. */
    readonly relativeDepth: number;
    /** As the target module spells it; `*` for a wildcard; absent for a whole-module import. */
    readonly imported?: string;
    readonly local: string;
  };
  /** Why this site will produce no edge, when the extractor already knows (I12). */
  readonly declined?: ResolutionReason;
}

// ── The result ──

export interface ExtractedFile {
  readonly path: WorkspacePath;
  readonly grammarId: GrammarId;
  readonly revision_id: string;
  readonly nodes: readonly NodeElement[];
  readonly symbols: readonly SymbolElement[];
  readonly edges: readonly EdgeElement[];
  readonly refSites: readonly RefSite[];
  readonly stats: {
    readonly astNodesVisited: number;
    readonly structuralNodes: number;
    readonly expressionNodes: number;
    readonly lineCount: number;
  };
  /** A pure function of the four arrays; unchanged when only revision_id changes (I18, Q7). */
  readonly elementDigest: string;
  /** sha256 of the normalized exported surface; U7 gates the cascade on it (ND-9). */
  readonly interfaceHash: string;
}

export type ExtractErrorCode =
  | 'root-type-mismatch'
  | 'grammar-unsupported'
  | 'tier-disabled'
  | 'budget-invalid'
  | 'path-not-relative'
  | 'adapter-missing'
  | 'internal';

/** Every failure is an outcome; extract never throws (I4) and never answers an unknown grammar empty (I25). */
export type ExtractOutcome =
  | { readonly kind: 'ok'; readonly file: ExtractedFile }
  | {
      readonly kind: 'truncated';
      readonly file: ExtractedFile;
      readonly truncation: {
        readonly limit: 'maxNodes' | 'maxDepth';
        readonly limitValue: number;
        readonly droppedAtNodeType: string;
        readonly droppedRange: SourceRange;
      };
    }
  | {
      readonly kind: 'failed';
      readonly error: {
        readonly code: ExtractErrorCode;
        readonly message: string;
        readonly path: string;
      };
    };

// ── Coverage (I13, I14) ──

export type Disposition =
  | { readonly state: 'emits'; readonly fromNodeTypes: readonly string[] }
  | {
      readonly state: 'not-mine';
      readonly owner: 'filesystem-tier' | 'resolve-pass' | 'analysis-pass' | 'meta';
    }
  | {
      readonly state: 'declared-not-emitted';
      readonly reason: string;
      readonly trackingId: string;
    };

/** Total over the 14 labels and 15 edge types: silence is unrepresentable (I13). */
export interface CoverageManifest {
  readonly contractVersion: string;
  readonly grammarId: GrammarId;
  readonly nodes: Readonly<Record<NodeLabel, Disposition>>;
  readonly edges: Readonly<Record<EdgeType, Disposition>>;
}

export interface Extractor {
  readonly contractVersion: string;
  readonly grammars: readonly GrammarId[];
  coverage(grammarId: GrammarId): CoverageManifest;
  /** Synchronous and pure: no I/O (I2), deterministic (I3), never throws (I4). */
  extract(request: ExtractRequest): ExtractOutcome;
}

// ── The language adapter: salience is decided here and nowhere else ──
// The walker owns descent, scopes, ordinals, ids, SYMBOL minting and edges. An adapter only says what one
// node means, from a frozen table compiled in per grammar; `undefined` means "no node for this" (sparse
// by design). Ported from archive f18ee71:packages/engine/src/extract/adapter.ts.

export type TypeDeclKind = (typeof TYPE_DECL_KIND)[number];
export type MethodKind = (typeof METHOD_KIND)[number];
export type CallKind = (typeof CALL_KIND)[number];

/** Whose direct children are classified: a Python `def` in a class body is a method, at MODULE a function. */
export type ContainerKind = 'MODULE' | 'TYPE_DECL';

export interface ParamInfo {
  readonly name: string;
  readonly node: SyntaxNode;
  /**
   * Its 0-based position among its def's params, written as the PARAM's `ordinal`. A param the adapter
   * dropped for a MISSING or empty name still holds its position (decision 114), so the ordinals of
   * a def's params can skip a number.
   */
  readonly ordinal: number;
  readonly typeText?: string;
  readonly defaultText?: string;
}

export interface TypeDeclInfo {
  readonly declares: 'TYPE_DECL';
  readonly name: string;
  readonly kind: TypeDeclKind;
  readonly exported: boolean;
  readonly structural: boolean;
  readonly docstringHead?: string;
  /** Its own body, whose direct children are classified with container `TYPE_DECL`. */
  readonly body: SyntaxNode | undefined;
  /**
   * The ERROR nodes directly under the class node outside its body (its header), in source order;
   * absent when there are none. Each is one UNKNOWN in this TYPE_DECL's scope, before its body's
   * children (decision 117).
   */
  readonly headerErrors?: readonly SyntaxNode[];
}

export interface MethodInfo {
  readonly declares: 'METHOD';
  readonly name: string;
  /** The name token: the METHOD's nameRange, written as `name_range` (decision 113). */
  readonly nameNode?: SyntaxNode;
  readonly kind: MethodKind;
  readonly signature: string;
  readonly exported: boolean;
  readonly async: boolean;
  readonly docstringHead?: string;
  readonly params: readonly ParamInfo[];
  /** The region Pass B descends for CALLs. Nested named declarations in it are not descended (decision 92). */
  readonly body?: SyntaxNode;
}

export interface MemberInfo {
  readonly declares: 'MEMBER';
  readonly name: string;
  readonly typeText?: string;
  readonly visibility?: string;
  /** Its initializer, an expression region of its own. */
  readonly value?: SyntaxNode;
}

export type DeclarationInfo = TypeDeclInfo | MethodInfo | MemberInfo;

/** One call argument; `identifier` is set only for a bare name (REACHING_DEF's one match shape). */
export interface ArgInfo {
  readonly node: SyntaxNode;
  readonly identifier?: string;
}

/**
 * One call site as syntax. The adapter does not attribute it (the archive's resolveCallee is REMOVED,
 * U6a.2): the walker resolves a bare name bound in this file and emits a RefSite for every other bound
 * name (controller decision 93, sprint U6a.2-4, which may extend this shape additively).
 */
export interface CallInfo {
  readonly emits: 'CALL';
  readonly kind: CallKind;
  /** `CALL.callee_name`: the last callee segment (`greet` in `g.greet()`). */
  readonly calleeName: string;
  /** `CALL.receiver_text`: the receiver as written; absent for a bare-name call. */
  readonly receiverText?: string;
  /** The callee chain, outermost first (`['g', 'greet']`); empty for a computed callee. */
  readonly nameParts: readonly string[];
  /** The last segment's token, where a ref site points (I20); absent for a computed callee. */
  readonly nameNode?: SyntaxNode;
  /** The receiver's token, for its receiver site (declined `receiver-unknown` in v1, I12). */
  readonly receiverNode?: SyntaxNode;
  readonly args: readonly ArgInfo[];
  /**
   * The adapter's builtin table's answer for a bare callee (U6a.2-4a, additive per decision 93): the
   * walker mints this external SYMBOL and a CALLS `external` edge only when no top-level declaration
   * of this file binds the name (I11: external only from the adapter's builtin table).
   */
  readonly builtin?: BuiltinTarget;
}

/** A builtin's SYMBOL, as `makeSymbolFqn`'s external parts (archive builtins/python-stdlib.ts). */
export interface BuiltinTarget {
  readonly scheme: string;
  readonly package: string;
  readonly descriptors: readonly SymbolDescriptor[];
}

/** One name an import statement binds: one `import` ref site (I20). */
export interface ImportBindingInfo {
  /** The imported name's token, never the alias: where the ref site points (I20). */
  readonly nameNode: SyntaxNode;
  /** The imported name's segments (`['os', 'path']`, `['helper']`, `['*']`). */
  readonly nameParts: readonly string[];
  /** The ref site's `importBinding`, as RefSite defines it. */
  readonly binding: NonNullable<RefSite['importBinding']>;
  /** Whether the name is part of the file's exported surface when the import is module-level (decision 94). */
  readonly exported: boolean;
}

/** One import statement as syntax (BMO-134): one IMPORT node, one ref site per binding. */
export interface ImportInfo {
  readonly emits: 'IMPORT';
  /** `IMPORT.source_text`: the module the statement names. */
  readonly sourceText: string;
  /** `IMPORT.imported_names`: the names it takes from that module, as the module spells them. */
  readonly importedNames: readonly string[];
  /** `IMPORT.alias`: absent unless the adapter's rule gives one. */
  readonly alias?: string;
  /** `IMPORT.is_type_only`. */
  readonly typeOnly: boolean;
  /** In source order. */
  readonly bindings: readonly ImportBindingInfo[];
}

/** Pass B's verdict on one node of an expression region; `undefined` means descend ordinarily. */
export type ExpressionVerdict =
  | CallInfo
  | ImportInfo
  | { readonly emits: 'none'; readonly descend: 'transparent' }
  | { readonly emits: 'none'; readonly descend: 'stop' };

export interface LanguageAdapter {
  readonly grammarId: GrammarId;
  /** `SYMBOL.language`: a `.tsx` file's adapter still reports `typescript`. */
  readonly language: string;
  /** The grammar's root node type for a whole file (`module`, `program`). */
  readonly moduleRootType: string;
  /** The MODULE's `name` (`main.py` -> `main`). Its id scope is always `$root` (decision 92). */
  moduleName(path: WorkspacePath): string;
  classify(node: SyntaxNode, container: ContainerKind): DeclarationInfo | undefined;
  classifyExpression?(node: SyntaxNode): ExpressionVerdict | undefined;
  /** Every name a region binds locally, so REACHING_DEF can shadow an outer binding. */
  localBindings?(regionRoot: SyntaxNode): readonly string[] | undefined;
  /**
   * A compound statement (Python's if/for/while/try/with/match, stop-list 196): the nodes the walker
   * visits in its place, in source order, as children of the same container one level deeper: each
   * clause body's statements and every other part of it. Not a scope, so it changes no id frame.
   * `undefined` for any other node.
   */
  compoundChildren?(node: SyntaxNode): readonly SyntaxNode[] | undefined;
  coverage(): CoverageManifest;
}

// ── The sealed set: resolution is a pass over every file, after every file is extracted (L-20, L-44) ──

/** Not exported: only `sealExtractedFiles` (U6a.2-2) can mint an ExtractedFileSet. */
declare const SEALED: unique symbol;

export interface ExtractedFileSet {
  readonly [SEALED]: true;
  readonly files: ReadonlyMap<WorkspacePath, ExtractedFile>;
  /** Every file's ref sites, in (path, site id) order. */
  readonly refSites: readonly RefSite[];
}

export type SealOutcome =
  | { readonly kind: 'ok'; readonly set: ExtractedFileSet }
  | { readonly kind: 'failed'; readonly duplicatePaths: readonly string[] };

/** `sealExtractedFiles`' signature, for its implementation to satisfy. */
export type SealExtractedFiles = (files: Iterable<ExtractedFile>) => SealOutcome;

/** A resolve pass takes only a sealed set: "resolve while still walking" does not typecheck. */
export type ResolvePassEntry = (set: ExtractedFileSet) => unknown;
