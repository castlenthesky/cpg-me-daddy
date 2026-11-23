// Legend rows (BMO-35 line 2, "legend"). Ported from the archive's buildLegend /
// buildRelationshipLegend / appendLegendItem (21754b4:packages/graph-visualizer/src/legend.ts): the
// node legend walks NODE_TYPES in order and skips absent types; the relationship legend lists the
// keys present, sorted; a row reads `Label (count)`, its title `Click to hide|show label` (label
// lower-cased), and aria-pressed is true while the type is shown.

import { describe, expect, it } from 'vitest';
import { countByType, nodeLegendRows, relationshipLegendRows, type LegendRow } from './legend';
import { NODE_TYPES } from './node-types';

const none: ReadonlySet<string> = new Set();

describe('countByType', () => {
  it('counts each type', () => {
    expect([...countByType(['FILE', 'DIRECTORY', 'FILE'])]).toEqual([
      ['FILE', 2],
      ['DIRECTORY', 1],
    ]);
    expect(countByType([]).size).toBe(0);
  });
});

describe('nodeLegendRows', () => {
  it('lists the registered types present, in registry order, with counts', () => {
    const rows = nodeLegendRows(['FILE', 'DIRECTORY', 'FILE', 'MODULE', '__root__'], none);
    expect(rows).toEqual<LegendRow[]>([
      {
        key: 'DIRECTORY',
        text: 'Directories (1)',
        title: 'Click to hide directories',
        color: '#ff9933',
        pressed: true,
      },
      {
        key: 'FILE',
        text: 'Files (2)',
        title: 'Click to hide files',
        color: '#4db3ff',
        pressed: true,
      },
    ]);
  });

  it('keeps a hidden type listed, unpressed, offering to show it', () => {
    const rows = nodeLegendRows(['FILE', 'DIRECTORY'], new Set(['FILE']));
    expect(rows.find((row) => row.key === 'FILE')).toEqual({
      key: 'FILE',
      text: 'Files (1)',
      title: 'Click to show files',
      color: '#4db3ff',
      pressed: false,
    });
    expect(rows.find((row) => row.key === 'DIRECTORY')?.pressed).toBe(true);
  });

  it('follows the registry order whatever order the types arrive in', () => {
    const all = NODE_TYPES.map((type) => type.key);
    expect(nodeLegendRows(all.toReversed(), none).map((row) => row.key)).toEqual(all);
  });

  it('has no rows for no types, or only unregistered ones', () => {
    expect(nodeLegendRows([], none)).toEqual([]);
    expect(nodeLegendRows(['MODULE', 'PARAM'], none)).toEqual([]);
  });
});

describe('relationshipLegendRows', () => {
  it('lists every key present, sorted, with the registry label and colour or the fallbacks', () => {
    const rows = relationshipLegendRows(['IMPORTS', 'HAS_ENTRY', '', 'IMPORTS', 'ZETA'], none);
    expect(rows).toEqual<LegendRow[]>([
      {
        key: '',
        text: 'Untyped (1)',
        title: 'Click to hide untyped',
        color: '#4b4b4b',
        pressed: true,
      },
      {
        key: 'HAS_ENTRY',
        text: 'Has entry (1)',
        title: 'Click to hide has entry',
        color: '#808080',
        pressed: true,
      },
      {
        key: 'IMPORTS',
        text: 'Imports (2)',
        title: 'Click to hide imports',
        color: '#C586C0',
        pressed: true,
      },
      {
        key: 'ZETA',
        text: 'ZETA (1)',
        title: 'Click to hide zeta',
        color: '#4b4b4b',
        pressed: true,
      },
    ]);
  });

  it('gives the same order whatever order the edges arrive in', () => {
    const keys = ['CALLS', 'DEFINES', 'HAS_ENTRY', 'IMPORTS'];
    expect(relationshipLegendRows(keys.toReversed(), none).map((row) => row.key)).toEqual(keys);
  });

  it('keeps a hidden key listed, unpressed, offering to show it', () => {
    const rows = relationshipLegendRows(['', 'CALLS'], new Set(['']));
    expect(rows[0]).toEqual({
      key: '',
      text: 'Untyped (1)',
      title: 'Click to show untyped',
      color: '#4b4b4b',
      pressed: false,
    });
    expect(rows[1]?.pressed).toBe(true);
  });

  it('has no rows for no edges', () => {
    expect(relationshipLegendRows([], none)).toEqual([]);
  });
});
