// The panel's theme (C-EXT I-4, controller decision 32): `kind` from VS Code's ColorThemeKind numbers
// (Light 1, Dark 2, HighContrast 3, HighContrastLight 4), and the node colours the registry's palette,
// so the panel and the browser draw the same picture. The palette is the archive's, pinned as literals.

import { describe, expect, it } from 'vitest';
import { panelTheme } from './theme';

const PALETTE = {
  nodeColors: {
    DIRECTORY: '#ff9933',
    FILE: '#4db3ff',
    METHOD: '#4FC1FF',
    TYPE_DECL: '#4EC9B0',
    CALL: '#CE9178',
    IMPORT: '#C586C0',
    SYMBOL: '#DCDCAA',
  },
  defaultNodeColor: '#999999',
};

describe('panelTheme', () => {
  it.each([
    [1, 'light'],
    [2, 'dark'],
    [3, 'high-contrast-dark'],
    [4, 'high-contrast-light'],
    // A kind this version does not know: dark, VS Code's own default theme.
    [0, 'dark'],
    [5, 'dark'],
  ] as const)('ColorThemeKind %s is %s, in the registry palette', (kind, expected) => {
    expect(panelTheme(kind)).toStrictEqual({ kind: expected, ...PALETTE });
  });

  it('carries only what a message can: it survives the structured clone VS Code posts', () => {
    expect(structuredClone(panelTheme(1))).toStrictEqual(panelTheme(1));
  });
});
