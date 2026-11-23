/** The assembled v1 CPG schema: shape and self-consistency (M0.0), plus the v3 revision_id rule. */
import { describe, expect, test } from 'vitest';

import {
  CPG_SCHEMA,
  EDGE_TYPES,
  ID_RULE,
  NODE_LABELS,
  RESERVED_EDGES,
  RESOLUTION_STATUS,
  SCHEMA_CONSTRAINTS,
  SCHEMA_INDEXES,
  edgeSpec,
  nodeSpec,
  type EdgeTypeSpec,
  type NodeLabelSpec,
} from '../index';
import { ownedBy } from './owner';

describe('v1 schema shape', () => {
  test('declares exactly the 14 R6-approved node labels', () => {
    const labels: string[] = NODE_LABELS.map((n) => n.label);
    const expected: string[] = [
      'CALL',
      'COMMUNITY',
      'DIRECTORY',
      'FILE',
      'IMPORT',
      'MEMBER',
      'META_DATA',
      'METHOD',
      'MODULE',
      'PARAM',
      'SYMBOL',
      'TAG',
      'TYPE_DECL',
      'UNKNOWN',
    ];
    expect(labels).toHaveLength(14);
    expect(new Set(labels)).toEqual(new Set(expected));
  });

  test('declares exactly the 15 v1 edge types (R6 + sparse REACHING_DEF + SOURCE_FILE)', () => {
    const types: string[] = EDGE_TYPES.map((e) => e.type);
    const expected: string[] = [
      'ALIAS_OF',
      'CALLS',
      'DECLARES',
      'DEFINES',
      'DEPENDS_ON',
      'HAS_ENTRY',
      'HAS_PARAM',
      'IMPORTS',
      'IN_SCOPE',
      'INHERITS_FROM',
      'MEMBER_OF',
      'REACHING_DEF',
      'SOURCE_FILE',
      'TAGGED_BY',
      'TARGETS',
    ];
    expect(types).toHaveLength(15);
    expect(new Set(types)).toEqual(new Set(expected));
  });

  test('no duplicate labels or edge types', () => {
    expect(new Set(NODE_LABELS.map((n) => n.label)).size).toBe(NODE_LABELS.length);
    expect(new Set(EDGE_TYPES.map((e) => e.type)).size).toBe(EDGE_TYPES.length);
  });

  test("every edge's endpoint labels are declared node labels", () => {
    const declared = new Set<string>(NODE_LABELS.map((n) => n.label));
    for (const edge of EDGE_TYPES) {
      for (const label of [...edge.from, ...edge.to]) {
        expect(declared.has(label)).toBe(true);
      }
    }
  });

  test('nodeSpec/edgeSpec resolve every declared label and type, and nothing else', () => {
    for (const n of NODE_LABELS) {
      expect(nodeSpec(n.label)).toBe(n);
    }
    for (const e of EDGE_TYPES) {
      expect(edgeSpec(e.type)).toBe(e);
    }
    expect(nodeSpec('NOT_A_LABEL')).toBeUndefined();
    expect(edgeSpec('NOT_AN_EDGE')).toBeUndefined();
  });
});

describe('schema version 3 and revision_id (P-B, F-1, ND-5)', () => {
  test('CPG_SCHEMA is version 3 and assembles the registry', () => {
    expect(CPG_SCHEMA).toEqual({
      version: 3,
      idRule: ID_RULE,
      nodes: NODE_LABELS,
      edges: EDGE_TYPES,
      reservedEdges: RESERVED_EDGES,
      indexes: SCHEMA_INDEXES,
      constraints: SCHEMA_CONSTRAINTS,
    });
  });

  test('FILE and every :CPG label carry revision_id as a required, golden-excluded string', () => {
    const carriers = NODE_LABELS.filter((n) =>
      n.properties.some((p) => p.name === 'revision_id'),
    ).map((n) => n.label);
    expect(carriers).toEqual([
      'FILE',
      'MODULE',
      'TYPE_DECL',
      'METHOD',
      'PARAM',
      'MEMBER',
      'CALL',
      'IMPORT',
      'UNKNOWN',
    ]);
    const cpgLabels = NODE_LABELS.filter((n) => n.cpgCoLabel).map((n) => n.label);
    expect(carriers).toEqual(expect.arrayContaining(cpgLabels));
    for (const label of carriers) {
      expect(nodeSpec(label)?.properties.find((p) => p.name === 'revision_id')).toMatchObject({
        type: 'string',
        cardinality: 'one',
        golden: 'exclude',
      });
    }
  });

  test('DIRECTORY, SYMBOL, TAG, COMMUNITY, META_DATA and every edge carry no revision_id', () => {
    for (const label of ['DIRECTORY', 'SYMBOL', 'TAG', 'COMMUNITY', 'META_DATA']) {
      expect(nodeSpec(label)?.properties.map((p) => p.name)).not.toContain('revision_id');
    }
    for (const e of EDGE_TYPES) {
      expect(e.properties.map((p) => p.name)).not.toContain('revision_id');
    }
  });
});

