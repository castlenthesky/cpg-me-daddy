// Which tree-sitter node types earn a graph node, and what CPG label each maps to. Kept as data
// tables (one per grammar) rather than baked into the walk in subgraph.ts, so adding a grammar or
// widening a language's coverage is a table edit, not a change to the traversal.
//
// Types recovered from the pre-rewrite `resources/queries/typescript.scm` / `python.scm` (see
// `git show f18ee71:resources/queries/typescript.scm`), which already enumerated the constructs a
// CPG cares about for these two languages.

export type CpgLabel = 'METHOD' | 'TYPE_DECL' | 'IMPORT' | 'CALL' | 'LOCAL';

const TS_JS_TABLE: Readonly<Record<string, CpgLabel>> = {
	function_declaration: 'METHOD',
	generator_function_declaration: 'METHOD',
	method_definition: 'METHOD',
	arrow_function: 'METHOD',
	class_declaration: 'TYPE_DECL',
	interface_declaration: 'TYPE_DECL',
	type_alias_declaration: 'TYPE_DECL',
	enum_declaration: 'TYPE_DECL',
	import_statement: 'IMPORT',
	call_expression: 'CALL',
	variable_declarator: 'LOCAL',
};

const PYTHON_TABLE: Readonly<Record<string, CpgLabel>> = {
	function_definition: 'METHOD',
	class_definition: 'TYPE_DECL',
	import_statement: 'IMPORT',
	import_from_statement: 'IMPORT',
	call: 'CALL',
	assignment: 'LOCAL',
};

/** Keyed by `ParsedFile.grammar` — the wasm filename `@cpg/ast-generator` loaded (see its `GRAMMAR_WASM_BY_EXTENSION`), not the file extension. */
const TABLE_BY_GRAMMAR: Readonly<Record<string, Readonly<Record<string, CpgLabel>>>> = {
	'tree-sitter-typescript.wasm': TS_JS_TABLE,
	'tree-sitter-tsx.wasm': TS_JS_TABLE,
	'tree-sitter-javascript.wasm': TS_JS_TABLE,
	'tree-sitter-python.wasm': PYTHON_TABLE,
};

/** An unrecognized grammar yields an empty table — every node is walked through but none kept, rather than throwing. */
export function significanceTableForGrammar(grammar: string): Readonly<Record<string, CpgLabel>> {
	return TABLE_BY_GRAMMAR[grammar] ?? {};
}
