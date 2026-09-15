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

	await Parser.init();
	const grammarBytes = await readFile(join(resolveGrammarDir(), wasmFile));
	const language = await Language.load(new Uint8Array(grammarBytes));

	const parser = new Parser();
	parser.setLanguage(language);
	const tree = parser.parse(source);
	if (tree === null) {
		throw new Error(`web-tree-sitter returned no tree for '${filePath}'.`);
	}

	return {
		filePath,
		grammar: wasmFile,
		root: nodeToAst(tree.rootNode, source),
		sExpression: tree.rootNode.toString(),
	};
}

export async function dumpAst(filePath: string, outputDir: string = DEFAULT_OUTPUT_DIR): Promise<string> {
	const parsed = await parseFile(filePath);
	await mkdir(outputDir, { recursive: true });
	const outputPath = join(outputDir, `${basename(filePath)}.ast.json`);
	await writeFile(outputPath, JSON.stringify(parsed, null, 2), 'utf8');
	return outputPath;
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
