import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { Language, Node, Parser } from 'web-tree-sitter';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, 'out', 'ast');

const SNIPPET_MAX_LENGTH = 40;

const GRAMMAR_WASM_BY_EXTENSION: Readonly<Record<string, string>> = {
	'.ts': 'tree-sitter-typescript.wasm',
	'.mts': 'tree-sitter-typescript.wasm',
	'.cts': 'tree-sitter-typescript.wasm',
	'.tsx': 'tree-sitter-tsx.wasm',
	'.js': 'tree-sitter-javascript.wasm',
	'.jsx': 'tree-sitter-javascript.wasm',
	'.mjs': 'tree-sitter-javascript.wasm',
	'.cjs': 'tree-sitter-javascript.wasm',
	'.py': 'tree-sitter-python.wasm',
};

export interface AstNode {
	type: string;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	text?: string;
	children?: AstNode[];
}

export interface ParsedFile {
	filePath: string;
	grammar: string;
	root: AstNode;
	sExpression: string;
}

/** Whether `dumpAst`/`parseFile` has a grammar for this path's extension — check before calling either to avoid a thrown error for routine unsupported files. */
export function isSupportedExtension(filePath: string): boolean {
	return GRAMMAR_WASM_BY_EXTENSION[extname(filePath).toLowerCase()] !== undefined;
}

function wasmFileForPath(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	const wasmFile = GRAMMAR_WASM_BY_EXTENSION[ext];
	if (wasmFile === undefined) {
		throw new Error(
			`No tree-sitter grammar registered for extension '${ext}'. Known extensions: ${Object.keys(GRAMMAR_WASM_BY_EXTENSION).join(', ')}.`,
		);
	}
	return wasmFile;
}

/**
 * `@vscode/tree-sitter-wasm` declares no `exports` field, so every subpath is
 * resolvable — anchoring on its `package.json` (rather than a `__dirname`
 * walk) resolves the same way whether this module runs from `src/` (ts-node)
 * or `dist/` (compiled).
 */
function resolveGrammarDir(): string {
	const packageJsonPath = require.resolve('@vscode/tree-sitter-wasm/package.json');
	return join(dirname(packageJsonPath), 'wasm');
}

// `Parser.init()` and `Language.load()` are both one-time setup costs that the
// original one-file-per-process CLI could afford to pay on every call. A
// whole-workspace parse (ParseWorkspace's AST pass) calls `parseFile` once per
// source file, so paying them per file means re-reading and re-compiling the
// same few megabytes of wasm hundreds of times — and leaking a fresh wasm
// `Language` each time. Memoized by promise (not by resolved value) so
// concurrent callers share one in-flight load rather than racing to start
// their own.
let parserInit: Promise<void> | undefined;
const languageByWasmFile = new Map<string, Promise<Language>>();

function initParser(): Promise<void> {
	parserInit ??= Parser.init();
	return parserInit;
}

function loadLanguage(wasmFile: string): Promise<Language> {
	let language = languageByWasmFile.get(wasmFile);
	if (!language) {
		language = readFile(join(resolveGrammarDir(), wasmFile)).then((bytes) => Language.load(new Uint8Array(bytes)));
		// A failed load must not be cached — the next call should retry rather
		// than replay the same rejection forever.
		language.catch(() => languageByWasmFile.delete(wasmFile));
		languageByWasmFile.set(wasmFile, language);
	}
	return language;
}

function truncate(text: string): string {
	return text.length <= SNIPPET_MAX_LENGTH ? text : `${text.slice(0, SNIPPET_MAX_LENGTH - 3)}...`;
}

function nodeToAst(node: Node, source: string): AstNode {
	const base = {
		type: node.type,
		startPosition: node.startPosition,
		endPosition: node.endPosition,
	};

	if (node.childCount === 0) {
		return { ...base, text: truncate(source.slice(node.startIndex, node.endIndex)) };
	}

	return { ...base, children: node.children.filter((child): child is Node => child !== null).map((child) => nodeToAst(child, source)) };
}

export async function parseFile(filePath: string): Promise<ParsedFile> {
	const wasmFile = wasmFileForPath(filePath);
	const source = await readFile(filePath, 'utf8');

	await initParser();
	const language = await loadLanguage(wasmFile);

	// Both the parser and the tree hold wasm-side memory that GC can't reclaim
	// on its own, so both are released once the plain-JS `AstNode` copy below
	// has been taken. One-file-at-a-time this was invisible; parsing a whole
	// workspace in one process, it isn't.
	const parser = new Parser();
	try {
		parser.setLanguage(language);
		const tree = parser.parse(source);
		if (tree === null) {
			throw new Error(`web-tree-sitter returned no tree for '${filePath}'.`);
		}
		try {
			return {
				filePath,
				grammar: wasmFile,
				root: nodeToAst(tree.rootNode, source),
				sExpression: tree.rootNode.toString(),
			};
		} finally {
			tree.delete();
		}
	} finally {
		parser.delete();
	}
}

/** Writes an already-parsed file's AST as JSON — the disk-write half of `dumpAst`, split out so a caller that already has a `ParsedFile` (e.g. `@cpg/file-watcher`'s AST pipeline) doesn't have to parse the file twice to also get it on disk. */
export async function writeAstJson(parsed: ParsedFile, outputDir: string = DEFAULT_OUTPUT_DIR): Promise<string> {
	await mkdir(outputDir, { recursive: true });
	const outputPath = join(outputDir, `${basename(parsed.filePath)}.ast.json`);
	await writeFile(outputPath, JSON.stringify(parsed, null, 2), 'utf8');
	return outputPath;
}

export async function dumpAst(filePath: string, outputDir: string = DEFAULT_OUTPUT_DIR): Promise<string> {
	const parsed = await parseFile(filePath);
	return writeAstJson(parsed, outputDir);
}

function resolveArgPath(arg: string): string {
	return isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
}

async function main(): Promise<void> {
	const [, , filePathArg, outputDirArg] = process.argv;
	if (filePathArg === undefined) {
		console.error('Usage: node dist/index.js <path/to/file> [outputDir]');
		process.exitCode = 1;
		return;
	}

	const filePath = resolveArgPath(filePathArg);
	const outputDir = outputDirArg === undefined ? DEFAULT_OUTPUT_DIR : resolveArgPath(outputDirArg);

	console.log(`Processing ${basename(filePath)}...`);
	const outputPath = await dumpAst(filePath, outputDir);
	console.log(`AST written to ${outputPath}`);
}

if (require.main === module) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}
