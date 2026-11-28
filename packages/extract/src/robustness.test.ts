// Parse robustness (BMO-137, lane H2): hostile and unusual Python through the REAL wasm grammar and
// extract's Pass A. The parse service setup and the expected.cpg reader are copied from ladder.test.ts.
//
// Where the expected values come from:
// - C-EXTRACT (docs/outline/05-contracts.yaml): I3, I4, I17 (budget), I19 (no U+0000), I23 (0-based rows,
//   UTF-16 columns), the ExtractOutcome shape; the walker's rules in src/walk.ts's doc comment (the MODULE
//   range, Pass A, UNKNOWN per ERROR under a container (decision 95), the budget); python.ts's doc comments
//   (names, signature, async, docstring_head, type_text, default); makeNodeId / makeSymbolFqn's grammar
//   (04-schema id_rule and SYMBOL.fqn, as written in packages/model/src/schema/{ids,symbols}.ts).
// - fixtures/ladder/README.md: a MODULE spans the whole file including its last newline, an empty file is
//   `1:0-1:0` (0-based 0:0-0:0); the rung and Pass A fixture expected.cpg files (hand-written) for CRLF.
// - The engine's lineCountOf (packages/engine/src/code-tier.ts): 0 for empty text, else split('\n').length;
//   decodeSource: TextDecoder('utf-8') strips a BOM.
// - 06-measurements.yaml: `def broken(:` recovers as one zero-width MISSING ')' and no ERROR node.
// - Each recovery case also pins the pinned grammar's tree (its S-expression) as a PRECONDITION: that is
//   the parser's input to extract, observed from @vscode/tree-sitter-wasm 0.3.1, never extract's output.
//   An exact UNKNOWN count is then decision 95's rule applied to that tree, checked twice: the hand count
//   in the case and `unknownsByRule`, the rule re-stated over the real tree.
//
// Assertions read Pass A only (MODULE, TYPE_DECL, METHOD, PARAM, MEMBER, UNKNOWN; DECLARES, HAS_PARAM,
// DEFINES; the SYMBOLs DEFINES targets), so Pass B's CALLs, call edges and builtin symbols can land beside.
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { isWorkspacePath, type SourceRange } from '@cpg/model';
import { BUILTIN_LANGUAGES, createLanguageRegistry, createParseService } from '@cpg/parse';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  EdgeElement,
  ExtractedFile,
  ExtractOutcome,
  NodeElement,
  PropertyValue,
} from './contract';
import { createExtractor } from './extractor';

const LADDER = join(__dirname, '../../../fixtures/ladder');
const PASS_A = join(__dirname, '../test/fixtures/pass-a');
const dirOf = (rung: string): string => (rung === 'pass-a' ? PASS_A : join(LADDER, rung));
const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');

const registry = createLanguageRegistry();
for (const r of BUILTIN_LANGUAGES) registry.register(r);
registry.freeze();
const service = createParseService({
  registry,
  source: {
    describe: () => WASM_DIR,
    load: async (ref) => ({
      ok: true,
      bytes: new Uint8Array(await readFile(join(WASM_DIR, ref.wasmFile))),
      origin: ref.wasmFile,
    }),
  },
});
afterAll(() => service.dispose());

/** The engine's ExtractRequest.lineCount rule (code-tier.ts lineCountOf), restated. */
const lineCountOf = (text: string): number => (text.length === 0 ? 0 : text.split('\n').length);

/** web-tree-sitter's Node, as far as these checks read it (C-PARSE's SyntaxNode plus three members). */
interface TreeNode {
  readonly type: string;
  readonly isMissing: boolean;
  readonly children: readonly TreeNode[];
  readonly namedChildren: readonly TreeNode[];
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  childForFieldName(name: string): TreeNode | null;
  toString(): string;
}

function isTreeNode(value: unknown): value is TreeNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isMissing' in value &&
    typeof value.isMissing === 'boolean' &&
    'children' in value &&
    Array.isArray(value.children)
  );
}

interface Run {
  readonly text: string;
  readonly outcome: ExtractOutcome;
  readonly tree: string;
  readonly missing: readonly SourceRange[];
  readonly unknownsByRule: number;
}

const toRange = (n: TreeNode): SourceRange => ({
  startRow: n.startPosition.row,
  startColumn: n.startPosition.column,
  endRow: n.endPosition.row,
  endColumn: n.endPosition.column,
});

/** Every MISSING token's range in the tree (an explicit stack: a deep file must not overflow). */
function missingRanges(root: TreeNode): SourceRange[] {
  const found: SourceRange[] = [];
  const stack = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.isMissing) found.push(toRange(node));
    stack.push(...node.children);
  }
  return found;
}

/**
 * Decision 95's rule over the real tree, in walk.ts's reading: one UNKNOWN per ERROR node among a
 * container's children, which are the MODULE's named children and the body's named children of every
 * class a container holds (bare or decorated, with a name). This is the same reading the hand counts
 * use, so it guards the hand count, not the reading: README Q5's "directly under a container" can also
 * be read to cover an ERROR that is a direct child of a class_definition outside its body (its header).
 * That reading is an open question on the BMO-137 PR; under it, the two class-header cases below count
 * one more UNKNOWN each.
 */
function unknownsByRule(root: TreeNode): number {
  let count = 0;
  const visit = (children: readonly TreeNode[]): void => {
    for (const child of children) {
      if (child.type === 'ERROR') {
        count += 1;
        continue;
      }
      const cls =
        child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
      if (cls?.type !== 'class_definition' || cls.childForFieldName('name') === null) continue;
      visit(cls.childForFieldName('body')?.namedChildren ?? []);
    }
  };
  visit(root.namedChildren);
  return count;
}

/** Parses `text` and extracts it as the engine would (lineCountOf), releasing the tree whatever happens. */
async function run(
  path: string,
  text: string,
  budget?: { maxNodes?: number; maxDepth?: number },
): Promise<Run> {
  if (!isWorkspacePath(path)) throw new Error(`${path} is not a workspace path`);
  const parsed = await service.parse({ key: path, text });
  if (!parsed.ok) throw new Error(parsed.error.message);
  try {
    const root: unknown = parsed.handle.root;
    if (!isTreeNode(root)) throw new Error('the root is not a web-tree-sitter Node');
    const outcome = createExtractor().extract({
      path,
      grammarId: parsed.handle.language,
      root: parsed.handle.root,
      revision_id: 'f'.repeat(64),
      lineCount: lineCountOf(text),
      ...(budget !== undefined ? { budget } : {}),
    });
    return {
      text,
      outcome,
      tree: text.length <= 400 ? root.toString() : '',
      missing: missingRanges(root),
      unknownsByRule: unknownsByRule(root),
    };
  } finally {
    parsed.handle.release();
  }
}

const PASS_A_LABELS = new Set(['MODULE', 'TYPE_DECL', 'METHOD', 'PARAM', 'MEMBER', 'UNKNOWN']);
const PASS_A_EDGES = new Set(['DECLARES', 'HAS_PARAM', 'DEFINES']);
const DECLARATIONS = new Set(['TYPE_DECL', 'METHOD', 'PARAM', 'MEMBER']);

interface PassA {
  readonly nodes: readonly NodeElement[];
  readonly edges: readonly EdgeElement[];
  readonly symbols: readonly string[];
}

function passA(file: ExtractedFile): PassA {
  const edges = file.edges.filter((e) => PASS_A_EDGES.has(e.type));
  const targets = new Set(edges.filter((e) => e.type === 'DEFINES').map((e) => e.to.key));
  return {
    nodes: file.nodes.filter((n) => PASS_A_LABELS.has(n.label)),
    edges,
    symbols: file.symbols.filter((s) => targets.has(s.fqn)).map((s) => s.fqn),
  };
}

