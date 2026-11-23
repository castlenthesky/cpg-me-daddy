// The relationship legend registry. Expected values are the archive's table
// (21754b4:packages/graph-visualizer/src/relationshipTypes.ts) with CONTAINS renamed HAS_ENTRY
// (04-schema.yaml: HAS_ENTRY "Was CONTAINS"), RECEIVER dropped (no schema edge) and the reserved
// EVAL_TYPE dropped (not admitted until U8; reserved.test.ts INV-RE-6).

import { EDGE_TYPES, RESERVED_EDGES } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RELATIONSHIP_COLOR,
  RELATIONSHIP_TYPES,
  UNTYPED_RELATIONSHIP_KEY,
  relationshipColor,
  relationshipKey,
  relationshipLabel,
} from './relationship-types';

describe('RELATIONSHIP_TYPES', () => {
  it('is the archive table in archive order, keyed by admitted schema edge types', () => {
    expect(RELATIONSHIP_TYPES).toEqual([
      { key: 'HAS_ENTRY', label: 'Has entry', color: '#808080' },
      { key: 'DEFINES', label: 'Defines', color: '#DCDCAA' },
      { key: 'CALLS', label: 'Calls', color: '#CE9178' },
      { key: 'IMPORTS', label: 'Imports', color: '#C586C0' },
    ]);
  });

  it('names only admitted edge types: no CONTAINS, RECEIVER or reserved type', () => {
    const admitted = new Set<string>(EDGE_TYPES.map((e) => e.type));
    const reserved = new Set<string>(RESERVED_EDGES.map((e) => e.type));
    expect(RELATIONSHIP_TYPES.length).toBeGreaterThan(0);
    expect(RELATIONSHIP_TYPES.filter((r) => !admitted.has(r.key))).toEqual([]);
    expect(RELATIONSHIP_TYPES.filter((r) => reserved.has(r.key))).toEqual([]);
  });
});

describe('relationshipKey', () => {
  it('is the type itself, or the untyped bucket for an edge with no type', () => {
    expect(UNTYPED_RELATIONSHIP_KEY).toBe('');
    expect(relationshipKey(undefined)).toBe('');
    expect(relationshipKey('CALLS')).toBe('CALLS');
    expect(relationshipKey('IN_SCOPE')).toBe('IN_SCOPE');
  });
});

describe('relationshipLabel', () => {
  it('reads the registry label for a known type', () => {
    expect(relationshipLabel('HAS_ENTRY')).toBe('Has entry');
    expect(relationshipLabel('CALLS')).toBe('Calls');
  });

  it('labels the untyped bucket "Untyped"', () => {
    expect(relationshipLabel(UNTYPED_RELATIONSHIP_KEY)).toBe('Untyped');
  });

  it('falls back to the raw type string for an unregistered type, prototype names included', () => {
    expect(relationshipLabel('IN_SCOPE')).toBe('IN_SCOPE');
    expect(relationshipLabel('CONTAINS')).toBe('CONTAINS');
    expect(relationshipLabel('constructor')).toBe('constructor');
    expect(relationshipLabel('toString')).toBe('toString');
  });
});

describe('relationshipColor', () => {
  it('reads the registry colour for a known type', () => {
    expect(relationshipColor('DEFINES')).toBe('#DCDCAA');
    expect(relationshipColor('HAS_ENTRY')).toBe('#808080');
  });

  it('is the neutral default for the untyped bucket and for any unregistered type', () => {
    expect(DEFAULT_RELATIONSHIP_COLOR).toBe('#4b4b4b');
    expect(relationshipColor(UNTYPED_RELATIONSHIP_KEY)).toBe('#4b4b4b');
    expect(relationshipColor('IN_SCOPE')).toBe('#4b4b4b');
    expect(relationshipColor('constructor')).toBe('#4b4b4b');
  });
});