describe('ownership, write mechanism and identity key (unchanged from the archived registry)', () => {
  test('every node label keeps its ownership, write and key', () => {
    const columns = Object.fromEntries(
      NODE_LABELS.map((n) => [n.label, [n.ownership, n.write, n.key]]),
    );
    expect(columns).toEqual({
      DIRECTORY: ['filesystem', 'merge-on-key', ['path']],
      FILE: ['filesystem', 'merge-on-key', ['path']],
      MODULE: ['file-owned', 'delete-create', ['id']],
      TYPE_DECL: ['file-owned', 'delete-create', ['id']],
      METHOD: ['file-owned', 'delete-create', ['id']],
      PARAM: ['file-owned', 'delete-create', ['id']],
      MEMBER: ['file-owned', 'delete-create', ['id']],
      CALL: ['file-owned', 'delete-create', ['id']],
      IMPORT: ['file-owned', 'delete-create', ['id']],
      SYMBOL: ['identity', 'merge-on-key', ['fqn']],
      COMMUNITY: ['overlay', 'overlay-job', ['id']],
      TAG: ['identity', 'merge-on-key', ['name']],
      UNKNOWN: ['file-owned', 'delete-create', ['id']],
      META_DATA: ['graph-singleton', 'merge-on-key', []],
    });
  });

  test('every edge type keeps its ownership and write', () => {
    const columns = Object.fromEntries(EDGE_TYPES.map((e) => [e.type, [e.ownership, e.write]]));
    expect(columns).toEqual({
      HAS_ENTRY: ['filesystem', 'move-rename-only'],
      DECLARES: ['file-owned', 'delete-create'],
      HAS_PARAM: ['file-owned', 'delete-create'],
      DEFINES: ['file-owned', 'delete-create'],
      CALLS: ['file-owned', 'delete-create'],
      IN_SCOPE: ['file-owned', 'delete-create'],
      IMPORTS: ['file-owned', 'delete-create'],
      INHERITS_FROM: ['file-owned', 'delete-create'],
      MEMBER_OF: ['overlay', 'overlay-job'],
      ALIAS_OF: ['identity', 'merge-on-key'],
      TAGGED_BY: ['identity', 'merge-on-key'],
      TARGETS: ['overlay', 'overlay-job'],
      DEPENDS_ON: ['overlay', 'overlay-job'],
      REACHING_DEF: ['file-owned', 'delete-create'],
      SOURCE_FILE: ['file-owned', 'delete-create'],
    });
  });
});

describe('SYMBOL indirection invariants (D5)', () => {
  test('SYMBOL is not :CPG and has no `file` property', () => {
    const symbol = nodeSpec('SYMBOL');
    expect(symbol?.cpgCoLabel).toBe(false);
    expect(symbol?.hasFileProperty).toBe(false);
  });

  test('META_DATA is not :CPG and has no `file` property', () => {
    const metaData = nodeSpec('META_DATA');
    expect(metaData?.cpgCoLabel).toBe(false);
    expect(metaData?.hasFileProperty).toBe(false);
  });

  test('every other :CPG-bearing label DOES carry a `file` property', () => {
    const nodes: readonly NodeLabelSpec[] = NODE_LABELS;
    expect(nodes.filter((n) => n.cpgCoLabel && !n.hasFileProperty)).toEqual([]);
  });
});

describe('overlay classification (R6 overlay-edge rule)', () => {
  test('TARGETS, DEPENDS_ON and MEMBER_OF are overlay-owned, overlay-job written', () => {
    for (const type of ['TARGETS', 'DEPENDS_ON', 'MEMBER_OF']) {
      const edge = edgeSpec(type);
      expect(edge?.ownership).toBe('overlay');
      expect(edge?.write).toBe('overlay-job');
    }
  });

  test('file-owned edges are never overlay-job written', () => {
    const edges: readonly EdgeTypeSpec[] = EDGE_TYPES;
    expect(edges.filter((e) => e.ownership === 'file-owned' && e.write === 'overlay-job')).toEqual(
      [],
    );
  });
});

describe('shared resolution status vocabulary', () => {
  test('CALLS.status and IMPORTS.status reference the same array object, not a copy', () => {
    const callsStatus = edgeSpec('CALLS')?.properties.find((p) => p.name === 'status');
    const importsStatus = edgeSpec('IMPORTS')?.properties.find((p) => p.name === 'status');
    expect(callsStatus?.enumValues).toBe(RESOLUTION_STATUS);
    expect(importsStatus?.enumValues).toBe(RESOLUTION_STATUS);
  });
});

describe('INHERITS_FROM points at SYMBOL (M0.0 planning decision)', () => {
  test('from TYPE_DECL to SYMBOL, not directly to TYPE_DECL', () => {
    const edge = edgeSpec('INHERITS_FROM');
    expect(edge?.from).toEqual(['TYPE_DECL']);
    expect(edge?.to).toEqual(['SYMBOL']);
  });
});