/** The file of an `ok` outcome; anything else fails the test with the outcome in the message. */
function okFile(r: Run): ExtractedFile {
  if (r.outcome.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r.outcome)}`);
  return r.outcome.file;
}

const at = (startRow: number, startColumn: number, endRow: number, endColumn: number) => ({
  startRow,
  startColumn,
  endRow,
  endColumn,
});
const before = (a: { row: number; col: number }, b: { row: number; col: number }) =>
  a.row < b.row || (a.row === b.row && a.col <= b.col);
const startOf = (r: SourceRange) => ({ row: r.startRow, col: r.startColumn });
const endOf = (r: SourceRange) => ({ row: r.endRow, col: r.endColumn });
const inside = (inner: SourceRange, outer: SourceRange) =>
  before(startOf(outer), startOf(inner)) && before(endOf(inner), endOf(outer));
const sameRange = (a: SourceRange, b: SourceRange) => JSON.stringify(a) === JSON.stringify(b);

/** The UTF-16 offset each row of `text` starts at (rows split on '\n', I23). */
function rowStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** The UTF-16 slice of `text` a range covers, `starts` being its rowStarts. */
function sliceOf(text: string, starts: readonly number[], r: SourceRange): string {
  return text.slice(
    (starts[r.startRow] ?? 0) + r.startColumn,
    (starts[r.endRow] ?? 0) + r.endColumn,
  );
}

/** Where a MODULE must end: after the last '\n', on the row that many newlines down (ladder README). */
function fileEnd(text: string): { row: number; col: number } {
  const rows = text.split('\n');
  return { row: rows.length - 1, col: (rows.at(-1) ?? '').length };
}

function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => k.includes('\u0000') || hasNul(v));
}

/**
 * The checks every ok or truncated case shares; returns the problems found (empty when it holds):
 * - one MODULE, `0:0` to the file's end, and stats.lineCount is lineCountOf(text);
 * - every Pass A range is ordered and inside the MODULE, a nameRange inside its node;
 * - a declaration's name is non-empty, never zero-width, never on a MISSING token; a METHOD's name is
 *   exactly the text its nameRange covers, any other declaration's name appears in its own range;
 * - no declaration lies inside an UNKNOWN (an ERROR is never descended, decision 95);
 * - the UNKNOWN count is decision 95's rule over the tree, and nothing holds U+0000 (I19).
 */
function problems(r: Run, file: ExtractedFile): string[] {
  const out: string[] = [];
  const { nodes, edges, symbols } = passA(file);
  const modules = nodes.filter((n) => n.label === 'MODULE');
  const module = modules[0];
  if (modules.length !== 1 || module === undefined) return [`${modules.length} MODULE nodes`];
  const end = fileEnd(r.text);
  if (!sameRange(module.range, at(0, 0, end.row, end.col)))
    out.push(`MODULE range ${JSON.stringify(module.range)}, file ends ${JSON.stringify(end)}`);
  if (file.stats.lineCount !== lineCountOf(r.text)) out.push(`lineCount ${file.stats.lineCount}`);
  if (r.text.length > 0 && module.range.endRow !== lineCountOf(r.text) - 1)
    out.push(`MODULE endRow ${module.range.endRow} vs lineCountOf ${lineCountOf(r.text)}`);
  const unknowns = nodes.filter((n) => n.label === 'UNKNOWN');
  const starts = rowStarts(r.text);
  for (const n of nodes) {
    const ranges = n.nameRange === undefined ? [n.range] : [n.range, n.nameRange];
    for (const range of ranges) {
      if (!before(startOf(range), endOf(range))) out.push(`${n.id}: unordered range`);
      if (!inside(range, module.range))
        out.push(`${n.id}: ${JSON.stringify(range)} outside MODULE`);
    }
    if (n.nameRange !== undefined && !inside(n.nameRange, n.range))
      out.push(`${n.id}: nameRange outside its node`);
    if (!DECLARATIONS.has(n.label)) continue;
    const name = n.properties['name'];
    if (typeof name !== 'string' || name === '') {
      out.push(`${n.id}: empty name`);
      continue;
    }
    if (!sliceOf(r.text, starts, n.range).includes(name))
      out.push(`${n.id}: name not in its range`);
    if (n.nameRange !== undefined) {
      const { startRow, startColumn, endRow, endColumn } = n.nameRange;
      if (startRow === endRow && startColumn === endColumn) out.push(`${n.id}: zero-width name`);
      if (sliceOf(r.text, starts, n.nameRange) !== name)
        out.push(`${n.id}: nameRange text is not its name`);
      const range = n.nameRange;
      if (r.missing.some((m) => sameRange(m, range))) out.push(`${n.id}: name on a MISSING token`);
    }
    if (unknowns.some((u) => inside(n.range, u.range))) out.push(`${n.id}: inside an UNKNOWN`);
  }
  if (unknowns.length !== r.unknownsByRule)
    out.push(`${unknowns.length} UNKNOWN, the rule over the tree gives ${r.unknownsByRule}`);
  if (hasNul({ nodes, edges, symbols })) out.push('U+0000 in an emitted string');
  return out;
}

/**
 * For a known bug that holds I4 either way: an ok or truncated file must pass problems(); a failure
 * must be `internal` on `path` with a message starting `prefix`. Returns what is wrong (empty if
 * nothing), so an outcome that changes shows in the diff.
 */
function violations(r: Run, path: string, prefix: string): string[] {
  const o = r.outcome;
  if (o.kind !== 'failed') return problems(r, o.file);
  const { code, message } = o.error;
  return code === 'internal' && o.error.path === path && message.startsWith(prefix)
    ? []
    : [`failed ${JSON.stringify(o.error)}`];
}

/** `r:c-r:c`, 0-based rows (I23). */
const fmt0 = (r: SourceRange) => `${r.startRow}:${r.startColumn}-${r.endRow}:${r.endColumn}`;
/** `l:c-l:c`, 1-based lines: the ladder's range format. */
const fmt1 = (r: SourceRange) =>
  `${r.startRow + 1}:${r.startColumn}-${r.endRow + 1}:${r.endColumn}`;

/** A Pass A node as `LABEL id r:c-r:c[ name r:c-r:c]`, 0-based rows (I23), to compare against by hand. */
function line(n: NodeElement): string {
  return `${n.label} ${n.id} ${fmt0(n.range)}${n.nameRange ? ` name ${fmt0(n.nameRange)}` : ''}`;
}

const lines = (file: ExtractedFile): string[] => passA(file).nodes.map(line);
const propsOf = (file: ExtractedFile, id: string) =>
  file.nodes.find((n) => n.id === id)?.properties ?? {};
const countOf = (file: ExtractedFile, label: string) =>
  passA(file).nodes.filter((n) => n.label === label).length;

// ── Syntax errors: MISSING tokens, ERROR regions, truncation ──

interface Recovery {
  readonly name: string;
  readonly text: string;
  /** PRECONDITION: the pinned grammar's tree for `text` (input to extract, not its output). */
  readonly tree: string;
  /** Decision 95 on that tree: ERROR nodes directly under the MODULE or a recovered class body. */
  readonly unknowns: number;
  /** The Pass A nodes, in pre-order (I3): what tree-sitter recovered, by Pass A's rules. */
  readonly nodes: readonly string[];
}

const RECOVERIES: readonly Recovery[] = [
  {
    // The brief's MISSING example: this grammar recovers it as an ERROR inside the class HEADER, a child
    // of the class_definition but not of its body, so it is none of a container's children (walk.ts),
    // the class is kept with the `pass` as its body, and m is not recovered at all. See unknownsByRule
    // for the other reading of README Q5 (one UNKNOWN here), left open.
    name: 'an unclosed parameter list inside a class',
    text: 'class C:\n def m(self:\n  pass',
    tree: '(module (class_definition name: (identifier) (ERROR (identifier) (identifier)) body: (block (pass_statement))))',
    unknowns: 0,
    nodes: ['MODULE file:m.py:MODULE:$root 0:0-2:6', 'TYPE_DECL file:m.py:TYPE_DECL:C 0:0-2:6'],
  },
  {
    // 06-measurements: `def broken(:` is one zero-width MISSING ')' and no ERROR.
    name: 'a MISSING close paren (06-measurements)',
    text: 'def broken(:\n    pass\n',
    tree: '(module (function_definition name: (identifier) parameters: (parameters (MISSING ")")) body: (block (pass_statement))))',
    unknowns: 0,
    nodes: [
      'MODULE file:m.py:MODULE:$root 0:0-2:0',
      'METHOD file:m.py:METHOD:broken 0:0-1:8 name 0:4-0:10',
    ],
  },
  {
    name: 'a MISSING close paren in a base list',
    text: 'class C(Base:\n    def m(self):\n        pass\n',
    tree: '(module (class_definition name: (identifier) superclasses: (argument_list (identifier) (MISSING ")")) body: (block (function_definition name: (identifier) parameters: (parameters (identifier)) body: (block (pass_statement))))))',
    unknowns: 0,
    nodes: [
      'MODULE file:m.py:MODULE:$root 0:0-3:0',
      'TYPE_DECL file:m.py:TYPE_DECL:C 0:0-2:12',
      'METHOD file:m.py:METHOD:C.m 1:4-2:12 name 1:8-1:9',
      'PARAM file:m.py:PARAM:C.m.self 1:10-1:14',
    ],
  },
  {
    name: 'an all-ERROR file',
    text: ')\n)\n)\n',
    tree: '(module (ERROR))',
    unknowns: 1,
    nodes: ['MODULE file:m.py:MODULE:$root 0:0-3:0', 'UNKNOWN file:m.py:UNKNOWN:$root:0 0:0-2:1'],
  },
  {
    name: 'an all-ERROR file with no newline',
    text: '))) ((( ]]]',
    tree: '(module (ERROR))',
    unknowns: 1,
    nodes: ['MODULE file:m.py:MODULE:$root 0:0-0:11', 'UNKNOWN file:m.py:UNKNOWN:$root:0 0:0-0:11'],
  },
  {
    name: 'a file truncated at `def f(a, b=`',
    text: 'def f(a, b=',
    tree: '(module (ERROR (identifier) (identifier) (identifier)))',
    unknowns: 1,
    nodes: ['MODULE file:m.py:MODULE:$root 0:0-0:11', 'UNKNOWN file:m.py:UNKNOWN:$root:0 0:0-0:11'],
  },
  {
    name: 'a file truncated inside a parameter list, with a newline',
    text: 'def f(a\n',
    tree: '(module (ERROR (identifier) (identifier)))',
    unknowns: 1,
    nodes: ['MODULE file:m.py:MODULE:$root 0:0-1:0', 'UNKNOWN file:m.py:UNKNOWN:$root:0 0:0-0:7'],
  },
  {
    // The ERROR is the stray `@` line, under the MODULE; the def after it is recovered.
    name: 'a bare decorator before a def',
    text: '@\ndef f():\n    pass\n',
    tree: '(module (ERROR) (function_definition name: (identifier) parameters: (parameters) body: (block (pass_statement))))',
    unknowns: 1,
    nodes: [
      'MODULE file:m.py:MODULE:$root 0:0-3:0',
      'UNKNOWN file:m.py:UNKNOWN:$root:0 0:0-0:1',
      'METHOD file:m.py:METHOD:f 1:0-2:8 name 1:4-1:5',
    ],
  },
  {
    // An unterminated triple quote: the grammar breaks it into an ERROR inside the def (no container
    // child), and the body's first statement is the bare name `doc`, so there is no docstring_head.
    name: 'an unterminated triple-quoted docstring',
    text: 'def f():\n    """doc\n    pass\n',
    tree: '(module (function_definition name: (identifier) parameters: (parameters) (ERROR (string_start)) body: (block (expression_statement (identifier)) (pass_statement))))',
    unknowns: 0,
    nodes: [
      'MODULE file:m.py:MODULE:$root 0:0-3:0',
      'METHOD file:m.py:METHOD:f 0:0-2:8 name 0:4-0:5',
    ],
  },
  {
    name: 'an unterminated triple-quoted value',
    text: "x = '''abc\ny = 2\n",
    tree: '(module (expression_statement (assignment left: (identifier) (ERROR (string_start)) right: (identifier))) (expression_statement (assignment left: (identifier) right: (integer))))',
    unknowns: 0,
    nodes: [
      'MODULE file:m.py:MODULE:$root 0:0-2:0',
      'MEMBER file:m.py:MEMBER:x 0:0-0:10',
      'MEMBER file:m.py:MEMBER:y 1:0-1:5',
    ],
  },
  {
    // Counted per scope. The `)` that opens the class body joins the class HEADER's ERROR in this
    // grammar (no container's child in walk.ts's reading, so no UNKNOWN; 4 under the other reading of
    // README Q5, left open); the one after `x = 1` is under the body.
    name: 'ERRORs under the MODULE and in a class body, one scope at a time',
    text: ')\nclass C:\n    )\n    x = 1\n    )\n)\n',
    tree: '(module (ERROR) (class_definition name: (identifier) (ERROR) body: (block (expression_statement (assignment left: (identifier) right: (integer))) (ERROR))) (ERROR))',
    unknowns: 3,
    nodes: [
      'MODULE file:m.py:MODULE:$root 0:0-6:0',
      'UNKNOWN file:m.py:UNKNOWN:$root:0 0:0-0:1',
      'TYPE_DECL file:m.py:TYPE_DECL:C 1:0-4:5',
      'MEMBER file:m.py:MEMBER:C.x 3:4-3:9',
      'UNKNOWN file:m.py:UNKNOWN:C:0 4:4-4:5',
      'UNKNOWN file:m.py:UNKNOWN:$root:1 5:0-5:1',
    ],
  },
];

describe('syntax errors through the real grammar (decision 95, C-PARSE I22)', () => {
  for (const c of RECOVERIES) {
    it(`${c.name}: ok, ${c.unknowns} UNKNOWN, what tree-sitter recovered`, async () => {
      const r = await run('m.py', c.text);
      expect(r.tree).toBe(c.tree);
      const file = okFile(r);
      expect(problems(r, file)).toEqual([]);
      expect(countOf(file, 'UNKNOWN')).toBe(c.unknowns);
      expect(lines(file)).toEqual(c.nodes);
      for (const u of passA(file).nodes.filter((n) => n.label === 'UNKNOWN'))
        expect(u.properties).toEqual({ reason: 'syntax-error', status: 'ready' });
    });
  }

  it('the MISSING paren leaves `broken` with no params and its name off the MISSING token', async () => {
    const r = await run('m.py', 'def broken(:\n    pass\n');
    const file = okFile(r);
    // The MISSING ')' is zero-width after `(` (column 11); the name stays `broken` at 4-10.
    expect(r.missing).toEqual([at(0, 11, 0, 11)]);
    expect(propsOf(file, 'file:m.py:METHOD:broken')).toMatchObject({
      name: 'broken',
      signature: 'broken()',
      params_count: 0,
    });
  });

  it('an unterminated docstring leaves no docstring_head: the body opens with a name, not a string', async () => {
    const r = await run('m.py', 'def f():\n    """doc\n    pass\n');
    // walk.ts's METHOD properties; python.ts: a docstring is a body whose first named child is an
    // expression_statement holding a `string`. Here that statement holds the identifier `doc`.
    expect(propsOf(okFile(r), 'file:m.py:METHOD:f')).toEqual({
      name: 'f',
      kind: 'function',
      signature: 'f()',
      params_count: 0,
      exported: true,
      async: false,
      status: 'ready',
    });
  });

  // A stray comma in a parameter list: the grammar inserts a zero-width MISSING identifier (the only
  // MISSING-identifier inputs found; every MISSING name attempt became an ERROR). PRECONDITIONS, input.
  const MISSING_IDENT = [
    {
      text: 'def f(,*args):\n    pass\n',
      tree: '(module (function_definition name: (identifier) parameters: (parameters (MISSING identifier) (list_splat_pattern (identifier))) body: (block (pass_statement))))',
      missing: [at(0, 6, 0, 6)],
      // python.ts: a list_splat_pattern is a PARAM named by the identifier inside, range the pattern's.
      nodes: [
        'MODULE file:m.py:MODULE:$root 0:0-2:0',
        'METHOD file:m.py:METHOD:f 0:0-1:8 name 0:4-0:5',
        'PARAM file:m.py:PARAM:f.args 0:7-0:12',
      ],
    },
    {
      // The Pass A fixture's `greet` (test/fixtures/pass-a) with one comma doubled.
      text: 'def greet(name: str, times=1,, *args, **kwargs) -> str:\n    pass\n',
      tree: '(module (function_definition name: (identifier) parameters: (parameters (typed_parameter (identifier) type: (type (identifier))) (default_parameter name: (identifier) value: (integer)) (MISSING identifier) (list_splat_pattern (identifier)) (dictionary_splat_pattern (identifier))) return_type: (type (identifier)) body: (block (pass_statement))))',
      missing: [at(0, 29, 0, 29)],
      nodes: [
        'MODULE file:m.py:MODULE:$root 0:0-2:0',
        'METHOD file:m.py:METHOD:greet 0:0-1:8 name 0:4-0:9',
        'PARAM file:m.py:PARAM:greet.name 0:10-0:19',
        'PARAM file:m.py:PARAM:greet.times 0:21-0:28',
        'PARAM file:m.py:PARAM:greet.args 0:31-0:36',
        'PARAM file:m.py:PARAM:greet.kwargs 0:38-0:46',
      ],
    },
  ] as const;

  for (const c of MISSING_IDENT) {
    // Passes before and after the fix: I4 (no throw), and never an ok file with an empty or MISSING name.
    it(`a MISSING identifier param (${JSON.stringify(c.text.split('\n')[0])}): never a throw, never an empty name`, async () => {
      const r = await run('m.py', c.text);
      expect(r.tree).toBe(c.tree);
      expect(r.missing).toEqual(c.missing);
      // Before sprint 40: the MISSING identifier became a PARAM named '' and makeNodeId refused its scope
      // (ids.ts: a scope segment is a non-empty string), which extractFile reported as `internal`.
      expect(violations(r, 'm.py', '')).toEqual([]);
    });

    // BMO-137 bug, fixed in sprint 40: a stray comma failed the whole file `internal`. Decision 95
    // (ladder README Q5): "for a region with a syntax error the extractor emits the declarations
    // tree-sitter recovered"; the builder's contract: `internal` is "a walker or adapter bug, never bad
    // input". Decision 114: the MISSING identifier is no PARAM; the surviving params' ordinals and the
    // signature are asserted in the decisions 114 and 115 describe below.
    it(`a MISSING identifier param keeps the def and its real params (BMO-137): ${JSON.stringify(c.text.split('\n')[0])}`, async () => {
      const r = await run('m.py', c.text);
      const file = okFile(r);
      expect(problems(r, file)).toEqual([]);
      expect(lines(file)).toEqual(c.nodes);
    });
  }

  // A file cut off inside a parameter list with no newline: the ROOT is the ERROR (no module node).
  // extractor.ts check 4 and C-EXTRACT's ExtractOutcome name this failure: `root-type-mismatch` (the
  // adapter's moduleRootType is `module`). Whether an ERROR root should instead be a MODULE with one
  // UNKNOWN (C-PARSE I22, decision 95) is an open question on the BMO-137 PR.
  const ERROR_ROOTS = [
    { text: 'class C:\n    def f(self', tree: '(ERROR (identifier) (identifier) (identifier))' },
    {
      text: 'x = 1\n\n\nclass C:\n    y = 2\n\n    def m(s',
      tree: '(ERROR (expression_statement (assignment left: (identifier) right: (integer))) (identifier) (expression_statement (assignment left: (identifier) right: (integer))) (identifier) (identifier))',
    },
  ] as const;

  for (const c of ERROR_ROOTS) {
    it(`an ERROR root (${JSON.stringify(c.text.split('\n').at(-1))}) is the named failure root-type-mismatch`, async () => {
      const r = await run('m.py', c.text);
      expect(r.tree).toBe(c.tree);
      if (r.outcome.kind !== 'failed') throw new Error(`expected failed, got ${r.outcome.kind}`);
      expect(r.outcome.error.code).toBe('root-type-mismatch');
      expect(r.outcome.error.path).toBe('m.py');
    });
  }
});

// ── Bytes no Python file should hold ──

describe('NUL bytes and lone surrogates (I19, I23)', () => {
  it('a NUL on its own line is one UNKNOWN between two MEMBERs', async () => {
    const r = await run('n.py', 'x = 1\n\u0000\ny = 2\n');
    expect(r.tree).toBe(
      "(module (expression_statement (assignment left: (identifier) right: (integer))) (ERROR (UNEXPECTED '\\0')) (expression_statement (assignment left: (identifier) right: (integer))))",
    );
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:n.py:MODULE:$root 0:0-3:0',
      'MEMBER file:n.py:MEMBER:x 0:0-0:5',
      'UNKNOWN file:n.py:UNKNOWN:$root:0 1:0-1:1',
      'MEMBER file:n.py:MEMBER:y 2:0-2:5',
    ]);
  });

  it('a file that is only NUL bytes is one UNKNOWN', async () => {
    const r = await run('n.py', '\u0000\u0000\n\u0000');
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:n.py:MODULE:$root 0:0-1:1',
      'UNKNOWN file:n.py:UNKNOWN:$root:0 0:0-1:1',
    ]);
  });

  it('a NUL in a docstring drops the docstring, never the def', async () => {
    const r = await run('n.py', 'def f():\n    """a\u0000b"""\n');
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:n.py:MODULE:$root 0:0-2:0',
      'METHOD file:n.py:METHOD:f 0:0-1:13 name 0:4-0:5',
    ]);
    expect(propsOf(file, 'file:n.py:METHOD:f')).not.toHaveProperty('docstring_head');
  });

  // BMO-137 bug: C-EXTRACT I19 ("no emitted string contains U+0000") is met by failing the WHOLE file
  // `internal` ("C-EXTRACT I19: nodes contains U+0000"), but the ERROR holding the NUL sits inside a
  // default value, and decision 95 (ladder README Q5) says a region with a syntax error emits the
  // declarations tree-sitter recovered: here `f` and its param `a`. The builder's own contract says
  // `internal` is "a walker or adapter bug, never bad input". python.ts copied the `value` node's
  // text, NUL included, into PARAM.default. Decision 115 (sprint 40): that default is omitted.
  const NUL_IN_DEFAULT = 'def f(a=[1, \u0000]):\n    pass\n';
  const NUL_IN_ANNOTATION = 'class C:\n    def m(self, a: Dict[str, \u0000] = {}):\n        pass\n';
  // PRECONDITIONS (input to extract): where the grammar puts each NUL's ERROR.
  const NUL_TREES = [
    [
      NUL_IN_DEFAULT,
      "(module (function_definition name: (identifier) parameters: (parameters (default_parameter name: (identifier) value: (list (integer) (ERROR (UNEXPECTED '\\0'))))) body: (block (pass_statement))))",
    ],
    [
      NUL_IN_ANNOTATION,
      "(module (class_definition name: (identifier) body: (block (function_definition name: (identifier) parameters: (parameters (identifier) (typed_default_parameter name: (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))) value: (dictionary))) body: (block (pass_statement))))))",
    ],
  ] as const;

  // Passes before and after the fix: I4 (no throw) and I19 (no ok or truncated file holds U+0000).
  // Before sprint 40 the builder's I19 assert failed the file `internal`, its message starting
  // `C-EXTRACT I19: ` (the builder's doc); the two cases below named that as the bug.
  for (const [text, tree] of NUL_TREES) {
    it(`a NUL inside a param (${JSON.stringify(text.split('\n').find((l) => l.includes('\u0000')))}): never a throw, never an emitted NUL`, async () => {
      const r = await run('n.py', text);
      expect(r.tree).toBe(tree);
      expect(violations(r, 'n.py', 'C-EXTRACT I19: ')).toEqual([]);
    });
  }

  it('a NUL inside a default value keeps the def and its param (BMO-137)', async () => {
    const r = await run('n.py', NUL_IN_DEFAULT);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:n.py:MODULE:$root 0:0-2:0',
      'METHOD file:n.py:METHOD:f 0:0-1:8 name 0:4-0:5',
      'PARAM file:n.py:PARAM:f.a 0:6-0:14',
    ]);
  });

  // BMO-137 bug, the same cause through type_text and the signature: the NUL's ERROR is inside the
  // annotation `Dict[str, \0]`, so typed_default_parameter's `type` text carried it and the file failed
  // `internal` instead of keeping C, C.m and its params (decision 95). Fixed by decision 115.
  it('a NUL inside an annotation keeps the class, the method and its params (BMO-137)', async () => {
    const r = await run('n.py', NUL_IN_ANNOTATION);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:n.py:MODULE:$root 0:0-3:0',
      'TYPE_DECL file:n.py:TYPE_DECL:C 0:0-2:12',
      'METHOD file:n.py:METHOD:C.m 1:4-2:12 name 1:8-1:9',
      'PARAM file:n.py:PARAM:C.m.self 1:10-1:14',
      'PARAM file:n.py:PARAM:C.m.a 1:16-1:36',
    ]);
  });

  it('a lone surrogate is one UTF-16 column, in a value and in a docstring', async () => {
    const value = await run('s.py', 'x = "\ud800"\ny = 1\n');
    const v = okFile(value);
    expect(problems(value, v)).toEqual([]);
    // `x = "` (5), the lone surrogate (1 code unit), `"` (1): column 7.
    expect(lines(v)).toEqual([
      'MODULE file:s.py:MODULE:$root 0:0-2:0',
      'MEMBER file:s.py:MEMBER:x 0:0-0:7',
      'MEMBER file:s.py:MEMBER:y 1:0-1:5',
    ]);

    const doc = await run('s.py', 'def f():\n    """a\ud800b"""\n');
    const d = okFile(doc);
    expect(problems(doc, d)).toEqual([]);
    // 4 spaces, `"""` (3), a, the surrogate, b, `"""` (3): column 13.
    expect(lines(d)).toEqual([
      'MODULE file:s.py:MODULE:$root 0:0-2:0',
      'METHOD file:s.py:METHOD:f 0:0-1:13 name 0:4-0:5',
    ]);
    expect(propsOf(d, 'file:s.py:METHOD:f')['docstring_head']).toBe('a\ud800b');
  });

  it('a lone surrogate after a def name leaves the name whole', async () => {
    const r = await run('s.py', 'def f\ud800():\n    pass\n');
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:s.py:MODULE:$root 0:0-2:0',
      'METHOD file:s.py:METHOD:f 0:0-1:8 name 0:4-0:5',
    ]);
  });
});

// ── Layout: indentation, empty files, BOM, CRLF ──

describe('indentation, empty files and a BOM', () => {
  it('tabs in one class and spaces in another (valid Python), columns in code units', async () => {
    const text =
      'class A:\n\tdef a(self):\n\t\treturn 1\n\n\nclass B:\n    def b(self):\n        return 2\n';
    const r = await run('t.py', text);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    // A tab is one UTF-16 code unit (I23): `\tdef a` puts `a` at column 5, `\t\treturn 1` ends at 10.
    expect(lines(file)).toEqual([
      'MODULE file:t.py:MODULE:$root 0:0-8:0',
      'TYPE_DECL file:t.py:TYPE_DECL:A 0:0-2:10',
      'METHOD file:t.py:METHOD:A.a 1:1-2:10 name 1:5-1:6',
      'PARAM file:t.py:PARAM:A.a.self 1:7-1:11',
      'TYPE_DECL file:t.py:TYPE_DECL:B 5:0-7:16',
      'METHOD file:t.py:METHOD:B.b 6:4-7:16 name 6:8-6:9',
      'PARAM file:t.py:PARAM:B.b.self 6:10-6:14',
    ]);
  });

  it('a tab and eight spaces in one block: no crash, both defs, names at their code-unit columns', async () => {
    const text = 'class C:\n\tdef a(self):\n\t\tpass\n        def b(self):\n\t\tpass\n';
    const r = await run('t.py', text);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    const methods = passA(file).nodes.filter((n) => n.label === 'METHOD');
    expect(methods.map((m) => [m.properties['name'], m.nameRange])).toEqual([
      ['a', at(1, 5, 1, 6)],
      ['b', at(3, 12, 3, 13)],
    ]);
  });

  it('an empty file is the MODULE alone, 0:0-0:0, lineCount 0', async () => {
    const r = await run('empty.py', '');
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual(['MODULE file:empty.py:MODULE:$root 0:0-0:0']);
    expect(passA(file).symbols).toEqual(['`empty.py`/']);
    expect(passA(file).edges.map((e) => `${e.type} ${e.from.key} -> ${e.to.key}`)).toEqual([
      'DEFINES file:empty.py:MODULE:$root -> `empty.py`/',
    ]);
    expect(file.stats.lineCount).toBe(0);
    expect(file.stats.astNodesVisited).toBe(1);
  });

  it('a file of blank lines is the MODULE alone, to the last newline', async () => {
    const r = await run('blank.py', '\n\n');
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual(['MODULE file:blank.py:MODULE:$root 0:0-2:0']);
    expect(file.stats.lineCount).toBe(3);
  });

  it('a BOM decoded the engine way (decodeSource strips it) leaves column 0 at the def', async () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('def f():\n    pass\n'),
    ]);
    const text = new TextDecoder('utf-8').decode(bytes);
    expect(text.startsWith('\ufeff')).toBe(false);
    const r = await run('bom.py', text);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:bom.py:MODULE:$root 0:0-2:0',
      'METHOD file:bom.py:METHOD:f 0:0-1:8 name 0:4-0:5',
    ]);
  });

  it('a BOM handed through raw is one code unit of column 0 (I23), with no UNKNOWN', async () => {
    const r = await run('bom.py', '\ufeffdef f():\n    pass\n');
    expect(r.tree).toBe(
      '(module (function_definition name: (identifier) parameters: (parameters) body: (block (pass_statement))))',
    );
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:bom.py:MODULE:$root 0:0-2:0',
      'METHOD file:bom.py:METHOD:f 0:1-1:8 name 0:5-0:6',
    ]);
  });
});

// ── CRLF: every Pass A rung again with Windows line ends ──

interface Fact {
  readonly head: string;
  readonly key: string;
  readonly props: ReadonlyMap<string, string>;
}

/** The [structural] and [symbols] facts of one rung's expected.cpg (ladder.test.ts's reader). */
function factsOf(rung: string): Fact[] {
  const facts: Fact[] = [];
  let section = '';
  for (const raw of readFileSync(join(dirOf(rung), 'expected.cpg'), 'utf8').split('\n')) {
    const text = raw.replace(/(^|\s)#.*$/, '').trim();
    const header = /^\[(\w+)\]$/.exec(text);
    if (header) section = header[1] ?? '';
    if (header || text === '' || (section !== 'structural' && section !== 'symbols')) continue;
    const words = text.split(/\s+/);
    const isEdge = words[2] === '->';
    const rest = words.slice(isEdge ? 4 : 2).map((kv) => {
      const [name = '', ...value] = kv.split('=');
      return [name, value.join('=')] as const;
    });
    facts.push({
      head: words[0] ?? '',
      key: isEdge ? `${words[1]} -> ${words[3]}` : (words[1] ?? ''),
      props: new Map(rest),
    });
  }
  return facts;
}

const show = (v: PropertyValue): string => (Array.isArray(v) ? `[${v.join(',')}]` : String(v));

/** Pass A of `file` as ladder facts: ranges 1-based lines (the ladder's format). */
function factsEmitted(file: ExtractedFile): Fact[] {
  const { nodes, edges } = passA(file);
  return [
    ...nodes.map((n) => {
      const props = new Map(Object.entries(n.properties).map(([k, v]) => [k, show(v)]));
      props.set('file', n.file).set('range', fmt1(n.range));
      if (n.nameRange !== undefined) props.set('name_range', fmt1(n.nameRange));
      return { head: n.label, key: n.id, props };
    }),
    ...edges.map((e) => ({ head: e.type, key: `${e.from.key} -> ${e.to.key}`, props: new Map() })),
  ];
}

const holds = (w: Fact, g: Fact) =>
  w.head === g.head &&
  w.key === g.key &&
  [...w.props].every(([k, v]) => (v === 'null' ? !g.props.has(k) : g.props.get(k) === v));

/** A Pass A line of a .py file in expected.cpg (ladder.test.ts's passATier). */
const passATier = (w: Fact) =>
  /^file:[^ ]*\.py:/.test(w.key) &&
  (PASS_A_LABELS.has(w.head) || (PASS_A_EDGES.has(w.head) && !w.key.includes(':IMPORT:')));

function pythonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return pythonFiles(full);
    return entry.name.endsWith('.py') ? [full] : [];
  });
}

const PY_RUNGS = [
  ...readdirSync(LADDER).filter(
    (rung) => /^\d\d-/.test(rung) && pythonFiles(join(LADDER, rung, 'ws')).length > 0,
  ),
  'pass-a',
];

/** A node with everything but revision_id, which follows the bytes (and so differs under CRLF). */
const shape = (n: NodeElement) => ({ ...n, revision_id: '' });

describe('a CRLF copy of every Pass A rung (rungs 01-09 and the Pass A fixture)', () => {
  it('covers 14 Python files across 10 rungs (ladder.test.ts extracts the same 14)', () => {
    // Rungs 01-05, 08 and 09 hold one file each, 06 two, 07 three, the Pass A fixture two.
    const files = PY_RUNGS.flatMap((rung) => pythonFiles(join(dirOf(rung), 'ws')));
    expect(PY_RUNGS).toHaveLength(10);
    expect(files).toHaveLength(14);
  });

  for (const rung of PY_RUNGS) {
    it(`${rung}: same ids, symbols, ranges and edges as LF; every Pass A line holds; no \\r`, async () => {
      const ws = join(dirOf(rung), 'ws');
      const want = factsOf(rung).filter(passATier);
      const got: Fact[] = [];
      for (const full of pythonFiles(ws)) {
        const path = relative(ws, full);
        const lf = readFileSync(full, 'utf8');
        expect(lf.includes('\r')).toBe(false);
        const crlf = lf.replaceAll('\n', '\r\n');
        const a = await run(path, lf);
        const b = await run(path, crlf);
        const lfFile = okFile(a);
        const crlfFile = okFile(b);
        expect(problems(b, crlfFile)).toEqual([]);
        // MODULE ends where the LF file's does: lineCountOf counts '\n' only, and a '\r' is no column.
        expect(lineCountOf(crlf)).toBe(lineCountOf(lf));
        expect(passA(crlfFile).nodes.map(shape)).toEqual(passA(lfFile).nodes.map(shape));
        expect(passA(crlfFile).edges).toEqual(passA(lfFile).edges);
        expect(passA(crlfFile).symbols).toEqual(passA(lfFile).symbols);
        expect(JSON.stringify(passA(crlfFile)).includes('\\r')).toBe(false);
        got.push(...factsEmitted(crlfFile));
      }
      expect(
        want.filter((w) => !got.some((g) => holds(w, g))).map((w) => `${w.head} ${w.key}`),
      ).toEqual([]);
    });
  }
});

// ── Names: unicode, escaping, async, PEP 695, string annotations ──

describe('unicode identifiers and id/fqn escaping (I23, ID_RULE, SYMBOL.fqn)', () => {
  // NFC é (U+00E9), Greek Ωμέγα and π, and two non-BMP Deseret letters (2 UTF-16 code units each).
  const text =
    'def caf\u00e9(\u00e0):\n    pass\n\n\nclass \u03a9\u03bc\u03ad\u03b3\u03b1:\n    \u03c0 = 3\n\n\ndef \u{10400}(\u{10401}, b):\n    pass\n';

  it('mints ids unescaped and fqns backticked, with name ranges in code units', async () => {
    const r = await run('uni.py', text);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:uni.py:MODULE:$root 0:0-10:0',
      'METHOD file:uni.py:METHOD:caf\u00e9 0:0-1:8 name 0:4-0:8',
      'PARAM file:uni.py:PARAM:caf\u00e9.\u00e0 0:9-0:10',
      'TYPE_DECL file:uni.py:TYPE_DECL:\u03a9\u03bc\u03ad\u03b3\u03b1 4:0-5:9',
      'MEMBER file:uni.py:MEMBER:\u03a9\u03bc\u03ad\u03b3\u03b1.\u03c0 5:4-5:9',
      'METHOD file:uni.py:METHOD:\u{10400} 8:0-9:8 name 8:4-8:6',
      'PARAM file:uni.py:PARAM:\u{10400}.\u{10401} 8:7-8:9',
      'PARAM file:uni.py:PARAM:\u{10400}.b 8:11-8:12',
    ]);
    // A name outside [A-Za-z0-9_+$-] is SCIP's escaped identifier: backticks around it.
    expect(passA(file).symbols).toEqual([
      '`uni.py`/',
      '`uni.py`/`caf\u00e9`().',
      '`uni.py`/`\u03a9\u03bc\u03ad\u03b3\u03b1`#',
      '`uni.py`/`\u03a9\u03bc\u03ad\u03b3\u03b1`#`\u03c0`.',
      '`uni.py`/`\u{10400}`().',
    ]);
    expect(propsOf(file, 'file:uni.py:METHOD:\u{10400}')).toMatchObject({
      signature: '\u{10400}(\u{10401}, b)',
      exported: true,
    });
  });

  it('escapes `%` and `:` in the path of an id and doubles a backtick in an fqn', async () => {
    const path = 'p\u00e4:k/m%o`d.py';
    const r = await run(path, 'def caf\u00e9():\n    pass\n');
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:p\u00e4%3Ak/m%25o`d.py:MODULE:$root 0:0-2:0',
      'METHOD file:p\u00e4%3Ak/m%25o`d.py:METHOD:caf\u00e9 0:0-1:8 name 0:4-0:8',
    ]);
    expect(passA(file).symbols).toEqual([
      '`p\u00e4:k/m%o``d.py`/',
      '`p\u00e4:k/m%o``d.py`/`caf\u00e9`().',
    ]);
    expect(propsOf(file, 'file:p\u00e4%3Ak/m%25o`d.py:MODULE:$root')['name']).toBe(
      'p\u00e4:k.m%o`d',
    );
  });
});

