// The node-type registry: the archive's palette (21754b4:packages/graph-visualizer/src/nodeTypes.ts)
// keyed by the schema's labels. Expected values are the archive's table, with `file`/`directory`
// renamed to the schema's FILE/DIRECTORY and LOCAL (no schema label) dropped.

import { NODE_LABELS } from '@cpg/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINK_COLOR_HEX,
  DEFAULT_NODE_COLOR,
  NODE_TYPE_COLORS,
  NODE_TYPES,
  REGISTRY_NODE_COLORS,
  hexToRgba,
  nodeTypeColor,
} from './node-types';
import { DEFAULT_RELATIONSHIP_COLOR } from './relationship-types';

describe('NODE_TYPES', () => {
  it('is the archive palette in archive order, keyed by schema labels', () => {
    expect(NODE_TYPES).toEqual([
      { key: 'DIRECTORY', label: 'Directories', color: '#ff9933' },
      { key: 'FILE', label: 'Files', color: '#4db3ff' },
      { key: 'METHOD', label: 'Methods', color: '#4FC1FF' },
      { key: 'TYPE_DECL', label: 'Types', color: '#4EC9B0' },
      { key: 'CALL', label: 'Calls', color: '#CE9178' },
      { key: 'IMPORT', label: 'Imports', color: '#C586C0' },
      { key: 'SYMBOL', label: 'Symbols', color: '#DCDCAA' },
    ]);
  });

  it('names only labels the schema defines (no archive-only file/directory/LOCAL)', () => {
    const labels = new Set<string>(NODE_LABELS.map((n) => n.label));
    expect(NODE_TYPES.length).toBeGreaterThan(0);
    expect(NODE_TYPES.filter((t) => !labels.has(t.key))).toEqual([]);
    expect(new Set(NODE_TYPES.map((t) => t.key)).size).toBe(NODE_TYPES.length);
  });
});

describe('hexToRgba', () => {
  it('maps #rrggbb to [r, g, b, 1] in 0..1', () => {
    expect(hexToRgba('#4db3ff')).toEqual([77 / 255, 179 / 255, 1, 1]);
    expect(hexToRgba('#ff9933')).toEqual([1, 153 / 255, 51 / 255, 1]);
    expect(hexToRgba('#000000')).toEqual([0, 0, 0, 1]);
  });

  it('reads upper- and lower-case hex alike, with or without the #', () => {
    expect(hexToRgba('#4FC1FF')).toEqual([79 / 255, 193 / 255, 1, 1]);
    expect(hexToRgba('#4fc1ff')).toEqual(hexToRgba('#4FC1FF'));
    expect(hexToRgba('4fc1ff')).toEqual(hexToRgba('#4FC1FF'));
  });
});

describe('NODE_TYPE_COLORS', () => {
  it('holds one colour per registry row, read from its hex', () => {
    expect([...NODE_TYPE_COLORS.keys()]).toEqual([
      'DIRECTORY',
      'FILE',
      'METHOD',
      'TYPE_DECL',
      'CALL',
      'IMPORT',
      'SYMBOL',
    ]);
    expect(NODE_TYPE_COLORS.get('FILE')).toEqual([77 / 255, 179 / 255, 1, 1]);
    expect(NODE_TYPE_COLORS.get('DIRECTORY')).toEqual([1, 153 / 255, 51 / 255, 1]);
    expect(NODE_TYPE_COLORS.get('SYMBOL')).toEqual([220 / 255, 220 / 255, 170 / 255, 1]);
  });

  it('is a Map: an unknown or prototype-named type has no colour', () => {
    expect(NODE_TYPE_COLORS.get('FILE')).toBeDefined();
    expect(NODE_TYPE_COLORS.get('file')).toBeUndefined();
    expect(NODE_TYPE_COLORS.get('constructor')).toBeUndefined();
    expect(NODE_TYPE_COLORS.get('toString')).toBeUndefined();
  });
});

describe('fallback colours', () => {
  it('an unregistered node type is neutral grey, never dropped', () => {
    expect(DEFAULT_NODE_COLOR).toEqual([0.6, 0.6, 0.6, 1]);
  });

  it('the default link colour is the relationship legend neutral', () => {
    expect(DEFAULT_LINK_COLOR_HEX).toBe('#4b4b4b');
    expect(DEFAULT_RELATIONSHIP_COLOR).toBe(DEFAULT_LINK_COLOR_HEX);
  });
});

// U3.1.1 part 3 (controller decision 32): the palette a theme carries, and what the page makes of one.
describe('REGISTRY_NODE_COLORS', () => {
  it('is the registry palette as a theme carries it: the rows, and the neutral grey as hex', () => {
    expect(REGISTRY_NODE_COLORS).toEqual({
      nodeColors: {
        DIRECTORY: '#ff9933',
        FILE: '#4db3ff',
        METHOD: '#4FC1FF',
        TYPE_DECL: '#4EC9B0',
        CALL: '#CE9178',
        IMPORT: '#C586C0',
        SYMBOL: '#DCDCAA',
      },
      // 0.6 of 255 is 153, 0x99.
      defaultNodeColor: '#999999',
    });
  });
});

describe('nodeTypeColor', () => {
  const colors = {
    nodeColors: { FILE: '#123456', METHOD: '#ABCdef', CALL: 'red', IMPORT: '#12345', SYMBOL: '' },
    defaultNodeColor: '#0a0b0c',
  };

  it.each([
    ['its own colour', 'FILE', '#123456'],
    ['its own colour, either case', 'METHOD', '#ABCdef'],
    ['the default for a type with none, registered or not', 'DIRECTORY', '#0a0b0c'],
    ['the default for an unregistered type', 'MODULE', '#0a0b0c'],
    ['the default for a colour name', 'CALL', '#0a0b0c'],
    ['the default for a short hex', 'IMPORT', '#0a0b0c'],
    ['the default for an empty colour', 'SYMBOL', '#0a0b0c'],
    ['the default for a prototype name', 'constructor', '#0a0b0c'],
  ])('is %s (%s)', (_what, type, expected) => {
    expect(nodeTypeColor(colors, type)).toBe(expected);
  });

  it.each(['x', '', '#fff', '#12345678', '##123456', ' #123456', '#12345g', 'rgb(1,2,3)'])(
    'falls back to the registry grey when the default is %j',
    (defaultNodeColor) => {
      expect(nodeTypeColor({ nodeColors: {}, defaultNodeColor }, 'FILE')).toBe('#999999');
    },
  );
});
