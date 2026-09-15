// Zero imports, deliberately — same reasoning as contract.ts. The extension
// host is CommonJS and cannot `require()` the rest of this package (it's
// browser/DOM code that pulls in @cosmos.gl/graph), so it deep-requires just
// this file: `require('@cpg/graph-visualizer/dist/shell')`. That only works
// because this module's own dependency graph is empty — importing anything
// else here would make requiring it from the host pull that in too.
//
// Only page-level CSS lives here (sizing the mount element to fill the
// webview). Component styling for what GraphVisualizer creates inside that
// element (the fit-view button, the legend) is injected by the visualizer
// itself at mount time — see styles.ts.

export interface GraphShellOptions {
	/** webview.asWebviewUri(...) URI of the bundled script (e.g. graph.js). */
	scriptUri: string;
	/** webview.cspSource — the host's own origin, allowed for style-src. */
	cspSource: string;
	/** A fresh per-render nonce, matched in the <script> tag's CSP allowance. */
	nonce: string;
	/** id given to the element GraphVisualizer should be constructed on. Defaults to 'graph-container'. */
	containerId?: string;
}

/**
 * Renders the HTML page a host (e.g. a VS Code WebviewView) should set as
 * `webview.html`. The returned page loads `scriptUri` under a strict CSP
 * (`default-src 'none'`) and provides the `#<containerId>` element
 * `GraphVisualizer` expects to be constructed on.
 */
export function graphWebviewHtml(options: GraphShellOptions): string {
	const containerId = options.containerId ?? 'graph-container';
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}';" />
	<style>
		html, body { height: 100%; margin: 0; padding: 0; }
		#${containerId} { width: 100%; height: 100%; position: relative; }
	</style>
</head>
<body>
	<div id="${containerId}"></div>
	<script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
