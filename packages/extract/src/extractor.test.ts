// The Extractor front door on hand-built SyntaxNodes (no wasm): request checks, I4, I25, the MODULE
// tier (rung 01's shape, ladder README range rule, decisions 90 and 92), the container shell, the
// budget (I17) and determinism (I3, I6, I18). The real-parser run over the ladder is ladder.test.ts.
import { isWorkspacePath, type WorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import type {
  ContainerKind,
  ExtractOutcome,
  ExtractRequest,
  LanguageAdapter,
  SyntaxNode,
  TypeDeclInfo,
} from './contract';
import { createExtractor, extractFile } from './extractor';
import { pythonAdapter } from './python';
import { EXTRACT_CONTRACT_VERSION } from './version';

function wsPath(value: string): WorkspacePath {
  if (!isWorkspacePath(value)) throw new Error(`not a workspace path: ${value}`);
  return value;
}

type At = readonly [row: number, column: number];

/** A tree node with no fields and no text: enough for the MODULE tier. */
function fake(
  type: string,
  start: At,
  end: At,
  namedChildren: readonly SyntaxNode[] = [],
): SyntaxNode {
  return {
    type,
    startPosition: { row: start[0], column: start[1] },
    endPosition: { row: end[0], column: end[1] },
    startIndex: 0,
    endIndex: 0,
    text: '',
    namedChildren,
    childForFieldName: () => null,
  };
}

const REV = '3c'.repeat(32);
const EMPTY = fake('module', [0, 0], [0, 0]);
const request = (over: Partial<ExtractRequest> = {}): ExtractRequest => ({
  path: wsPath('main.py'),
  grammarId: 'python',
  root: EMPTY,
  revision_id: REV,
  lineCount: 0,
  ...over,
});
const extract = (over: Partial<ExtractRequest> = {}): ExtractOutcome =>
  createExtractor().extract(request(over));

function okFile(outcome: ExtractOutcome) {
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.file;
}
const errorOf = (outcome: ExtractOutcome) =>
  outcome.kind === 'failed' ? { code: outcome.error.code, path: outcome.error.path } : outcome.kind;

const SHA_OF_EMPTY_LIST = 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const MOD = 'file:main.py:MODULE:$root';

// Three top-level statements with distinct types and rows, so a wrong index cannot pass.
const FIRST = fake('import_statement', [0, 0], [0, 9]);
const THIRD = fake('expression_statement', [5, 0], [5, 7]);
const STATEMENTS = [
  FIRST,
  fake('function_definition', [2, 0], [3, 8], [fake('identifier', [2, 4], [2, 9])]),
  THIRD,
];
const THREE = fake('module', [0, 0], [6, 0], STATEMENTS);

describe('Extractor surface (decision 96)', () => {
  it('extracts python only, under one contract version', () => {
    const extractor = createExtractor();
    expect(extractor.grammars).toEqual(['python']);
    expect(extractor.contractVersion).toBe(EXTRACT_CONTRACT_VERSION);
    expect(extractor.coverage('python')).toBe(pythonAdapter.coverage());
  });

  it('has no CoverageManifest for a grammar it cannot extract', () => {
    expect(() => createExtractor().coverage('typescript')).toThrow(/typescript/);
  });

  it.each(['typescript', 'tsx', 'javascript', 'ruby', '', 'toString', '__proto__', 'constructor'])(
    'fails grammar-unsupported for %j, never an empty ok (I25)',
    (grammarId) => {
      const root = fake('program', [0, 0], [1, 0]);
      expect(errorOf(extract({ grammarId, root }))).toEqual({
        code: 'grammar-unsupported',
        path: 'main.py',
      });
    },
  );

  it('checks the grammar before the path', () => {
    const forged = Object.assign(request({ grammarId: 'typescript' }), { path: '/abs/main.ts' });
    expect(errorOf(createExtractor().extract(forged))).toEqual({
      code: 'grammar-unsupported',
      path: '/abs/main.ts',
    });
  });
});

describe('request checks', () => {
  it.each(['/abs/main.py', '../main.py', '.', 'a//b.py', '', 'a/./b.py', 'pkg/'])(
    'fails path-not-relative for %j',
    (path) => {
      const forged = Object.assign(request(), { path });
      expect(errorOf(createExtractor().extract(forged))).toEqual({
        code: 'path-not-relative',
        path,
      });
    },
  );

  it("reports '' as the path when the path is not a string", () => {
    const forged = Object.assign(request(), { path: 42 });
    expect(errorOf(extractFile(forged, pythonAdapter))).toEqual({
      code: 'path-not-relative',
      path: '',
    });
  });

  it('fails tier-disabled when the expression tier is asked for (I16)', () => {
    expect(errorOf(extract({ tiers: { expression: true } }))).toEqual({
      code: 'tier-disabled',
      path: 'main.py',
    });
    expect(extract({ tiers: { expression: false } }).kind).toBe('ok');
    expect(extract({ tiers: {} }).kind).toBe('ok');
  });

  it.each([
    { maxNodes: 0 },
    { maxNodes: -1 },
    { maxNodes: 1.5 },
    { maxNodes: Number.NaN },
    { maxNodes: Number.POSITIVE_INFINITY },
    { maxNodes: 2 ** 53 },
    { maxDepth: -1 },
    { maxDepth: 0.5 },
    { maxDepth: Number.POSITIVE_INFINITY },
    { maxDepth: 2 ** 53 },
    { maxDepth: Number.NaN },
    { maxNodes: 10, maxDepth: -2 },
  ])('fails budget-invalid for %j', (budget) => {
    expect(errorOf(extract({ budget }))).toEqual({ code: 'budget-invalid', path: 'main.py' });
  });

  it.each([{}, { maxNodes: 1 }, { maxDepth: 0 }, { maxNodes: 2 ** 53 - 1, maxDepth: 0 }])(
    'accepts the budget %j on an empty file',
    (budget) => {
      expect(extract({ budget }).kind).toBe('ok');
    },
  );

  it('fails root-type-mismatch when the root is not a python module', () => {
    const root = fake('program', [0, 0], [0, 0]);
    expect(errorOf(extract({ root }))).toEqual({ code: 'root-type-mismatch', path: 'main.py' });
  });

  it.each([
    [
      'the path before the tier',
      { path: '/abs.py', tiers: { expression: true } },
      'path-not-relative',
    ],
    [
      'the tier before the budget',
      { tiers: { expression: true }, budget: { maxNodes: 0 } },
      'tier-disabled',
    ],
    [
      'the budget before the root',
      { budget: { maxNodes: 0 }, root: fake('program', [0, 0], [0, 0]) },
      'budget-invalid',
    ],
  ] as const)('checks %s (r2)', (_name, over, code) => {
    const forged = Object.assign(request(), over);
    expect(errorOf(createExtractor().extract(forged))).toMatchObject({ code });
  });

  it("reports '' as the path of an unsupported grammar when the path is not a string (r2)", () => {
    const forged = Object.assign(request({ grammarId: 'ruby' }), { path: null });
    expect(errorOf(createExtractor().extract(forged))).toEqual({
      code: 'grammar-unsupported',
      path: '',
    });
  });
});

const DECLARATION: TypeDeclInfo = {
  declares: 'TYPE_DECL',
  name: 'Greeter',
  kind: 'class',
  exported: true,
  structural: true,
  body: undefined,
};

const throwing = (part: 'classify' | 'moduleName'): LanguageAdapter => ({
  ...pythonAdapter,
  [part]: () => {
    throw new Error(`boom in ${part}`);
  },
});

describe('extract never throws (I4)', () => {
  it.each(['classify', 'moduleName'] as const)('turns a throw in %s into internal', (part) => {
    const outcome = extractFile(request({ root: THREE }), throwing(part));
    expect(outcome).toEqual({
      kind: 'failed',
      error: { code: 'internal', message: `boom in ${part}`, path: 'main.py' },
    });
  });

  it('turns a tree that throws into internal', () => {
    const root = Object.defineProperty(fake('module', [0, 0], [1, 0]), 'namedChildren', {
      get: () => {
        throw new Error('tree released');
      },
    });
    expect(errorOf(extract({ root }))).toEqual({ code: 'internal', path: 'main.py' });
  });

  it('reports a broken runtime invariant as internal (I19 through the builder)', () => {
    const adapter: LanguageAdapter = { ...pythonAdapter, moduleName: () => 'ma\u0000in' };
    const outcome = extractFile(request(), adapter);
    if (outcome.kind !== 'failed') throw new Error(`expected failed, got ${outcome.kind}`);
    expect(outcome.error.code).toBe('internal');
    expect(outcome.error.message).toMatch(/^C-EXTRACT I19: /);
  });

  it('fails internal on a declaration: Pass A is SEAT until U6a.2-3 (r2)', () => {
    const declaring: LanguageAdapter = { ...pythonAdapter, classify: () => DECLARATION };
    const outcome = extractFile(request({ root: THREE }), declaring);
    if (outcome.kind !== 'failed') throw new Error(`expected failed, got ${outcome.kind}`);
    expect([outcome.error.code, outcome.error.message]).toEqual([
      'internal',
      'SEAT: Pass A declarations land in U6a.2-3',
    ]);
  });
});

describe('the MODULE tier', () => {
  it('is rung 01 for an empty main.py: MODULE, its SYMBOL, DEFINES (decisions 90, 92)', () => {
    expect(okFile(extract())).toEqual({
      path: 'main.py',
      grammarId: 'python',
      revision_id: REV,
      nodes: [
        {
          label: 'MODULE',
          id: MOD,
          file: 'main.py',
          revision_id: REV,
          tier: 'structural',
          range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
          properties: { name: 'main', status: 'ready' },
        },
      ],
      symbols: [
        { fqn: '`main.py`/', origin: 'local', language: 'python', properties: { kind: 'module' } },
      ],
      edges: [
        {
          type: 'DEFINES',
          from: { by: 'id', label: 'MODULE', key: MOD },
          to: { by: 'fqn', label: 'SYMBOL', key: '`main.py`/' },
          properties: {},
        },
      ],
      refSites: [],
      stats: { astNodesVisited: 1, structuralNodes: 1, expressionNodes: 0, lineCount: 0 },
      elementDigest: 'fnv1a32:ac9b85e9',
      interfaceHash: SHA_OF_EMPTY_LIST,
    });
  });

  it('spans the whole file from 1:0, wherever tree-sitter starts the root', () => {
    // Probed: "\n\nx = 1\n" gives a root at (2,0)-(3,0); "   \n  " gives (1,2)-(1,2).
    const blankAbove = fake(
      'module',
      [2, 0],
      [3, 0],
      [fake('expression_statement', [2, 0], [2, 5])],
    );
    const onlySpace = fake('module', [1, 2], [1, 2]);
    expect(okFile(extract({ root: blankAbove })).nodes[0]?.range).toEqual({
      startRow: 0,
      startColumn: 0,
      endRow: 3,
      endColumn: 0,
    });
    expect(okFile(extract({ root: onlySpace })).nodes[0]?.range).toEqual({
      startRow: 0,
      startColumn: 0,
      endRow: 1,
      endColumn: 2,
    });
  });

  it('names the MODULE by its dotted module name and keys it by its own path', () => {
    const file = okFile(extract({ path: wsPath('shapes/square.py') }));
    expect(file.nodes.map((n) => [n.id, n.file, n.properties['name']])).toEqual([
      ['file:shapes/square.py:MODULE:$root', 'shapes/square.py', 'shapes.square'],
    ]);
    expect(file.symbols.map((s) => s.fqn)).toEqual(['`shapes/square.py`/']);
    expect(file.edges.map((e) => [e.from.key, e.to.key])).toEqual([
      ['file:shapes/square.py:MODULE:$root', '`shapes/square.py`/'],
    ]);
  });

  it('mints ids and fqns through makeNodeId and makeSymbolFqn (a colon in the path)', () => {
    const file = okFile(extract({ path: wsPath('a:b.py') }));
    expect(file.nodes[0]?.id).toBe('file:a%3Ab.py:MODULE:$root');
    expect(file.symbols[0]?.fqn).toBe('`a:b.py`/');
    // r2: makeSymbolFqn doubles a backtick; makeNodeId leaves it.
    const quoted = okFile(extract({ path: wsPath('a`b.py') }));
    expect([quoted.nodes[0]?.id, quoted.symbols[0]?.fqn]).toEqual([
      'file:a`b.py:MODULE:$root',
      '`a``b.py`/',
    ]);
  });

  it('reads the root type, the language and the module name from the adapter (r2)', () => {
    const other: LanguageAdapter = {
      ...pythonAdapter,
      grammarId: 'other',
      language: 'otherlang',
      moduleRootType: 'source_file',
      moduleName: () => 'M',
    };
    const root = fake('source_file', [0, 0], [1, 0]);
    const file = okFile(extractFile(request({ grammarId: 'other', root }), other));
    expect([file.grammarId, file.nodes[0]?.properties['name'], file.symbols[0]?.language]).toEqual([
      'other',
      'M',
      'otherlang',
    ]);
    expect(errorOf(extractFile(request({ grammarId: 'other' }), other))).toEqual({
      code: 'root-type-mismatch',
      path: 'main.py',
    });
  });

  it('classifies each top-level named child once, in order, as a MODULE child', () => {
    const calls: [string, ContainerKind][] = [];
    const recording: LanguageAdapter = {
      ...pythonAdapter,
      classify: (node, container) => {
        calls.push([node.type, container]);
        return undefined;
      },
    };
    const outcome = extractFile(request({ root: THREE }), recording);
    expect(calls).toEqual(STATEMENTS.map((s) => [s.type, 'MODULE']));
    // The root and its three children; the identifier inside the def is not visited at this tier.
    expect(okFile(outcome).stats.astNodesVisited).toBe(4);
    expect(okFile(outcome).nodes.map((n) => n.label)).toEqual(['MODULE']);
  });

  it('passes lineCount through and counts nodes by tier', () => {
    const file = okFile(extract({ root: THREE, lineCount: 7 }));
    expect(file.stats).toEqual({
      astNodesVisited: 4,
      structuralNodes: 1,
      expressionNodes: 0,
      lineCount: 7,
    });
  });
});

const droppedAt = (node: SyntaxNode) => ({
  droppedAtNodeType: node.type,
  droppedRange: {
    startRow: node.startPosition.row,
    startColumn: node.startPosition.column,
    endRow: node.endPosition.row,
    endColumn: node.endPosition.column,
  },
});

describe('the budget (I17)', () => {
  it.each([
    ['maxNodes 3 drops the third statement', { maxNodes: 3 }, 'maxNodes', 3, THIRD, 3],
    ['maxNodes 1 drops the first statement', { maxNodes: 1 }, 'maxNodes', 1, FIRST, 1],
    ['maxDepth 0 drops the first statement', { maxDepth: 0 }, 'maxDepth', 0, FIRST, 1],
    ['maxDepth before maxNodes', { maxDepth: 0, maxNodes: 1 }, 'maxDepth', 0, FIRST, 1],
  ] as const)('%s', (_name, budget, limit, limitValue, dropped, visited) => {
    const outcome = extract({ root: THREE, budget });
    if (outcome.kind !== 'truncated') throw new Error(`expected truncated, got ${outcome.kind}`);
    expect(outcome.truncation).toEqual({ limit, limitValue, ...droppedAt(dropped) });
    expect(outcome.file.stats.astNodesVisited).toBe(visited);
    expect(outcome.file.nodes.map((n) => n.id)).toEqual([MOD]);
    expect(outcome.file.edges).toHaveLength(1);
  });

  it('has no hidden cap: 5000 statements and no budget are all visited (r2)', () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      fake('expression_statement', [i, 0], [i, 5]),
    );
    const file = okFile(extract({ root: fake('module', [0, 0], [5000, 0], many) }));
    expect(file.stats.astNodesVisited).toBe(5001);
  });

  it('does not classify the child it drops (r2)', () => {
    const seen: string[] = [];
    const recording: LanguageAdapter = {
      ...pythonAdapter,
      classify: (node) => {
        seen.push(node.type);
        return undefined;
      },
    };
    const outcome = extractFile(request({ root: THREE, budget: { maxNodes: 2 } }), recording);
    expect([outcome.kind, seen]).toEqual(['truncated', [FIRST.type]]);
  });

  it.each([{ maxNodes: 4 }, { maxDepth: 1 }, { maxNodes: 4, maxDepth: 1 }])(
    'is ok exactly at %j',
    (budget) => {
      expect(okFile(extract({ root: THREE, budget })).stats.astNodesVisited).toBe(4);
    },
  );
});

describe('determinism and identity (I3, I6, I18)', () => {
  it('gives byte-identical output for the same request, on any extractor', () => {
    const first = JSON.stringify(createExtractor().extract(request({ root: THREE })));
    const again = JSON.stringify(createExtractor().extract(request({ root: THREE })));
    expect(again).toBe(first);
  });

  it('keeps ids, elements and elementDigest when only revision_id changes', () => {
    const before = okFile(extract({ root: THREE }));
    const after = okFile(extract({ root: THREE, revision_id: 'e5'.repeat(32) }));
    expect(after.revision_id).toBe('e5'.repeat(32));
    expect(after.nodes.map((n) => n.revision_id)).toEqual(['e5'.repeat(32)]);
    expect(after.nodes.map((n) => ({ ...n, revision_id: REV }))).toEqual(before.nodes);
    expect([after.symbols, after.edges]).toEqual([before.symbols, before.edges]);
    expect(after.elementDigest).toBe(before.elementDigest);
  });

  it('keeps the MODULE id when the file grows', () => {
    const grown = okFile(extract({ root: THREE }));
    expect(grown.nodes[0]?.id).toBe(okFile(extract()).nodes[0]?.id);
  });
});
