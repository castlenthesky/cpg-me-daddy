// Zero imports, deliberately — same rule `changes.ts` follows in
// @cpg/file-watcher and `contract.ts` follows in @cpg/graph-visualizer. It
// matters more here than it did for `WatchBackend`, because the reason is
// structural rather than stylistic: the only resolver that can answer
// precisely calls `vscode.executeDefinitionProvider`, and the `vscode` module
// is not importable from `packages/*` at all. So the real implementation is
// *forced* to live in the extension host (`src/resolve/
// vscodeDefinitionResolver.ts`) and arrive through this seam.
//
// The payoff is not just layering. Because everything on this side of the seam
// is plain Node, the hard part — turning a definition location into a stable
// symbol identity — can be driven by a fake resolver in a throwaway `node`
// script with no VS Code running at all. That is the same trick that made
// `WatchBackend` testable with a fake backend, and it's why the seam is worth
// having before there is anything real behind it.

/** A position in a file. Rows are zero-based and columns are UTF-16 code units — identical to `vscode.Position`, so no conversion is needed at the host boundary. */
export interface RefPosition {
	row: number;
	column: number;
}

/**
 * Which kind of reference a site is. Narrower than the eight kinds R2
 * enumerates: these are the four `toSubgraph`/`collectReferenceSites` emit
 * today. `receiver` and `receiver-type` both come from a `CALL` node's
 * receiver token (`data.receiverRange`) and always share that node's
 * `nodeId`, unlike `call` and `import` which each own a node: `receiver`
 * asks *where the receiver is bound* (→ a `RECEIVER` edge to that binding),
 * `receiver-type` asks *what its type is* (→ an `EVAL_TYPE` edge to the
 * type's symbol). Widening further is additive.
 */
export type RefKind = 'call' | 'import' | 'receiver' | 'receiver-type';

/**
 * One place in the source that points at a definition somewhere — a call site
 * or a single import binding.
 *
 * `position` is the crux and the easiest thing to get wrong. It must be the
 * *exact token a definition provider should be asked about*, which is **not**
 * the construct's extent and **not** necessarily its `nameRange`:
 *
 * - For a call, `nameRange` covers the whole callee subtree, so for
 *   `greeter.greet()` it starts on `greeter` — asking there resolves the local
 *   variable, not the method. It has to be the *last* segment (`greet`).
 * - For an import, it must be the imported name as the target module spells it
 *   (`a` in `from m import a as b`), never the local alias — an alias resolves
 *   to itself.
 */
export interface RefSite {
	/**
	 * Unique per site, and the key a `Resolution` answers by. Usually equal to
	 * `nodeId`, but **one `IMPORT` statement fans out to one site per bound
	 * name** (`from m import a, b`), and those must be resolvable independently.
	 */
	id: string;
	/** The graph node this reference came from — the `CALL` or `IMPORT` node, and the `source` of any edge minted for it. Several sites can share one. */
	nodeId: string;
	/** Absolute path of the file the reference lives in. */
	filePath: string;
	kind: RefKind;
	position: RefPosition;
	/** `['greeter','greet']` / `['generate_greeting']` — what a syntactic resolver needs when no language server answers. */
	nameParts: readonly string[];
	/** Present iff `kind === 'import'`. One `RefSite` per binding, so this describes that one binding. */
	importBinding?: ImportBindingRef;
}

export interface ImportBindingRef {
	/** Dotted module path as written, with leading dots stripped (`''` for a bare `from . import x`). */
	module: string;
	/** Leading-dot count for a Python relative import; `0` for absolute and for TS/JS. */
	relativeDepth: number;
	/** Name as the target module spells it. `'*'` for a wildcard; `undefined` for a whole-module import (`import os`). */
	imported?: string;
	/** Name bound in the importing file. */
	local: string;
}

/** Where a definition lives. Produced by a `Resolver`, consumed by whatever maps a location back to the graph node that owns it. */
export interface DefinitionSite {
	filePath: string;
	/** The definition's name token, when the resolver could narrow to it; otherwise the construct's extent. */
	position: RefPosition;
}

/**
 * Vocabulary kept verbatim from the schema this project already ratified, so
 * the two don't fork: a reference is `resolved` (one definition), `ambiguous`
 * (several, none preferred), `external` (resolved, but outside the indexed
 * workspace — a builtin or a third-party package), `unresolved` (nothing
 * answered) or `dynamic` (resolvable only at runtime).
 */
export type ResolutionStatus = 'resolved' | 'ambiguous' | 'external' | 'unresolved' | 'dynamic';

/** Enumerable codes rather than free text, because this is the dimension an unresolved-rate metric groups by. */
export type ResolutionReason =
	| 'no-definition'
	| 'receiver-unknown'
	| 'name-not-exported'
	| 'module-not-found'
	| 'reexport-depth'
	/** `import os` binds a *module*, not a name inside one, and modules aren't modelled as symbols. */
	| 'module-binding'
	/** `from m import *` binds a set that cannot be enumerated syntactically. */
	| 'wildcard'
	| 'truncated-subgraph'
	| 'provider-error'
	| 'builtin'
	| 'self'
	| 'not-warm'
	| 'no-resolver';

