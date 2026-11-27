// toWriteOp, from C-STORE (DQ-03 fold), controller decisions 97 and 113 and the schema's property lists.
// Every expected value is written by hand from the spec: ranges 0-based in, 1-based lines out.

import type { EdgeElement, ExtractedFile, NodeElement, SymbolElement } from '@cpg/extract';
import type { SourceRange, WorkspacePath } from '@cpg/model';
import { isWorkspacePath } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import { toWriteOp } from './write-op';

function wp(s: string): WorkspacePath {
  if (!isWorkspacePath(s)) throw new Error(`not a WorkspacePath: ${s}`);
  return s;
}
const range = (startRow: number, startColumn: number, endRow: number, endColumn: number) =>
  ({ startRow, startColumn, endRow, endColumn }) satisfies SourceRange;

const PATH = wp('pkg/main.py');
const REV = 'a1'.repeat(32);
const OLD_REV = 'b2'.repeat(32);
const MOD_ID = 'file:pkg/main.py:MODULE:$root';
const GREET_ID = 'file:pkg/main.py:METHOD:greet';
const IMPORT_ID = 'file:pkg/main.py:IMPORT:$root:0';
const MOD_FQN = '`pkg/main.py`/';
const GREET_FQN = '`pkg/main.py`/greet().';
const UTIL_FQN = '`pkg/util.py`/helper().';

const MODULE: NodeElement = {
  label: 'MODULE',
  id: MOD_ID,
  file: PATH,
  revision_id: REV,
  tier: 'structural',
  range: range(0, 0, 4, 0),
  properties: { name: 'main', status: 'ready' },
};
const GREET: NodeElement = {
  label: 'METHOD',
  id: GREET_ID,
  file: PATH,
  revision_id: REV,
  tier: 'structural',
  range: range(1, 4, 2, 12),
  nameRange: range(1, 8, 1, 13),
  properties: { name: 'greet', kind: 'function', params_count: 0, exported: true },
};
// Its own revision differs from the file's: a row carries the element's.
const IMPORT: NodeElement = {
  label: 'IMPORT',
  id: IMPORT_ID,
  file: PATH,
  revision_id: OLD_REV,
  tier: 'expression',
  range: range(3, 0, 3, 22),
  properties: { imported_names: ['path', 'sep'] },
};
const MOD_SYM: SymbolElement = {
  fqn: MOD_FQN,
  origin: 'local',
  language: 'python',
  properties: { kind: 'module' },
};
const GREET_SYM: SymbolElement = {
  fqn: GREET_FQN,
  origin: 'external',
  language: 'python',
  properties: { kind: 'function', aliases: ['hello'] },
};
const DECLARES: EdgeElement = {
  type: 'DECLARES',
  from: { by: 'id', label: 'MODULE', key: MOD_ID },
  to: { by: 'id', label: 'METHOD', key: GREET_ID },
  properties: {},
};
const DEFINES: EdgeElement = {
  type: 'DEFINES',
  from: { by: 'id', label: 'METHOD', key: GREET_ID },
  to: { by: 'fqn', label: 'SYMBOL', key: GREET_FQN },
  properties: { roles: ['definition'] },
};
const RESOLVED: EdgeElement = {
  type: 'IMPORTS',
  from: { by: 'id', label: 'IMPORT', key: IMPORT_ID },
  to: { by: 'fqn', label: 'SYMBOL', key: UTIL_FQN },
  properties: { status: 'resolved', resolved_by: 'python-path' },
};
const RESOLVED_PROPS = { status: 'resolved', resolved_by: 'python-path' };
const FILE: ExtractedFile = {
  path: PATH,
  grammarId: 'python',
  revision_id: REV,
  nodes: [MODULE, GREET, IMPORT],
  symbols: [MOD_SYM, GREET_SYM],
  edges: [DECLARES, DEFINES],
  refSites: [],
  stats: { astNodesVisited: 41, structuralNodes: 3, expressionNodes: 1, lineCount: 5 },
  elementDigest: 'fnv1a32:0000beef',
  interfaceHash: 'c3'.repeat(32),
};