describe('id rule', () => {
  test('matches the AM1/D31 formula, not the superseded content-hash formula', () => {
    expect(ID_RULE).toBe('path:kind:qualifiedScopePath[:ordinal|:bodyHash]');
    expect(ID_RULE).not.toContain('fileHash');
  });
});

describe('bootstrap data for M0.4', () => {
  test('declares the CPG.id / CPG.file / FILE.path / DIRECTORY.path / SYMBOL.fqn indexes', () => {
    expect(SCHEMA_INDEXES).toEqual([
      { label: 'CPG', properties: ['id'], kind: 'RANGE' },
      { label: 'CPG', properties: ['file'], kind: 'RANGE' },
      { label: 'FILE', properties: ['path'], kind: 'RANGE' },
      { label: 'DIRECTORY', properties: ['path'], kind: 'RANGE' },
      { label: 'SYMBOL', properties: ['fqn'], kind: 'RANGE' },
    ]);
  });

  test('every UNIQUE constraint has a supporting index (FalkorDB refuses one without it)', () => {
    for (const c of SCHEMA_CONSTRAINTS) {
      expect(SCHEMA_INDEXES).toContainEqual({
        label: c.label,
        properties: c.properties,
        kind: 'RANGE',
      });
    }
  });

  test('declares the UNIQUE SYMBOL.fqn constraint', () => {
    expect(SCHEMA_CONSTRAINTS).toContainEqual({
      type: 'UNIQUE',
      label: 'SYMBOL',
      properties: ['fqn'],
      entityType: 'NODE',
    });
  });
});

const ownersOf = (label: string): Record<string, string> =>
  Object.fromEntries((nodeSpec(label)?.properties ?? []).map((p) => [p.name, p.owner]));

describe('per-property owner (DQ-01c, D3, D4)', () => {
  test('every property of every node label and edge type declares owner filesystem|code', () => {
    const all = [
      ...NODE_LABELS.flatMap((n) => n.properties.map((p) => [n.label, p] as const)),
      ...EDGE_TYPES.flatMap((e) => e.properties.map((p) => [e.type, p] as const)),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const [, property] of all) {
      expect(['filesystem', 'code']).toContain(property.owner);
    }
  });

  test('FILE is split: the walker owns identity and hashes, the code tier owns the rest', () => {
    const owners = ownersOf('FILE');
    expect(owners).toEqual({
      path: 'filesystem',
      name: 'filesystem',
      language: 'filesystem',
      content_hash: 'filesystem',
      revision_id: 'filesystem',
      interface_hash: 'code',
      status: 'code',
      version: 'code',
      indexed_at: 'code',
      loc: 'code',
    });
  });

  test('DIRECTORY is entirely filesystem-owned', () => {
    expect(new Set(Object.values(ownersOf('DIRECTORY')))).toEqual(new Set(['filesystem']));
    expect(Object.keys(ownersOf('DIRECTORY'))).toEqual(['path', 'name', 'status']);
  });

  test('every other label, including revision_id on :CPG labels, is code-owned', () => {
    for (const n of NODE_LABELS) {
      if (n.label === 'FILE' || n.label === 'DIRECTORY') continue;
      for (const p of n.properties)
        expect([n.label, p.name, p.owner]).toEqual([n.label, p.name, 'code']);
    }
    expect(ownersOf('METHOD')['revision_id']).toBe('code');
  });

  test('every edge property is code-owned', () => {
    for (const e of EDGE_TYPES) {
      for (const p of e.properties)
        expect([e.type, p.name, p.owner]).toEqual([e.type, p.name, 'code']);
    }
  });
});

describe('ownedBy', () => {
  test('stamps owner on each property and leaves every other field unchanged', () => {
    const enumValues = ['x', 'y'] as const;
    const input = [
      { name: 'a', type: 'string', cardinality: 'one', golden: 'include' },
      { name: 'b', type: 'string', cardinality: 'one', golden: 'redact', enumValues },
    ] as const;
    const out = ownedBy('code', input);
    expect(out).toEqual([
      { name: 'a', type: 'string', cardinality: 'one', golden: 'include', owner: 'code' },
      {
        name: 'b',
        type: 'string',
        cardinality: 'one',
        golden: 'redact',
        enumValues,
        owner: 'code',
      },
    ]);
    // enumValues keeps its identity (R6: shared vocabulary compared by ===).
    expect(out[1]?.enumValues).toBe(enumValues);
  });
});

describe('golden corrections (U1.1.2 D4)', () => {
  test('FILE.content_hash is golden-excluded, like revision_id whose value it equals', () => {
    expect(nodeSpec('FILE')?.properties.find((p) => p.name === 'content_hash')?.golden).toBe(
      'exclude',
    );
  });

  test.each(['confidence', 'resolvedBy'])('CALLS.%s is golden-excluded (DQ-09)', (name) => {
    expect(
      EDGE_TYPES.find((e) => e.type === 'CALLS')?.properties.find((p) => p.name === name)?.golden,
    ).toBe('exclude');
  });
});
