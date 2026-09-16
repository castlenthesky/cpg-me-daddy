// Component CSS for the fit-view button and legend that GraphVisualizer
// creates. Injected via a <style> tag at mount time (see visualizer.ts)
// rather than shipped as a separate stylesheet, so a consumer only has to
// load the one script — and so the code that creates these elements is also
// what styles them, instead of that living in the page shell (shell.ts owns
// only page-level layout: html/body sizing and the mount container).
//
// A host embedding this (e.g. a VS Code webview) must allow inline styles in
// its CSP (`style-src <cspSource> 'unsafe-inline'` is what graphWebviewHtml
// sets) for this to take effect.
export const GRAPH_VISUALIZER_STYLES = `
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
	background: rgba(30, 30, 30, 0.85);
	color: #cccccc;
	border: 1px solid rgba(255, 255, 255, 0.2);
	border-radius: 4px;
	cursor: pointer;
	padding: 0;
}
#fit-view-button:hover { background: rgba(60, 60, 60, 0.9); }
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
	background: rgba(30, 30, 30, 0.85);
	border: 1px solid rgba(255, 255, 255, 0.2);
	border-radius: 4px;
	padding: 4px;
}
#relationship-legend:empty { display: none; }
.legend-item {
	display: flex;
	align-items: center;
	gap: 6px;
	background: transparent;
	color: #cccccc;
	border: none;
	border-radius: 3px;
	padding: 3px 6px;
	font-family: var(--vscode-font-family, sans-serif);
	font-size: 12px;
	cursor: pointer;
	text-align: left;
}
.legend-item:hover { background: rgba(255, 255, 255, 0.1); }
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
	background: rgba(30, 30, 30, 0.85);
	color: #cccccc;
	border: 1px solid rgba(255, 255, 255, 0.2);
	border-radius: 4px;
	padding: 3px 6px;
	font-family: var(--vscode-font-family, sans-serif);
	font-size: 12px;
	white-space: nowrap;
}
#node-tooltip[hidden] { display: none; }
`;