describe('async, decorators, PEP 695 and string annotations', () => {
  it('a decorated async def and async methods: async true, ranges from the decorator', async () => {
    const text =
      '@deco\nasync def fetch(url):\n    pass\n\n\nclass K:\n    async def run(self):\n        pass\n\n    @staticmethod\n    async def make():\n        pass\n';
    const r = await run('a.py', text);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:a.py:MODULE:$root 0:0-12:0',
      'METHOD file:a.py:METHOD:fetch 0:0-2:8 name 1:10-1:15',
      'PARAM file:a.py:PARAM:fetch.url 1:16-1:19',
      'TYPE_DECL file:a.py:TYPE_DECL:K 5:0-11:12',
      'METHOD file:a.py:METHOD:K.run 6:4-7:12 name 6:14-6:17',
      'PARAM file:a.py:PARAM:K.run.self 6:18-6:22',
      'METHOD file:a.py:METHOD:K.make 9:4-11:12 name 10:14-10:18',
    ]);
    expect(propsOf(file, 'file:a.py:METHOD:fetch')).toMatchObject({
      kind: 'function',
      async: true,
      signature: 'fetch(url)',
    });
    expect(propsOf(file, 'file:a.py:METHOD:K.run')).toMatchObject({ kind: 'method', async: true });
    expect(propsOf(file, 'file:a.py:METHOD:K.make')).toMatchObject({
      kind: 'method',
      async: true,
      params_count: 0,
      signature: 'make()',
    });
    expect(passA(file).symbols).toEqual([
      '`a.py`/',
      '`a.py`/fetch().',
      '`a.py`/K#',
      '`a.py`/K#run().',
      '`a.py`/K#make().',
    ]);
  });

  it('PEP 695 type parameters leave names, params and signatures alone; `type X = ...` is no node', async () => {
    const text =
      'def f[T](x: T) -> T:\n    return x\n\n\nclass Box[T]:\n    item: T\n\n\ntype Alias = int\n';
    const r = await run('g.py', text);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(countOf(file, 'UNKNOWN')).toBe(0);
    expect(lines(file)).toEqual([
      'MODULE file:g.py:MODULE:$root 0:0-9:0',
      'METHOD file:g.py:METHOD:f 0:0-1:12 name 0:4-0:5',
      'PARAM file:g.py:PARAM:f.x 0:9-0:13',
      'TYPE_DECL file:g.py:TYPE_DECL:Box 4:0-5:11',
      'MEMBER file:g.py:MEMBER:Box.item 5:4-5:11',
    ]);
    expect(propsOf(file, 'file:g.py:METHOD:f')['signature']).toBe('f(x: T) -> T');
    expect(propsOf(file, 'file:g.py:PARAM:f.x')['type_text']).toBe('T');
    expect(propsOf(file, 'file:g.py:MEMBER:Box.item')['type_text']).toBe('T');
  });

  it('a sync def that mentions `async ` in its body is not async (the text must START with it)', async () => {
    const r = await run('a.py', 'def helper():\n    """Wraps an async call."""\n    pass\n');
    // python.ts: async is "the node's text starts with `async` and whitespace".
    expect(propsOf(okFile(r), 'file:a.py:METHOD:helper')).toMatchObject({
      async: false,
      docstring_head: 'Wraps an async call.',
    });
  });

  it('string-literal annotations are kept as written, quotes included', async () => {
    const text = 'def g(a: "Foo", b: \'list[int]\' = None) -> "Bar":\n    pass\n\n\nx: "Foo" = 1\n';
    const r = await run('q.py', text);
    const file = okFile(r);
    expect(problems(r, file)).toEqual([]);
    expect(lines(file)).toEqual([
      'MODULE file:q.py:MODULE:$root 0:0-5:0',
      'METHOD file:q.py:METHOD:g 0:0-1:8 name 0:4-0:5',
      'PARAM file:q.py:PARAM:g.a 0:6-0:14',
      'PARAM file:q.py:PARAM:g.b 0:16-0:37',
      'MEMBER file:q.py:MEMBER:x 4:0-4:12',
    ]);
    expect(propsOf(file, 'file:q.py:METHOD:g')['signature']).toBe(
      'g(a: "Foo", b: \'list[int]\') -> "Bar"',
    );
    expect(propsOf(file, 'file:q.py:PARAM:g.a')).toEqual({
      name: 'a',
      ordinal: 0,
      type_text: '"Foo"',
    });
    expect(propsOf(file, 'file:q.py:PARAM:g.b')).toEqual({
      name: 'b',
      ordinal: 1,
      type_text: "'list[int]'",
      default: 'None',
    });
    expect(propsOf(file, 'file:q.py:MEMBER:x')).toEqual({ name: 'x', type_text: '"Foo"' });
  });
});

