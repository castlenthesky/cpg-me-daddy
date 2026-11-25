// SEAT (U3.1.1 part 3, BMO-52): what the graph panel's webview shows (controller decision 31). Plain
// node: the WebviewPanel itself is part 4.

/** The page bundle's file name in pageDirectory(). */
export const PAGE_SCRIPT = 'graph.js';

/**
 * Where the page bundle is: `dist/page` of the installed @cpg/inspector, found as the CLI finds its bin
 * (controller decision 16). Resolving a path loads no inspector code. The panel's only
 * localResourceRoots entry (decision 31).
 */
export function pageDirectory(): string {
  throw new Error('SEAT: pageDirectory');
}

export interface PanelPageOptions {
  /** Where PAGE_SCRIPT is: pageDirectory(). */
  readonly directory: string;
  /** A local file's URI as the webview may load it (webview.asWebviewUri). */
  readonly asUri: (path: string) => string;
  /** webview.cspSource. */
  readonly cspSource: string;
}

/**
 * The panel's HTML: graphShellHtml on the bundle with a fresh node:crypto nonce per call and connect-src
 * 'none' (C-EXT I-27). When the bundle can't be read, a script-free page under `default-src 'none'`
 * that names the missing file and `bun run compile` (decision 31: never a blank panel). Never rejects.
 */
export async function panelHtml(_options: PanelPageOptions): Promise<string> {
  throw new Error('SEAT: panelHtml');
}