// Expected rows, spelt by hand: `owned` is what every file-owned row gains.
const owned = (revision_id: string, at: string) => ({
  file: 'pkg/main.py',
  revision_id,
  range: at,
});
const nodeRow = (label: string, key: string, properties: Record<string, unknown>) => ({
  label,
  key,
  properties,
});
const edgeRow = (
  type: string,
  fromLabel: string,
  fromKey: string,
  toLabel: string,
  toKey: string,
  properties: Record<string, unknown>,
) => ({ type, fromLabel, fromKey, toLabel, toKey, properties });

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('toWriteOp', () => {
  it('builds the replace-file row by row: elements, symbols, the FILE code half, then edges', () => {
    expect(toWriteOp(FILE, [RESOLVED], 7)).toStrictEqual({
      kind: 'replace-file',
      file: 'pkg/main.py',
      seq: 7,
      revision_id: REV,
      nodes: [
        nodeRow('MODULE', MOD_ID, { name: 'main', status: 'ready', ...owned(REV, '1:0-5:0') }),
        nodeRow('METHOD', GREET_ID, {
          name: 'greet',
          kind: 'function',
          params_count: 0,
          exported: true,
          ...owned(REV, '2:4-3:12'),
          // U6a.2-3 (decisions 108, 113): a nameRange is written as the schema's name_range
          name_range: '2:8-2:13',
        }),
        nodeRow('IMPORT', IMPORT_ID, {
          imported_names: ['path', 'sep'],
          ...owned(OLD_REV, '4:0-4:22'),
        }),
        nodeRow('SYMBOL', MOD_FQN, { kind: 'module', fqn: MOD_FQN, language: 'python' }),
        nodeRow('SYMBOL', GREET_FQN, {
          kind: 'function',
          aliases: ['hello'],
          fqn: GREET_FQN,
          language: 'python',
        }),
        nodeRow('FILE', 'pkg/main.py', { interface_hash: 'c3'.repeat(32), loc: 5 }),
      ],
      edges: [
        edgeRow('DECLARES', 'MODULE', MOD_ID, 'METHOD', GREET_ID, {}),
        edgeRow('DEFINES', 'METHOD', GREET_ID, 'SYMBOL', GREET_FQN, { roles: ['definition'] }),
        edgeRow('IMPORTS', 'IMPORT', IMPORT_ID, 'SYMBOL', UTIL_FQN, RESOLVED_PROPS),
      ],
    });
  });

  it('lets the element fields win over a property of the same name', () => {
    const clash: ExtractedFile = {
      ...FILE,
      nodes: [
        {
          ...MODULE,
          properties: { name: 'main', file: 'x.py', revision_id: 'r', range: '9:9-9:9' },
        },
      ],
      symbols: [{ ...MOD_SYM, properties: { kind: 'module', fqn: 'wrong', language: 'js' } }],
      edges: [],
    };
    const op = toWriteOp(clash, [], 0);
    expect(op.nodes.map((row) => row.properties)).toStrictEqual([
      { name: 'main', file: 'pkg/main.py', revision_id: REV, range: '1:0-5:0' },
      { kind: 'module', fqn: MOD_FQN, language: 'python' },
      { interface_hash: 'c3'.repeat(32), loc: 5 },
    ]);
  });

  it('writes an empty file as its MODULE row and the FILE code half, and keeps the resolved edges', () => {
    const empty: ExtractedFile = {
      ...FILE,
      nodes: [{ ...MODULE, range: range(0, 0, 0, 0) }],
      symbols: [],
      edges: [],
      stats: { astNodesVisited: 1, structuralNodes: 1, expressionNodes: 0, lineCount: 0 },
      interfaceHash: 'd4'.repeat(32),
    };
    const op = toWriteOp(empty, [RESOLVED], 12);
    expect([op.seq, op.nodes.map((row) => [row.label, row.properties['range']])]).toEqual([
      12,
      [
        ['MODULE', '1:0-1:0'],
        ['FILE', undefined],
      ],
    ]);
    expect(op.nodes.find((row) => row.label === 'FILE')?.properties).toStrictEqual({
      interface_hash: 'd4'.repeat(32),
      loc: 0,
    });
    expect(op.edges.map((edge) => edge.type)).toEqual(['IMPORTS']);
  });

  it('mutates nothing and shares no object with its inputs', () => {
    const file = deepFreeze(structuredClone(FILE));
    const resolved = deepFreeze([structuredClone(RESOLVED)]);
    const op = toWriteOp(file, resolved, 1);
    const importRow = op.nodes.find((row) => row.key === IMPORT_ID);
    const fileRow = op.nodes.find((row) => row.label === 'FILE');
    const symbolRow = op.nodes.find((row) => row.key === GREET_FQN);
    const resolvedRow = op.edges.find((edge) => edge.type === 'IMPORTS');
    const definesRow = op.edges.find((edge) => edge.type === 'DEFINES');
    const inSymbol = file.symbols.find((s) => s.fqn === GREET_FQN)?.properties;
    const inDefines = file.edges.find((e) => e.type === 'DEFINES')?.properties;
    const shared = [
      importRow?.properties === file.nodes.find((n) => n.id === IMPORT_ID)?.properties,
      importRow?.properties['imported_names'] === IMPORT.properties['imported_names'],
      importRow?.properties['imported_names'] ===
        file.nodes.find((n) => n.id === IMPORT_ID)?.properties['imported_names'],
      symbolRow?.properties === file.symbols.find((s) => s.fqn === GREET_FQN)?.properties,
      resolvedRow?.properties === resolved.find((e) => e.type === 'IMPORTS')?.properties,
      symbolRow?.properties['aliases'] === inSymbol?.['aliases'],
      definesRow?.properties === inDefines,
      definesRow?.properties['roles'] === inDefines?.['roles'],
      fileRow === undefined,
    ];
    expect(shared).toEqual(Array(9).fill(false));
    expect([symbolRow?.properties['aliases'], definesRow?.properties['roles']]).toEqual([
      ['hello'],
      ['definition'],
    ]);
    expect(importRow?.properties['imported_names']).toEqual(['path', 'sep']);
  });

  it('throws on an invalid range: a producer bug', () => {
    const bad: ExtractedFile = { ...FILE, nodes: [{ ...GREET, range: range(2, 0, 1, 0) }] };
    expect(() => toWriteOp(bad, [], 0)).toThrow(/invalid source range/);
  });

  // U6a.2-3 (decision 113; stop-list 194): METHOD writes name_range, formatted like range.
  it('writes name_range from nameRange only, and the element field wins over a property', () => {
    const named: ExtractedFile = {
      ...FILE,
      nodes: [
        { ...GREET, nameRange: range(0, 4, 0, 9), properties: { name_range: '9:9-9:9' } },
        { ...MODULE, properties: { name_range: '8:0-8:1' } },
      ],
      symbols: [],
      edges: [],
    };
    expect(toWriteOp(named, [], 0).nodes.map((row) => row.properties['name_range'])).toEqual([
      '1:4-1:9',
      '8:0-8:1',
      undefined,
    ]);
    const bad: ExtractedFile = { ...FILE, nodes: [{ ...GREET, nameRange: range(1, 9, 1, 8) }] };
    expect(() => toWriteOp(bad, [], 0)).toThrow(/invalid source range/);
  });
});