// ── Size: thousands of defs, deep nesting, and the budget (I17) ──

/** `C0.C1. ... .C<k>`: the scope of the k-th nested class. */
const scopeTo = (k: number) => Array.from({ length: k + 1 }, (_, i) => `C${i}`).join('.');

describe('large and deep files through parse and extract (I17)', () => {
  // A 12000-line parse beside the rest of the suite under coverage needs more than the 5 s default.
  const SLOW = 60_000;
  const DEFS = 6000;
  // Row 2i: `def f<i>(x):`, row 2i+1: `    pass`.
  const wide = Array.from({ length: DEFS }, (_, i) => `def f${i}(x):\n    pass\n`).join('');

  it(
    `${DEFS} defs: ok, every METHOD and PARAM at its row, unbudgeted`,
    async () => {
      const r = await run('wide.py', wide);
      const file = okFile(r);
      expect(problems(r, file)).toEqual([]);
      const { nodes, edges, symbols } = passA(file);
      expect(nodes).toHaveLength(1 + 2 * DEFS);
      expect(symbols).toHaveLength(1 + DEFS);
      expect(edges.filter((e) => e.type === 'DECLARES')).toHaveLength(DEFS);
      expect(edges.filter((e) => e.type === 'HAS_PARAM')).toHaveLength(DEFS);
      expect(edges.filter((e) => e.type === 'DEFINES')).toHaveLength(1 + DEFS);
      expect(file.stats.astNodesVisited).toBe(1 + DEFS);
      const methods = nodes.filter((n) => n.label === 'METHOD');
      const wrong = methods.filter((m, i) => {
        const name = `f${i}`;
        return (
          m.id !== `file:wide.py:METHOD:${name}` ||
          !sameRange(m.range, at(2 * i, 0, 2 * i + 1, 8)) ||
          !sameRange(m.nameRange ?? m.range, at(2 * i, 4, 2 * i, 4 + name.length))
        );
      });
      expect(wrong.map(line)).toEqual([]);
    },
    SLOW,
  );

  it(
    'maxNodes = defs + 1 is exactly enough: ok',
    async () => {
      const r = await run('wide.py', wide, { maxNodes: DEFS + 1 });
      expect(r.outcome.kind).toBe('ok');
    },
    SLOW,
  );

  for (const maxNodes of [DEFS, 2500]) {
    it(
      `maxNodes ${maxNodes}: truncated with astNodesVisited exactly ${maxNodes}, dropped at f${maxNodes - 1}`,
      async () => {
        const r = await run('wide.py', wide, { maxNodes });
        if (r.outcome.kind !== 'truncated')
          throw new Error(`expected truncated, got ${r.outcome.kind}`);
        const dropped = maxNodes - 1;
        expect(r.outcome.truncation).toEqual({
          limit: 'maxNodes',
          limitValue: maxNodes,
          droppedAtNodeType: 'function_definition',
          droppedRange: at(2 * dropped, 0, 2 * dropped + 1, 8),
        });
        const file = r.outcome.file;
        expect(file.stats.astNodesVisited).toBe(maxNodes);
        expect(problems(r, file)).toEqual([]);
        const methods = passA(file).nodes.filter((n) => n.label === 'METHOD');
        expect(methods).toHaveLength(dropped);
        expect(methods.at(-1)?.id).toBe(`file:wide.py:METHOD:f${dropped - 1}`);
        expect(countOf(file, 'PARAM')).toBe(dropped);
      },
      SLOW,
    );
  }

  const DEPTH = 200;
  // Row k < 200: k spaces then `class C<k>:`; row 200: 200 spaces then `x = 0`. One-space steps keep
  // every indent under 256 columns.
  const deep =
    Array.from({ length: DEPTH }, (_, k) => `${' '.repeat(k)}class C${k}:\n`).join('') +
    `${' '.repeat(DEPTH)}x = 0\n`;

  it(
    `classes nested ${DEPTH} deep: ok, every TYPE_DECL scoped through its parents`,
    async () => {
      const r = await run('deep.py', deep);
      const file = okFile(r);
      expect(problems(r, file)).toEqual([]);
      const { nodes, symbols } = passA(file);
      const types = nodes.filter((n) => n.label === 'TYPE_DECL');
      expect(types.map(line)).toEqual(
        Array.from(
          { length: DEPTH },
          (_, k) =>
            `TYPE_DECL file:deep.py:TYPE_DECL:${scopeTo(k)} ${k}:${k}-${DEPTH}:${DEPTH + 5}`,
        ),
      );
      expect(nodes.filter((n) => n.label === 'MEMBER').map(line)).toEqual([
        `MEMBER file:deep.py:MEMBER:${scopeTo(DEPTH - 1)}.x ${DEPTH}:${DEPTH}-${DEPTH}:${DEPTH + 5}`,
      ]);
      const hashes = Array.from({ length: DEPTH }, (_, i) => `C${i}#`).join('');
      expect(symbols.at(-1)).toBe(`\`deep.py\`/${hashes}x.`);
      expect(file.stats.astNodesVisited).toBe(1 + DEPTH + 1);
    },
    SLOW,
  );

  it(
    `maxDepth ${DEPTH}: truncated at the member, depth ${DEPTH + 1}`,
    async () => {
      const r = await run('deep.py', deep, { maxDepth: DEPTH });
      if (r.outcome.kind !== 'truncated')
        throw new Error(`expected truncated, got ${r.outcome.kind}`);
      expect(r.outcome.truncation).toEqual({
        limit: 'maxDepth',
        limitValue: DEPTH,
        droppedAtNodeType: 'expression_statement',
        droppedRange: at(DEPTH, DEPTH, DEPTH, DEPTH + 5),
      });
      expect(countOf(r.outcome.file, 'TYPE_DECL')).toBe(DEPTH);
      expect(countOf(r.outcome.file, 'MEMBER')).toBe(0);
      expect(r.outcome.file.stats.astNodesVisited).toBe(1 + DEPTH);
      expect(problems(r, r.outcome.file)).toEqual([]);
    },
    SLOW,
  );

  it(
    `maxDepth ${DEPTH + 1} is exactly enough: ok`,
    async () => {
      const r = await run('deep.py', deep, { maxDepth: DEPTH + 1 });
      expect(r.outcome.kind).toBe('ok');
    },
    SLOW,
  );

  it(
    'maxNodes 101 on the deep file: truncated at C100, astNodesVisited exactly 101',
    async () => {
      const r = await run('deep.py', deep, { maxNodes: 101 });
      if (r.outcome.kind !== 'truncated')
        throw new Error(`expected truncated, got ${r.outcome.kind}`);
      expect(r.outcome.truncation).toEqual({
        limit: 'maxNodes',
        limitValue: 101,
        droppedAtNodeType: 'class_definition',
        droppedRange: at(100, 100, DEPTH, DEPTH + 5),
      });
      expect(r.outcome.file.stats.astNodesVisited).toBe(101);
      expect(countOf(r.outcome.file, 'TYPE_DECL')).toBe(100);
      expect(problems(r, r.outcome.file)).toEqual([]);
    },
    SLOW,
  );
});

