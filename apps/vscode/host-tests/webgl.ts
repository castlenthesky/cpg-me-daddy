// REAL (U3.1.2, BMO-56): which WebGL2 a webview gets here, asked of one. A page with none at all still
// reports its graph as drawn, so a render-report does not say (stop-list 124; 08-verification.md §7).

import * as vscode from 'vscode';

const ANSWER_MS = 20_000;

const PAGE = `<!DOCTYPE html><html><body><script>
const api = acquireVsCodeApi();
let renderer = null;
try {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
  if (gl) renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
} catch {}
api.postMessage({ renderer });
</script></body></html>`;

/** The WebGL2 renderer a webview gets, or undefined when it gets none. Rejects after 20 s with no answer. */
export function webglRenderer(): Promise<string | undefined> {
  const panel = vscode.window.createWebviewPanel('cpg.webgl', 'WebGL', vscode.ViewColumn.One, {
    enableScripts: true,
  });
  return new Promise<string | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`a webview did not answer in ${String(ANSWER_MS)} ms`));
    }, ANSWER_MS);
    panel.webview.onDidReceiveMessage((message: { readonly renderer: string | null }) => {
      clearTimeout(timer);
      resolve(message.renderer ?? undefined);
    });
    panel.webview.html = PAGE;
  }).finally(() => panel.dispose());
}
