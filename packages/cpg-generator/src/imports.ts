import type { AstNode } from '@cpg/ast-generator';
import type { SourceRange } from '@cpg/graph-visualizer/dist/contract';

/** One name an import statement binds. */
export interface ImportBinding {
	/** Name bound in the importing file: `b` for `from m import a as b`, `osp` for `import os.path as osp`. */
	local: string;
	/** Name as the *target module* spells it: `a`. `'*'` for a wildcard. `undefined` for a whole-module import (`import os`), which binds the module rather than a name inside it. */
	imported?: string;
	/**
	 * Range of the token to ask a definition provider about — the **imported**
	 * token, never the local alias. `b` in `from m import a as b` resolves to
	 * itself; only `a` resolves into the target module.
	 */
	range: SourceRange;
}

export interface ImportSpec {
	/** Dotted module path as written, leading dots stripped. `''` for a bare `from . import x`. */
	module: string;
	/** Range of the module specifier, for a future `IMPORT -> FILE` edge. Absent when there is no module token (`from . import x`). */
	moduleRange?: SourceRange;
	/** Leading-dot count for a Python relative import; `0` for absolute, and for every TS/JS import today. */
	relativeDepth: number;
	bindings: ImportBinding[];
	/** `from m import *` — `bindings` is empty and the target set is not knowable syntactically. */
	wildcard: boolean;
}

const PYTHON_GRAMMAR = 'tree-sitter-python.wasm';

/**
 * Pulls the module specifier and bound names out of an import statement.
 *
 * The parse rule is "split the children at the child whose `type` is
 * `import`": everything before that keyword is the module part, everything
 * after it is a binding. Verified against real parser output for
 * `from my_module import generate_greeting`, whose children are exactly
 * `from` / `dotted_name`@0:5 / `import`@0:15 / `dotted_name`@0:22.
 *
 * That rule is why this needs no tree-sitter field names — which matters,
 * because `@cpg/ast-generator`'s `nodeToAst` drops them, and teaching it to
 * keep them would double the cost of the hot loop in the activation-time pass
 * for no gain here. Anonymous keyword children (`from`, `import`, `(`, `.`)
 * *are* present in `node.children`, so the keyword is findable and the
 * punctuation is skippable by type.
 *
 * Returns `undefined` for a shape this grammar's extractor doesn't recognize —
 * never throws. An unrecognized import degrades to the old behavior (a node
 * with no specifier) rather than costing the file its whole subgraph.
 */
export function importSpecFor(node: AstNode, grammar: string): ImportSpec | undefined {
	if (grammar !== PYTHON_GRAMMAR) {
		// SEAT — TypeScript/JavaScript. Their `import_statement` carries a
		// `string` specifier child and an `import_clause`, so the same
		// split-on-keyword shape applies, but `string_content` leaf text is
		// truncated to 40 chars upstream (`SNIPPET_MAX_LENGTH`), which silently
		// corrupts a long specifier like '@company/some/deeply/nested/path'.
		// That truncation has to be exempted for load-bearing leaf types first.
		return undefined;
	}
	if (node.type === 'import_statement') {
		return { module: '', relativeDepth: 0, wildcard: false, bindings: bindingsAfterKeyword(node, true) };
	}
	if (node.type === 'import_from_statement') {
		const children = node.children ?? [];
		const keywordIndex = children.findIndex((child) => child.type === 'import');
		const modulePart = keywordIndex > 0 ? children.slice(0, keywordIndex).find(isModulePart) : undefined;
		const bindings = bindingsAfterKeyword(node, false);
		return {
			module: modulePart ? moduleNameOf(modulePart) : '',
			...(modulePart && modulePart.type !== 'relative_import' ? { moduleRange: rangeOf(modulePart) } : {}),
			relativeDepth: modulePart ? relativeDepthOf(modulePart) : 0,
			wildcard: (node.children ?? []).some((child) => child.type === 'wildcard_import'),
			bindings,
		};
	}
	return undefined;
}

/** Bindings are every `dotted_name`/`aliased_import` after the `import` keyword; commas and parens are skipped by type. */
function bindingsAfterKeyword(node: AstNode, wholeModule: boolean): ImportBinding[] {
	const children = node.children ?? [];
	const keywordIndex = children.findIndex((child) => child.type === 'import');
	if (keywordIndex === -1) {
		return [];
	}
	const bindings: ImportBinding[] = [];
	for (const child of children.slice(keywordIndex + 1)) {
		if (child.type === 'dotted_name') {
			const name = moduleNameOf(child);
			if (!name) {
				continue;
			}
			bindings.push(
				wholeModule
					? // `import os.path` binds the *module*, and the name a later
						// reference uses is its first segment (`os`).
						{ local: name.split('.')[0], range: rangeOf(child) }
					: { local: name, imported: name, range: rangeOf(child) }
			);
		} else if (child.type === 'aliased_import') {
			const parts = child.children ?? [];
			const source = parts.find((part) => part.type === 'dotted_name');
			const alias = parts.filter((part) => part.type === 'identifier').pop();
			if (!source || !alias?.text) {
				continue;
			}
			const name = moduleNameOf(source);
			bindings.push({
				local: alias.text,
				...(wholeModule ? {} : { imported: name }),
				// The imported token, not the alias — see `ImportBinding.range`.
				range: rangeOf(source),
			});
		}
	}
	return bindings;
}

function isModulePart(node: AstNode): boolean {
	return node.type === 'dotted_name' || node.type === 'relative_import';
}

/** `dotted_name` has no `text` of its own (only leaves do), so its segments are joined — the `.` tokens are themselves leaves and come along. */
function moduleNameOf(node: AstNode): string {
	if (node.type === 'relative_import') {
		const inner = (node.children ?? []).find((child) => child.type === 'dotted_name');
		return inner ? moduleNameOf(inner) : '';
	}
	return collectLeafText(node).join('');
}

/** Leading-dot count: `from ..pkg import x` is depth 2. The dots are leaves under `import_prefix`. */
function relativeDepthOf(node: AstNode): number {
	if (node.type !== 'relative_import') {
		return 0;
	}
	const prefix = (node.children ?? []).find((child) => child.type === 'import_prefix');
	if (!prefix) {
		return 0;
	}
	return collectLeafText(prefix).join('').split('').filter((character) => character === '.').length;
}

function collectLeafText(node: AstNode): string[] {
	if (!node.children || node.children.length === 0) {
		return node.text ? [node.text] : [];
	}
	return node.children.flatMap(collectLeafText);
}

function rangeOf(node: AstNode): SourceRange {
	return {
		startRow: node.startPosition.row,
		startColumn: node.startPosition.column,
		endRow: node.endPosition.row,
		endColumn: node.endPosition.column,
	};
}