// ── What survives a MISSING param name or a NUL (sprint 40, decisions 114 and 115) ──
//
// Decision 114: a MISSING or empty param name yields no PARAM, and the surviving params keep their
// source ordinals: the position each has among the def's params, the MISSING one counted (python.ts's
// six param shapes; `/`, `*` and an ERROR are no param and take no position, as before). params_count
// is walk.ts's `params.length`, so it counts the PARAMs emitted; the signature lists them (python.ts).
// Decision 115: a default or annotation whose text holds U+0000 is omitted (no `default`, no
// `type_text`, on a PARAM or a MEMBER); the signature keeps each annotation as written with every
// U+0000 dropped. Trees are PRECONDITIONS (the pinned grammar's input to extract).

const param = (name: string, ordinal: number, more: Record<string, PropertyValue> = {}) => ({
  name,
  ordinal,
  ...more,
});
const survivor = (
  text: string,
  tree: string,
  method: string,
  signature: string,
  ...params: readonly Record<string, PropertyValue>[]
) => ({ text, tree, method: `file:m.py:METHOD:${method}`, signature, params });

/** The properties of each PARAM the METHOD has a HAS_PARAM edge to, in node order. */
function paramProps(file: ExtractedFile, methodId: string): Record<string, PropertyValue>[] {
  const linked = new Set(
    file.edges
      .filter((e) => e.type === 'HAS_PARAM' && e.from.key === methodId)
      .map((e) => e.to.key),
  );
  return file.nodes.filter((n) => linked.has(n.id)).map((n) => ({ ...n.properties }));
}