export interface Resolution {
	/** The `RefSite.id` this answers. */
	refId: string;
	status: ResolutionStatus;
	/**
	 * Where the definition lives, when the resolver only knows a *location* —
	 * which is all a language server reports. The caller maps it to a symbol via
	 * `DefinitionLookup.symbolAt`.
	 *
	 * Set iff `status` is `resolved` or `ambiguous`. Absent for `external`: an
	 * external definition is outside the graph by construction, so there is no
	 * node to point at.
	 */
	definition?: DefinitionSite;
	/**
	 * The resolved symbol, when the resolver already knows it — a resolver that
	 * worked *through* the definition index (rather than being handed a raw
	 * position) has the fqn in hand, and making it re-derive one from a position
	 * it just looked up would be a pointless round trip.
	 *
	 * A resolution may carry `target`, `definition`, or both. `target` wins.
	 */
	target?: { fqn: string; filePath?: string };
	/** `Resolver.id` of the link that produced this, mirrored onto the edge so provenance is inspectable per edge rather than per run. */
	resolvedBy: string;
	/** 1.0 = exact-position language-server hit · 0.8 = via a stub or re-export hop · 0.6 = filesystem probe · 0.5 = ambiguous. */
	confidence: number;
	reason?: ResolutionReason;
}

/** Structural subset of `vscode.CancellationToken`, so a caller can pass one through without this package importing `vscode`. */
export interface CancellationLike {
	readonly isCancellationRequested: boolean;
}

/**
 * Answers "is there a definition at this position / by this name, in a file we
 * actually indexed?" — implemented by `@cpg/graph-builder`'s `GraphBuilder`,
 * which already owns the per-file lifecycle this has to follow.
 *
 * Declared here rather than imported from there on purpose: TypeScript is
 * structurally typed, so `GraphBuilder` satisfies this without importing it,
 * and `@cpg/graph-builder` keeps its rule of depending only on the render
 * contract (see that package's AGENTS.md "Gotchas"). A resolver is handed a
 * lookup, never the graph.
 */
export interface DefinitionLookup {
	/**
	 * The fqn of the symbol defined at this position — the definition whose name
	 * token starts exactly here, or that most tightly encloses it.
	 *
	 * Returning the *symbol* rather than the AST node is what makes the answer
	 * usable: an AST node id is positional and will change on the defining
	 * file's next re-parse, whereas the fqn is what an edge can safely point at.
	 * Reading the definition's own already-minted fqn (instead of rebuilding one
	 * from the reference's name) is also the only way to tell two same-named
	 * functions in one scope apart.
	 */
	symbolAt(filePath: string, row: number, column: number): string | undefined;
	/** The fqn of a module-level symbol by simple name — what a filesystem resolver asks once it has picked a module file but has no position to offer. */
	symbolNamed(filePath: string, name: string): string | undefined;
	/** Whether a symbol node currently exists for this fqn. An edge to an absent id renders as nothing, which would hide the bug rather than show it. */
	hasSymbol(fqn: string): boolean;
	/** Whether this file was parsed into the graph at all. Distinguishes "no definition there" from "we never looked", which is the difference between `unresolved` and `external`. */
	isIndexed(filePath: string): boolean;
}

export interface ResolverWorkspace {
	rootPath: string;
	definitions: DefinitionLookup;
}

/**
 * Answers *where* a reference points — never *what it is called*. Symbol
 * identity stays on the graph side of this seam, deliberately, so swapping a
 * resolver can never change a symbol id and therefore can never invalidate
 * cross-file edges that other files already point at.
 *
 * Batch-shaped (one call per file, array in / array out) because the only
 * precise implementation is a language-server round trip per site. A per-site
 * interface would push "how many of these may be in flight at once" into every
 * caller, and there are two of them (the workspace pass and the per-save
 * pipeline).
 *
 * Every site gets a `Resolution` back, in order. A site that cannot be
 * answered is `status: 'unresolved'` — not a thrown error and not a dropped
 * entry. An unanswerable reference is the *normal* case (a builtin, a
 * third-party package, a language with no server installed), and a caller
 * forced to reconcile a short array against its own input will get it wrong.
 */
export interface Resolver {
	/** Stable identifier, recorded on every edge this resolver produces. */
	readonly id: string;
	readonly precision: 'syntactic' | 'checker' | 'index';
	open(workspace: ResolverWorkspace): Promise<void>;
	/** `null` text means the file was deleted. Used to drop caches; a resolver with none can ignore it. */
	fileChanged(filePath: string, text: string | null): Promise<void>;
	resolve(filePath: string, refs: readonly RefSite[], token?: CancellationLike): Promise<Resolution[]>;
	close(): Promise<void>;
}

/** Convenience for the common "couldn't answer" shape, so every resolver spells it identically. */
export function unresolved(ref: RefSite, resolvedBy: string, reason: ResolutionReason): Resolution {
	return { refId: ref.id, status: 'unresolved', resolvedBy, confidence: 0, reason };
}
