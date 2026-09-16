import type { NodeLocation } from '@cpg/graph-visualizer/dist/contract';

/**
 * A cross-file symbol: one name, identified by *what it is* rather than *where
 * it sits*.
 *
 * `fqn` doubles as the `SYMBOL` node's id. That is the whole mechanism behind
 * cross-file edges surviving a save: an AST node id is
 * `` `${filePath}::ast::${ordinal}` ``, which shifts whenever anything earlier
 * in the file changes, so an edge pointing straight at a `METHOD` would be
 * dropped on the next re-parse of the defining file with nothing to re-add it
 * (`GraphDelta` has no `removedEdgeIds`). An fqn is derived from the file path
 * and the enclosing declaration names only — no ordinal, no range, no content
 * hash — so a re-parse re-attaches the new `METHOD` to the *same* symbol and
 * nobody else's edge is touched.
 */
export interface CpgSymbol {
	/** Also the `SYMBOL` node's id. See the note above. */
	fqn: string;
	/** Trailing descriptor only, e.g. `generate_greeting()` — a display label, never a path. */
	name: string;
	/** Set only by the file that defines the symbol, so clicking it can jump to the definition. */
	location?: NodeLocation;
}

/** Descriptor kinds we mint today. SCIP also defines term/type-parameter/parameter/meta/macro; those are reserved, not emitted. */
export type DescriptorKind = 'type' | 'method';

// A bare SCIP name needs no escaping; anything else is backtick-wrapped with
// inner backticks doubled.
const BARE_NAME = /^[A-Za-z0-9_+$-]+$/;

/**
 * SCIP's escaping rule, applied to one descriptor name.
 *
 * Worth keeping even though almost every Python/TS identifier is already bare:
 * a file path is also a descriptor name here, and paths routinely contain `.`,
 * `/` and spaces.
 */
export function escapeScipName(name: string): string {
	return BARE_NAME.test(name) ? name : `\`${name.replace(/`/g, '``')}\``;
}

/**
 * One descriptor, in SCIP's grammar: `Type#` for a type, `name().` for a
 * method. `disambiguator` renders as `name(+1).` — used only when one scope
 * declares the same name twice (Python rebinding a `def`), never as a general
 * ordinal, because an ordinal is exactly the positional instability this
 * scheme exists to avoid.
 */
export function encodeDescriptor(kind: DescriptorKind, name: string, disambiguator?: number): string {
	const escaped = escapeScipName(name);
	if (kind === 'type') {
		return `${escaped}#`;
	}
	return disambiguator && disambiguator > 0 ? `${escaped}(+${disambiguator}).` : `${escaped}().`;
}

/**
 * The file's own namespace descriptor — the fqn's first segment and the reason
 * a symbol id can never be mistaken for anything else in the payload.
 *
 * Ids in a payload are disjoint **on their first character**: a file or
 * directory id is an absolute path (`/`), an AST node id is an absolute path
 * plus `::ast::N` (`/`), the visualizer's synthetic layout root starts with a
 * space, and a symbol id starts with a backtick. So `isSymbolId` is a single
 * character comparison rather than a substring scan.
 *
 * The path is workspace-relative and POSIX-separated so an fqn survives moving
 * the checkout and reads the same on every platform. Multi-root workspaces
 * would collide here — two folders each containing `src/my_module.py` produce
 * the same fqn — which is safe today only because `extension.ts` takes
 * `workspaceFolders[0]` and ignores the rest.
 */
export function fileNamespace(workspaceRelativePath: string): string {
	return `${escapeScipName(toPosix(workspaceRelativePath))}/`;
}

/** `` `src/my_module.py`/ `` + `generate_greeting().` → the full symbol id. */
export function buildFqn(workspaceRelativePath: string, descriptors: readonly string[]): string {
	return fileNamespace(workspaceRelativePath) + descriptors.join('');
}

/** Whether an id in a payload is a `SYMBOL` id. See `fileNamespace` for why one character is enough. */
export function isSymbolId(id: string): boolean {
	return id.charCodeAt(0) === 96; // '`'
}

function toPosix(path: string): string {
	return path.replace(/\\/g, '/');
}
