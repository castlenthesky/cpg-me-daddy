// REAL (U2b.1 part 2b, BMO-35): ADAPT of 21754b4:packages/graph-visualizer/src/styles.ts.
//
// Component CSS for what mountGraphViews creates (the fit-view button, the legends, the tooltip),
// injected as one <style> at mount so the code that creates the elements also styles them; the shell
// owns only page layout. Colours are --vscode-* variables with CSS system-colour fallbacks (owner
// decision 11a), never literal colours (C-EXT I-28).
//
// A host embedding this (e.g. a VS Code webview or the inspector server) must allow inline styles
// in its CSP (`style-src <cspSource> 'unsafe-inline'` is what graphShellHtml sets) for this to take
// effect.

export const GRAPH_VISUALIZER_STYLES: string = `
#fit-view-button {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-editorWidget-background, Canvas);
  color: var(--vscode-editorWidget-foreground, CanvasText);
  border: 1px solid var(--vscode-editorWidget-border, GrayText);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}
#fit-view-button:hover { background: var(--vscode-toolbar-hoverBackground, ButtonFace); }
#fit-view-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; }
#legend-container {
  position: absolute;
  bottom: 8px;
  left: 8px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
#legend, #relationship-legend {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--vscode-editorWidget-background, Canvas);
  border: 1px solid var(--vscode-editorWidget-border, GrayText);
  border-radius: 4px;
  padding: 4px;
}
#relationship-legend:empty { display: none; }
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  color: var(--vscode-editorWidget-foreground, CanvasText);
  border: none;
  border-radius: 3px;
  padding: 3px 6px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.legend-item:hover { background: var(--vscode-list-hoverBackground, ButtonFace); }
.legend-item[aria-pressed="false"] { opacity: 0.45; }
.legend-item[aria-pressed="false"] .legend-swatch { filter: grayscale(1); }
.legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}
.legend-label { white-space: nowrap; }
#node-tooltip {
  position: absolute;
  z-index: 11;
  pointer-events: none;
  transform: translate(-50%, -100%);
  background: var(--vscode-editorHoverWidget-background, Canvas);
  color: var(--vscode-editorHoverWidget-foreground, CanvasText);
  border: 1px solid var(--vscode-editorHoverWidget-border, GrayText);
  border-radius: 4px;
  padding: 3px 6px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px;
  white-space: nowrap;
}
#node-tooltip[hidden] { display: none; }
`;
