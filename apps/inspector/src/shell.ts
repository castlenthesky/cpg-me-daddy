// SEAT (U2b.1 part 2b, BMO-35): port of 21754b4:packages/graph-visualizer/src/shell.ts.
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

/**
 * The page a host serves (the VS Code webview's html, the inspector's index): a strict CSP
 * (C-EXT I-27), the `#<containerId>` element the page mounts on, the reserved `#cpg-verification`
 * region beside it, and the one nonce'd script. Throws on a connect source other than 'none' or
 * `ws://127.0.0.1:<port>`.
 */
export function graphShellHtml(_options: GraphShellOptions): string {
  throw new Error('SEAT: graphShellHtml is U2b.1 part 2b');
}
