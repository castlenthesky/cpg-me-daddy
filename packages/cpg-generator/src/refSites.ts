// Value import, not type-only — unlike the rest of this package's imports from
// `@cpg/graph-visualizer`. Safe for the same reason `GraphViewProvider` does it
// host-side: `contract.ts` has zero imports of its own, so reaching it directly
// never pulls in the DOM-typed barrel or `@cosmos.gl/graph`. `nodeLocation` is
// the sanctioned reader of `data.location`, and duplicating its shape knowledge
// here is exactly what it exists to prevent.
import { nodeLocation } from '@cpg/graph-visualizer/dist/contract';
import type { GraphNode, SourceRange } from '@cpg/graph-visualizer/dist/contract';
import type { ImportSpec } from './imports';
import type { RefKind, RefPosition, RefSite } from './resolve';

/** `CpgLabel`s that denote a reference to something defined elsewhere, mapped to the `RefKind` a resolver understands. */
const REFERENCE_KINDS: Record<string, RefKind> = { CALL: 'call', IMPORT: 'import' };

/**
 * Turns the `CALL`/`IMPORT` nodes of an already-built payload into the
 * `RefSite`s a `Resolver` takes.
 *
 * Reads finished graph nodes rather than the AST on purpose: resolution runs as
 * a pass over the *complete* graph, after every file has been parsed, because a
 * call in the first file walked can target a definition in the last. Collecting
 * from the payload is what makes that ordering expressible — and it means this
 * function is equally usable for the whole workspace and for one re-parsed
 * file, which are the two callers it has.
 */
export function collectReferenceSites(nodes: readonly GraphNode[]): RefSite[] {
	const sites: RefSite[] = [];
	for (const node of nodes) {
		const kind = REFERENCE_KINDS[node.type];
		if (!kind) {
			continue;
		}
		const location = nodeLocation(node);
		if (!location) {
			continue;
		}
		if (kind === 'import') {
			sites.push(...importSites(node, location.filePath));
			continue;
		}
		sites.push({
			id: node.id,
			nodeId: node.id,
			filePath: location.filePath,
			kind,
			position: referencePosition(node, location.range, location.nameRange),
			nameParts: nameParts(node),
		});
		sites.push(...receiverSites(node, location.filePath));
	}
	return sites;
}

/**
 * Two extra sites for a call's receiver (`greeter` of `greeter.greet()`),
 * both at the receiver's own token — never the call's `refRange` token —
 * and both sharing the `CALL` node's `nodeId`, since a `RECEIVER`/`EVAL_TYPE`
 * edge hangs off the same node a `CALLS` edge does.
 *
 * Two sites rather than one: `executeDefinitionProvider` and
 * `executeTypeDefinitionProvider` are two separate round trips regardless,
 * they fail independently (a parameter-bound receiver has a useless
 * definition but a useful type; `self` is the mirror image), and splitting
 * them keeps `Resolution` — one definition, one target — unchanged, rather
 * than letting `ChainResolver` stop a site's chain with only one half
 * answered (`chain.ts`'s "first answer wins" composition).
 *
 * Absent whenever `subgraph.ts` didn't emit `data.receiverRange` — a
 * bare-name call, or a receiver that isn't unambiguously a name/name-chain
 * (`f(x).g()`, `a[0].g()`).
 */
function receiverSites(node: GraphNode, filePath: string): RefSite[] {
	const receiverRange = node.data?.receiverRange;
	if (!isSourceRangeLike(receiverRange)) {
		return [];
	}
	const position = { row: receiverRange.startRow, column: receiverRange.startColumn };
	// The receiver's own parts, e.g. `['greeter']` of `greeter.greet` or
	// `['a','b']` of `a.b.c()` — every segment but the callee's own last one.
	const parts = nameParts(node).slice(0, -1);
	return [
		{ id: `${node.id}#recv`, nodeId: node.id, filePath, kind: 'receiver', position, nameParts: parts },
		{ id: `${node.id}#type`, nodeId: node.id, filePath, kind: 'receiver-type', position, nameParts: parts },
	];
}

/**
 * One site per bound name, not one per statement — `from m import a, b` is two
 * independent references that can resolve differently (or one succeed and one
 * fail), so collapsing them would make either outcome unrepresentable.
 *
 * All of them share the statement's `nodeId`, because the `IMPORT` node is what
 * an edge hangs off; only `id` distinguishes them.
 *
 * Each site's position is the **imported** token, from the spec — never the
 * statement's own start (which names no symbol) and never a local alias (which
 * resolves to itself).
 */
function importSites(node: GraphNode, filePath: string): RefSite[] {
	const spec = node.data?.import as ImportSpec | undefined;
	if (!spec || spec.bindings.length === 0) {
		return [];
	}
	return spec.bindings.map((binding, index) => ({
		id: `${node.id}#${index}`,
		nodeId: node.id,
		filePath,
		kind: 'import' as const,
		position: { row: binding.range.startRow, column: binding.range.startColumn },
		nameParts: binding.imported ? [binding.imported] : [binding.local],
		importBinding: {
			module: spec.module,
			relativeDepth: spec.relativeDepth,
			...(binding.imported ? { imported: binding.imported } : {}),
			local: binding.local,
		},
	}));
}

/**
 * The token a definition provider should actually be asked about.
 *
 * Prefers `data.refRange` when a producer supplied one, because for a call
 * `nameRange` is the *whole callee subtree*: for `greeter.greet()` it starts on
 * `greeter`, so asking there resolves the local variable rather than the
 * method. (Measured on the demo workspace: 2 of 6 calls in `src/sample.py` are
 * dotted, so this is a one-in-three error, not a corner case.)
 *
 * `subgraph.ts` does not emit `refRange` yet, so today this falls back to
 * `nameRange` — correct for bare-name calls and for every import, wrong for
 * dotted calls. Reading the precise field first means the fix is additive over
 * there and needs no change here.
 */
function referencePosition(node: GraphNode, range: SourceRange, nameRange: SourceRange | undefined): RefPosition {
	const refRange = node.data?.refRange;
	if (isSourceRangeLike(refRange)) {
		return { row: refRange.startRow, column: refRange.startColumn };
	}
	const chosen = nameRange ?? range;
	return { row: chosen.startRow, column: chosen.startColumn };
}

/** `'greeter.greet'` → `['greeter','greet']`. What a syntactic resolver needs when no language server answers. */
function nameParts(node: GraphNode): readonly string[] {
	return node.name ? node.name.split('.').filter((part) => part.length > 0) : [];
}

function isSourceRangeLike(value: unknown): value is SourceRange {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return typeof candidate.startRow === 'number' && typeof candidate.startColumn === 'number';
}