describe('a MISSING param name and a NUL in a default or annotation (decisions 114, 115)', () => {
  const SURVIVORS = [
    survivor(
      'def f(,*args):\n    pass\n',
      '(module (function_definition name: (identifier) parameters: (parameters (MISSING identifier) (list_splat_pattern (identifier))) body: (block (pass_statement))))',
      'f',
      'f(args)',
      param('args', 1),
    ),
    survivor(
      'def greet(name: str, times=1,, *args, **kwargs) -> str:\n    pass\n',
      '(module (function_definition name: (identifier) parameters: (parameters (typed_parameter (identifier) type: (type (identifier))) (default_parameter name: (identifier) value: (integer)) (MISSING identifier) (list_splat_pattern (identifier)) (dictionary_splat_pattern (identifier))) return_type: (type (identifier)) body: (block (pass_statement))))',
      'greet',
      'greet(name: str, times, args, kwargs) -> str',
      param('name', 0, { type_text: 'str' }),
      param('times', 1, { default: '1' }),
      param('args', 3),
      param('kwargs', 4),
    ),
    // The keyword separator `*` is no param, so it takes no position; the MISSING identifier does.
    survivor(
      'def f(a, *, ,*args):\n    pass\n',
      '(module (function_definition name: (identifier) parameters: (parameters (identifier) (keyword_separator) (MISSING identifier) (list_splat_pattern (identifier))) body: (block (pass_statement))))',
      'f',
      'f(a, args)',
      param('a', 0),
      param('args', 2),
    ),
    survivor(
      'def f(a=[1, \u0000]):\n    pass\n',
      "(module (function_definition name: (identifier) parameters: (parameters (default_parameter name: (identifier) value: (list (integer) (ERROR (UNEXPECTED '\\0'))))) body: (block (pass_statement))))",
      'f',
      'f(a)',
      param('a', 0),
    ),
    survivor(
      'class C:\n    def m(self, a: Dict[str, \u0000] = {}):\n        pass\n',
      "(module (class_definition name: (identifier) body: (block (function_definition name: (identifier) parameters: (parameters (identifier) (typed_default_parameter name: (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))) value: (dictionary))) body: (block (pass_statement))))))",
      'C.m',
      'm(self, a: Dict[str, ])',
      param('self', 0),
      param('a', 1, { default: '{}' }),
    ),
    // Each param on its own: a NUL drops only the text that holds it.
    survivor(
      'def f(a=[\u0000], b: int = 2, c: Dict[str, \u0000] = 3, d=4):\n    pass\n',
      "(module (function_definition name: (identifier) parameters: (parameters (default_parameter name: (identifier) value: (list (ERROR (UNEXPECTED '\\0')))) (typed_default_parameter name: (identifier) type: (type (identifier)) value: (integer)) (typed_default_parameter name: (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))) value: (integer)) (default_parameter name: (identifier) value: (integer))) body: (block (pass_statement))))",
      'f',
      'f(a, b: int, c: Dict[str, ], d)',
      param('a', 0),
      param('b', 1, { type_text: 'int', default: '2' }),
      param('c', 2, { default: '3' }),
      param('d', 3, { default: '4' }),
    ),
    // The return type reaches the signature only: its NUL is dropped there. r2 (review 1): two NULs in
    // each, so every U+0000 goes, not only the first.
    survivor(
      'def f(self, b: Dict[str, \u0000\u0000]) -> List[int, \u0000\u0000]:\n    pass\n',
      "(module (function_definition name: (identifier) parameters: (parameters (identifier) (typed_parameter (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))))) return_type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))) body: (block (pass_statement))))",
      'f',
      'f(self, b: Dict[str, ]) -> List[int, ]',
      param('self', 0),
      param('b', 1),
    ),
    // r2 (review 2): a NUL in a typed default's value drops its default only; in both, both go.
    survivor(
      'def f(e: int = [1, \u0000], g: Dict[str, \u0000] = [1, \u0000]):\n    pass\n',
      "(module (function_definition name: (identifier) parameters: (parameters (typed_default_parameter name: (identifier) type: (type (identifier)) value: (list (integer) (ERROR (UNEXPECTED '\\0')))) (typed_default_parameter name: (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))) value: (list (integer) (ERROR (UNEXPECTED '\\0'))))) body: (block (pass_statement))))",
      'f',
      'f(e: int, g: Dict[str, ])',
      param('e', 0, { type_text: 'int' }),
      param('g', 1),
    ),
    // r2 (review 3): `/`, a tuple pattern, an ERROR and `*` take no position; the MISSING one does.
    survivor(
      'def f(a, /, b, (c, d), e, , g, *, ,*args):\n    pass\n',
      '(module (function_definition name: (identifier) parameters: (parameters (identifier) (positional_separator) (identifier) (tuple_pattern (identifier) (identifier)) (identifier) (ERROR) (identifier) (keyword_separator) (MISSING identifier) (list_splat_pattern (identifier))) body: (block (pass_statement))))',
      'f',
      'f(a, b, e, g, args)',
      param('a', 0),
      param('b', 1),
      param('e', 2),
      param('g', 3),
      param('args', 5),
    ),
    survivor(
      'def f(a: Dict[str, \u0000], *args: Tuple[int, \u0000], **kw: Dict[str, \u0000]):\n    pass\n',
      "(module (function_definition name: (identifier) parameters: (parameters (typed_parameter (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0')))))) (typed_parameter (list_splat_pattern (identifier)) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0')))))) (typed_parameter (dictionary_splat_pattern (identifier)) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))))) body: (block (pass_statement))))",
      'f',
      'f(a: Dict[str, ], args: Tuple[int, ], kw: Dict[str, ])',
      param('a', 0),
      param('args', 1),
      param('kw', 2),
    ),
  ];

  for (const c of SURVIVORS) {
    it(`${JSON.stringify(c.text.split('\n').find((l) => l.includes('(')))}: ${c.signature}`, async () => {
      const r = await run('m.py', c.text);
      expect(r.tree).toBe(c.tree);
      const file = okFile(r);
      expect(problems(r, file)).toEqual([]);
      expect(propsOf(file, c.method)).toMatchObject({
        signature: c.signature,
        params_count: c.params.length,
      });
      expect(paramProps(file, c.method)).toStrictEqual(c.params);
    });
  }

  // r2 (review 4): `z` holds its NUL in the value, which is no property, so it keeps its type_text.
  const MEMBERS = [
    [
      'x: Dict[str, \u0000] = 1\ny: int = 2\nz: int = [1, \u0000]\n',
      "(module (expression_statement (assignment left: (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))) right: (integer))) (expression_statement (assignment left: (identifier) type: (type (identifier)) right: (integer))) (expression_statement (assignment left: (identifier) type: (type (identifier)) right: (list (integer) (ERROR (UNEXPECTED '\\0'))))))",
      ['x', 'y', 'z'],
    ],
    [
      'class C:\n    x: Dict[str, \u0000]\n    y: int = 2\n',
      "(module (class_definition name: (identifier) body: (block (expression_statement (assignment left: (identifier) type: (type (generic_type (identifier) (type_parameter (type (identifier)) (ERROR (UNEXPECTED '\\0'))))))) (expression_statement (assignment left: (identifier) type: (type (identifier)) right: (integer))))))",
      ['C.x', 'C.y'],
    ],
  ] as const;
  const MEMBER_PROPS = [
    { name: 'x' },
    { name: 'y', type_text: 'int' },
    { name: 'z', type_text: 'int' },
  ];

  for (const [text, tree, ids] of MEMBERS) {
    it(`a NUL in a MEMBER's annotation drops its type_text only (${ids.join(', ')})`, async () => {
      const r = await run('m.py', text);
      expect(r.tree).toBe(tree);
      const file = okFile(r);
      expect(problems(r, file)).toEqual([]);
      expect(ids.map((x) => propsOf(file, `file:m.py:MEMBER:${x}`))).toStrictEqual(
        MEMBER_PROPS.slice(0, ids.length),
      );
    });
  }
});
