// SEAT (U3.1.1 part 3, BMO-52): the theme the panel's host sends (C-EXT I-4, controller decision 32).
// Plain node: `kind` is the number VS Code's ColorThemeKind enum carries.

import type { ThemeSnapshot } from '@cpg/model';

/**
 * The theme for a VS Code colour theme of `kind`: 1 light, 2 dark, 3 high-contrast dark, 4 high-contrast
 * light (vscode.ColorThemeKind), and anything else dark. The node colours are the inspector's registry
 * palette whatever the kind, so the panel and the browser draw the same picture (decision 32).
 */
export function panelTheme(_kind: number): ThemeSnapshot {
  throw new Error('SEAT: panelTheme');
}
