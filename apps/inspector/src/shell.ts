// REAL (U2b.1 part 2b, BMO-35): port of 21754b4:packages/graph-visualizer/src/shell.ts.
//
// Zero imports on purpose: a host that only needs the page HTML (the VS Code extension at U3, the
// inspector's server in part 3) must not pull in the renderer by requiring this file.

/** The id of the element the page mounts on, unless the caller names another. */
export const GRAPH_CONTAINER_ID = 'graph-container';

/** The region the verify report fills (part 3); the graph is never shown without it (08-verification §3.3). */
export const VERIFICATION_ID = 'cpg-verification';

export interface GraphShellOptions {
  /** URI of the bundled page script (graph.js). */
  readonly scriptUri: string;
  /** The host's own origin, allowed for style-src (webview.cspSource in VS Code). */
  readonly cspSource: string;
  /** A fresh per-render nonce, matched in the script tag's CSP allowance. */
  readonly nonce: string;
  /** id of the element the page mounts on; default GRAPH_CONTAINER_ID. */
  readonly containerId?: string;
  /**
   * The CSP connect-src: `'none'` (the default, the VS Code panel), or exactly the browser
   * inspector's own `ws://127.0.0.1:<port>` (owner decision 10a). Anything else throws.
   */
  readonly connectSrc?: string;
}

// Decimal port without leading zero, sign, whitespace or extra tokens (1-65535 checked below).
const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;

function validateConnectSrc(connectSrc: string): string {
  if (connectSrc === "'none'") return connectSrc;
  const match = LOOPBACK_WS.exec(connectSrc);
  if (match !== null && Number(match[1]) <= 65535) return connectSrc;
  throw new Error(
    `Invalid CSP connect-src "${connectSrc}": expected 'none' or ws://127.0.0.1:<port>`,
  );
}

/**
 * The page a host serves (the VS Code webview's html, the inspector's index): a strict CSP
 * (C-EXT I-27), the `#<containerId>` element the page mounts on, the reserved `#cpg-verification`
 * region beside it, and the one nonce'd script. Throws on a connect source other than 'none' or
 * `ws://127.0.0.1:<port>`.
 */
export function graphShellHtml(options: GraphShellOptions): string {
  const containerId = options.containerId ?? GRAPH_CONTAINER_ID;
  const connectSrc = validateConnectSrc(options.connectSrc ?? "'none'");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${connectSrc}; style-src ${options.cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}';" />
  <style>
    html, body { height: 100%; margin: 0; padding: 0; }
    body { display: flex; flex-direction: column; background: var(--vscode-editor-background, Canvas); color: var(--vscode-editor-foreground, CanvasText); font-family: var(--vscode-font-family, sans-serif); }
    #${VERIFICATION_ID} { padding: 4px 8px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, GrayText); }
    #${containerId} { flex: 1; min-height: 0; position: relative; }
  </style>
</head>
<body>
  <div id="${VERIFICATION_ID}" role="status">Liveness check, not verification: no verify report yet.</div>
  <div id="${containerId}"></div>
  <script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
