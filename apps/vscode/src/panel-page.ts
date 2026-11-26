// REAL (U3.1.1 part 3, BMO-52): what the graph panel's webview shows (controller decision 31). Plain
// node: the WebviewPanel itself is part 4.

import { randomBytes } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { graphShellHtml } from '@cpg/inspector';

/** The page bundle's file name in pageDirectory(). */
export const PAGE_SCRIPT = 'graph.js';

/**
 * Where the page bundle is: `dist/page` of the installed @cpg/inspector, found as the CLI finds its bin
 * (controller decision 16). Resolving a path loads no inspector code. The panel's only
 * localResourceRoots entry (decision 31).
 */
export function pageDirectory(): string {
  return join(dirname(require.resolve('@cpg/inspector/package.json')), 'dist', 'page');
}

export interface PanelPageOptions {
  /** Where PAGE_SCRIPT is: pageDirectory(). */
  readonly directory: string;
  /** A local file's URI as the webview may load it (webview.asWebviewUri). */
  readonly asUri: (path: string) => string;
  /** webview.cspSource. */
  readonly cspSource: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function unreadableBundleHtml(bundlePath: string): string {
  const path = escapeHtml(bundlePath);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'" />
</head>
<body>
  <p>The CPG graph page cannot be read (${path}). Build it with <code>bun run compile</code>, then open the graph again.</p>
</body>
</html>`;
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The panel's HTML: graphShellHtml on the bundle with a fresh node:crypto nonce per call and connect-src
 * 'none' (C-EXT I-27). When the bundle is not a file this process can read, a script-free page under
 * `default-src 'none'` that names the file and `bun run compile` (decision 31: never a blank panel),
 * and never a rejection.
 */
export async function panelHtml(options: PanelPageOptions): Promise<string> {
  const bundlePath = join(options.directory, PAGE_SCRIPT);
  if (!(await isReadableFile(bundlePath))) {
    return unreadableBundleHtml(bundlePath);
  }
  const nonce = randomBytes(16).toString('base64');
  return graphShellHtml({
    scriptUri: options.asUri(bundlePath),
    cspSource: options.cspSource,
    nonce,
    connectSrc: "'none'",
  });
}
